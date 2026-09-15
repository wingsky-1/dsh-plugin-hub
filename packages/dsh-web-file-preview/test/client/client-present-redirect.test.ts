/**
 * dsh-web-file-preview — 「打开文件」重定向拦截（issue #698）。
 *
 * vm 沙箱执行真实 lib/client.js，断言：fetch 包装在真实 apply 装配下生效；命中时不出网且把
 * 官方地址交给侧栏；reveal 与非目标请求原样透传；openResource 抛错时显式重放；disposer 按
 * 身份还原（不摘掉别人的包装）。本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）。
 *
 * 沙箱只提供**产物真正用到**的全局（见下），不模拟浏览器：重定位后客户端没有渲染面，
 * 历史夹具里的 createElement / head.appendChild / localStorage / Element 等桩已随
 * 自研预览器一并失去用途，删掉它们既去死代码也去掉桩与产物的漂移面。
 *
 * 逻辑分支（采集来源、pending 语义、会话读取失败等）由 test/unit 直连 src 覆盖；
 * 本文件只负责"产物形态 + 顶层装配"这类只能在产物上验证的事实。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

/** 客户端产物 factory 的形状（wrapper 模式经 __ModuleLoader__.load 交回）。 */
type ClientFactory = (require: (id: string) => unknown) => {
  apply: (ctx: unknown) => void;
  inject: readonly string[];
};

/** 夹具节点：只实现被测链路读到的 DOM 面。 */
type StubElement = { getAttribute(name: string): string | null };

type StubNode = {
  closest(selector: string): StubNode | null;
  querySelector(selector: string): StubElement | null;
  getAttribute(name: string): string | null;
};

type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

/** 响应形状（原生 fetch 与合成响应都用它取字段）。 */
type FetchResult = { status: number; ok: boolean; marker?: unknown };

/** 沙箱：全局与 window 自引用都运行期挂载，故用 Record 承接并在访问处收窄。 */
type Sandbox = Record<string, unknown> & { window: Record<string, unknown>; fetch: FetchLike };

type BootHandle = {
  mod: { apply: (ctx: unknown) => void; inject: readonly string[] };
  sandbox: Sandbox;
  listeners: Map<string, Set<(event: unknown) => void>>;
  fetchCalls: Array<{ input: unknown; init: unknown }>;
  originalFetch: FetchLike;
  factoryRegistered: boolean;
};

/**
 * 装配一次真实 apply 会话，返回可驱动的句柄。
 *
 * 沙箱里只放产物用到的宿主 API：`document` 的两个监听接口、`window`（自引用）、`fetch`、
 * `window.__ModuleLoader__`、`Response`（合成 204）、`URL`（请求归一）与静音 `console`。
 * 其余 JS 内建由 vm context 自带。
 */
function boot(): BootHandle {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const documentStub = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      listeners.get(type)?.delete(handler);
    },
  };

  const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
  const originalFetch: FetchLike = function (input, init) {
    fetchCalls.push({ input, init });
    return Promise.resolve({ ok: true, status: 200, marker: "original" });
  };

  let loadedFactory: ClientFactory | null = null;
  const sandbox = {
    console: { ...console, warn: (): void => {} },
    URL,
    Response,
    document: documentStub,
  } as unknown as Sandbox;
  sandbox.window = sandbox;
  sandbox.fetch = originalFetch;
  const win = sandbox.window;
  win.__ModuleLoader__ = {
    load(handoff: { factory: ClientFactory }): void {
      loadedFactory = handoff.factory;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);

  const factoryRegistered = loadedFactory !== null;
  const factory: ClientFactory =
    loadedFactory ??
    (() => {
      throw new Error("产物未注册 factory（lib/client.js 形态变了？）");
    });
  const mod = factory(() => {
    throw new Error("unexpected require（wfp 无 external，内联自包含）");
  });
  return { mod, sandbox, listeners, fetchCalls, originalFetch, factoryRegistered };
}

/** presented 卡片夹具：卡片根带 data-presented-file，覆盖按钮带 title。 */
function cardFor(path: string): StubNode {
  const button: StubElement = { getAttribute: (name) => (name === "title" ? path : null) };
  const card: StubNode = {
    closest: (selector) => (selector === "[data-presented-file]" ? card : null),
    querySelector: (selector) => (selector === "button[title]" ? button : null),
    getAttribute: () => null,
  };
  return card;
}

/** 助手回复正文提及夹具：`<code><button title=路径>`。 */
function mentionFor(path: string): StubNode {
  const button: StubNode = {
    closest: (selector) => {
      if (selector === "[data-presented-file]") return null;
      return selector === "code > button[title]" ? button : null;
    },
    querySelector: () => null,
    getAttribute: (name) => (name === "title" ? path : null),
  };
  return button;
}

