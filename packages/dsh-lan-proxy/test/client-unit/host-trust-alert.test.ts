/**
 * dsh-lan-proxy — 四态判定 → 控制台告警的判据（P1-1 / issue #856）。
 *
 * 两条互不可替代的判据，缺一不可：
 * 1. **纯函数表驱动**：`hostTrustAlert` 对四态给出正确取舍（哪两态告警、文案区分）；
 * 2. **装配接线**：`apply` 真的会调用告警——只测纯函数证明不了「告警被接上了」，
 *    这正是 P1-1 的病灶（判定有、可见面没有）。这里用假 ctx 驱动真实 apply，
 *    断言 console.warn 实际被调用，且**在设置面缺席时照样调用**（slots 服务缺失的
 *    用例即「卡片不可能挂载」的极端形态）。
 *
 * 为什么告警要在 apply 最前面（本文件锁的就是这件事）：设置卡片的承载面
 * `settings.plugin.item` 在非回环 authority（settings scope = memory）下根本不渲染，
 * compat-off / contract-drift 两个故障态因此在页面上不可达；告警必须独立于 slots
 * 与设置面。异常防御同理：观测失败不得打断页面启动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apply } from "../../src/client/index.ts";
import { hostTrustAlert, type HostTrustStatus } from "../../src/client/host-trust-status.ts";

/** 页面侧 marker 全局键的字面量（不 import 常量：同源期望会让改名两边一起绿）。 */
const MARKER_GLOBAL = "__DSH_LAN_PROXY_HOST_TRUST__";

/** 告警前缀：与 apply 里其它 warn 共用，用来把本告警从别的 warn 里挑出来。 */
const PREFIX = "[dsh-lan-proxy]";

/** 一次假装配的可观测面。 */
interface FakeBoot {
  readonly ctx: any;
  /** 被登记进 settings.plugin.item 的工厂；本文件一律不调用它 = 卡片未挂载。 */
  readonly slotFactories: Array<() => unknown>;
}

/**
 * 最小假 ctx：只提供 apply 真正读到的面（slots / locale / remote / effect）。
 *
 * @param options.withSlots false 时 slots 服务缺失——设置面完全不存在。
 */
function makeCtx(options: { withSlots?: boolean; remote?: unknown } = {}): FakeBoot {
  const slotFactories: Array<() => unknown> = [];
  const slots = {
    inject(_name: string, factory: () => unknown) {
      slotFactories.push(factory);
    },
    register() {
      return () => {};
    },
  };
  const ctx: any = {
    remote: "remote" in options ? options.remote : { $host: { isLoopback: false } },
    get(name: string) {
      if (name === "slots") return options.withSlots === false ? undefined : slots;
      return undefined;
    },
    effect() {
      return undefined;
    },
  };
  return { ctx, slotFactories };
}

/** 捕获的 console.warn 文案（本告警只认带前缀的那些）。 */
let warns: string[];

beforeEach(() => {
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  });
  // ensureStyle 需要 document.head 判空早退；node 环境无 DOM，这里只装最小可判面。
  (globalThis as Record<string, unknown>).document = { head: null, getElementById: () => null };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).location;
  delete (globalThis as Record<string, unknown>)[MARKER_GLOBAL];
});

/** 本插件告警（带前缀且提到 host trust）在捕获里的条数。 */
function hostTrustWarns(): string[] {
  return warns.filter((text) => text.startsWith(PREFIX) && text.includes("host trust"));
}

describe("hostTrustAlert：四态 → 是否告警与文案", () => {
  const cases: Array<{ status: HostTrustStatus; warn: boolean; must: string[] }> = [
    { status: "loopback-page", warn: false, must: [] },
    { status: "compat-active", warn: false, must: [] },
    { status: "contract-drift", warn: true, must: ["marker", "isLoopback"] },
    { status: "compat-off", warn: true, must: ["memory scope", "ownsHostCompat"] },
  ];

  it.each(cases)("$status → warn=$warn", ({ status, warn, must }) => {
    const alert = hostTrustAlert(status);
    if (!warn) {
      expect(alert).toBe(null);
      return;
    }
    expect(typeof alert).toBe("string");
    for (const fragment of must) expect(alert).toContain(fragment);
  });

  it("两个故障态文案互不相同（漂移不是「开关关闭」的同义复述）", () => {
    expect(hostTrustAlert("contract-drift")).not.toBe(hostTrustAlert("compat-off"));
  });
});

describe("apply 接线：故障态告警不依赖设置面（设置卡片不挂载时也要发）", () => {
  it("非回环 + marker 在 + isLoopback=false（契约漂移）：发出一次告警", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "192.168.1.50" };
    (globalThis as Record<string, unknown>)[MARKER_GLOBAL] = true;
    const boot = makeCtx({ remote: { $host: { isLoopback: false } } });
    apply(boot.ctx);
    // 卡片工厂只被登记、从未被调用——即「设置面在非回环页面下不渲染」这一事实。
    expect(boot.slotFactories.length).toBe(1);
    const alerts = hostTrustWarns();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toBe(`${PREFIX} ${hostTrustAlert("contract-drift")}`);
  });

  it("非回环 + 无 marker + isLoopback=false（开关关闭）：发出一次告警", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "10.0.0.7" };
    const boot = makeCtx({ remote: { $host: { isLoopback: false } } });
    apply(boot.ctx);
    const alerts = hostTrustWarns();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toBe(`${PREFIX} ${hostTrustAlert("compat-off")}`);
  });

  it("slots 服务缺失（设置面根本不存在）：告警照样发出", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "192.168.1.50" };
    (globalThis as Record<string, unknown>)[MARKER_GLOBAL] = true;
    const boot = makeCtx({ withSlots: false, remote: { $host: { isLoopback: false } } });
    apply(boot.ctx);
    expect(boot.slotFactories.length).toBe(0);
    expect(hostTrustWarns().length).toBe(1);
  });

  it("回环 authority：不告警（本机页设置面天然可用）", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "127.0.0.1" };
    const boot = makeCtx({ remote: { $host: { isLoopback: true } } });
    apply(boot.ctx);
    expect(hostTrustWarns()).toEqual([]);
  });

  it("非回环 + marker 在 + isLoopback=true（兼容模式生效）：不告警", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "192.168.1.50" };
    (globalThis as Record<string, unknown>)[MARKER_GLOBAL] = true;
    const boot = makeCtx({ remote: { $host: { isLoopback: true } } });
    apply(boot.ctx);
    expect(hostTrustWarns()).toEqual([]);
  });

  it("remote 读取抛异常：不外抛、不告警（观测失败不得打断页面启动）", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "192.168.1.50" };
    const boot = makeCtx();
    Object.defineProperty(boot.ctx, "remote", {
      get() {
        throw new Error("remote boom");
      },
    });
    expect(() => apply(boot.ctx)).not.toThrow();
    expect(hostTrustWarns()).toEqual([]);
  });
});
