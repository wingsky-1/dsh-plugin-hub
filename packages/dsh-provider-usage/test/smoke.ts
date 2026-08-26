// @ts-nocheck
/**
 * dsh-provider-usage — 宿主端冒烟测试·集成区（v2 重构版，fake ctx + 注入，无网络）。
 *
 * 覆盖：
 * - apply：enabled:false 不注册；注册四路由（stats/history/health/adapter.mjs）
 * - 全路由 403（非回环）/ 405（方法错）围栏
 * - /stats v2 响应形状（capsuleHtml / status / adapterVersion）
 * - /history v2 响应形状（panelHtml / range）
 * - /health 快照形状
 * - 客户端 bundle 契约面与路由一致性
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// 纯函数断言区先行执行（无 @ts-nocheck、强类型）
import "./smoke-pure.ts";

// 结构化单元测试（#83 阶段一：对齐 notifier 的 unit-*.test.ts 样板）
import "./unit-contract.test.ts";
import "./unit-config.test.ts";
import "./unit-history.test.ts";
import "./unit-v1.test.ts";
import "./unit-apply.test.ts";
import "./unit-detect.test.ts";
import "./unit-refresh-revalidate.test.ts";
import "./unit-deepseek-official.test.ts";

import {
  apply,
  ROUTES,
  ADAPTER_CONTRACT_VERSION,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_ADAPTER_ID,
  userAdaptersFile,
  adapterStateFile,
  PANEL_CACHE_TTL_MS,
  normalizeRangeDay,
  panelCacheKey,
  isPanelCacheStale,
} from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// 全局隔离（红线）：apply 一律落在临时 DSH_HOME，绝不触碰真实 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-home-"));

// 网络隔离（红线）：清掉可能存在于真实环境的密钥变量，防内置适配器发起真实请求；
// 测试结束后恢复（#198：deepseek 系列密钥一并清空——T2 无真实凭据纪律）。
const SAVED_ENV_KEYS = ["OPENCODE_GO_API_KEY", "OPENCODE_GO_PROVIDER_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_OFFICIAL_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};
for (const k of SAVED_ENV_KEYS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
process.env.OPENCODE_GO_API_KEY_TEST_ABSENT = "1";

// 隔离配置：显式 key（优先级最高，阻断 auth.json/env 真实凭据读取）+
// 不可达回环地址（无外呼，快速 network 失败）。所有 apply 用例必须携带。
const ISOLATED_CONFIG = { apiKey: "sk-smoke-test", apiEndpoint: "http://127.0.0.1:9" };

// ---------------------------------------------------------------- fake ctx + apply

function fakeReq(overrides = {}) {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    // readJsonBody 用 for await 读 body：提供 async-iterator 桩
    [Symbol.asyncIterator]: async function* () {
      if (typeof overrides.body === "string" && overrides.body !== "") {
        yield Buffer.from(overrides.body);
      }
      // 无 body 或空 → 直接结束（readJsonBody 得到空 → JSON.parse 抛 → 400）
    },
    ...overrides,
  };
  return req;
}

function makeFakeCtx(overrides = {}) {
  const routes = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    llm: {
      listProviders() {
        return [
          { id: "anthropic", name: "Anthropic" },
          { id: OPENCODE_GO_PROVIDER, name: "OpenCode Go" },
        ];
      },
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, routes };
}

// ---------------------------------------------------------------- enabled 开关

{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { enabled: false });
  assert.equal(routes.length, 0, "enabled:false 不注册任何路由");
}

// ---------------------------------------------------------------- 注册九路由

{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [ROUTES.health, ROUTES.history, ROUTES.stats, ROUTES.adapters, ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig, ROUTES.events].sort(),
    "注册九条路由（stats/history/adapters.json/select/inspect/add/health/ui-config/events）",
  );
  assert.ok(routes.every((r) => r.kind === "exact" || r.kind === "prefix"), "路由 kind 合法");
}

// ---------------------------------------------------------------- 围栏：403 / 405

const POST_ROUTES = new Set([ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig]);
for (const routePath of [ROUTES.stats, ROUTES.history, ROUTES.health, ROUTES.adapters, ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig, ROUTES.events]) {
  {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    const route = routes.find((r) => r.path === routePath);
    assert.ok(route, `${routePath} 路由存在`);

    // 非回环 → 403
    const responses403 = [];
    const res403 = { writeHead: () => {}, end: (chunk) => responses403.push(JSON.parse(chunk)) };
    route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res403);
    assert.equal(responses403.at(-1)?.error, "forbidden: loopback-only", `${routePath} 非回环 403`);

    // 方法错 → 405（POST 路由用 DELETE 触发；GET 路由用 POST 触发）
    const wrongMethod = POST_ROUTES.has(routePath) ? "DELETE" : "POST";
    const responses405 = [];
    const res405 = { writeHead: (code) => { responses405.push({ __code: code }); }, end: () => {} };
    route.handler(fakeReq({ method: wrongMethod }), res405);
    assert.equal(responses405.at(-1)?.__code, 405, `${routePath} 非 ${POST_ROUTES.has(routePath) ? "POST" : "GET"} 405`);
  }
}

// ---------------------------------------------------------------- ui-config / events

{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  const uiRoute = routes.find((r) => r.path === ROUTES.uiConfig);
  const evRoute = routes.find((r) => r.path === ROUTES.events);
  assert.ok(uiRoute !== undefined && evRoute !== undefined, "ui-config/events 路由存在");

  // GET 返回默认配置
  let payload;
  uiRoute.handler(fakeReq({ method: "GET" }), {
    writeHead: () => {},
    end: (chunk) => { payload = JSON.parse(chunk); },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(payload.ok, true, "ui-config GET ok");
  assert.equal(payload.ui.placement, "top-right", "默认 placement top-right");

  // POST 保存：非法 placement 回退默认、offset clamp、落盘 ui.json
  let postPayload;
  uiRoute.handler(
    fakeReq({
      method: "POST",
      body: JSON.stringify({ placement: "middle", offsetX: 99999, offsetY: -5, panelOffsetY: 10 }),
    }),
    {
      writeHead: () => {},
      end: (chunk) => { postPayload = JSON.parse(chunk); },
    },
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(postPayload.ok, true, "ui-config POST ok");
  assert.equal(postPayload.ui.placement, "top-right", "非法 placement 回退默认");
  assert.equal(postPayload.ui.offsetX, 2000, "offsetX clamp 2000");
  assert.equal(postPayload.ui.offsetY, 0, "offsetY clamp 0");
  assert.equal(postPayload.ui.panelOffsetY, 10, "panelOffsetY 透传");
  // #128：POST 缺省 zIndexBase 归一化为默认 40
  assert.equal(postPayload.ui.zIndexBase, 40, "#128 zIndexBase 缺省归一化默认 40");

  // ui.json 已落盘（DSH_HOME 隔离目录内）
  const uiFile = join(process.env.DSH_HOME, "dsh-provider-usage", "ui.json");
  assert.ok(existsSync(uiFile), "ui.json 已落盘");
  const stored = JSON.parse(readFileSync(uiFile, "utf8"));
  assert.equal(stored.placement, "top-right", "落盘值已归一化");
  assert.equal(stored.zIndexBase, 40, "#128 落盘 ui.json 含归一化 zIndexBase");
}

// ---------------------------------------------------------------- /stats v2 响应
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  // 等待启动预热完成（避免命中"锁忙"降级分支）
  await new Promise((r) => setTimeout(r, 300));
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let payload;
  const res = {
    writeHead: () => {},
    end: (chunk) => { payload = JSON.parse(chunk); },
  };
  stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }), res);
  // 等待 async handler 完成
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(payload.plugin, "dsh-provider-usage");
  assert.equal(payload.version, ADAPTER_CONTRACT_VERSION, "响应带契约版本 v2");
  assert.equal(payload.provider, OPENCODE_GO_PROVIDER);
  assert.equal(payload.adapterName, OPENCODE_GO_ADAPTER_ID, "内置适配器名");
  assert.ok(["fresh", "cached", "stale"].includes(payload.status), `status 合法（实际 ${payload.status}）`);
  assert.ok(typeof payload.adapterVersion === "number", "响应带 adapterVersion");
  // 不可达端点 → network 错误，但不崩溃（纪律1：只降级）
  assert.equal(payload.ok, false);
  assert.ok(payload.error !== null && payload.error !== undefined, `错误态应有 error 字段（实际 ${JSON.stringify(payload.error)}）`);
}

// ---------------------------------------------------------------- /history v2 响应

{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  let payload;
  const res = {
    writeHead: () => {},
    end: (chunk) => { payload = JSON.parse(chunk); },
  };
  historyRoute.handler(fakeReq({ url: `${ROUTES.history}?provider=${OPENCODE_GO_PROVIDER}&days=7` }), res);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(payload.plugin, "dsh-provider-usage");
  assert.equal(payload.version, ADAPTER_CONTRACT_VERSION);
  assert.equal(payload.provider, OPENCODE_GO_PROVIDER);
  assert.equal(payload.adapterName, OPENCODE_GO_ADAPTER_ID);
  assert.ok(payload.range && typeof payload.range.start === "number", "range 形状合法");
}

// ---------------------------------------------------------------- /health 响应

{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  const health = routes.find((r) => r.path === ROUTES.health);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq(), res);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(payload.ok, true);
  assert.equal(payload.version, ADAPTER_CONTRACT_VERSION);
  assert.ok(Array.isArray(payload.adapters), "adapters 列表存在");
  assert.ok(Array.isArray(payload.errors), "errors 登记表存在");
  // 内置适配器已注册
  assert.ok(
    payload.adapters.some((a) => a.name === OPENCODE_GO_ADAPTER_ID),
    "内置 opencode-go 已注册",
  );
}

// ---------------------------------------------------------------- 用户适配器加载（fail-fast）

{
  // 写一个非法适配器文件
  const dir = mkdtempSync(join(tmpdir(), "dou-user-"));
  const badFile = join(dir, "bad.mjs");
  writeFileSync(badFile, `export const version = 2; export const name = "bad";`, "utf8");

  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG, adapter: badFile });
  const health = routes.find((r) => r.path === ROUTES.health);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq(), res);
  await new Promise((r) => setTimeout(r, 20));

  // fail-fast：非法适配器被拒收并登记错误，插件本身不崩溃
  assert.ok(
    payload.errors.some((e) => e.kind === "load" && e.message.includes("契约校验失败")),
    "非法适配器加载失败应登记 load 错误",
  );

  // 合法适配器
  const goodFile = join(dir, "good.mjs");
  writeFileSync(goodFile, `
export const version = 2;
export const name = "good-stats";
export const label = "Good";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { visits: 42 }; }
export function formatCapsule(input) { return "<span>" + input.data.visits + "</span>"; }
export function formatPanel() { return "<p>ok</p>"; }
`, "utf8");

  const ctx2 = makeFakeCtx();
  await apply(ctx2.ctx, { ...ISOLATED_CONFIG, adapter: goodFile, provider: OPENCODE_GO_PROVIDER });
  const stats = ctx2.routes.find((r) => r.path === ROUTES.stats);
  let p2;
  const res2 = { writeHead: () => {}, end: (chunk) => { p2 = JSON.parse(chunk); } };
  stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }), res2);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(p2.adapterName, "good-stats", "用户适配器生效");
  assert.equal(p2.status, "stale", "缺 API key 时 stale 态");
  // fetchData 抛 no-api-key 前…实际上 fetchData 直接返回数据成功；
  // 但 resolveProviderConfig 无 key → adapter.fetchData 正常返回 → fresh。
  // 注意：内置 fetchOpenCodeGoV2 检查 key，但用户适配器自行决定。这里返回 42 → fresh
  // （若行为不同以实际为准，断言放宽为 status 合法）
  assert.ok(["fresh", "cached", "stale"].includes(p2.status));
}

// ---------------------------------------------------------------- 卸载清理不抛错

{
  const disposers = [];
  const { ctx, routes } = makeFakeCtx({
    effect(fn) {
      const d = fn();
      disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  });
  await apply(ctx, { ...ISOLATED_CONFIG });
  for (const d of disposers) {
    if (typeof d === "function") d(); // 不应抛错
  }
  assert.ok(true, "卸载清理链路正常");
}

// ---------------------------------------------------------------- adapters.json / select / inspect / add

{
  const dir = mkdtempSync(join(tmpdir(), "dou-adapter-manage-"));
  const goodFile = join(dir, "manage.mjs");
  writeFileSync(goodFile, `
export const version = 2;
export const name = "manage-stats";
export const label = "管理测试";
export const providers = ["opencode-go"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>x</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { ...ISOLATED_CONFIG });
  const withBody = (body: string) => fakeReq({ method: "POST", body });

  // adapters.json：初始含内置适配器 + modelProviders
  {
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    let payload;
    adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    assert.equal(payload.version, 2, "adapters.json 带契约版本 v2");
    assert.ok(payload.host.some((a) => a.name === OPENCODE_GO_ADAPTER_ID), "内置 opencode-go 在候选列表");
    assert.ok(Array.isArray(payload.modelProviders), "modelProviders 来自 llm 服务");
    assert.ok(payload.enabled[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID, "内置默认启用");
  }

  // inspect：合法文件回显导出信息（不注册）
  {
    const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
    let payload;
    inspectRoute.handler(withBody(JSON.stringify({ file: goodFile })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    if (payload.ok !== true) console.log("INSPECT PAYLOAD:", JSON.stringify(payload)); assert.equal(payload.ok, true, "inspect 合法文件 ok");
    assert.equal(payload.adapter.name, "manage-stats", "inspect 回显 name");
    assert.deepEqual(payload.adapter.providers, ["opencode-go"], "inspect 回显 providers");
  }

  // inspect：非法文件 → 422 + 可排障 detail
  {
    const badFile = join(dir, "bad.mjs");
    writeFileSync(badFile, `export const version = 2; export const name = "only-name";`, "utf8");
    const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
    let payload;
    inspectRoute.handler(withBody(JSON.stringify({ file: badFile })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(payload.error, "invalid-adapter", "非法文件 inspect 返回 invalid-adapter");
    assert.ok(payload.detail.includes("契约校验失败"), "detail 含可排障信息");
  }

  // inspect：未规整相对路径（../ 穿越形态）→ 400 invalid-file
  {
    const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
    let payload;
    inspectRoute.handler(withBody(JSON.stringify({ file: "../evil.mjs" })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(payload.error, "invalid-file", "未规整相对路径 inspect 400");
  }

  // inspect：绝对路径但非 JS（如 /etc/passwd）→ 加载失败（本地可信，不做路径拒绝，
  // 但 import 阶段失败登记 adapter-load-failed）
  {
    const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
    let payload;
    inspectRoute.handler(withBody(JSON.stringify({ file: "/etc/hostname" })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(payload.error === "adapter-load-failed" || payload.error === "invalid-adapter" || payload.error === "invalid-file",
      `非 JS 文件加载失败（实际 ${payload.error}）`);
  }

  // add：成功登记 + 成为启用者 + 持久化到 user-adapters.json
  {
    const addRoute = routes.find((r) => r.path === ROUTES.add);
    let payload;
    addRoute.handler(withBody(JSON.stringify({ file: goodFile })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(payload.ok, true, "add 成功");
    assert.equal(payload.adapter.name, "manage-stats");
    assert.ok(payload.enabled[OPENCODE_GO_PROVIDER] === "manage-stats", "新增适配器成为该 provider 启用者");

    // adapters.json 现在有三条候选（两个内置 + 用户；#198 新增 deepseek-official-builtin）
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    let meta;
    adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { meta = JSON.parse(c); } });
    assert.equal(meta.host.length, 3, "候选列表含两个内置 + 用户");
  }

  // add：重复 name → 409
  {
    const addRoute = routes.find((r) => r.path === ROUTES.add);
    let payload;
    addRoute.handler(withBody(JSON.stringify({ file: goodFile })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(payload.error, "duplicate-name", "重复 name add 409");
  }

  // issue #206：add 后建立的适配器文件也纳入热更新监视——改文件 → 轮询周期内热更新生效
  // #212 回归：成功不再伪装 error 记录（旧实现把「热更新成功」写进 health errors），
  // 改以 adapters.json 中新版 label 可观测生效为准，并断言 errors 无「热更新成功」、enabled 保持。
  {
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const healthRoute = routes.find((r) => r.path === ROUTES.health);
    const readAdapters = (): Promise<{ host: Array<{ name: string; label: string; file: string | null; enabled: boolean }>; enabled: Record<string, string>; errors: Array<{ key: string; message: string }> }> => {
      let p;
      adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { p = JSON.parse(c); } });
      return Promise.resolve(p);
    };
    const readHealth = async (): Promise<Array<{ key: string; message: string }>> => {
      let p;
      healthRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { p = JSON.parse(c); } });
      await new Promise((r) => setTimeout(r, 20));
      return p?.errors ?? [];
    };
    // 改文件（label 文案变化，mtime+size 均变）
    writeFileSync(goodFile, `
export const version = 2;
export const name = "manage-stats";
export const label = "管理测试二版";
export const providers = ["opencode-go"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>v2</span>"; }
export function formatPanel() { return "<p>p2</p>"; }
`, "utf8");
    // 轮询等待热更新生效（热更新轮询 2s；用轮询等待防 flake，上限 ~6s）
    let hot = false;
    let snap;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      snap = await readAdapters();
      if (snap.host.some((a) => a.name === "manage-stats" && a.label === "管理测试二版")) { hot = true; break; }
    }
    assert.ok(hot, "add 后修改文件应触发热更新且新版代码生效（issue #206）");
    assert.equal(snap.host.find((a) => a.name === "manage-stats")?.enabled, true, "热更新不改写启用关系：add 时成为的启用者保持启用（#212-A）");
    const errors = await readHealth();
    assert.ok(!errors.some((e) => e.message.includes("热更新成功")), "成功不得伪装为 error 记录（#212 日志真实）");
  }

  // select：切换回内置
  {
    const selectRoute = routes.find((r) => r.path === ROUTES.select);
    let payload;
    selectRoute.handler(withBody(JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(payload.ok, true, "select 成功");
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    let meta;
    adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { meta = JSON.parse(c); } });
    assert.ok(meta.enabled[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID, "切换回内置生效");
  }

  // select：清空（null）→ 该 provider 无启用
  {
    const selectRoute = routes.find((r) => r.path === ROUTES.select);
    let payload;
    selectRoute.handler(withBody(JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: null })), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(payload.ok, true, "清空 select 成功");
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    let meta;
    adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { meta = JSON.parse(c); } });
    assert.equal(meta.enabled[OPENCODE_GO_PROVIDER], undefined, "清空后无启用");

    // 清空后 /stats 返回 no-enabled-adapter（默认 provider 已被清空）
    const stats = routes.find((r) => r.path === ROUTES.stats);
    let s;
    stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }), { writeHead: () => {}, end: (c) => { s = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.reason, "no-enabled-adapter", "有候选但清空 → no-enabled-adapter");
  }
}

// ---------------------------------------------------------------- #212-A：热更新不改写 enabled 且持久化

{
  const dir = mkdtempSync(join(tmpdir(), "dou-212-a-"));
  const histDir = join(dir, "hist");
  const aFile = join(dir, "a.mjs");
  writeFileSync(aFile, `
export const version = 2;
export const name = "p212-a";
export const label = "A v1";
export const providers = ["p212"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>a1</span>"; }
export function formatPanel() { return "<p>a1</p>"; }
`, "utf8");
  const { ctx, routes } = makeFakeCtx();
  mkdirSync(histDir, { recursive: true }); // 清单/状态落盘目录（消除 warmup 时序依赖，对齐 #212-B）
  await apply(ctx, { ...ISOLATED_CONFIG, provider: "p212", adapter: aFile, historyDir: histDir });
  await new Promise((r) => setTimeout(r, 300)); // 启动稳定（含 hr.start 初始同步）

  const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
  const selectRoute = routes.find((r) => r.path === ROUTES.select);
  const readAdapters = (): { host: Array<{ name: string; label: string; enabled: boolean }>; enabled: Record<string, string> } => {
    let p;
    adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { p = JSON.parse(c); } });
    return p;
  };
  // 用户显式停用（select provider null）
  {
    let payload;
    selectRoute.handler(fakeReq({ method: "POST", body: JSON.stringify({ provider: "p212", adapterName: null }) }), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(payload.ok, true, "显式停用成功");
  }
  // 改文件触发热更新（label 变化可观测新版生效）
  writeFileSync(aFile, `
export const version = 2;
export const name = "p212-a";
export const label = "A v2";
export const providers = ["p212"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>a2</span>"; }
export function formatPanel() { return "<p>a2</p>"; }
// v2 marker —— 内容长度变化保证 stamp 可检出
`, "utf8");
  let snap;
  let hot = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    snap = readAdapters();
    if (snap.host.some((a) => a.name === "p212-a" && a.label === "A v2")) { hot = true; break; }
  }
  assert.ok(hot, "停用的适配器文件编辑后热更新生效");
  assert.equal(snap.host.find((a) => a.name === "p212-a")?.enabled, false, "停用的适配器热更新后保持停用，不得静默变回启用（#212-A）");
  assert.equal(snap.enabled.p212, undefined, "provider 保持无启用者");
  // 持久化：adapter-state.json 轮询等待落盘 null（scheduleWriteAdapterState 为异步串行链）
  let persisted = false;
  const stateFile = adapterStateFile(histDir);
  const persistDeadline = Date.now() + 3000;
  while (Date.now() < persistDeadline) {
    if (existsSync(stateFile)) {
      try {
        const st = JSON.parse(readFileSync(stateFile, "utf8"));
        if (st.p212 === null) { persisted = true; break; }
      } catch { /* 写入中途，继续轮询 */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(persisted, "热更新后的启用关系已持久化到 adapter-state.json（#212-A）");
}

