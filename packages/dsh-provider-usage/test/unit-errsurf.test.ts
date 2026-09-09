// @ts-nocheck
/**
 * dsh-provider-usage — unit：域2每层错误面（#670 阶段三 B）+ /health per-layer 段
 * + 崩溃注入冒烟。
 *
 * 覆盖：
 * 1. errsurf 模块行为：累计计数 / 最近 N 条环形缓冲（新在前）/ snapshot 深拷贝 /
 *    时钟注入 / noop 实现 / 未知层忽略；
 * 2. handleHealth per-layer 段：注入错误记录后 /health 反映（记录→呈现链路）；
 * 3. execute 层真实退出冒烟：ReportTaskQueue 执行失败 → warn 出口 → 错误面记录；
 * 4. schedule 层真实退出冒烟：ReportScheduler onDue 失败 → warn 出口 → 错误面记录；
 * 5. apply 集成：装配接线后 /health 携带三键齐 layerErrors（初始零值）。
 *
 * aggregate 层的真实故障（压实/刷盘失败）触发依赖 store 故障注入，成本高，
 * 由 apply.ts 的 TrendTracker warn 接线覆盖（代码路径与 3/4 同构），此处以
 * 模块级记录 + health 断言验证链路。
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert, pollUntil } from "./helpers.ts";
import { makeLayerErrorSurface, makeNoopLayerErrorSurface, LAYER_ERROR_KEYS } from "../src/errsurf.ts";
import { handleHealth } from "../src/routes/ui.ts";
import { ReportTaskQueue } from "../src/report/tasks.ts";
import { ReportScheduler } from "../src/report/scheduler.ts";
import { normalizeReportConfig } from "../src/report/config.ts";

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    ...overrides,
  };
}

function callSyncHandler(handler, req) {
  let payload;
  handler(req, { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(String(chunk)); } });
  return payload;
}

/** handleHealth 的 UiRoutesContext mock（仅 health 用到的面）。 */
function healthContext(layerErrors) {
  return {
    statsService: {
      registry: { snapshot: () => ({ infos: [], enabled: {}, enabledProviders: [], errors: [] }) },
      config: { provider: "opencode-go" },
      cacheSize: () => 0,
      historyRoot: "/tmp/dou-fake-root",
    },
    trend: { stats: () => ({ days: 0, pendingRows: 0, unpersistedRows: 0, lastFlushAt: null }) },
    uiConfig: {},
    sseClients: new Set(),
    broadcastUiConfigChanged: () => {},
    layerErrors,
  };
}

// ---------------------------------------------------------------- 1) errsurf 模块行为

{
  let t = 1_700_000_000_000;
  const surface = makeLayerErrorSurface({ now: () => t });
  const initial = surface.snapshot();
  assert.deepEqual(Object.keys(initial).sort(), [...LAYER_ERROR_KEYS].sort(), "snapshot 三键齐（aggregate/schedule/execute）");
  for (const layer of LAYER_ERROR_KEYS) {
    assert.equal(initial[layer].count, 0, `${layer} 初始 count=0`);
    assert.deepEqual(initial[layer].recent, [], `${layer} 初始 recent 为空`);
  }

  surface.record("aggregate", "压实失败（2026-01-14）：注入故障"); // at = 1700000000000
  t += 1000;
  surface.record("aggregate", "归属异常：resolve 失败", "session-abc"); // at = 1700000001000
  surface.record("execute", "task daily 2026-01-14 执行失败：注入故障");
  const snap = surface.snapshot();
  assert.equal(snap.aggregate.count, 2, "aggregate 累计计数=2");
  assert.equal(snap.execute.count, 1, "execute 累计计数=1");
  assert.equal(snap.aggregate.recent.length, 2, "recent 保留全部 ≤N 记录");
  assert.equal(snap.aggregate.recent[0].message, "归属异常：resolve 失败", "recent 新在前（后记的在前）");
  assert.equal(snap.aggregate.recent[0].context, "session-abc", "context 原样保留");
  assert.equal(snap.aggregate.recent[0].at, t, "时间戳取注入时钟");
  assert.equal(snap.aggregate.recent[1].at, t - 1000, "时间戳逐条取自注入时点");
  assert.equal(snap.schedule.count, 0, "未发生错误的层保持 0");

  // snapshot 深拷贝：改返回对象不影响内部状态
  snap.execute.recent[0].message = "被污染";
  snap.execute.count = 99;
  const again = surface.snapshot();
  assert.equal(again.execute.count, 1, "snapshot 修改不污染内部");
  assert.notEqual(again.execute.recent[0].message, "被污染", "snapshot 修改不污染内部（recent 条目）");

  // 未知层忽略（防御）
  surface.record("bogus", "不应记录");
  assert.deepEqual(Object.keys(surface.snapshot()).sort(), [...LAYER_ERROR_KEYS].sort(), "未知层不新增键");
}