describe("「打开文件」重定向拦截（issue #698）", () => {
  let factoryRegistered: boolean;
  let wrappedAfterApply: boolean;
  let fetchCallsAfterNoPending: number;
  let openedAfterNoPending: number;
  let openedAfterCardClick: string[];
  let fetchCallsAfterHit: number;
  let synthStatus: number;
  let synthOk: boolean;
  let fetchCallsAfterReveal: number;
  let passthroughMarker: unknown;
  let openedAfterMention: string | undefined;
  let fetchCallsBeforeReplay: number;
  let fetchCallsAfterReplay: number;
  let wrappedAfterSecondApply: boolean;
  let openedAfterSecondApplyHit: string | undefined;
  let fetchRestoredAfterDispose: boolean;

  beforeAll(async () => {
    const handle = boot();
    factoryRegistered = handle.factoryRegistered;
    const opened: string[] = [];
    const disposers: Array<() => void> = [];
    const ctx = {
      sessions: { list: { getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/w" } } }) } },
      sidebarRight: {
        openResource(address: string): void {
          opened.push(address);
        },
      },
      effect(fn: () => () => void): () => void {
        const d = fn();
        disposers.push(d);
        return d;
      },
    };
    handle.mod.apply(ctx);

    const fetchOf = (): FetchLike => handle.sandbox.window.fetch as FetchLike;
    const click = (target: unknown): void => {
      for (const h of handle.listeners.get("click") ?? []) h({ target });
    };
    const call = async (input: unknown, init?: unknown): Promise<FetchResult> =>
      (await fetchOf()(input, init)) as FetchResult;

    wrappedAfterApply = fetchOf() !== handle.originalFetch;

    // 未采集到路径时不能吞请求：宁可放行原生，也不能让用户点了没反应。
    await call("/api/present.open?sessionId=s1&seq=1&index=0", { method: "POST" });
    fetchCallsAfterNoPending = handle.fetchCalls.length;
    openedAfterNoPending = opened.length;

    click(cardFor("/w/out/report.md"));
    const response = await call("/api/present.open?sessionId=s1&seq=1&index=0", { method: "POST" });
    openedAfterCardClick = [...opened];
    fetchCallsAfterHit = handle.fetchCalls.length;
    synthStatus = response.status;
    synthOk = response.ok;

    await call("/api/present.open?sessionId=s1&seq=1&index=0&action=reveal", { method: "POST" });
    fetchCallsAfterReveal = handle.fetchCalls.length;

    const passthrough = await call("/api/present.host");
    passthroughMarker = passthrough.marker;

    click(mentionFor("src/index.ts"));
    await call("/api/present.open?sessionId=s1&seq=2&index=0", { method: "POST" });
    openedAfterMention = opened.at(-1);

    fetchCallsBeforeReplay = handle.fetchCalls.length;
    ctx.sidebarRight.openResource = () => {
      throw new Error("no registered tab type claims");
    };
    await call("/api/present.open?sessionId=s1&seq=3&index=0", { method: "POST" });
    fetchCallsAfterReplay = handle.fetchCalls.length;

    // 重复 apply（HMR / 二次挂载）：包装叠加在旧包装之上，收口仍须生效。
    handle.mod.apply(ctx);
    wrappedAfterSecondApply = fetchOf() !== handle.originalFetch;
    ctx.sidebarRight.openResource = (address: string): void => {
      opened.push(address);
    };
    click(cardFor("/w/twice.md"));
    await call("/api/present.open?sessionId=s1&seq=9&index=0", { method: "POST" });
    openedAfterSecondApplyHit = opened.at(-1);

    // 身份比对还原是分层的：cordis 按 LIFO 逆序清栈，故按注册逆序卸载才能逐层摘除
    // （顺序敏感是已知取舍，见 present-open-redirect.ts 还原器处的 why 注释）。
    for (const d of disposers.splice(0).reverse()) d();
    fetchRestoredAfterDispose = fetchOf() === handle.originalFetch;
  });

  it("#698：产物 load 已注册 factory", () => {
    expect(factoryRegistered).toBe(true);
  });

  it("#698：apply 后 window.fetch 被包装", () => {
    expect(wrappedAfterApply).toBe(true);
  });

  it("#698：无 pending 时透传原生请求", () => {
    expect(fetchCallsAfterNoPending).toBe(1);
  });

  it("#698：无 pending 不打开预览", () => {
    expect(openedAfterNoPending).toBe(0);
  });

  it("#698：卡片路径折叠 cwd 后交给官方侧栏", () => {
    expect(openedAfterCardClick).toEqual(["dsh-resource://file/session/s1/out/report.md"]);
  });

  it("#698：命中时不出网", () => {
    expect(fetchCallsAfterHit).toBe(1);
  });

  it("#698：合成 204 响应", () => {
    expect(synthStatus).toBe(204);
  });

  it("#698：合成响应 ok（官方只判 ok/422）", () => {
    expect(synthOk).toBe(true);
  });

  it("#698：reveal 原样透传（决策 1）", () => {
    expect(fetchCallsAfterReveal).toBe(2);
  });

  it("#698：非目标请求返回原响应对象", () => {
    expect(passthroughMarker).toBe("original");
  });

  it("#698：正文提及也能采集路径", () => {
    expect(openedAfterMention).toBe("dsh-resource://file/session/s1/src/index.ts");
  });

  it("#698：openResource 抛错时显式重放原生请求", () => {
    expect(fetchCallsAfterReplay).toBe(fetchCallsBeforeReplay + 1);
  });

  it("#698：重复 apply 后仍处于包装态", () => {
    expect(wrappedAfterSecondApply).toBe(true);
  });

  it("#698：重复 apply 后收口仍生效", () => {
    expect(openedAfterSecondApplyHit).toBe("dsh-resource://file/session/s1/twice.md");
  });

  it("#698：逐层逆序卸载后按身份还原 fetch", () => {
    expect(fetchRestoredAfterDispose).toBe(true);
  });
});