// ---------------------------------------------------------------- #212-B：改名撞名 → 冲突报错 + 旧条目保留 + 无假成功

{
  const dir = mkdtempSync(join(tmpdir(), "dou-212-b-"));
  const histDir = join(dir, "hist");
  const f1 = join(dir, "one.mjs");   // 经 config.adapter 登记
  const f2 = join(dir, "two.mjs");   // 经 add 路由登记
  writeFileSync(f1, `
export const version = 2;
export const name = "u-one";
export const label = "One v1";
export const providers = ["p212b"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>1</span>"; }
export function formatPanel() { return "<p>1</p>"; }
`, "utf8");
  writeFileSync(f2, `
export const version = 2;
export const name = "u-two";
export const label = "Two v1";
export const providers = ["p212c"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>2</span>"; }
export function formatPanel() { return "<p>2</p>"; }
`, "utf8");
  const { ctx, routes } = makeFakeCtx();
  mkdirSync(histDir, { recursive: true }); // 清单/状态落盘目录（生产由插件 home 保证存在）
  await apply(ctx, { ...ISOLATED_CONFIG, adapter: f1, historyDir: histDir });
  const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
  const healthRoute = routes.find((r) => r.path === ROUTES.health);
  const addRoute = routes.find((r) => r.path === ROUTES.add);
  // add 登记第二个文件（纳入热更监视）
  {
    let payload;
    addRoute.handler(fakeReq({ method: "POST", body: JSON.stringify({ file: f2 }) }), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(payload.ok, true, "第二个适配器登记成功");
  }
  // 把 one.mjs 的导出 name 改为 u-two（与另一 user-file 撞名）→ 触发热更冲突路径
  writeFileSync(f1, `
export const version = 2;
export const name = "u-two";
export const label = "One renamed";
export const providers = ["p212b"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>x</span>"; }
export function formatPanel() { return "<p>x</p>"; }
// rename marker —— 内容长度变化保证 stamp 可检出
`, "utf8");
  // 轮询等待冲突报错出现（health errors 可见）
  let conflictErr = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    let p;
    healthRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { p = JSON.parse(c); } });
    const found = (p?.errors ?? []).find((e) => e.kind === "load" && e.message.includes("热更新失败") && e.message.includes("u-two"));
    if (found !== undefined) { conflictErr = found; break; }
  }
  assert.ok(conflictErr !== null, "改名撞名应产生明确的冲突报错且 health 可见（#212-B）");
  // 旧条目保留：one.mjs 仍以旧名 u-one 在候选列表，u-two 归属不变
  let meta;
  adaptersRoute.handler(fakeReq(), { writeHead: () => {}, end: (c) => { meta = JSON.parse(c); } });
  const oneEntry = meta.host.find((a) => a.file === "one.mjs");
  assert.ok(oneEntry !== undefined && oneEntry.name === "u-one", "撞名后 one.mjs 旧条目保留、未静默丢失（#212-B）");
  assert.ok(meta.host.some((a) => a.name === "u-two" && a.file === "two.mjs"), "既有 u-two 条目不受牵连");
  assert.ok(!meta.errors.some((e) => e.message.includes("热更新成功")), "不得出现假「热更新成功」记录（#212-B）");
}

