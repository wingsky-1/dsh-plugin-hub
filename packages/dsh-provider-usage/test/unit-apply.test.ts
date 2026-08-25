// @ts-nocheck
/**
 * dsh-provider-usage — unit：apply 宿主注入路径覆盖。
 *
 * 覆盖：installSettingsNamespace inject 回调全分支（含 isUnloading）、
 * HotReloadableAdapter onReload 回调分支、dispose 清理全分支、
 * sseClients 清理、warmupTimer 清理。
 *
 * 此文件不重复 smoke.ts 已覆盖的 boot/enabled/fence 断言，仅专注
 * 于 smoke 未到达的 apply 内部分支（#82 批次 3）。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { assert } from "./helpers.ts";
import {
  apply,
  ROUTES,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  ADAPTER_CONTRACT_VERSION,
  fetchWithTimeout,
} from "../lib/index.js";

// ---------------------------------------------------------------- 工具：fakeReqs

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    [Symbol.asyncIterator]: async function* () {
      if (typeof overrides.body === "string" && overrides.body !== "") {
        yield Buffer.from(overrides.body);
      }
    },
    ...overrides,
  };
}

function makeRes() {
  const chunks = [];
  let code = 200;
  return {
    writeHead: (c) => { code = c; },
    end: (chunk) => { chunks.push(chunk); },
    write: (chunk) => { chunks.push(chunk); },
    on: () => {},
    _code: () => code,
    _body: () => chunks.map((c) => (typeof c === "string" ? c : String(c))).join(""),
  };
}

// ---------------------------------------------------------------- 存 DSH_HOME
let savedHome;

// ---------------------------------------------------------------- 1) inject 回调：settings 正常注册

{
  const routes = [];
  const settingsEvents = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => {
      const scope = {
        get: () => ({}),
        watch: (fn) => { settingsEvents.push("watch-registered"); },
      };
      const sctx = {
        settings: {
          register: (ns, schema, opts) => {
            settingsEvents.push("register-called");
            return scope;
          },
        },
        effect: (fn) => {
          const disposer = fn();
          settingsEvents.push("effect-registered");
          return typeof disposer === "function" ? disposer : () => {};
        },
      };
      cb(sctx);
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(settingsEvents.includes("register-called"), "settings.register 被调用");
  assert.ok(settingsEvents.includes("effect-registered"), "sctx.effect 被注册");
  assert.ok(settingsEvents.includes("watch-registered"), "scope.watch 被注册");
}

// ---------------------------------------------------------------- 2) inject 回调：settings.register 抛错

{
  const warns = [];
  const routes = [];
  const ctx = {
    logger: { warn: (m) => { warns.push(m); } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => {
      cb({
        settings: { register: () => { throw new Error("duplicate"); } },
        effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
      });
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(warns.some((m) => m.includes("duplicate")), "settings.register 抛错应 warn");
}

// ---------------------------------------------------------------- 3) inject 回调：settings 服务缺 register

{
  const warns = [];
  const routes = [];
  const ctx = {
    logger: { warn: (m) => { warns.push(m); } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => {
      cb({ settings: {} });
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(warns.some((m) => m.includes("register")), "settings 缺 register 应 warn");
}

// ---------------------------------------------------------------- 4) inject 回调：ctx.inject 不可用（已覆盖/无需重复）

// smoke.ts 已有的 apply 用 fake ctx 无 inject → installSettingsNamespace 走
// "ctx.inject 不可用" 分支。本文件不重复。

// ---------------------------------------------------------------- 5) isUnloading 全分支通过 inject 回调覆盖

// 5a) fiber.state = "unloading" → sctx.effect disposer 内 isUnloading 返回 true →
//     disposer 提前 return（setSource 不切回 entry）
{
  const setSourceCalls = [];
  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "unloading" },
    inject: (deps, cb) => {
      const scope = { get: () => ({}), watch: (fn) => {} };
      cb({
        settings: { register: () => scope },
        effect: (fn) => {
          const disposer = fn();
          // 模拟 fiber 卸载时调用 disposer：isUnloading(ctx) 应为 true → 提前 return
          disposer();
          return () => {};
        },
      });
    },
    effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
  };
  await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  // setSource 应该在 register 成功后被设为 () => scope.get()，但 disposer 内
  // isUnloading=true 时不会切回 entry。此处纯验证不抛错。
  assert.ok(true, "isUnloading=true 分支不抛错");
}

// 5b) fiber.state = "disposed" → 同 unloading 分支
{
  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "disposed" },
    inject: (deps, cb) => {
      const scope = { get: () => ({}), watch: (fn) => {} };
      cb({
        settings: { register: () => scope },
        effect: (fn) => {
          const disposer = fn();
          disposer();
          return () => {};
        },
      });
    },
    effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
  };
  await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(true, "isUnloading=disposed 分支不抛错");
}

// ---------------------------------------------------------------- 6) HotReloadableAdapter onReload 回调全分支

// 6a) 合法用户适配器文件 → onReload ok:true → hr.current !== null → full branch
{
  const dir = mkdtempSync(join(tmpdir(), "dou-hr-"));
  const goodFile = join(dir, "good.mjs");
  writeFileSync(goodFile, `
export const version = 2;
export const name = "hr-test";
export const label = "HR Test";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>ok</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => { cb({ settings: {} }); },
    effect: (fn) => {
      const d = fn();
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { adapter: goodFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(true, "HotReload ok:true 分支不抛错");
}

// 6b) 非法适配器文件 → onReload ok:false → !info.ok 分支
{
  const dir = mkdtempSync(join(tmpdir(), "dou-hr-bad-"));
  const badFile = join(dir, "bad.mjs");
  writeFileSync(badFile, `export const version = 2; export const name = "bad";`, "utf8");

  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => { cb({ settings: {} }); },
    effect: (fn) => {
      const d = fn();
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { adapter: badFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  assert.ok(true, "HotReload ok:false 分支不抛错");
}

// ---------------------------------------------------------------- 7) dispose 清理全分支（含 hotReloaders + sseClients）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-dispose-"));
  const goodFile = join(dir, "dispose.mjs");
  writeFileSync(goodFile, `
export const version = 2;
export const name = "dispose-test";
export const label = "Dispose";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>ok</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

  const disposers = [];
  const errors = [];
  const routes = [];

  // 先订阅 SSE（使 sseClients 有成员）
  const eventsRoute = { path: ROUTES.events };
  // 外部收集 disposer
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
    },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => { cb({ settings: {} }); },
    effect: (fn) => {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return d;
    },
  };
  await apply(ctx, { adapter: goodFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });

  // 订阅 SSE（通过 events 路由 handler 添加 SSE 客户端）
  const evRoute = routes.find((r) => r.path === ROUTES.events);
  assert.ok(evRoute, "events 路由存在");
  let sseRes;
  evRoute.handler(fakeReq({ method: "GET" }), {
    writeHead: (code, headers) => {},
    write: (chunk) => {},
    on: (evt, cb) => { if (evt === "close") sseRes = { close: cb }; },
  });

  // 执行所有 disposer（包括内层 ctx.effect 的 disposer）
  for (const d of disposers) {
    if (typeof d === "function") d();
  }

  assert.ok(true, "dispose 全分支不抛错");
}

// ---------------------------------------------------------------- 8) 确保 warmupTimer 被清理（disposer 中）

{
  const disposers = [];
  const routes = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    llm: { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps, cb) => { cb({ settings: {} }); },
    effect: (fn) => {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  };
  await apply(ctx, { warmupIntervalMs: 60000, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  for (const d of disposers) {
    if (typeof d === "function") d();
  }
  assert.ok(true, "warmupTimer 清理不抛错");
}
// ================================================================ #150 二阶段：apply 内部数据面与路由分支

import { existsSync, readFileSync, readdirSync } from "node:fs";

/** 构造标准 fake ctx：收集路由与 disposer。 */
function makeCtx(over: {
  llm?: unknown;
} = {}) {
  const routes: Array<Record<string, unknown>> = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route: Record<string, unknown>) { routes.push(route); return () => {}; } },
    llm: over.llm !== undefined ? over.llm : { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps: unknown, cb: (s: unknown) => void) => { cb({ settings: {} }); },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d as () => void);
      return typeof d === "function" ? d : () => {};
    },
  };
  return { ctx, routes, disposers };
}