{
  // 环形截断：maxRecent 自定义
  const surface = makeLayerErrorSurface({ maxRecent: 2 });
  for (let i = 1; i <= 3; i++) surface.record("execute", `故障 ${i}`);
  const snap = surface.snapshot();
  assert.equal(snap.execute.count, 3, "截断不影响累计计数");
  assert.equal(snap.execute.recent.length, 2, "recent 截断到 maxRecent=2");
  assert.equal(snap.execute.recent[0].message, "故障 3", "截断保留最新在前");
  assert.equal(snap.execute.recent[1].message, "故障 2", "最旧一条被淘汰");
}

{
  // noop 实现：同形态、零副作用
  const noop = makeNoopLayerErrorSurface();
  noop.record("aggregate", "应被忽略");
  const snap = noop.snapshot();
  for (const layer of LAYER_ERROR_KEYS) {
    assert.equal(snap[layer].count, 0, `noop ${layer}.count=0（record 不记录）`);
    assert.deepEqual(snap[layer].recent, [], `noop ${layer}.recent 恒空`);
  }
}

{
  // context 字段按注入存在与否精确呈现（双向覆盖 if 变异：有/无都必须正确）
  const surface = makeLayerErrorSurface();
  surface.record("aggregate", "无上下文的错误");
  surface.record("aggregate", "带上下文的错误", "daily 2026-01-14");
  const snap = surface.snapshot();
  assert.equal("context" in snap.aggregate.recent[0], true, "注入 context 时记录携带 context");
  assert.equal(snap.aggregate.recent[0].context, "daily 2026-01-14", "context 值原样");
  assert.equal("context" in snap.aggregate.recent[1], false, "未注入 context 时记录不带 context 字段");
}

// ---------------------------------------------------------------- 2) handleHealth per-layer 段（记录→呈现链路）

{
  const surface = makeLayerErrorSurface();
  surface.record("execute", "注入故障：persist 失败（/reports/generate）", "daily 2026-01-14");
  const payload = callSyncHandler((req, res) => handleHealth(req, res, healthContext(surface)), fakeReq());

  assert.equal(payload.ok, true, "health 正常响应");
  const layerErrors = payload.layerErrors;
  assert.ok(layerErrors !== undefined, "health 响应携带 layerErrors 段");
  assert.deepEqual(Object.keys(layerErrors).sort(), [...LAYER_ERROR_KEYS].sort(),
    "layerErrors 三键齐（aggregate/schedule/execute）");
  assert.equal(layerErrors.execute.count, 1, "注入的 execute 故障被 health 反映");
  assert.equal(layerErrors.execute.recent.length, 1, "最近记录条数正确");
  assert.equal(layerErrors.execute.recent[0].message, "注入故障：persist 失败（/reports/generate）",
    "最近记录消息与注入一致");
  assert.equal(typeof layerErrors.execute.recent[0].at, "number", "最近记录带时间戳");
  assert.equal(layerErrors.execute.recent[0].context, "daily 2026-01-14", "最近记录带上下文");
  assert.equal(layerErrors.aggregate.count, 0, "未注入层保持 0（加性段不误报）");
  assert.equal(layerErrors.schedule.count, 0, "未注入层保持 0（加性段不误报）");
  // 与既有段并存（回归护栏：加性字段不破坏原结构）
  assert.ok(Array.isArray(payload.adapters), "adapters 段保留");
  assert.ok(Array.isArray(payload.errors), "errors 段保留");
  assert.ok(payload.trend !== undefined, "trend 段保留");
}