// ---------------------------------------------------------------- 客户端契约

{
  const pkgDir = join(here, "..");
  // 断言入参为包目录（helper 自行读 lib/client.js）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);

  // 客户端源码为干净模块（只 export apply/inject，无 loader 痕迹）
  const clientSource = readFileSync(join(pkgDir, "src/client/index.ts"), "utf8");
  assert.ok(!clientSource.includes("__ModuleLoader__"), "客户端源码不得含 loader 痕迹");
  assert.ok(clientSource.includes("export function apply"), "客户端入口导出 apply");
  // issue #116：避让已去除——客户端不再探测 MCP 浮窗做动态偏移，改为固定定位（位置只由配置决定）
  assert.ok(!clientSource.includes("mcpClearance"), "客户端源码已去除 MCP 避让（mcpClearance）");
  assert.ok(!clientSource.includes("data-dsh-mcp-float"), "客户端源码已去除 MCP 浮窗探测避让");
  assert.ok(clientSource.includes('.style.position = "fixed"'), "客户端源码用固定定位渲染胶囊");

  // qa F1（#128 实测）：bottom-* 锚点首次打开以小高度定位、异步数据撑高面板后
  // 无重排路径 → 稳定向下溢出视口。防回归：renderPanel 尾部触发重定位 +
  // toggleFloat 先渲染后定位。
  assert.ok(/function renderPanel[\s\S]*?if \(floatOpen\) applyUiPlacement\(\);/.test(clientSource),
    "renderPanel 内容更新完成后触发 applyUiPlacement 重定位（bottom 锚点防溢出）");
  {
    const tfStart = clientSource.indexOf("function toggleFloat");
    const tf = clientSource.slice(tfStart);
    assert.ok(tf.indexOf("renderPanel()") >= 0 && tf.indexOf("renderPanel()") < tf.indexOf("placePanel()"),
      "toggleFloat 先 renderPanel 后 placePanel（以真实内容高度定位）");
  }

  // lib/index.js 导出 v2 契约面
  const hostLib = readFileSync(join(pkgDir, "lib/index.js"), "utf8");
  for (const name of ["isUsageStatsAdapter", "esc", "sanitizeHtml", "HistoryStore", "runV2Pipeline"]) {
    assert.ok(hostLib.includes(name), `宿主产物应含 ${name}`);
  }
}

