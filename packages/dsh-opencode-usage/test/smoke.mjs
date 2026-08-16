/**
 * dsh-opencode-usage — 宿主端冒烟测试（fake ctx + 注入 fetch，无网络）。
 *
 * 覆盖：
 * - normalizeConfig：默认值/部分覆盖/非法值丢弃/限额合并
 * - pickWindow / parseUsageResponse：防御式窗口解析（嵌套/直接/坏数据）
 * - credentialsKeyFromYaml / opencodeKeyFromAuth / resolveApiKey：解析链优先级
 * - fetchUsage：注入 fake fetch —— 200 / 401 / 500 / 网络错 / 坏 JSON / 无 key
 * - makeUsageCache：TTL 内命中、过期失效
 * - apply：enabled:false 不注册；注册 stats+health 两路由；stats 403（非回环）
 *   405（非 GET）；stats 200 全链路（注入 fetchImpl + apiKey）；health 200 摘要
 * - 客户端路由常量一致性（正则提取 client bundle /api/ 字面量 vs host ROUTES）
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  apply,
  ROUTES,
  DEFAULT_CONFIG,
  normalizeConfig,
  pickWindow,
  parseUsageResponse,
  credentialsKeyFromYaml,
  opencodeKeyFromAuth,
  resolveApiKey,
  fetchUsage,
  makeUsageCache,
  makeHistoryStore,
  writeHistoryFile,
  readHistoryFile,
} from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 配置

assert.equal(normalizeConfig(undefined).baseUrl, DEFAULT_CONFIG.baseUrl);
const merged = normalizeConfig({ baseUrl: "https://example.com/x", timeoutMs: 999, cacheTtlMs: 5000, limits: { weekly: 40 }, bogus: 1 });
assert.equal(merged.baseUrl, "https://example.com/x");
assert.equal(merged.timeoutMs, 999);
assert.equal(merged.cacheTtlMs, 5000);
assert.equal(merged.limits.weekly, 40);
assert.equal(merged.limits.rolling, DEFAULT_CONFIG.limits.rolling, "未覆盖的限额保留默认");
assert.equal(merged.bogus, undefined, "未知键丢弃");
assert.equal(normalizeConfig({ timeoutMs: "x" }).timeoutMs, DEFAULT_CONFIG.timeoutMs, "非法数字回退");
assert.equal(normalizeConfig({ timeoutMs: -5 }).timeoutMs, DEFAULT_CONFIG.timeoutMs, "负数回退");
assert.equal(normalizeConfig({ timeoutMs: 999999 }).timeoutMs, 120000, "超上限钳制");
assert.equal(DEFAULT_CONFIG.sampleIntervalMs, 300000, "后台采样默认 5 分钟");
assert.equal(normalizeConfig({ sampleIntervalMs: 60000 }).sampleIntervalMs, 60000, "后台采样间隔可配置");
assert.equal(normalizeConfig({ sampleIntervalMs: 1000 }).sampleIntervalMs, DEFAULT_CONFIG.sampleIntervalMs, "后台采样间隔 <30s 回退（防打爆官方接口）");
assert.equal(normalizeConfig({ sampleIntervalMs: 99999999 }).sampleIntervalMs, 3600000, "后台采样间隔上限钳制 1h");
assert.equal(normalizeConfig({ apiKey: "  sk-abc  " }).apiKey, "sk-abc", "apiKey 修剪");
assert.equal(normalizeConfig({ apiKey: "   " }).apiKey, undefined, "空白 apiKey 丢弃");
assert.equal(normalizeConfig({ maxAgeDays: 30 }).maxAgeDays, 30, "maxAgeDays 覆盖");
assert.equal(normalizeConfig({ maxAgeDays: 9999 }).maxAgeDays, 365, "maxAgeDays 钳制上限");
assert.equal(normalizeConfig({ maxAgeDays: -1 }).maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "maxAgeDays 负数回退");
assert.equal(normalizeConfig({ persistFile: " /tmp/h.json " }).persistFile, "/tmp/h.json", "persistFile 修剪");

// ---------------------------------------------------------------- 窗口解析

assert.deepEqual(pickWindow({ status: "ok", percent: 9, resetsAt: "2026-08-15T00:00:00Z" }), { status: "ok", percent: 9, resetsAt: "2026-08-15T00:00:00Z" });
assert.deepEqual(pickWindow({ percent: "12" }), { status: null, percent: 12, resetsAt: null }, "字符串 percent 转数字");
assert.deepEqual(pickWindow({ percent: "abc" }), { status: null, percent: null, resetsAt: null }, "非法 percent 置 null");
assert.equal(pickWindow(null), null);
assert.equal(pickWindow(undefined), null);
assert.equal(pickWindow("x"), null);

assert.deepEqual(parseUsageResponse({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } } }).monthly.percent, 3, "嵌套 usage");
assert.deepEqual(parseUsageResponse({ rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } }).rolling.percent, 1, "直接三键");
assert.equal(parseUsageResponse(null), null);
assert.equal(parseUsageResponse("x"), null);

// ---------------------------------------------------------------- API Key 解析链

assert.equal(credentialsKeyFromYaml('DEEPSEEK_API_KEY: sk-aaa\nOPENCODE_GO_API_KEY: sk-opencode-123\n'), "sk-opencode-123");
assert.equal(credentialsKeyFromYaml('OPENCODE_GO_API_KEY: "sk-q"'), "sk-q", "带引号");
assert.equal(credentialsKeyFromYaml('OPENCODE_GO_API_KEY:'), undefined, "无值");
assert.equal(credentialsKeyFromYaml(""), undefined);
assert.equal(credentialsKeyFromYaml(undefined), undefined);

assert.equal(opencodeKeyFromAuth('{"opencode-go":{"type":"api","key":"sk-go-1"}}'), "sk-go-1", "opencode-go 优先");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api","key":"sk-oc-2"}}'), "sk-oc-2", "回退 opencode");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api"}}'), undefined, "无 key");
assert.equal(opencodeKeyFromAuth("{bad json"), undefined);
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"oauth","key":"x"}}'), undefined, "非 api 类型");

assert.equal(resolveApiKey({ explicit: "sk-e", env: "sk-v", credentialsYaml: "k: sk-c", authJson: "{}" }), "sk-e", "显式优先");
assert.equal(resolveApiKey({ env: "sk-v", credentialsYaml: "k: sk-c", authJson: "{}" }), "sk-v", "环境变量次之");
assert.equal(resolveApiKey({ credentialsYaml: "OPENCODE_GO_API_KEY: sk-c", authJson: "{}" }), "sk-c", "credentials.yaml 再次");
assert.equal(resolveApiKey({ authJson: '{"opencode-go":{"type":"api","key":"sk-a"}}' }), "sk-a", "auth.json 兜底");
assert.equal(resolveApiKey({}), undefined, "全缺返回 undefined");

// ---------------------------------------------------------------- fetchUsage

function fakeRes(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const OK_BODY = { usage: { rolling: { status: "ok", percent: 2, resetsAt: "r" }, weekly: { status: "ok", percent: 1, resetsAt: "w" }, monthly: { status: "ok", percent: 0, resetsAt: "m" } } };

{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(200, OK_BODY) });
  assert.equal(r.ok, true);
  assert.equal(r.usage.monthly.percent, 0);
}
{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(401, {}) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unauthorized");
}
{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(500, {}) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "http-500");
}
{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}
{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(200, "<html>") });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad-json");
}
{
  const r = await fetchUsage({ baseUrl: "https://x", apiKey: "", fetchImpl: async () => fakeRes(200, OK_BODY) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-api-key");
}
{
  // 超时：fetchImpl 挂起时 abort 生效（timeout 用极小值，等 abort 后返回 network）
  const r = await fetchUsage({
    baseUrl: "https://x",
    apiKey: "sk-1",
    timeoutMs: 5,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}

// ---------------------------------------------------------------- 历史采样序列

{
  // 追加 + 分钟去重（同分钟只留最新）
  let now = 1_000_000;
  const store = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.deepEqual(store.append([now, 1, 2, 3]), { appended: 1, replaced: 0 });
  assert.deepEqual(store.append([now + 1000, 4, 5, 6]), { appended: 0, replaced: 1 }, "同分钟替换");
  assert.equal(store.count(), 1);
  assert.deepEqual(store.list()[0], [now + 1000, 4, 5, 6], "替换后保留最新点");
  assert.deepEqual(store.append([now + 60000, 7, 8, 9]), { appended: 1, replaced: 0 }, "跨分钟追加");
  assert.equal(store.count(), 2);
  // 非法点丢弃
  assert.deepEqual(store.append(null), { appended: 0, replaced: 0 });
  assert.deepEqual(store.append([1, 2]), { appended: 0, replaced: 0 }, "元素不足 4 丢弃");
  assert.deepEqual(store.append(["x", 1, 2, 3]), { appended: 0, replaced: 0 }, "ts 非法丢弃");
  // percent 非法转 null
  assert.deepEqual(store.append([now + 120000, "bad", 5, null]), { appended: 1, replaced: 0 });
  assert.equal(store.list().at(-1)[1], null, "非法 percent 归一为 null");

  // trim：超龄头部裁剪
  now += 15 * 86400000;
  const removed = store.trim();
  assert.ok(removed >= 2, "超龄点被裁剪");
  assert.ok(store.list().every((s) => s[0] >= now - 14 * 86400000), "剩余点都在窗口内");
}

{
  // dump/load 往返 + load 防御（坏 JSON / 坏结构 / 乱序重排）
  // 注意：load 会按 now 裁剪超龄点，测试用近期时间戳
  const now = Date.now();
  const store = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  store.append([now - 3600000, 1, 2, 3]);
  store.append([now, 4, 5, 6]);
  const text = store.dump();
  const store2 = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.equal(store2.load(text), 2, "load 返回加载点数");
  assert.deepEqual(store2.list(), store.list(), "dump/load 往返一致");

  const bad = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.equal(bad.load("{bad json"), 0, "坏 JSON 返回 0");
  assert.equal(bad.load(JSON.stringify({ version: 1, samples: "x" })), 0, "坏结构返回 0");
  assert.equal(bad.load(JSON.stringify({ version: 1, samples: [[1, 2], ["x", 1, 2, 3], [now, 1, 2, 3]] })), 1, "坏元素丢弃，好元素保留");
  assert.equal(bad.load(undefined), 0, "undefined 返回 0");
  const store3 = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  store3.load(JSON.stringify({ version: 1, samples: [[now, 1, 2, 3], [now - 60000, 4, 5, 6]] }));
  assert.deepEqual(store3.list(), [[now - 60000, 4, 5, 6], [now, 1, 2, 3]], "load 按 ts 升序重排");
}

{
  // 原子落盘往返（临时目录）
  const dir = mkdtempSync(join(tmpdir(), "dou-smoke-"));
  const file = join(dir, "hist.json");
  await writeHistoryFile(file, JSON.stringify({ version: 1, samples: [[1, 2, 3, 4]] }));
  const text = await readHistoryFile(file);
  assert.equal(JSON.parse(text).samples.length, 1, "落盘往返");
  assert.equal(await readHistoryFile(join(dir, "no-such.json")), undefined, "文件不存在返回 undefined");
}

// ---------------------------------------------------------------- TTL 缓存

let now = 1000;
const cache = makeUsageCache({ ttlMs: 30000, now: () => now });
assert.equal(cache.get(), undefined);
cache.set({ a: 1 });
assert.deepEqual(cache.get(), { a: 1 });
now = 1000 + 29999;
assert.deepEqual(cache.get(), { a: 1 }, "TTL 内命中");
now = 1000 + 30000;
assert.equal(cache.get(), undefined, "TTL 过期失效");
cache.set({ b: 2 });
cache.clear();
assert.equal(cache.get(), undefined, "clear 生效");

// ---------------------------------------------------------------- fake ctx + apply

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    ...overrides,
  };
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
    effect(fn) {
      // 真实 cordis 语义：fn 立即同步执行，返回值收集为 disposer（卸载时调用）。
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, routes };
}

// enabled:false 不注册任何路由
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { enabled: false });
  assert.equal(routes.length, 0, "enabled:false 不注册路由");
}

// 注册 stats + history + health 三路由
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  assert.deepEqual(routes.map((r) => r.path).sort(), [ROUTES.health, ROUTES.history, ROUTES.stats].sort(), "注册三条路由");
  assert.ok(routes.every((r) => r.kind === "exact"));
}

// stats 路由：403（非回环）/ 405（非 GET）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const stats = routes.find((r) => r.path === ROUTES.stats);
  assert.ok(stats, "stats 路由存在");

  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  const req403 = fakeReq({ socket: { remoteAddress: "10.0.0.2" } });
  stats.handler(req403, res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "非回环 403");

  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  stats.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "非 GET 405");
}

// stats 200 全链路：注入 fetchImpl + apiKey（不落盘、不网络）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => fakeRes(200, OK_BODY),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res);
  assert.equal(payload.ok, true);
  assert.equal(payload.configured, true);
  assert.equal(payload.error, null);
  assert.equal(payload.usage.monthly.percent, 0, "200 全链路返回用量");
  assert.equal(payload.limits.monthly, 60, "响应带展示限额");
  assert.equal(payload.plugin, "dsh-opencode-usage");
  const fetchedAt = payload.fetchedAt;

  // 缓存命中：第二次请求不触发 fetchImpl（计数不变）
  let calls = 0;
  const { ctx: ctx2, routes: routes2 } = makeFakeCtx();
  await apply(ctx2, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => { calls += 1; return fakeRes(200, OK_BODY); },
  });
  const stats2 = routes2.find((r) => r.path === ROUTES.stats);
  const res2 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats2.handler(fakeReq(), res2);
  await stats2.handler(fakeReq(), res2);
  assert.equal(calls, 1, "TTL 内第二次命中缓存，不重复请求");
  assert.equal(payload.cached, true, "缓存命中标记");
  assert.ok(payload.fetchedAt >= fetchedAt);
}

// history 路由：403（非回环）/ 405（非 GET）/ 200（采样累积后返回序列）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-hist-"));
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => fakeRes(200, OK_BODY),
    persistFile: join(dir, "history.json"),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  const history = routes.find((r) => r.path === ROUTES.history);
  assert.ok(history, "history 路由存在");

  // 403 非回环
  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  history.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "history 非回环 403");

  // 405 非 GET
  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  history.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "history 非 GET 405");

  // 空历史：200 且 samples 为空
  let payload;
  const res2 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  history.handler(fakeReq(), res2);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 0, "未采样前空历史");
  assert.deepEqual(payload.samples, []);

  // 调 stats 触发采样 → history 返回 1 个采样点（三窗口 percent 落位）
  const res3 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res3);
  history.handler(fakeReq(), res3);
  assert.equal(payload.count, 1, "一次成功 fetch 产生一个采样点");
  assert.deepEqual(payload.samples[0].slice(1), [2, 1, 0], "采样点 = [ts, rolling, weekly, monthly] percent");

  // ?days=1 过滤：采样点在 1 天内 → 仍返回
  history.handler(fakeReq({ url: "/api/dsh-opencode-usage/history?days=1" }), res3);
  assert.equal(payload.count, 1, "days=1 内包含当前采样点");

  // 缓存命中不重复采样：TTL 内第二次 stats 仍是 1 个点
  await stats.handler(fakeReq(), res3);
  assert.equal(payload.cached, true, "第二次命中缓存");
  history.handler(fakeReq(), res3);
  assert.equal(payload.count, 1, "缓存命中不产生新采样点");
}

// stats：无 key 时 configured:false + reason:no-api-key（不网络；路径指向不存在文件）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    fetchImpl: async () => fakeRes(200, OK_BODY),
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res);
  assert.equal(payload.configured, false);
  assert.equal(payload.reason, "no-api-key");
  assert.equal(payload.usage, null);
}

// health 路由：200 摘要
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const health = routes.find((r) => r.path === ROUTES.health);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq(), res);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin, "dsh-opencode-usage");
  assert.equal(payload.baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(payload.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
  assert.deepEqual(payload.limits, DEFAULT_CONFIG.limits);
  assert.equal(payload.history.maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "health 带历史摘要");
  assert.equal(typeof payload.history.count, "number");
  assert.equal(typeof payload.history.persistFile, "string");

  const res403 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq({ socket: { remoteAddress: "192.168.1.5" } }), res403);
  assert.equal(payload.error, "forbidden: loopback-only", "health 也强制 loopback");
}

// ---------------------------------------------------------------- 客户端路由一致性

{
  const client = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  const literals = new Set(client.match(/\/api\/[A-Za-z0-9_/-]+/gu) ?? []);
  const hostPaths = new Set([ROUTES.stats, ROUTES.history, ROUTES.health]);
  // client 出现的 /api/ 字面量必须都在 host ROUTES 中（防漂移）
  for (const lit of literals) {
    assert.ok(hostPaths.has(lit), `client 字面量 ${lit} 在 host ROUTES 中存在`);
  }
  // 客户端必须调 stats 与 history；health 是宿主诊断路由，客户端不调（无需出现）
  assert.ok(literals.has(ROUTES.stats), `client bundle 含 ${ROUTES.stats}`);
  assert.ok(literals.has(ROUTES.history), `client bundle 含 ${ROUTES.history}`);
}

// ---------------------------------------------------------------- 客户端浮窗布局/展示（防回归）

{
  const client = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  // 上下排列：MCP 浮窗在场时本胶囊固定在其正下方（top 42 = MCP 8 + 高 26 + 间隙 8）
  assert.ok(client.includes("var repositionPill"), "client 含 repositionPill 定位函数");
  assert.ok(client.includes("[data-dsh-mcp-float]"), "client 识别 MCP 浮窗 [data-dsh-mcp-float]");
  assert.ok(client.includes("? 42 : 8"), "MCP 在场 42px（正下方）/ 不在场 8px（右上角第一行）");
  // 三窗口迷你图卡片：标题行当前值大号加粗 + Δ 趋势 + 限额/重置
  assert.ok(client.includes("font-weight:700;font-size:14px"), "卡片当前值 14px 加粗");
  assert.ok(client.includes("trendOf"), "client 含区间 Δ 趋势计算");
  assert.ok(client.includes("▲ +"), "趋势上升显示 ▲+delta%");
  assert.ok(client.includes("▼ "), "趋势下降显示 ▼delta%");
  // 胶囊直接展示三个窗口百分比（无需展开面板）
  assert.ok(client.includes('parts.push("5h " + u.rolling.percent + "%")'), "胶囊含 5h 滚动百分比");
  assert.ok(client.includes('parts.push("周 " + u.weekly.percent + "%")'), "胶囊含周百分比");
  assert.ok(client.includes('parts.push("月 " + u.monthly.percent + "%")'), "胶囊含月百分比");
  // 状态点取三个窗口最高消耗
  assert.ok(client.includes("worst"), "状态点按三窗口最高消耗着色");
  // 迷你图：独立自适应 y 轴（nice 域）+ 每图独立动态 x 轴 + 100% 参考线 + 平滑 + 降采样
  assert.ok(client.includes("miniChartSvgMarkup"), "client 含迷你图 SVG 渲染");
  assert.ok(client.includes("niceDomain"), "client 含 y 轴自适应 nice 域");
  assert.ok(client.includes("niceStep"), "client 含 nice 刻度步长");
  assert.ok(client.includes("timeTicks"), "client 含时间刻度自适应");
  assert.ok(client.includes("tail - s[4]"), "client 按窗口观察周期动态切片 x 范围");
  assert.ok(client.includes("24 * 36e5"), "rolling x 范围 = 最近 24h（5h 滑动窗口观察周期，esbuild 数字规范化）");
  assert.ok(client.includes("7 * 864e5"), "weekly x 范围 = 最近 7d（自然周一周期，esbuild 数字规范化）");
  assert.ok(client.includes("stroke-dasharray:4 3"), "client 含 100% 配额上限参考虚线");
  assert.ok(client.includes("resetTicks"), "client 含重置点反推");
  assert.ok(client.includes("窗口重置点"), "重置线带悬浮提示");
  assert.ok(client.includes("5 * 36e5"), "rolling 重置周期 5h（esbuild 数字规范化）");
  assert.ok(client.includes("30 * 864e5"), "monthly 重置周期 30d 近似（esbuild 数字规范化）");
  assert.ok(client.includes("fmtAge"), "client 含相对时间新鲜度函数");
  assert.ok(client.includes("分钟前"), "新鲜度显示 x 分钟前");
  assert.ok(client.includes("smoothPath"), "client 含平滑曲线");
  assert.ok(client.includes("downsample"), "client 含降采样");
  assert.ok(client.includes("数据采集中"), "client 含空态引导文案");
  assert.ok(client.includes("CHART_SERIES"), "client 含三窗口图卡片配置");
}

console.log("dsh-opencode-usage smoke: 全部通过 ✅");
