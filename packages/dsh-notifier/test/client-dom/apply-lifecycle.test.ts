// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project：变异面按拓扑派生的是
// 单 project node 环境配置（vitest.stryker.d/*.config.ts），本层要进变异面就得自带环境。
/**
 * dsh-notifier — apply() 装配/卸载的端到端清理判据（评审 R5 的核心缺口）。
 *
 * 为什么另立这一层：disposers.ts 的单测只断「栈本身会逆序吞错释放」，而「apply 这条装配路径有
 * 没有把 teardown 登记进去、登记点是否晚于资源建立」此前没有任何判据——中途同步抛错时已建立的
 * 资源失去释放点（R5）正是从这个缺口溜过去的。本层在真实 happy-dom document 上驱动客户端入口，
 * 断言的是页面级副作用（<style> / 假 EventSource / document.title / visibilitychange 监听）
 * 在卸载前后的实际存在性，而不是「实现调用过某个方法」。
 *
 * EventSource 是全局构造器（index.tsx 的 createSource 里 new 的是全局名，没有端口可注入），
 * 故按测试纪律的例外用 globalThis 上的手写假类替换：只记录实例、close() 与挂上的 onmessage，
 * 不实现任何重连语义（重连判定归 client-unit 的 notify-session 判据）。
 *
 * 状态纪律：pageOwner / eventsHandle / titleFlasher 都是模块级单例，跨用例共享。每个用例的释放
 * 点在 afterEach 里兜底触发（disposer 释放幂等），并用一枚固定归属令牌把 titleFlasher 的恢复
 * 缓存接盘清空——否则上个用例残留的「闪烁中」状态会串进下一个。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { apply } from "../../src/client/index.tsx";
import { t } from "../../src/client/locale.ts";
import { titleFlasher } from "../../src/client/notify/title.ts";

/** 实现写入的样式幂等键。写字面量而不是从实现 import：同源期望会让常量改成任何值都绿。 */
const STYLE_ID = "dsh-notifier-style";

/** 每例的基线标题：标题闪烁记下的「原文」由它承载。 */
const BASE_TITLE = "DSH 测试页";

/** 清空 titleFlasher 恢复缓存用的归属令牌。 */
const RESET_OWNER: object = {};

/** 假 EventSource：只记录实例与关闭，不模拟重连。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

const RealEventSource = globalThis.EventSource;

/** 假 ctx：只承载 apply 真正读到的两个服务名。 */
interface FakeCtx {
  get(name: string): unknown;
  effect(callback: () => () => void): void;
}

/** 一次 apply 的可观测面。 */
interface Boot {
  readonly ctx: FakeCtx;
  /** 捕获到的 effect 释放函数（正常装配路径只登记一处）。 */
  readonly effects: Array<() => void>;
}

/** 本文件里所有 apply 的释放点，供 afterEach 兜底（release 幂等，重复触发无副作用）。 */
const disposers: Array<() => void> = [];

/** 当前 document.visibilityState 的取值来源。 */
let visibility: "visible" | "hidden" = "visible";

/**
 * 建立一次 apply 所需的最小宿主面。
 *
 * @param options.localeThrows 复现「装配中途同步抛错」——locale 在若干资源建立之后才被读取。
 */
function makeCtx(options: { localeThrows?: boolean; localeService?: unknown } = {}): Boot {
  const effects: Array<() => void> = [];
  const ctx: FakeCtx = {
    get(name: string): unknown {
      if (name === "locale" && options.localeThrows === true) {
        throw new Error("locale 服务读取失败（测试注入）");
      }
      if (name === "locale" && options.localeService !== undefined) {
        return options.localeService;
      }
      return undefined;
    },
    effect(callback: () => () => void): void {
      effects.push(callback());
    },
  };
  return { ctx, effects };
}

/** 驱动一次 apply 并把释放点登进兜底清单（apply 抛错时也要登记：finally 里可能已经挂上了）。 */
function boot(options: { localeThrows?: boolean; localeService?: unknown } = {}): Boot {
  const handle = makeCtx(options);
  try {
    apply(handle.ctx);
  } finally {
    disposers.push(...handle.effects);
  }
  return handle;
}

/** 页面里当前的插件样式节点。 */
function styleNode(): HTMLElement | null {
  return document.getElementById(STYLE_ID);
}

/** 切换页面可见性（document.visibilityState 是本文件挂上去的 getter）。 */
function setVisibility(value: "visible" | "hidden"): void {
  visibility = value;
}

/** 经假连接投递一帧通知：走 session.onmessage → apply 装配的完整展示链路。 */
function deliverNotify(source: FakeEventSource, title: string): void {
  source.onmessage?.({
    data: JSON.stringify({ type: "notify", kind: "done", title, message: "正文" }),
  });
}

/** 派发一次回前台事件。 */
function dispatchVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  FakeEventSource.reset();
  disposers.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.title = BASE_TITLE;
  localStorage.clear();
});

