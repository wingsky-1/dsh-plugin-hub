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
console.error("EVAL-ORDER-TAG: APPLY");
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { assert, injectGlobalFetch } from "./helpers.ts";
import {
  apply,
  ROUTES,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  ADAPTER_CONTRACT_VERSION,
  fetchWithTimeout,
  userAdaptersFile,
  adapterStateFile,
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

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";

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

// ---------------------------------------------------------------- #301：apply 内部恢复隔离坏状态且诊断单次可见

{
  const dir = mkdtempSync(join(tmpdir(), "dou-state-301-quarantine-apply-"));
  const historyDir = join(dir, "history");
  mkdirSync(historyDir, { recursive: true });
  const stateFile = adapterStateFile(historyDir);
  const cases = [
    { raw: "{broken", marker: "JSON 损坏" },
    { raw: '["not","a","mapping"]', marker: "顶层结构无效" },
  ];
  const backups: string[] = [];
  for (const entry of cases) {
    writeFileSync(stateFile, entry.raw, "utf8");
    const { ctx, routes, disposers } = makeCtx();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await apply(ctx, {
        autoReload: false,
        apiKey: "sk-test",
        apiEndpoint: "http://127.0.0.1:9",
        historyDir,
      });
    } finally {
      console.warn = originalWarn;
    }

    const health = routes.find((route) => route.path === ROUTES.health) as { handler: (req: unknown, res: unknown) => void };
    const response = makeRes();
    health.handler(fakeReq(), response);
    const errors = (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> }).errors ?? [];
    assert.equal(warnings.filter((line) => line.includes(entry.marker)).length, 1,
      `${entry.marker} 恰好输出一次 console.warn`);
    assert.ok(errors.some((error) => error.key === "adapter-state" && error.message.includes(entry.marker)),
      `${entry.marker} 同时进入 health 诊断`);
    assert.equal(existsSync(stateFile), false, `${entry.marker} 原文件已移出恢复路径`);
    const backup = readdirSync(historyDir)
      .filter((name) => name.startsWith("adapter-state.json.bak-"))
      .find((name) => !backups.includes(name) && readFileSync(join(historyDir, name), "utf8") === entry.raw);
    assert.ok(backup !== undefined, `${entry.marker} 原文完整保留在新取证备份`);
    backups.push(backup ?? "missing");
    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
  }
  for (const [index, backup] of backups.entries()) {
    assert.equal(readFileSync(join(historyDir, backup), "utf8"), cases[index]?.raw, "全部取证备份最终均保留");
  }
}

// ---------------------------------------------------------------- #301：恢复缺失候选可见 + 写入失败可见且串行链可恢复

{
  const dir = mkdtempSync(join(tmpdir(), "dou-state-301-apply-"));
  const historyDir = join(dir, "history");
  mkdirSync(historyDir, { recursive: true });
  const stateFile = adapterStateFile(historyDir);
  writeFileSync(stateFile, JSON.stringify({ "ghost-provider": "missing-adapter" }), "utf8");

  const { ctx, routes, disposers } = makeCtx();
  const restoreWarnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { restoreWarnings.push(args.map(String).join(" ")); };
  try {
    await apply(ctx, {
      autoReload: false,
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir,
    });
  } finally {
    console.warn = originalWarn;
  }
  const health = routes.find((route) => route.path === ROUTES.health) as { handler: (req: unknown, res: unknown) => void };
  const select = routes.find((route) => route.path === ROUTES.select) as { handler: (req: unknown, res: unknown) => Promise<void> };
  const healthErrors = (): Array<{ key: string; message: string }> => {
    const response = makeRes();
    health.handler(fakeReq(), response);
    return (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> }).errors ?? [];
  };

  assert.ok(healthErrors().some((entry) =>
    entry.key === "adapter-state" && entry.message.includes("missing-adapter") && entry.message.includes("不在当前候选")),
  "启动恢复 select(false) 进入 health 诊断，不再静默回退默认启用者");
  assert.equal(restoreWarnings.filter((line) =>
    line.includes("missing-adapter") && line.includes("不在当前候选")).length, 1,
  "启动恢复 select(false) 恰好输出一次 console.warn，避免重复诊断");

  // 成功路径：发布物实际调度链写出合法 JSON、无 tmp 残留，POSIX 权限为 0600。
  let response = makeRes();
  await select.handler(fakeReq({
    method: "POST",
    body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
  }), response);
  const persisted = await pollUntil(() => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
    } catch { return false; }
  });
  assert.equal(persisted, true, "select 经串行链原子写入新的启用选择");
  assert.deepEqual(readdirSync(historyDir).filter((name) => name.endsWith(".tmp")), [], "成功写入无 tmp 残留");
  if (process.platform !== "win32") {
    assert.equal(statSync(stateFile).mode & 0o777, 0o600, "POSIX 状态文件权限为 0600");
  }

  rmSync(stateFile, { force: true });
  mkdirSync(stateFile); // 旧状态读取稳定报 EISDIR，构造 fail-closed 的持久化错误
  response = makeRes();
  const writeErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { writeErrors.push(args.map(String).join(" ")); };
  let surfaced = false;
  try {
    await select.handler(fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
    }), response);
    assert.equal(response._code(), 200, "运行期 select 内存切换仍成功响应");
    surfaced = await pollUntil(() => healthErrors().some((entry) =>
      entry.key === "adapter-state" && entry.message.includes("启用选择落盘失败")));
  } finally {
    console.error = originalError;
  }
  assert.equal(surfaced, true, "异步写盘失败进入 health 诊断（同时由宿主 console.error 输出）");
  assert.equal(writeErrors.filter((line) => line.includes("启用选择落盘失败")).length, 1,
    "每次失败写入恰好输出一次 console.error");

  rmSync(stateFile, { recursive: true, force: true });
  response = makeRes();
  await select.handler(fakeReq({
    method: "POST",
    body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
  }), response);
  const recovered = await pollUntil(() => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
    } catch { return false; }
  });
  assert.equal(recovered, true, "一次持久化失败不会毒化串行链，修复文件系统后后续选择可成功落盘");

  for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
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