// ---------------------------------------------------------------- 3) execute 层真实退出冒烟（ReportTaskQueue）

{
  const surface = makeLayerErrorSurface();
  const queue = new ReportTaskQueue({
    executor: async () => { throw new Error("注入故障：生成器崩溃"); },
    warn: (m) => surface.record("execute", m),
  });
  queue.submit({ period: "daily", key: "2026-01-14", startDay: "2026-01-14", endDay: "2026-01-14" });
  const surfaced = await pollUntil(() => surface.snapshot().execute.count >= 1);
  assert.equal(surfaced, true, "队列执行失败经 warn 出口进入 execute 层错误面");
  const snap = surface.snapshot();
  assert.ok(snap.execute.recent[0].message.includes("注入故障：生成器崩溃"),
    "任务失败消息内容原样记录（含 task 定位）");
  assert.equal(snap.execute.count, 1, "单次失败计数=1");
}

// ---------------------------------------------------------------- 4) schedule 层真实退出冒烟（ReportScheduler onDue 失败）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-errsurf-schedule-"));
  const surface = makeLayerErrorSurface();
  const scheduler = ReportScheduler.start({
    root: dir,
    config: normalizeReportConfig({ daily: { enabled: true, time: "00:00" } }),
    now: () => new Date(2026, 0, 15, 12, 0).getTime(),
    onDue: async () => { throw new Error("注入故障：调度提交崩溃"); },
    warn: (m) => surface.record("schedule", m),
  });
  try {
    await scheduler.tick(); // start 内异步首 tick 之外，再显式走一轮（断言同步化）
    const surfaced = await pollUntil(() => surface.snapshot().schedule.count >= 1);
    assert.equal(surfaced, true, "调度提交失败经 warn 出口进入 schedule 层错误面");
    assert.ok(surface.snapshot().schedule.recent[0].message.includes("注入故障：调度提交崩溃"),
      "调度失败消息内容原样记录");
  } finally {
    scheduler.dispose();
  }
}

// ---------------------------------------------------------------- 5) apply 集成：装配接线后 /health 携带 layerErrors

{
  const dir = mkdtempSync(join(tmpdir(), "dou-errsurf-apply-"));
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "dshhome");
  mkdirSync(process.env.DSH_HOME, { recursive: true });
  const historyDir = join(dir, "history");
  mkdirSync(historyDir, { recursive: true });
  try {
    const { apply, ROUTES } = await import("../lib/index.js");
    const routes = [];
    const disposers = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: () => () => {},
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => { cb({ settings: {} }); },
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { autoReload: false, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9", historyDir });
    const health = routes.find((r) => r.path === ROUTES.health);
    assert.ok(health !== undefined, "apply 挂载 health 路由");
    const payload = callSyncHandler(health.handler, fakeReq());
    const layerErrors = payload.layerErrors;
    assert.ok(layerErrors !== undefined, "apply 接线后 /health 携带 layerErrors");
    assert.deepEqual(Object.keys(layerErrors).sort(), [...LAYER_ERROR_KEYS].sort(), "三键齐");
    for (const layer of LAYER_ERROR_KEYS) {
      assert.equal(layerErrors[layer].count, 0, `初始 ${layer}.count=0（无故障时零污染）`);
      assert.deepEqual(layerErrors[layer].recent, [], `初始 ${layer}.recent 空`);
    }
    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
}