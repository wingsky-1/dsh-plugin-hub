// @ts-nocheck
/**
 * dsh-web-file-preview — 「打开文件」重定向拦截（issue #698）。
 *
 * vm 沙箱执行真实 lib/client.js（与 client-style.test.ts 同范式），断言：fetch 包装
 * 在真实 apply 装配下生效；命中时不出网且把官方地址交给侧栏；reveal 与非目标请求
 * 原样透传；openResource 抛错时显式重放；disposer 按身份还原（不摘掉别人的包装）。
 *
 * 本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）：原每条 assert 一个 it。
 * 加载方式保持原样——仍读 lib/client.js 产物 + vm 执行，未改为直连 src。
 * 原块是一整条交错会话（包装 → 放行 → 命中 → reveal 透传 → 抛错重放 → 二次 apply
 * → 逆序卸载），故 beforeAll 逐行保留原顺序并在每个原断言位置取观测快照。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

/** 装配一次真实 apply 会话，返回可驱动的句柄。 */
function boot() {
  const listeners = new Map();
  const headNodes = [];
  const byId = new Map();
  const documentStub = {
    head: headNodes,
    body: { appendChild() {}, style: {} },
    fullscreenElement: null,
    contains() { return false; },
    getElementById(id) { return byId.get(id) ?? null; },
    querySelector() { return null; },
    createElement() {
      return {
        id: "", textContent: "", dataset: {}, style: {},
        appendChild() {}, remove() {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, getAttribute() { return null; },
        querySelector() { return null; },
        addEventListener() {}, removeEventListener() {},
      };
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  documentStub.head.appendChild = (node) => {
    headNodes.push(node);
    if (node.id !== "") byId.set(node.id, node);
  };

  const fetchCalls = [];
  const originalFetch = function (input, init) {
    fetchCalls.push({ input, init });
    return Promise.resolve({ ok: true, status: 200, marker: "original" });
  };

  let loadedFactory = null;
  // 旧捕获器以 `instanceof Element` 判定目标，夹具的假节点不是它的实例——
  // 于是旧路径直接放行，本次断言只观察新重定向链路。
  class ElementStub {}
  class NodeStub {}
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise, Number, String, RegExp, Error, URL, Response,
    Element: ElementStub,
    Node: NodeStub,
    HTMLElement: ElementStub,
    Event: class {},
    setTimeout, clearTimeout,
    document: documentStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.fetch = originalFetch;
  sandbox.window.matchMedia = undefined;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  sandbox.window.isSecureContext = false;
  sandbox.window.open = () => null;
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  const factoryRegistered = loadedFactory !== null;
  const mod = loadedFactory(() => {
    throw new Error("unexpected require（wfp 无 external，内联自包含）");
  });
  return { mod, sandbox, listeners, fetchCalls, originalFetch, factoryRegistered };
}

/** presented 卡片夹具：卡片根带 data-presented-file，覆盖按钮带 title。 */
function cardFor(path) {
  const button = { getAttribute: (name) => (name === "title" ? path : null) };
  const card = {
    closest: (selector) => (selector === "[data-presented-file]" ? card : null),
    querySelector: (selector) => (selector === "button[title]" ? button : null),
    getAttribute: () => null,
  };
  return card;
}

/** 助手回复正文提及夹具：`<code><button title=路径>`。 */
function mentionFor(path) {
  const button = {
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
  let factoryRegistered;
  let wrappedAfterApply;
  let fetchCallsAfterNoPending;
  let openedAfterNoPending;
  let openedAfterCardClick;
  let fetchCallsAfterHit;
  let synthStatus;
  let synthOk;
  let fetchCallsAfterReveal;
  let passthroughMarker;
  let openedAfterMention;
  let fetchCallsBeforeReplay;
  let fetchCallsAfterReplay;
  let wrappedAfterSecondApply;
  let openedAfterSecondApplyHit;
  let fetchRestoredAfterDispose;

  beforeAll(async () => {
    const handle = boot();
    factoryRegistered = handle.factoryRegistered;
    const opened = [];
    const disposers = [];
    const ctx = {
      locale: undefined,
      sessions: { list: { getSnapshot: () => ({ current: "s1", byId: { s1: { cwd: "/w" } } }) } },
      remote: undefined,
      sidebarRight: { openResource(address) { opened.push(address); } },
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    };
    handle.mod.apply(ctx);

    const fetchOf = () => handle.sandbox.window.fetch;
    const click = (target) => { for (const h of handle.listeners.get("click") ?? []) h({ target }); };
    const call = (input, init) => fetchOf()(input, init);

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
    ctx.sidebarRight.openResource = () => { throw new Error("no registered tab type claims"); };
    await call("/api/present.open?sessionId=s1&seq=3&index=0", { method: "POST" });
    fetchCallsAfterReplay = handle.fetchCalls.length;

    // 重复 apply（HMR / 二次挂载）：包装叠加在旧包装之上，收口仍须生效。
    handle.mod.apply(ctx);
    wrappedAfterSecondApply = fetchOf() !== handle.originalFetch;
    ctx.sidebarRight.openResource = (address) => { opened.push(address); };
    click(cardFor("/w/twice.md"));
    await call("/api/present.open?sessionId=s1&seq=9&index=0", { method: "POST" });
    openedAfterSecondApplyHit = opened.at(-1);

    // 身份比对还原是分层的：按注册逆序卸载才能逐层摘除（顺序敏感是已知取舍，见装配注释）。
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