// ---------------------------------------------------------------- getStats：跨 provider 并行 / 锁内二次校验 / 未配置

{
  const dir = mkdtempSync(join(tmpdir(), "dou-getstats-"));
  // 隔离 DSH_HOME：避免读到真实环境的 user-adapters.json / adapter-state.json
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "dshhome");
  mkdirSync(process.env.DSH_HOME, { recursive: true });
  try {
    // 两个用户适配器（providers 互不相同）：
    // - slow：80ms IO 延迟 + 调用计数（seq 经返回数据透出、formatCapsule 渲染）——
    //   提供「全程仅一次真实取数」的证据载体；
    // - fast：60ms 延迟 + 起止时间戳写 globalThis 探针——提供跨 provider 并行的窗口证据。
    const slowFile = join(dir, "slow.mjs");
    writeFileSync(slowFile, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "slow-adp";
export const providers = ["prov-slow"];
let calls = 0;
export async function fetchData() {
  calls += 1;
  const probe = (globalThis.__pp120 ??= []);
  probe.push({ n: "A", t: Date.now(), k: "s", seq: calls });
  await new Promise((r) => setTimeout(r, 80));
  probe.push({ n: "A", t: Date.now(), k: "e" });
  return { v: calls };
}
export function formatCapsule(input) { return "<span>" + input.data.v + "</span>"; }
export function formatPanel() { return "<p>s</p>"; }
`, "utf8");
    const fastFile = join(dir, "fast.mjs");
    writeFileSync(fastFile, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "fast-adp";
export const providers = ["prov-fast"];
export async function fetchData() {
  const probe = (globalThis.__pp120 ??= []);
  probe.push({ n: "B", t: Date.now(), k: "s" });
  await new Promise((r) => setTimeout(r, 60));
  probe.push({ n: "B", t: Date.now(), k: "e" });
  return { v: 7 };
}
export function formatCapsule(input) { return "<span>" + input.data.v + "</span>"; }
export function formatPanel() { return "<p>f</p>"; }
`, "utf8");
    // 清单写入 historyRoot（本块显式传了 historyDir → user-adapters.json 从那里读取）
    mkdirSync(join(dir, "hist"), { recursive: true });
    writeFileSync(userAdaptersFile(join(dir, "hist")), JSON.stringify({
      adapters: [
        { id: "slow-adp", label: "Slow", providers: ["prov-slow"], file: slowFile },
        { id: "fast-adp", label: "Fast", providers: ["prov-fast"], file: fastFile },
      ],
    }), "utf8");
    delete globalThis.__pp120;
    const { ctx, routes, disposers } = makeCtx();
    await apply(ctx, {
      autoReload: false,
      apiKey: "sk", apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });
    const stats = routeOf(routes, ROUTES.stats) as { handler: (req: unknown, res: unknown) => Promise<void> };
    const selectR = routeOf(routes, ROUTES.select) as { handler: (req: unknown, res: unknown) => Promise<void> };
    const askStats = async (provider: string): Promise<Record<string, unknown>> => {
      const r = makeRes();
      await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${provider}` }), r);
      return JSON.parse(r._body()) as Record<string, unknown>;
    };

    // 场景1 跨 provider 并行 + 场景2 锁内二次校验（#120）：启动预热对各启用 provider
    // 并行 fire-and-forget（各持各的 per-provider 锁）；紧随其后发起的两个客户端请求
    // 在各自 provider 锁上排队，首个取数完成写缓存后经锁内二次 cacheFresh 校验命中，
    // 全程仅 1 次真实取数（旧全局锁下 fast 必须等 slow 80ms 完成才能开始，且并发者
    // 只能拿 busy 占位帧）。
    const pFast = askStats("prov-fast");
    const pSlow = askStats("prov-slow");
    const [bFast, bSlow] = await Promise.all([pFast, pSlow]);

    // 场景1 断言：slow/fast 取数时间窗重叠 = 无全局队头阻塞
    const probe = (globalThis.__pp120 ?? []) as Array<{ n: string; t: number; k: string; seq?: number }>;
    const win = (n: string): { s: number; e: number } => ({
      s: probe.find((e) => e.n === n && e.k === "s")?.t ?? Number.NaN,
      e: probe.find((e) => e.n === n && e.k === "e")?.t ?? Number.NaN,
    });
    const wa = win("A");
    const wb = win("B");
    assert.ok(!Number.isNaN(wa.s) && !Number.isNaN(wb.s), "两适配器探针成对出现");
    assert.ok(Math.max(wa.s, wb.s) < Math.min(wa.e, wb.e),
      `slow/fast 取数窗口重叠（A=${wa.s}-${wa.e} B=${wb.s}-${wb.e}）——跨 provider 并行取数`);

    // 场景2 断言：并发请求命中锁内二次校验缓存（复用首次结果，fetchData 全程仅一次）
    assert.equal(bSlow.status, "cached", `并发同 provider 请求复用缓存（实际 ${bSlow.status}）`);
    assert.equal(bSlow.capsuleHtml, "<span>1</span>",
      "capsuleHtml 显示 v=1——预热+2 并发客户端共 3 次请求仅触发 1 次真实取数（无 check-then-act 双取）");
    assert.notEqual(bSlow.reason, "busy", "#120 后 busy 短路语义废除，排队者拿真数据帧");
    assert.equal(bFast.status, "cached", "另一 provider 的并发请求同样命中二次校验");
    assert.equal(bFast.capsuleHtml, "<span>7</span>", "fast 数据保真");
    const seqs = probe.filter((e) => e.n === "A" && e.k === "s").map((e) => e.seq);
    assert.equal(seqs.length, 1, `slow.fetchData 仅执行一次（实际 ${seqs.length} 次）`);

    // 场景3 fresh 产物落盘历史（fresh 语义经落盘侧验证）
    const histDir = join(dir, "hist", "prov-slow", "slow-adp");
    const landed = await pollUntil(() => existsSync(histDir) && readdirSync(histDir).length > 0);
    assert.equal(landed, true, "fresh 数据落盘历史 JSONL");

    // 场景4 no-enabled-adapter：候选存在但被显式清空（select 清空路径，clearing 不预热）
    await selectR.handler(fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: "prov-slow", adapterName: null }),
    }), makeRes());
    const bNoEn = await askStats("prov-slow");
    assert.equal(bNoEn.reason, "no-enabled-adapter", "候选存在但清空启用报 no-enabled-adapter");
    assert.equal(bNoEn.ok, false, "未配置语义 ok=false");
    assert.equal(bNoEn.configured, false, "configured=false");

    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
}

// ---------------------------------------------------------------- fetchWithTimeout 边界（#150 二阶段）

// fetchWithTimeout 边界（#150 二阶段）

// 注入窗口纪律：fetchWithTimeout 硬编码读取全局 fetch。经 injectGlobalFetch
// 串行通道（#120）与其他模块的注入窗口互斥，save/restore 恒配对——ESM TLA
// 交错下不再可能把他人 mock 固化为「现场」（unit-v1 慢路径 × 本窗口交错驻留实证）。
{
  await injectGlobalFetch(async (set) => {
    // 快路径：远小于超时的延迟 -> 正常拿到注入实现的返回值
    let fastCalls = 0;
    set(async (url: unknown, opts: { signal?: AbortSignal }) => {
      fastCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, ok: true, url, aborted: opts?.signal?.aborted ?? null };
    });
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
    set(async (_url: unknown, opts: { signal?: AbortSignal } | undefined) => {
      slowCalls += 1;
      await new Promise((r) => setTimeout(r, 500));
      return { status: 200, ok: true, aborted: opts?.signal?.aborted ?? null };
    });
    const slowRes = await fetchWithTimeout("https://gw.test/slow", 20);
    assert.ok(slowCalls >= 1, "慢路径到达注入 fetch 至少一次");
    assert.equal((slowRes as unknown as { aborted: boolean }).aborted, true,
      "超过 timeoutMs 后 controller.abort 已触发");

    // 默认参数形态：省略 timeoutMs 与 init 仍完成调用
    // （与 fast/slow 同理用下界断言：飞行中的外部异步可能泄漏进窗口调用全局 fetch）
    let defCalls = 0;
    set(async () => { defCalls += 1; return { status: 204 }; });
    await fetchWithTimeout("https://gw.test/def");
    assert.ok(defCalls >= 1, "默认参数下仍走 fetch 至少一次");
  });
}
