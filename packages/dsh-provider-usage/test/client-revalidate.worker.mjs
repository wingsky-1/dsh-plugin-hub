// @ts-nocheck
/**
 * dsh-provider-usage — 行为级 worker：refreshStats 取数前 provider 复检（issue #71 方案 A1）。
 *
 * 背景：宿主 sessions.list 订阅仅在切换会话（list.current 变化）/ roster
 * 注册卸载时 fire；**会话内切模型/provider 不产生任何宿主信号**，而旧 refreshStats
 * 每 60s 只重拉旧 provider 的 /stats、从不复检 → 轮询零自愈（#71 主根因）。
 *
 * 覆盖（对 src/client/index.ts 真实源码做行为级断言，esbuild 内存打包 +
 * mini-DOM stub + mock fetch/sessions，无网络无 DOM 依赖）：
 * - A1 核心：会话内切模型（宿主信号不 fire）→ 手动触发轮询回调 →
 *   refreshStats 取数前复检 → /stats?provider=<新> 被请求、胶囊/面板跟随新 provider；
 * - 切换会话跨 provider（sessions.list fire）→ 立即拉新 provider（不等轮询）；
 * - 切换会话同 provider → 维护者补充需求：仍立即刷一次 stats；
 * - 初次挂载：检测先行，首拉即新 provider（FALLBACK 不泄漏进任何 /stats 请求）。
 *
 * 运行形态：由 unit-refresh-revalidate.test.ts 以子进程执行。本脚本需替换
 * document/fetch/setInterval 全局对象——独立进程隔离，既不污染 smoke 模块图，
 * 也不受其他测试文件 fetch 替换/恢复交错的影响（TLA 并发求值语义下同进程必冲突）。
 * 全部断言通过打印 WORKER-PASS 标记行；任何失败经非零退出码 + stderr 上报。
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---------------------------------------------------------------- 打包（stub react/css）

/** react/css stub：settings.ts 的 React 仅在设置页渲染时使用（本测试不渲染）；css 仅注入文本。 */
const stubPlugin = {
  name: "stub-react-css",
  setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: "react-stub", namespace: "stub-rc" }));
    build.onLoad({ filter: /.*/, namespace: "stub-rc" }, () => ({
      contents: "export const createElement = (type, props, ...children) => ({ type, props, children });",
      loader: "js",
    }));
    build.onLoad({ filter: /\.css$/, namespace: "file" }, (args) => ({
      contents: `export default ${JSON.stringify(`/*stub-css:${args.path}*/`)};`,
      loader: "js",
    }));
  },
};

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/index.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  define: { __DSH_ROUTES__: "undefined" },
  plugins: [stubPlugin],
});
const client = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

// ---------------------------------------------------------------- mini-DOM stub

function makeNode(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    className: "",
    innerHTML: "",
    hidden: false,
    title: "",
    dataset: {},
    style: {},
    attrs: {},
    parentElement: null,
    listeners: {},
    offsetWidth: 120,
    offsetHeight: 36,
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    remove() {
      const p = node.parentElement;
      if (p) {
        const i = p.children.indexOf(node);
        if (i >= 0) p.children.splice(i, 1);
      }
      node.parentElement = null;
    },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = node.listeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    /** 仅支持本插件实际使用的两类查询：.class 与 tag[attr]（含裸 attr 形态由 document 侧处理）。 */
    querySelector(sel) { return deepFind(node.children, sel); },
    getBoundingClientRect() {
      return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
    },
  };
  // DOM 语义：设 textContent 会清空子树（renderPanel 以 textContent="" 重建面板）
  let textValue = "";
  Object.defineProperty(node, "textContent", {
    get: () => textValue,
    set(v) {
      textValue = String(v);
      for (const c of [...node.children]) c.remove();
    },
  });
  return node;
}

function matchSelector(node, sel) {
  const cls = sel.match(/^\.([\w-]+)$/);
  if (cls) return String(node.className || "").split(/\s+/).includes(cls[1]);
  const tagAttr = sel.match(/^([\w-]+)\[(.+?)\]$/);
  if (tagAttr) {
    const [, tag, attr] = tagAttr;
    return node.tagName === tag.toUpperCase() && node.attrs[attr] !== undefined;
  }
  return false;
}

function deepFind(nodes, sel) {
  for (const n of nodes) {
    if (matchSelector(n, sel)) return n;
    const hit = deepFind(n.children ?? [], sel);
    if (hit) return hit;
  }
  return null;
}

// ---- 全局环境安装（模块顶层不触 DOM；apply 之后才会访问）----
const docHead = makeNode("head");
const docBody = makeNode("body");
const convHost = makeNode("main"); // conversationHost() 命中 [data-conversation-scroll]
convHost.attrs["data-conversation-scroll"] = "";
docBody.appendChild(convHost);