console.log("[smoke] 全部断言通过 ✓ (v2 集成)");

// ---------------------------------------------------------------- #198 deepseek-official 内置适配器集成
//
// 覆盖：A1（失败 stale 帧 + capsuleHtml）/ A3（错误帧不落盘）/ A5（成功帧落盘）/
// E4（no-api-key → stale + 徽标常驻 G8）/ F1（builtin 默认启用）/ F2/K12（与 user-file
// 原型共存且注册顺序覆盖成立）/ F4（候选列表 source 区分）/ E5（密钥不出现在响应体）。
// 网络纪律：apiEndpoint 指向不可达回环（快速 network 失败），无任何出网请求。

{
  // 用户 mjs 原型模拟：name 与 provider 同名（deepseek-official，原型形态），
  // 用于 K12 有意差异断言——与内置 -builtin 后缀名共存不冲突
  const userDir = mkdtempSync(join(tmpdir(), "dou-ds-user-"));
  const userFile = join(userDir, "deepseek-official.mjs");
  writeFileSync(userFile, `
export const version = 2;
export const name = "deepseek-official";
export const label = "DeepSeek 官方余额(用户)";
export const providers = ["${DEEPSEEK_OFFICIAL_PROVIDER}"];
export async function fetchData() { return { isAvailable: true, balance: 42.5, toppedUp: null, grantedBalance: null }; }
export function formatCapsule(i) { return "<span>USER ¥" + (typeof i.data.balance === "number" ? i.data.balance.toFixed(2) : "--") + "</span>"; }
export function formatPanel() { return "<p>user-panel</p>"; }
`, "utf8");

  const historyRoot = join(process.env.DSH_HOME, "dsh-provider-usage");
  const withBody = (body) => fakeReq({ method: "POST", body });
  const getJSON = async (route, url) => {
    let payload;
    await route.handler(fakeReq({ url }), { writeHead: () => {}, end: (c) => { payload = JSON.parse(c); } });
    await new Promise((r) => setTimeout(r, 30));
    return payload;
  };

  // ---- 场景 1：纯 builtin（warmup 关闭避免缓存/锁竞争，手动触发取数）----
  {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG, provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });

    // F1：默认注册后 adapters.json 启用者 = builtin、source=builtin
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const meta = await getJSON(adaptersRoute, ROUTES.adapters);
    assert.equal(meta.enabled[DEEPSEEK_OFFICIAL_PROVIDER], DEEPSEEK_OFFICIAL_ADAPTER_ID,
      "F1: deepseek-official 默认启用者为 deepseek-official-builtin");
    const dsBuiltin = meta.host.find((a) => a.name === DEEPSEEK_OFFICIAL_ADAPTER_ID);
    assert.ok(dsBuiltin !== undefined && dsBuiltin.source === "builtin", "F1: 候选含 builtin 条目且 source=builtin");

    // 启动即预热会把失败帧写进缓存（warmupIntervalMs 有下限 clamp 无法关闭）；
    // select 语义自带 cache.clear()，重选 builtin 后下一次 stats 即全新取数
    await new Promise((r) => setTimeout(r, 350));
    const selectRoute1 = routes.find((r) => r.path === ROUTES.select);
    await new Promise((resolve) => {
      selectRoute1.handler(withBody(JSON.stringify({ provider: DEEPSEEK_OFFICIAL_PROVIDER, adapterName: DEEPSEEK_OFFICIAL_ADAPTER_ID })), {
        writeHead: () => {}, end: (c) => resolve(JSON.parse(c)),
      });
    });

    // A1：取数失败（不可达回环）→ HTTP 形状仍 200 由路由保证；ok=false / status=stale / capsuleHtml 非空
    const stats = routes.find((r) => r.path === ROUTES.stats);
    const failPayload = await getJSON(stats, `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}`);
    assert.equal(failPayload.ok, false, "A1: 失败帧 ok=false");
    assert.equal(failPayload.status, "stale", "A1: 失败帧 status=stale");
    assert.equal(failPayload.reason, "fetch-failed");
    assert.ok(typeof failPayload.capsuleHtml === "string" && failPayload.capsuleHtml.length > 0, "A1: 失败帧 capsuleHtml 非空");
    assert.ok(failPayload.capsuleHtml.includes("DeepSeek 余额 --"), "A1: 空 data 渲染占位文案");
    assert.ok(failPayload.capsuleHtml.includes("dou-peak"), "G8: stale 帧峰谷徽标常驻");
    assert.ok(failPayload.error === "network", `A1: 错误码 network（实际 ${failPayload.error}）`);

    // A3：错误帧绝不落盘历史——builtin 历史目录不应存在
    const builtinHistDir = join(historyRoot, DEEPSEEK_OFFICIAL_PROVIDER, DEEPSEEK_OFFICIAL_ADAPTER_ID);
    assert.ok(!existsSync(builtinHistDir), "A3: 取数失败后历史目录无 builtin 条目（错误帧未落盘）");

    // E5：密钥不出现在任一响应体
    for (const p of [meta, failPayload]) {
      assert.ok(!JSON.stringify(p).includes("sk-smoke-test"), "E5: 响应体不含密钥子串");
    }

    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  }

  // ---- 场景 2：三级密钥全空 → no-api-key → stale 帧 + 徽标（E4/G8）----
  {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { apiKey: "", apiEndpoint: "http://127.0.0.1:9", provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });
    // 等预热完成后 select 清缓存，确保下一次 stats 走全新取数路径（同场景 1）
    await new Promise((r) => setTimeout(r, 350));
    const selectRoute2 = routes.find((r) => r.path === ROUTES.select);
    await new Promise((resolve) => {
      selectRoute2.handler(withBody(JSON.stringify({ provider: DEEPSEEK_OFFICIAL_PROVIDER, adapterName: DEEPSEEK_OFFICIAL_ADAPTER_ID })), {
        writeHead: () => {}, end: (c) => resolve(JSON.parse(c)),
      });
    });
    const stats = routes.find((r) => r.path === ROUTES.stats);
    const payload = await getJSON(stats, `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}`);
    assert.equal(payload.status, "stale", "E4: 三级全空 → stale 帧");
    assert.equal(payload.error, "no-api-key", "E4: 错误码 no-api-key");
    assert.ok(payload.capsuleHtml?.includes("dou-peak"), "G8: no-api-key 下徽标仍渲染（纯本地时间计算）");
    assert.ok(!JSON.stringify(payload).includes("sk-"), "E4: 响应不含任何密钥形态子串");
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  }

  // ---- 场景 3：add user-file 原型（name=deepseek-official）→ 共存 + 覆盖启用（K12/F2/F4/A5）----
  {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG, provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });

    const addRoute = routes.find((r) => r.path === ROUTES.add);
    const addPayload = await new Promise((resolve) => {
      addRoute.handler(withBody(JSON.stringify({ file: userFile })), {
        writeHead: () => {},
        end: (c) => resolve(JSON.parse(c)),
      });
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(addPayload.ok, true, `K12: user-file 原型注册成功（${JSON.stringify(addPayload).slice(0, 120)}）`);
    assert.equal(addPayload.enabled[DEEPSEEK_OFFICIAL_PROVIDER], "deepseek-official",
      "F2: 后注册的 user-file 认领同名 provider 时成为启用者");

    // F4：设置页候选列表同时展示 builtin 与 user-file 且 source 区分
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const meta = await getJSON(adaptersRoute, ROUTES.adapters);
    const sources = Object.fromEntries(meta.host.filter((a) => a.providers.includes(DEEPSEEK_OFFICIAL_PROVIDER)).map((a) => [a.name, a.source]));
    assert.equal(sources[DEEPSEEK_OFFICIAL_ADAPTER_ID], "builtin", "F4: builtin 条目 source=builtin");
    assert.equal(sources["deepseek-official"], "user-file", "F4: user-file 条目 source=user-file");
    assert.ok(!JSON.stringify(meta).includes("sk-smoke-test"), "E5: adapters.json 不含密钥");

    // stats：用户版生效 → fresh + 用户胶囊文案（本地数据零网络）
    // #217：轮询替代固定 sleep——注册后 warmup 采样时序不定（CI 并行下更明显），
    // 反复查 stats 直到用户版接管（adapterName=deepseek-official），超时 3s 兜底。
    const stats = routes.find((r) => r.path === ROUTES.stats);
    let finalFresh = null;
    const pollDeadline = Date.now() + 3000;
    while (Date.now() < pollDeadline) {
      const snap = await getJSON(stats, `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}`);
      if (snap.adapterName === "deepseek-official") { finalFresh = snap; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(finalFresh, "K12: 用户原型适配器接管取数（轮询 3s 内应生效）");
    assert.ok(["fresh", "cached"].includes(finalFresh.status), `A5: 成功帧 fresh/cached（实际 ${finalFresh.status}）`);
    assert.ok(finalFresh.capsuleHtml?.includes("USER ¥42.50"), "A5: 用户版胶囊文案渲染");
    assert.ok(!JSON.stringify(finalFresh).includes("sk-smoke-test"), "E5: stats 响应不含密钥");

    // A5：成功帧正常落盘历史（对照 A3 的失败帧不落盘）
    await new Promise((r) => setTimeout(r, 80));
    const userHistDir = join(historyRoot, DEEPSEEK_OFFICIAL_PROVIDER, "deepseek-official");
    assert.ok(existsSync(userHistDir), "A5: fresh 帧已按 (provider, adapterName) 落盘历史目录");

    // history 路由对用户版可用（面板管线不崩）
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const hist = await getJSON(historyRoute, `${ROUTES.history}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}&days=1`);
    assert.equal(hist.adapterName, "deepseek-official");
    assert.ok(!JSON.stringify(hist).includes("sk-smoke-test"), "E5: history 响应不含密钥");

    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
  }
}

// ---------------------------------------------------------------- #156 warmup 串行采样回归

/**
 * 回归：warmup 并发发起 + getStats 全局 mutex busy 短路 → 多 provider 只有
 * 注册序第一个能采样，其余零采样数小时。修复后 warmupFn 串行 await，
 * 全部 enabled provider 依次持锁取数。
 */
{
  // 构造两个用户适配器（providers 互不相同），注册表指向绝对路径 mjs
  const adapterDir = mkdtempSync(join(tmpdir(), "dou-warmup-adapters-"));
  const mkAdapter = (name, provider) => {
    const file = join(adapterDir, `${name}.mjs`);
    writeFileSync(file, `
export const version = 2;
export const name = "${name}";
export const label = "${name}";
export const providers = ["${provider}"];
export async function fetchData() {
  // 模拟真实远端 IO 延迟：让持锁窗口覆盖后续 provider 的同步检查段，
  // 否则 mock 同步完成过快、两请求都排进 mutex 队列，无法复现 busy 短路
  await new Promise((r) => setTimeout(r, 40));
  return { visits: 7 };
}
export function formatCapsule(input) { return "<span>" + input.data.visits + "</span>"; }
export function formatPanel() { return "<p>ok</p>"; }
`, "utf8");
    return file;
  };
  const fileA = mkAdapter("warm-a", "prov-a");
  const fileB = mkAdapter("warm-b", "prov-b");
  writeFileSync(userAdaptersFile(join(process.env.DSH_HOME, "dsh-provider-usage")), JSON.stringify({
    adapters: [
      { id: "warm-a", label: "Warm A", providers: ["prov-a"], file: fileA },
      { id: "warm-b", label: "Warm B", providers: ["prov-b"], file: fileB },
    ],
  }), "utf8");

  const disposers = [];
  const { ctx, routes } = makeFakeCtx({
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  });
  await apply(ctx, { ...ISOLATED_CONFIG, warmupIntervalMs: 60000 });
  // 启动即预热一次（串行 await）：给足两个 provider 依次取数的时间
  await new Promise((r) => setTimeout(r, 400));

  const statsRoute = routes.find((r) => r.path === ROUTES.stats);
  const queryProvider = async (provider) => {
    let payload;
    statsRoute.handler(
      fakeReq({ url: `${ROUTES.stats}?provider=${provider}` }),
      { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } },
    );
    await new Promise((r) => setTimeout(r, 30));
    return payload;
  };
  const pa = await queryProvider("prov-a");
  const pb = await queryProvider("prov-b");

  assert.equal(pa.adapterName, "warm-a", "provider A 经 warmup 完成采样（适配器生效）");
  assert.notEqual(pa.status, "stale", `provider A 非 stale 短路（实际 ${pa.status}）`);
  assert.equal(pb.adapterName, "warm-b", "provider B 经 warmup 完成采样——旧实现下 B 因 mutex busy 零采样（#156 主回归点）");
  assert.notEqual(pb.status, "stale", `provider B 非 stale 短路（实际 ${pb.status}）`);

  for (const d of [...disposers].reverse()) {
    try { d(); } catch {}
  }
  console.log("[smoke] #156 warmup 串行采样回归 ✓");
}

// ---------------------------------------------------------------- #105① /history 渲染缓存

/**
 * 子项①验收（issue #105 spec-writer 13 条清单，本节覆盖 AC#1–AC#11 行为断言；
 * AC#12 性能三要素见 PR 正文实测数据、AC#13 见 README 宣称）。
 *
 * 机制：进程内 Map 缓存 runV2PanelPipeline 返回值字符串层 {panelHtml,error,at}，
 * key=provider+adapterName+自然日粒度归一化 range；主失效=append 落盘全清
 * （stats TTL 命中期间不产生新 append，主失效由 warmup×stats TTL 复合门控），
 * select/add/热更新三挂点同清；TTL 90s 仅兜底；错误/无适配器响应不入缓存。
 */

// ---- S0：纯函数定界与 key 正确性（AC#2 / AC#8 的常量与归一化部分）
{
  // AC#8：TTL 为 [60s,120s] 内编译期常量
  assert.ok(Number.isInteger(PANEL_CACHE_TTL_MS), "TTL 是编译期整数常量");
  assert.ok(PANEL_CACHE_TTL_MS >= 60000 && PANEL_CACHE_TTL_MS <= 120000, `TTL ∈ [60000,120000]（实际 ${PANEL_CACHE_TTL_MS}）`);
  // 过期判定边界（严格大于）：at/now 分离入参支持注入时钟
  assert.equal(isPanelCacheStale({ at: 0 }, PANEL_CACHE_TTL_MS), false, "恰好到龄未过期");
  assert.equal(isPanelCacheStale({ at: 0 }, PANEL_CACHE_TTL_MS + 1), true, "超龄 1ms 即过期");
  assert.equal(isPanelCacheStale({ at: 0 }, 59999, 60000), false, "自定义 ttl 下界内新鲜");
  assert.equal(isPanelCacheStale({ at: 0 }, 60001, 60000), true, "自定义 ttl 超界过期");

  // AC#2：自然日粒度归一化——同日内时钟漂移不进 key，跨日/不同 days 不同 key
  const t1 = new Date(2026, 1, 10, 9, 15, 12, 345).getTime();
  const t2 = new Date(2026, 1, 10, 20, 0, 0, 500).getTime();
  const dayOf = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  assert.deepEqual(normalizeRangeDay({ start: t1, end: t2 }), { start: dayOf(t1), end: dayOf(t2) }, "归一到当地当日零点");
  const nextDay = new Date(2026, 1, 11, 0, 0, 1).getTime();
  assert.notEqual(
    panelCacheKey("p", "a", { start: t1, end: t2 }),
    panelCacheKey("p", "a", { start: t1, end: nextDay }),
    "跨自然日 → 不同 key",
  );
  assert.equal(
    panelCacheKey("p", "a", { start: t1, end: t2 }),
    panelCacheKey("p", "a", { start: t1 + 5000, end: t2 + 1500 }),
    "同自然日内秒级漂移不进 key（end=Date.now() 漂移不致缓存空转）",
  );
  const weekMs = 7 * 86400000;
  assert.notEqual(
    panelCacheKey("p", "a", { start: t1 - weekMs, end: t1 }),
    panelCacheKey("p", "a", { start: t1 - 30 * 86400000, end: t1 }),
    "days=7 与 days=30 归一化为不同 key",
  );
  assert.notEqual(panelCacheKey("p1", "a", { start: t1, end: t2 }), panelCacheKey("p2", "a", { start: t1, end: t2 }), "provider 入 key");
  assert.notEqual(panelCacheKey("p", "a1", { start: t1, end: t2 }), panelCacheKey("p", "a2", { start: t1, end: t2 }), "adapterName 入 key");
}

// ---- 测试公共件：spy 适配器生成 / 路由调用 helper / 可收集 disposers 的 fakeCtx

const mkSpyFile = (dir, fileBase, name, provider, formatPanelBody, extra = "") => {
  const file = join(dir, `${fileBase}.mjs`);
  writeFileSync(file, `
export const version = 2;
export const name = "${name}";
export const label = "${name}";
export const providers = ["${provider}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) { ${formatPanelBody} }
${extra}
`, "utf8");
  return file;
};

const countingPanel = (counter) =>
  `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1;` +
  `return "<p data-calls=\\"" + globalThis.${counter} + "\\" data-n=\\"" + input.entries.length + "\\">panel</p>";`;

const makeCollectingCtx = () => {
  const disposers = [];
  const { ctx, routes } = makeFakeCtx({
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  });
  return { ctx, routes, disposers };
};

const callRoute = (route, reqOverrides) => new Promise((resolve) => {
  let payload;
  route.handler(fakeReq(reqOverrides), {
    writeHead: () => {},
    end: (chunk) => { payload = JSON.parse(chunk); resolve(payload); },
  });
});
const getHistory = (route, provider, days) =>
  callRoute(route, { url: `${ROUTES.history}?provider=${provider}&days=${days}` });
const postJson = (route, body) => callRoute(route, { method: "POST", body: JSON.stringify(body) });

const disposeAll = (disposers) => {
  for (const d of [...disposers].reverse()) { try { d(); } catch { /* 忽略 */ } }
};

// ---- S1：命中逐字节一致 + key 不含漂移时间戳 + append 落盘全清（AC#1/#2/#3 + 形状回归）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-cache-"));
  const spyFile = mkSpyFile(dir, "spy-a", "cache-spy-a", "cache-prov", countingPanel("__SPY_A"));
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "cache-prov",
    adapter: spyFile,
    historyDir: join(dir, "hist"),
    cacheDurationMs: 5000, // stats 缓存 5s 到龄：让「重取→append→面板缓存全清」可在测试窗口触发
  });
  await new Promise((r) => setTimeout(r, 800)); // 启动预热完成（getStats fresh → append#0 → 清空缓存）

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const statsRoute = routes.find((r) => r.path === ROUTES.stats);

  // AC#1 冷算填缓存
  const h1 = await getHistory(historyRoute, "cache-prov", 7);
  assert.equal(globalThis.__SPY_A, 1, "首次请求完整执行管道");
  assert.equal(h1.ok, true);
  assert.ok(String(h1.panelHtml).includes('data-calls="1"'), "冷算渲染首版");

  // AC#1+#2 时钟推进 ≥1s 后仍命中同一 key：panelHtml/error 逐字节一致、管道计数不增
  await new Promise((r) => setTimeout(r, 1100));
  const h2 = await getHistory(historyRoute, "cache-prov", 7);
  assert.equal(globalThis.__SPY_A, 1, "命中路径不重跑管道（query+formatPanel 计数均不增）");
  assert.equal(h2.panelHtml, h1.panelHtml, "二次响应 panelHtml 与首次逐字节一致");
  assert.equal(h2.error, h1.error, "error 字段一致");
  assert.ok(h2.range.end > h1.range.end, "end 已随系统时钟漂移但不进 key，仍命中");
  assert.deepEqual(
    Object.keys(h2).sort(),
    ["adapterName", "error", "ok", "panelHtml", "plugin", "provider", "range", "version"],
    "八字段响应形状不变（AC#10 回归）",
  );

  // AC#2 不同 days 归一化为不同 key、互不串数据，range 回显各自真实 start/end
  const h30 = await getHistory(historyRoute, "cache-prov", 30);
  assert.equal(globalThis.__SPY_A, 2, "days=30 新 key 冷算");
  assert.ok(h30.range.end - h30.range.start > 29 * 86400000, "days=30 窗口独立");
  const h7b = await getHistory(historyRoute, "cache-prov", 7);
  assert.equal(globalThis.__SPY_A, 2, "days=7 条目未被 days=30 冲掉，仍命中");
  assert.equal(h7b.panelHtml, h1.panelHtml, "days=7 回放原条目");

  // AC#3 主失效：等 stats TTL(5s) 到龄 → GET /stats 重取 fresh → append 落盘 → 面板缓存全清
  await new Promise((r) => setTimeout(r, 5200));
  const nBefore = Number(h1.panelHtml.match(/data-n="(\d+)"/)[1]);
  await callRoute(statsRoute, { url: `${ROUTES.stats}?provider=cache-prov` });
  const h3 = await getHistory(historyRoute, "cache-prov", 7);
  assert.equal(globalThis.__SPY_A, 3, "append 落盘后缓存整体清除、完整管道重跑");
  const nAfter = Number(h3.panelHtml.match(/data-n="(\d+)"/)[1]);
  assert.equal(nAfter, nBefore + 1, "重算结果反映新落盘 entry");

  disposeAll(disposers);
}