afterEach(() => {
  // 兜底释放：用例中途失败时也不把监听 / 连接 / 样式漏给下一个用例。
  for (const dispose of disposers.splice(0)) dispose();
  styleNode()?.remove();
  localStorage.clear();
  // titleFlasher 是模块级单例：固定令牌接盘后 restore 只认当前归属者，故这一步能清掉残留闪烁。
  titleFlasher.flash("__reset__", RESET_OWNER);
  titleFlasher.restore(RESET_OWNER);
  document.title = BASE_TITLE;
  Reflect.deleteProperty(document, "visibilityState");
});

afterAll(() => {
  globalThis.EventSource = RealEventSource;
});

describe("apply：正常装配与卸载", () => {
  it("装配注入页面样式并建立 SSE；卸载后样式被摘、连接被关、标题复位", () => {
    const { effects } = boot();

    expect(styleNode()).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.closed).toBe(false);

    setVisibility("hidden");
    deliverNotify(source, "任务完成");
    expect(document.title).toBe("🔔 任务完成");

    expect(effects).toHaveLength(1);
    effects[0]!();

    expect(styleNode()).toBeNull();
    expect(source.closed).toBe(true);
    expect(document.title).toBe(BASE_TITLE);
  });
});

describe("apply：装配中途同步抛错（R5）", () => {
  it("apply 只 warn 不抛出，抛错前建立的样式仍被登记，释放后从页面摘除", () => {
    const { effects } = boot({ localeThrows: true });

    expect(effects).toHaveLength(1);
    expect(styleNode()).not.toBeNull();

    effects[0]!();

    expect(styleNode()).toBeNull();
  });

  it("apply 中途抛错时不向外抛：宿主不会因一次可降级失败看到异常", () => {
    // 走 boot 而不是裸 apply：这次装配捕获到的释放点同样要进兜底清单，否则它挂上的
    // visibilitychange 监听会漏给后续用例（与文件头的状态纪律自相矛盾）。
    expect(() => boot({ localeThrows: true })).not.toThrow();
  });
});

describe("apply：visibilitychange 监听的摘除", () => {
  it("装载期回前台会还原标题；卸载后同样的回前台不再还原（监听已摘）", () => {
    const { effects } = boot();
    const source = FakeEventSource.instances[0]!;

    setVisibility("hidden");
    deliverNotify(source, "第一条");
    expect(document.title).toBe("🔔 第一条");

    setVisibility("visible");
    dispatchVisibilityChange();
    expect(document.title).toBe(BASE_TITLE);

    effects[0]!();

    // 假连接的 onmessage 闭包仍在手里：卸载后还能用同一个归属者再闪一次，
    // 于是「回前台会不会还原」就只取决于监听还在不在。
    setVisibility("hidden");
    deliverNotify(source, "第二条");
    expect(document.title).toBe("🔔 第二条");

    setVisibility("visible");
    dispatchVisibilityChange();

    expect(document.title).toBe("🔔 第二条");
  });
});

describe("apply：页面级单例的归属判定", () => {
  it("两次装配后触发先装实例的清理：它的连接被关，但后装实例的样式仍在", () => {
    const first = boot();
    const second = boot();

    expect(styleNode()).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(2);

    first.effects[0]!();

    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    expect(styleNode()).not.toBeNull();

    second.effects[0]!();

    expect(styleNode()).toBeNull();
  });
});

/** this 敏感的假 locale 服务：最小复刻宿主实现（bind 读 this 上的 bound/translate），detached 摘出调用即抛。 */
class ThisSensitiveLocale {
  private readonly dicts = new Map<
    string,
    { zh: Record<string, string>; en: Record<string, string> }
  >();
  private readonly bound = new Map<string, (key: string) => string>();
  private readonly listeners = new Set<() => void>();
  private active: "zh" | "en" = "en";
  register(ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }): void {
    this.dicts.set(ns, dict);
  }
  bind(ns: string): (key: string) => string {
    let fn = this.bound.get(ns);
    if (fn === undefined) {
      fn = (key: string) => this.translate(ns, key);
      this.bound.set(ns, fn);
    }
    return fn;
  }
  private translate(ns: string, key: string): string {
    const dict = this.dicts.get(ns);
    if (dict === undefined) return key;
    const table = this.active === "zh" ? dict.zh : dict.en;
    return table[key] ?? key;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  getSnapshot(): number {
    return this.listeners.size;
  }
  setLocale(next: "zh" | "en"): void {
    this.active = next;
    const pending = [...this.listeners];
    for (const listener of pending) listener();
  }
}

describe("apply：locale 绑定必须带接收者调用", () => {
  // 宿主 bind 依赖 this：旧代码把方法摘出再调会抛，失败被 catch 吞掉后整面板回落 key 本体。
  // 本用例在旧代码下红在第一条断言（t 回落为 key 本体）。
  it("装配后 t 即返回译文；切语言后订阅重绑跟随", () => {
    const service = new ThisSensitiveLocale();
    boot({ localeService: service });
    expect(t("tabLabel")).toBe("Notification center");
    service.setLocale("zh");
    expect(t("tabLabel")).toBe("通知中心");
  });
});