/** 合法用户适配器 mjs 文本。 */
function adapterMjs(name: string, body = "{ v: 1 }"): string {
  return `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = ${JSON.stringify(name)};
export const label = ${JSON.stringify(name)};
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return ${body}; }
export function formatCapsule() { return "<span>${name}</span>"; }
export function formatPanel() { return "<p>${name}</p>"; }
`;
}

/** 轮询直到条件成立或超时（防 flake：不使用固定 sleep 判定）。 */
async function pollUntil(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

const routeOf = (routes: Array<Record<string, unknown>>, path: string) =>
  routes.find((r) => r.path === path) as { handler: (req: unknown, res: unknown) => Promise<void> | void } | undefined;

// ---------------------------------------------------------------- stats/history 路由围栏与数据面

{
  const dir = mkdtempSync(join(tmpdir(), "dou-stats-"));
  const goodFile = join(dir, "good.mjs");
  writeFileSync(goodFile, adapterMjs("stats-adp"), "utf8");
  const { ctx, routes } = makeCtx();
  await apply(ctx, {
    adapter: goodFile, autoReload: false,
    apiKey: "sk", apiEndpoint: "http://127.0.0.1:9",
    historyDir: join(dir, "hist"),
  });

  // stats：403 非 loopback / 405 非 GET
  const stats = routeOf(routes, ROUTES.stats);
  assert.ok(stats, "stats 路由已注册");
  const res403 = makeRes();
  await stats.handler(fakeReq({ headers: { host: "evil.example" } }), res403);
  assert.equal(res403._code(), 403, "stats 非 loopback 403");
  const res405 = makeRes();
  await stats.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(res405._code(), 405, "stats POST 405");

  // history：403 / 405 / 无候选 no-adapter / days clamp
  const historyR = routeOf(routes, ROUTES.history);
  assert.ok(historyR, "history 路由已注册");
  const h403 = makeRes();
  await historyR.handler(fakeReq({ headers: { host: "x" } }), h403);
  assert.equal(h403._code(), 403, "history 非 loopback 403");

  // 无启用适配器（清空选择后）→ 结构化 no-adapter
  const hNoAdp = makeRes();
  await historyR.handler(fakeReq({ url: `${ROUTES.history}?provider=ghost` }), hNoAdp);
  const noAdpBody = JSON.parse(hNoAdp._body());
  assert.equal(noAdpBody.reason, "no-adapter", "无候选 provider 报 no-adapter");
  assert.equal(noAdpBody.panelHtml, null, "无候选不带占位 HTML");

  // days 参数：合法窗口取 min(days, maxAgeDays)
  const hDays = makeRes();
  await historyR.handler(fakeReq({ url: `${ROUTES.history}?days=7` }), hDays);
  const okBody = JSON.parse(hDays._body());
  assert.equal(okBody.plugin, "dsh-provider-usage", "history 正常响应 plugin 字段");
  assert.equal(okBody.adapterName, "stats-adp", "用户适配器注册后默认成为启用者");
  assert.equal(typeof okBody.range.start, "number", "range.start 数字");
}

// ---------------------------------------------------------------- getStats：缓存命中 / busy / 未配置

{
  const dir = mkdtempSync(join(tmpdir(), "dou-getstats-"));
  // 隔离 DSH_HOME：避免读到真实环境的 user-adapters.json / adapter-state.json，
  // 否则启动预热会对真实适配器逐个取数（每个最长 fetchTimeoutMs）长期持锁。
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "dshhome");
  mkdirSync(process.env.DSH_HOME, { recursive: true });
  try {
    // fetchData 带 IO 延迟（80ms）的适配器：为 busy 竞争提供持锁窗口
    const slowFile = join(dir, "slow.mjs");
    writeFileSync(slowFile, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "slow-adp";
export const providers = ["prov-slow"];
export async function fetchData() {
  await new Promise((r) => setTimeout(r, 80));
  return { v: 42 };
}
export function formatCapsule() { return "<span>s</span>"; }
export function formatPanel() { return "<p>s</p>"; }
`, "utf8");
    const { ctx, routes } = makeCtx();
    await apply(ctx, {
      adapter: slowFile, autoReload: false,
      apiKey: "sk", apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });
    const stats = routeOf(routes, ROUTES.stats) as { handler: (req: unknown, res: unknown) => Promise<void> };
    const selectR = routeOf(routes, ROUTES.select) as { handler: (req: unknown, res: unknown) => Promise<void> };
    const clearCache = async (): Promise<void> => {
      // select 成功路径自带 cache.clear()：清空再重启用，两次都触发清空
      await selectR.handler(fakeReq({ method: "POST", body: JSON.stringify({ provider: "prov-slow", adapterName: null }) }), makeRes());
      await selectR.handler(fakeReq({ method: "POST", body: JSON.stringify({ provider: "prov-slow", adapterName: "slow-adp" }) }), makeRes());
    };
    const askStats = async (): Promise<Record<string, unknown>> => {
      const r = makeRes();
      await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=prov-slow` }), r);
      return JSON.parse(r._body()) as Record<string, unknown>;
    };

    // 确定性等待启动预热结束：warmup 对 enabledProviders 串行取数，内置
    // opencode-go 走真实网络（最长 fetchTimeoutMs=2000ms），prov-slow 是最后一个。
    // 轮询中遇到 cached 即证明预热已对 prov-slow 写入缓存（整条链必然走完）；
    // 遇到 busy 继续等；cached 出现后清缓存，随后的请求必为 fresh 且无飞行任务。
    const deadline = Date.now() + 20000;
    let warmed = false;
    while (Date.now() < deadline) {
      const b = await askStats();
      if (b.reason === "busy") { await new Promise((r2) => setTimeout(r2, 40)); continue; }
      warmed = true; // cached 或 fresh：预热已完成 prov-slow（链尾）
      break;
    }
    assert.equal(warmed, true, "启动预热在时限内完成");
    await clearCache();

    // 第一次取数：fresh + 历史落盘（此时无任何后台取数干扰）
    const b1 = await askStats();
    assert.equal(b1.status, "fresh", "清缓存后首次取数 fresh");
    assert.equal(b1.capsuleHtml, "<span>s</span>", "胶囊来自适配器");
    const histDir = join(dir, "hist", "prov-slow", "slow-adp");
    const landed = await pollUntil(() => existsSync(histDir) && readdirSync(histDir).length > 0);
    assert.equal(landed, true, "fresh 数据落盘历史 JSONL");

    // 第二次：缓存命中（TTL 内）
    const b2 = await askStats();
    assert.equal(b2.status, "cached", "TTL 内二次请求 cached");

    // busy：清缓存后发起长取数（fetchData 80ms），15ms 后并发同 provider 请求：
    // 无缓存 + 锁忙 → reason=busy stale。此刻 warmup 已结束、60s 内不会重启，
    // 竞争窗口完全由测试控制。
    await clearCache();
    const pFirst = stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=prov-slow` }), makeRes());
    void pFirst.catch(() => {});
    await new Promise((r2) => setTimeout(r2, 15)); // 让首个请求进入 runExclusive 并持锁
    const bBusy = await askStats();
    assert.equal(bBusy.reason, "busy", "锁内并发请求报 busy");
    assert.equal(bBusy.status, "stale", "busy 响应状态 stale");
    assert.equal(bBusy.configured, true, "busy ≠ 未配置");
    assert.equal(bBusy.adapterName, "slow-adp", "busy 响应携带目标 provider 启用适配器名");
    await pFirst;

    // no-enabled-adapter：候选存在但被显式清空（select 清空后 cache.clear()）
    await selectR.handler(fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: "prov-slow", adapterName: null }),
    }), makeRes());
    const bNoEn = await askStats();
    assert.equal(bNoEn.reason, "no-enabled-adapter", "候选存在但清空启用报 no-enabled-adapter");
    assert.equal(bNoEn.ok, false, "未配置语义 ok=false");
    assert.equal(bNoEn.configured, false, "configured=false");
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
}

// ---------------------------------------------------------------- fetchWithTimeout 边界（#150 二阶段）

// 本文件是 tap 流程最后一个模块：fetchWithTimeout 硬编码读取全局 fetch，
// 注入窗口必须放在不会再被后续模块 TLA 恢复改写的位置（此前置于 unit-contract，
// 其 TLA 让 v1 先行求值并在注入窗口内改写全局 fetch，实证互相污染）。
{
  const savedFetch = globalThis.fetch;
  try {
    // 快路径：远小于超时的延迟 -> 正常拿到注入实现的返回值
    let fastCalls = 0;
    globalThis.fetch = (async (url: unknown, opts: { signal?: AbortSignal }) => {
      fastCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, ok: true, url, aborted: opts?.signal?.aborted ?? null };
    }) as unknown as typeof fetch;
    const okRes = await fetchWithTimeout("https://gw.test/fast", 1000);
    assert.equal((okRes as unknown as { status: number }).status, 200, "快路径返回注入实现的响应");
    // 计数只作下界断言：飞行中的外部异步可能泄漏进窗口调用全局 fetch（绝对计数实证 flake）
    assert.ok(fastCalls >= 1, "快路径到达注入 fetch 至少一次");
    assert.equal(
      (okRes as unknown as { url: string }).url,
      "https://gw.test/fast",
      "url 原样透传到 fetch",
    );

    // 慢路径：超过 timeoutMs 的延迟 -> 返回时已观察到 abort
    // （delayMs 远大于 timeoutMs=20：防微任务风暴推迟 abort 定时器）
    let slowCalls = 0;
    globalThis.fetch = (async (_url: unknown, opts: { signal?: AbortSignal } | undefined) => {
      slowCalls += 1;
      await new Promise((r) => setTimeout(r, 500));
      return { status: 200, ok: true, aborted: opts?.signal?.aborted ?? null };
    }) as unknown as typeof fetch;
    const slowRes = await fetchWithTimeout("https://gw.test/slow", 20);
    assert.ok(slowCalls >= 1, "慢路径到达注入 fetch 至少一次");
    assert.equal((slowRes as unknown as { aborted: boolean }).aborted, true,
      "超过 timeoutMs 后 controller.abort 已触发");

    // 默认参数形态：省略 timeoutMs 与 init 仍完成调用
    let defCalls = 0;
    globalThis.fetch = (async () => { defCalls += 1; return { status: 204 }; }) as unknown as typeof fetch;
    await fetchWithTimeout("https://gw.test/def");
    assert.equal(defCalls, 1, "默认参数下仍走 fetch");
  } finally {
    globalThis.fetch = savedFetch;
  }
}