// ---- S2：select 切换/清空挂点失效（AC#4）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-select-"));
  const fileA = mkSpyFile(dir, "sel-a", "sel-spy-a", "sel-prov", countingPanel("__SPY_SEL_A"));
  const fileB = mkSpyFile(dir, "sel-b", "sel-spy-b", "sel-prov", countingPanel("__SPY_SEL_B"));
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "sel-prov",
    adapter: fileA,
    historyDir: join(dir, "hist"),
  });
  await new Promise((r) => setTimeout(r, 800));

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const addRoute = routes.find((r) => r.path === ROUTES.add);
  const selectRoute = routes.find((r) => r.path === ROUTES.select);

  const ha1 = await getHistory(historyRoute, "sel-prov", 7);
  assert.equal(globalThis.__SPY_SEL_A, 1, "sel-a 冷算填缓存");

  // 登记 sel-b（add 抢占成为启用者），按 sel-b 重算填其条目
  const added = await postJson(addRoute, { file: fileB });
  assert.equal(added.ok, true, "add sel-b 成功");
  const hb1 = await getHistory(historyRoute, "sel-prov", 7);
  assert.equal(hb1.adapterName, "sel-spy-b", "sel-b 已是启用者");
  assert.equal(globalThis.__SPY_SEL_B, 1);

  // 切回 sel-a：select 挂点必须已清缓存——否则这里会复用切换前的旧 sel-a 条目
  const switched = await postJson(selectRoute, { provider: "sel-prov", adapterName: "sel-spy-a" });
  assert.equal(switched.ok, true);
  const ha2 = await getHistory(historyRoute, "sel-prov", 7);
  assert.equal(globalThis.__SPY_SEL_A, 2, "切换后旧缓存不得复用、按新启用关系重算");
  assert.ok(String(ha2.panelHtml).includes('data-calls="2"'), "返回的是重算新 HTML 而非旧快照");

  // 清空（adapterName=null）：结构化 reason，绝不回吐任何旧 HTML
  const cleared = await postJson(selectRoute, { provider: "sel-prov", adapterName: null });
  assert.equal(cleared.ok, true);
  const hnone = await getHistory(historyRoute, "sel-prov", 7);
  assert.equal(hnone.reason, "no-enabled-adapter", "清空后返回 no-enabled-adapter 结构化 JSON");
  assert.equal(hnone.panelHtml, null, "panelHtml=null 而非任何旧 HTML");
  assert.equal(hnone.adapterName, null);

  disposeAll(disposers);
}