globalThis.document = {
  head: docHead,
  body: docBody,
  visibilityState: "visible",
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ nodeName: "#text", textContent: String(t), parentElement: null }),
  addEventListener() {},
  removeEventListener() {},
  querySelector(sel) {
    if (sel.includes("data-conversation-scroll")) return convHost;
    if (sel.includes("data-pane")) return null;
    return deepFind([docHead, docBody], sel);
  },
};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
};
globalThis.EventSource = class {
  constructor(url) { EventSource.lastUrl = url; }
  close() {}
};

// ---- fetch mock：按路由分派并记录（capsuleHtml 携带独特标记供胶囊断言）----
const ROUTES = {
  stats: "/api/dsh-provider-usage/stats",
  history: "/api/dsh-provider-usage/history",
  uiConfig: "/api/dsh-provider-usage/ui-config",
};
const statsCalls = [];
const historyCalls = [];

function statsBody(provider) {
  const mark = provider === "mock-a" ? "MOCK-A" : provider === "mock-b" ? "MOCK-B" : "MOCK-?";
  return {
    plugin: "dsh-provider-usage",
    version: 2,
    provider,
    adapterName: `${mark.toLowerCase().replace("-", "")}-usage`,
    status: "fresh",
    capsuleHtml: `<span>${mark}</span>`,
    ok: true,
    configured: true,
    error: null,
    fetchedAt: Date.now(),
    adapterVersion: 1,
  };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.startsWith(ROUTES.stats)) {
    statsCalls.push(u);
    const provider = new URL(u, "http://x").searchParams.get("provider") ?? "";
    return json(statsBody(provider));
  }
  if (u.startsWith(ROUTES.history)) {
    historyCalls.push(u);
    const provider = new URL(u, "http://x").searchParams.get("provider") ?? "";
    return json({
      ok: true, plugin: "dsh-provider-usage", version: 2, provider,
      adapterName: `${provider}-usage`, panelHtml: `<p data-p="${provider}">panel</p>`, error: null,
      range: { start: Date.now() - 86400000, end: Date.now() },
    });
  }
  if (u.startsWith(ROUTES.uiConfig)) {
    return json({ ok: true, ui: { placement: "top-right", offsetX: 0, offsetY: 48, panelOffsetY: 10 } });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ---- setInterval 收集器：轮询回调由测试手动触发（不真等 60s）----
const intervals = [];
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

// ---------------------------------------------------------------- fake sessions/remote/ctx

function makeFakeServices(initialProvider) {
  const state = {
    listCurrent: "s1",
    byId: { s1: {} },
    // 0.1.2-alpha.2：行携带 per-session modelSelection 投影（lastUsed 为主槽位）
    projectionBySession: { s1: { provider: initialProvider, model: "model-x" } },
  };
  const listSubs = [];
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: state.listCurrent,
        ids: Object.keys(state.byId),
        byId: Object.fromEntries(
          Object.entries(state.byId).map(([id, base]) => {
            const proj = state.projectionBySession[id];
            return [
              id,
              proj === undefined
                ? base
                : { ...base, projections: { values: { modelSelection: { lastUsed: proj } } } },
            ];
          }),
        ),
      }),
      subscribe: (fn) => { listSubs.push(fn); return () => { const i = listSubs.indexOf(fn); if (i >= 0) listSubs.splice(i, 1); }; },
    },
  };
  return {
    state,
    sessions,
    // 0.1.2-alpha.2：ctx.remote 网关（兜底 modelCatalog；剧本主路径走投影，无需兜底命中）
    remote: {
      session: {
        modelCatalog: async () => ({ ok: true, value: { default: { provider: "mock-catalog-default" } } }),
      },
    },
    /** 模拟宿主 publishCurrent：仅切换会话/roster 变化时 fire（#71 已实证边界）。 */
    fireSessionChanged() { for (const fn of [...listSubs]) fn(); },
  };
}

function makeCtx(svc) {
  const disposers = [];
  const ctx = {
    get(key) {
      if (key === "sessions") return svc.sessions;
      if (key === "remote") return svc.remote; // 0.1.2-alpha.2：ctx.remote 网关（兜底 modelCatalog）
      return undefined; // slots 缺席 → settings section try/catch 跳过
    },
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  };
  return { ctx, disposers };
}

/** 轮询等待条件成立（防 flake 纪律：不用固定 sleep 判定）。 */
async function until(cond, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (cond()) return; } catch { /* 条件内部异常继续等到超时 */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`until 超时：${what}`);
}

const pillLabel = () => deepFind([docBody], ".dou-label");
const lastProviderOf = (urls) => {
  const u = urls.at(-1);
  return u === undefined ? undefined : new URL(u, "http://x").searchParams.get("provider");
};