// ---- S3：错误与 no-adapter 响应不入缓存、条件消除立即恢复（AC#7）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-err-"));
  const errFile = join(dir, "err-a.mjs");
  writeFileSync(errFile, `
export const version = 2;
export const name = "err-spy";
export const providers = ["err-prov"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_ERR = (globalThis.__SPY_ERR ?? 0) + 1;
  throw new Error("format-boom");
}
`, "utf8");
  const okFile = mkSpyFile(dir, "ok-e", "ok-e-spy", "err-prov", countingPanel("__SPY_OK_E"));
  const ghostFile = mkSpyFile(dir, "ghost-ok", "ghost-ok-spy", "ghost-prov", countingPanel("__SPY_GHOST"));
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "err-prov",
    adapter: errFile,
    historyDir: join(dir, "hist"),
  });
  await new Promise((r) => setTimeout(r, 800));

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const addRoute = routes.find((r) => r.path === ROUTES.add);

  const e1 = await getHistory(historyRoute, "err-prov", 7);
  assert.equal(e1.ok, false, "formatPanel 抛错 → 错误响应");
  assert.ok(e1.error !== null && String(e1.error).length > 0, "error 非 undefined 语义经 null 化下发");

  // 关键：两次错误请求之间【无任何 clear 挂点动作】——若错误入了缓存，
  // 第二次会在剩余 TTL 内复读旧错误（计数维持 1）；未入缓存则必然重算
  await new Promise((r) => setTimeout(r, 1100));
  const e2 = await getHistory(historyRoute, "err-prov", 7);
  assert.equal(globalThis.__SPY_ERR, 2, "错误响应不入缓存：第二次仍完整重算而非复读旧错误");
  assert.equal(e2.ok, false);

  // no-adapter：结构化响应不入缓存（连续两次一致、无崩溃）
  const g1 = await getHistory(historyRoute, "ghost-prov", 7);
  assert.equal(g1.reason, "no-adapter");
  assert.equal(g1.panelHtml, null);
  const g2 = await getHistory(historyRoute, "ghost-prov", 7);
  assert.equal(g2.reason, "no-adapter", "no-adapter 结构化响应稳定重现");
  assert.equal(g2.adapterName, null);

  // 条件消除：登记正常适配器顶替错误适配器 → 下一次请求立即成功
  const added = await postJson(addRoute, { file: okFile });
  assert.equal(added.ok, true);
  const o1 = await getHistory(historyRoute, "err-prov", 7);
  assert.equal(o1.ok, true, "条件消除后立即重算并成功，不在剩余 TTL 内复读旧错误");
  assert.equal(o1.adapterName, "ok-e-spy");
  assert.equal(globalThis.__SPY_OK_E, 1);

  // ghost-prov 条件消除（注册适配器）后同样立即可用
  const gAdded = await postJson(addRoute, { file: ghostFile });
  assert.equal(gAdded.ok, true);
  const g3 = await getHistory(historyRoute, "ghost-prov", 7);
  assert.equal(g3.ok, true, "no-adapter 条件消除后立即出数据");
  assert.equal(globalThis.__SPY_GHOST, 1);

  disposeAll(disposers);
}

// ---- S4：add 挂点失效（AC#5）——登记其他 provider 适配器，唯一变量即挂点全清
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-add-"));
  const mainFile = mkSpyFile(dir, "add-a", "add-spy-a", "add-prov", countingPanel("__SPY_ADD_A"));
  const otherFile = mkSpyFile(dir, "add-b", "add-spy-b", "other-add-prov", countingPanel("__SPY_ADD_B"));
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "add-prov",
    adapter: mainFile,
    historyDir: join(dir, "hist"),
  });
  await new Promise((r) => setTimeout(r, 800));

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const addRoute = routes.find((r) => r.path === ROUTES.add);

  const a1 = await getHistory(historyRoute, "add-prov", 7);
  assert.equal(globalThis.__SPY_ADD_A, 1);

  // 登记一个【其他 provider】的适配器：add-prov 启用关系不变、key 不变、TTL 未到——
  // 唯一能让下一次请求重算的机制就是 add 成功后的缓存全清
  const added = await postJson(addRoute, { file: otherFile });
  assert.equal(added.ok, true);
  const a2 = await getHistory(historyRoute, "add-prov", 7);
  assert.equal(globalThis.__SPY_ADD_A, 2, "add 成功后旧缓存清除、下次 /history 重算");

  disposeAll(disposers);
}