// ---------------------------------------------------------------- 剧本：一个 GUI 生命周期串起全部场景

async function main() {
const svc = makeFakeServices("mock-a");
const { ctx, disposers } = makeCtx(svc);
client.apply(ctx);

// 场景 1：初次挂载——检测先行，首拉即会话实际 provider（FALLBACK 不出现在任何 /stats 请求）
{
  await until(
    () => statsCalls.length > 0 && pillLabel()?.innerHTML.includes("MOCK-A"),
    "初次挂载胶囊出现 MOCK-A",
  );
  assert.ok(
    statsCalls.every((u) => new URL(u, "http://x").searchParams.get("provider") === "mock-a"),
    `首次挂载全部 /stats 请求均为 mock-a（实际 ${JSON.stringify(statsCalls)}）`,
  );
  console.log("[client-revalidate.worker] 场景1 初次挂载直取 mock-a ✓");
}

// 打开面板（qa b3 场景前置）：面板跟随断言需要 floatOpen
{
  const pill = deepFind([docBody], ".dou-float");
  assert.ok(pill, "胶囊已挂载");
  pill.listeners.click[0]();
  assert.ok(deepFind([docBody], ".dou-panel"), "面板已展开");
}

// 场景 2（A1 核心）：会话内切模型 a→b——sessionId/list.current 均不变，宿主信号【不 fire】，
// 手动触发一次轮询回调 → refreshStats 取数前复检 → 使用新 provider
{
  const before = statsCalls.length;
  svc.state.projectionBySession.s1 = { provider: "mock-b", model: "model-x" }; // 会话内切换：行投影 lastUsed 已变
  const pollTimer = intervals.find((t) => t.ms === 60000);
  assert.ok(pollTimer, "60s 轮询定时器已注册");
  pollTimer.fn();

  await until(
    () => lastProviderOf(statsCalls) === "mock-b" && pillLabel()?.innerHTML.includes("MOCK-B"),
    "轮询周期内 refreshStats 自愈到 mock-b",
  );
  const afterSwitch = statsCalls.slice(before);
  assert.ok(
    afterSwitch.every((u) => new URL(u, "http://x").searchParams.get("provider") === "mock-b"),
    `切换后 refreshStats 使用新 provider（实际 ${JSON.stringify(afterSwitch)}）`,
  );
  // 面板同步跟随（旧实现在此滞留旧 provider——qa b3 反证点）
  await until(() => {
    const box = deepFind([docBody], ".dou-charts");
    return box !== null && String(box.innerHTML).includes('data-p="mock-b"');
  }, "面板内容跟随 mock-b");
  console.log("[client-revalidate.worker] 场景2 A1 轮询自愈 a→b（含面板） ✓");
}

// 场景 3（维护者补充需求）：切换会话 s2，provider 相同（mock-b）→ 仍立即刷一次 stats
{
  svc.state.byId.s2 = {};
  svc.state.listCurrent = "s2";
  svc.state.projectionBySession.s2 = { provider: "mock-b", model: "model-x" };
  const before = statsCalls.length;
  svc.fireSessionChanged(); // 宿主信号：切换会话时 fire
  await until(() => statsCalls.length > before, "同 provider 切换会话仍立即刷新 stats");
  assert.equal(lastProviderOf(statsCalls), "mock-b", "同 provider 刷新仍指向 mock-b");
  console.log("[client-revalidate.worker] 场景3 切换会话（同 provider）立即刷 stats ✓");
}

// 场景 4：切换会话 s3 跨 provider（b→a）→ fire 后立即拉新 provider，不等轮询
{
  svc.state.byId.s3 = {};
  svc.state.listCurrent = "s3";
  svc.state.projectionBySession.s3 = { provider: "mock-a", model: "model-x" };
  const before = statsCalls.length;
  svc.fireSessionChanged();
  await until(
    () => lastProviderOf(statsCalls) === "mock-a" && pillLabel()?.innerHTML.includes("MOCK-A"),
    "切换会话跨 provider 立即跟随",
  );
  assert.ok(statsCalls.length > before, "fire 后确有新请求（即时性：非轮询驱动）");
  console.log("[client-revalidate.worker] 场景4 切换会话跨 provider 即时跟随 ✓");
}

// 场景 5：卸载清理不抛错
{
  for (const d of [...disposers].reverse()) {
    try { d(); } catch (error) {
      assert.fail(`卸载清理抛错：${error?.message ?? error}`);
    }
  }
  console.log("[client-revalidate.worker] 场景5 卸载清理 ✓");
}
}

main()
  .then(() => {
    console.log("WORKER-PASS [client-revalidate.worker] 全部断言通过 ✓ (#71 A1)");
  })
  .catch((error) => {
    console.error("[client-revalidate.worker] 断言失败：", error?.message ?? error);
    process.exit(1);
  });