// ---- S5：热更新挂点失效（AC#6）——autoReload 下文件变更 → 新版代码渲染
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-hr-"));
  const hrFile = mkSpyFile(
    dir, "hr-a", "hr-spy", "hr-prov",
    `globalThis.__SPY_HR = (globalThis.__SPY_HR ?? 0) + 1; return "<p data-v=\\"1\\">v1</p>";`,
    "// v1 marker line",
  );
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "hr-prov",
    adapter: hrFile,
    autoReload: true,
    historyDir: join(dir, "hist"),
  });
  await new Promise((r) => setTimeout(r, 900));

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const w1 = await getHistory(historyRoute, "hr-prov", 7);
  assert.ok(String(w1.panelHtml).includes('data-v="1"'), "热更新前渲染 v1");

  // 改写文件（size/mtime 双变）→ HotReloadableAdapter 轮询（2s）→ onReload ok → 挂点 clear
  writeFileSync(hrFile, `
export const version = 2;
export const name = "hr-spy";
export const label = "hr-spy";
export const providers = ["hr-prov"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_HR = (globalThis.__SPY_HR ?? 0) + 1;
  return "<p data-v=\\"2\\">v2</p>";
}
// v2 marker line —— 内容长度与 v1 不同，保证 stamp 变化可检出
`, "utf8");

  let w2 = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const p = await getHistory(historyRoute, "hr-prov", 7);
    if (String(p.panelHtml).includes('data-v="2"')) { w2 = p; break; }
  }
  assert.ok(w2 !== null, "热更新成功回调后旧缓存清除（轮询窗口内以新版代码渲染）");
  assert.ok(globalThis.__SPY_HR >= 2, "新版 formatPanel 已被真实执行");

  disposeAll(disposers);
}

// ---- S6：只缓存返回值字符串层——formatPanel 变异 entries 后命中不受影响（AC#9）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-105-mut-"));
  const mutFile = join(dir, "mut-a.mjs");
  writeFileSync(mutFile, `
export const version = 2;
export const name = "mut-spy";
export const providers = ["mut-prov"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_MUT = (globalThis.__SPY_MUT ?? 0) + 1;
  const n = input.entries.length;
  input.entries.length = 0; // 变异入参：恶意/劣质用户代码探针
  return "<p data-len=\\"" + n + "\\" data-after=\\"" + input.entries.length + "\\">m</p>";
}
`, "utf8");
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, {
    ...ISOLATED_CONFIG,
    provider: "mut-prov",
    adapter: mutFile,
    historyDir: join(dir, "hist"),
  });
  await new Promise((r) => setTimeout(r, 800)); // 预热保证历史至少 1 条

  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const m1 = await getHistory(historyRoute, "mut-prov", 7);
  const lenN = Number(m1.panelHtml.match(/data-len="(\d+)"/)[1]);
  assert.ok(lenN >= 1, `首算基于原始 entries（len=${lenN}）`);
  assert.ok(String(m1.panelHtml).includes('data-after="0"'), "变异在首算内生效过");

  const m2 = await getHistory(historyRoute, "mut-prov", 7);
  assert.equal(globalThis.__SPY_MUT, 1, "命中路径不再调用 formatPanel");
  assert.equal(m2.panelHtml, m1.panelHtml, "命中回放缓存字符串层——绝不读取/复用 entries 中间层重渲染");

  disposeAll(disposers);
}

// ---- S7：不引入条件请求协商——无 ETag/Last-Modified 头、协商头请求仍 200 全量体（AC#11）
{
  const { ctx, routes, disposers } = makeCollectingCtx();
  await apply(ctx, { ...ISOLATED_CONFIG, historyDir: join(mkdtempSync(join(tmpdir(), "dou-105-etag-")), "hist") });
  await new Promise((r) => setTimeout(r, 300));
  const historyRoute = routes.find((r) => r.path === ROUTES.history);

  let code = 0;
  let hdrs = {};
  let raw = "";
  historyRoute.handler(
    fakeReq({
      url: `${ROUTES.history}?days=7`,
      headers: {
        host: "127.0.0.1:3080",
        "sec-fetch-site": "same-origin",
        "if-none-match": '"W/fake-etag"',
        "if-modified-since": "Mon, 09 Feb 2026 00:00:00 GMT",
      },
    }),
    {
      writeHead: (c, h) => { code = c; hdrs = h ?? {}; },
      end: (chunk) => { raw = chunk; },
    },
  );
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(code, 200, "携带 If-None-Match/If-Modified-Since 一律完整 200，不做 304 短路");
  for (const k of Object.keys(hdrs)) {
    const lk = k.toLowerCase();
    assert.ok(lk !== "etag" && lk !== "last-modified", `响应头不含协商头（发现 ${k}）`);
  }
  const p = JSON.parse(raw);
  assert.ok("panelHtml" in p && "range" in p, "200 体为完整响应形状");

  disposeAll(disposers);
}

console.log("[smoke] #105① /history 渲染缓存断言全部通过 ✓");

// 恢复真实环境变量（测试收尾）
for (const k of SAVED_ENV_KEYS) {
  if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
  else delete process.env[k];
}
delete process.env.OPENCODE_GO_API_KEY_TEST_ABSENT;
