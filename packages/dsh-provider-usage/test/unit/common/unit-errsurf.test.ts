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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import { makeLayerErrorSurface, makeNoopLayerErrorSurface, LAYER_ERROR_KEYS } from "../../../src/domain2/common/errsurf.ts";
import { handleHealth } from "../../../src/domain2/routes/ui.ts";
import { ReportTaskQueue } from "../../../src/domain2/schedule/tasks.ts";
import { ReportScheduler } from "../../../src/domain2/schedule/scheduler.ts";
import { normalizeReportConfig } from "../../../src/domain2/schedule/config.ts";

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

describe("1) errsurf 模块行为", () => {
  // 累计计数 / 环形缓冲 / 深拷贝 / 时钟注入 / 未知层忽略共用同一现场：
  // beforeAll 复现动作序列并快照每条断言当时读到的观测值。
  let initial, snap, again, surface, t, executeCountBeforeTamper;

  beforeAll(() => {
    t = 1_700_000_000_000;
    surface = makeLayerErrorSurface({ now: () => t });
    initial = surface.snapshot();

    surface.record("aggregate", "压实失败（2026-01-14）：注入故障"); // at = 1700000000000
    t += 1000;
    surface.record("aggregate", "归属异常：resolve 失败", "session-abc"); // at = 1700000001000
    surface.record("execute", "task daily 2026-01-14 执行失败：注入故障");
    snap = surface.snapshot();

    // snapshot 深拷贝：改返回对象不影响内部状态（先快照被断言的值，再做污染写入）
    executeCountBeforeTamper = snap.execute.count;
    snap.execute.recent[0].message = "被污染";
    snap.execute.count = 99;
    again = surface.snapshot();

    // 未知层忽略（防御）
    surface.record("bogus", "不应记录");
  });

  it("snapshot 三键齐（aggregate/schedule/execute）", () => {
    expect(Object.keys(initial).sort()).toEqual([...LAYER_ERROR_KEYS].sort());
  });

  for (const layer of LAYER_ERROR_KEYS) {
    it(`${layer} 初始 count=0`, () => {
      expect(initial[layer].count).toBe(0);
    });

    it(`${layer} 初始 recent 为空`, () => {
      expect(initial[layer].recent).toEqual([]);
    });
  }

  it("aggregate 累计计数=2", () => {
    expect(snap.aggregate.count).toBe(2);
  });

  it("execute 累计计数=1", () => {
    expect(executeCountBeforeTamper).toBe(1);
  });

  it("recent 保留全部 ≤N 记录", () => {
    expect(snap.aggregate.recent.length).toBe(2);
  });

  it("recent 新在前（后记的在前）", () => {
    expect(snap.aggregate.recent[0].message).toBe("归属异常：resolve 失败");
  });

  it("context 原样保留", () => {
    expect(snap.aggregate.recent[0].context).toBe("session-abc");
  });

  it("时间戳取注入时钟", () => {
    expect(snap.aggregate.recent[0].at).toBe(t);
  });

  it("时间戳逐条取自注入时点", () => {
    expect(snap.aggregate.recent[1].at).toBe(t - 1000);
  });

  it("未发生错误的层保持 0", () => {
    expect(snap.schedule.count).toBe(0);
  });

  it("snapshot 修改不污染内部", () => {
    expect(again.execute.count).toBe(1);
  });

  it("snapshot 修改不污染内部（recent 条目）", () => {
    expect(again.execute.recent[0].message).not.toBe("被污染");
  });

  it("未知层不新增键", () => {
    expect(Object.keys(surface.snapshot()).sort()).toEqual([...LAYER_ERROR_KEYS].sort());
  });
});

describe("1) errsurf 环形截断：maxRecent 自定义", () => {
  let snap;

  beforeAll(() => {
    const surface = makeLayerErrorSurface({ maxRecent: 2 });
    for (let i = 1; i <= 3; i++) surface.record("execute", `故障 ${i}`);
    snap = surface.snapshot();
  });

  it("截断不影响累计计数", () => {
    expect(snap.execute.count).toBe(3);
  });

  it("recent 截断到 maxRecent=2", () => {
    expect(snap.execute.recent.length).toBe(2);
  });

  it("截断保留最新在前", () => {
    expect(snap.execute.recent[0].message).toBe("故障 3");
  });

  it("最旧一条被淘汰", () => {
    expect(snap.execute.recent[1].message).toBe("故障 2");
  });
});

describe("1) errsurf noop 实现：同形态、零副作用", () => {
  let snap;

  beforeAll(() => {
    const noop = makeNoopLayerErrorSurface();
    noop.record("aggregate", "应被忽略");
    snap = noop.snapshot();
  });

  for (const layer of LAYER_ERROR_KEYS) {
    it(`noop ${layer}.count=0（record 不记录）`, () => {
      expect(snap[layer].count).toBe(0);
    });

    it(`noop ${layer}.recent 恒空`, () => {
      expect(snap[layer].recent).toEqual([]);
    });
  }
});

describe("1) errsurf context 字段按注入存在与否精确呈现（双向覆盖 if 变异）", () => {
  let snap;

  beforeAll(() => {
    const surface = makeLayerErrorSurface();
    surface.record("aggregate", "无上下文的错误");
    surface.record("aggregate", "带上下文的错误", "daily 2026-01-14");
    snap = surface.snapshot();
  });

  it("注入 context 时记录携带 context", () => {
    expect("context" in snap.aggregate.recent[0]).toBe(true);
  });

  it("context 值原样", () => {
    expect(snap.aggregate.recent[0].context).toBe("daily 2026-01-14");
  });

  it("未注入 context 时记录不带 context 字段", () => {
    expect("context" in snap.aggregate.recent[1]).toBe(false);
  });
});

describe("2) handleHealth per-layer 段（记录→呈现链路）", () => {
  let payload;

  beforeAll(() => {
    const surface = makeLayerErrorSurface();
    surface.record("execute", "注入故障：persist 失败（/reports/generate）", "daily 2026-01-14");
    payload = callSyncHandler((req, res) => handleHealth(req, res, healthContext(surface)), fakeReq());
  });

  it("health 正常响应", () => {
    expect(payload.ok).toBe(true);
  });

  it("health 响应携带 layerErrors 段", () => {
    expect(payload.layerErrors !== undefined).toBeTruthy();
  });

  it("layerErrors 三键齐（aggregate/schedule/execute）", () => {
    expect(Object.keys(payload.layerErrors).sort()).toEqual([...LAYER_ERROR_KEYS].sort());
  });

  it("注入的 execute 故障被 health 反映", () => {
    expect(payload.layerErrors.execute.count).toBe(1);
  });

  it("最近记录条数正确", () => {
    expect(payload.layerErrors.execute.recent.length).toBe(1);
  });

  it("最近记录消息与注入一致", () => {
    expect(payload.layerErrors.execute.recent[0].message).toBe("注入故障：persist 失败（/reports/generate）");
  });

  it("最近记录带时间戳", () => {
    expect(typeof payload.layerErrors.execute.recent[0].at).toBe("number");
  });

  it("最近记录带上下文", () => {
    expect(payload.layerErrors.execute.recent[0].context).toBe("daily 2026-01-14");
  });

  it("未注入层保持 0（加性段不误报）", () => {
    expect(payload.layerErrors.aggregate.count).toBe(0);
  });

  it("未注入层保持 0（加性段不误报）", () => {
    expect(payload.layerErrors.schedule.count).toBe(0);
  });

  // 与既有段并存（回归护栏：加性字段不破坏原结构）
  it("adapters 段保留", () => {
    expect(Array.isArray(payload.adapters)).toBeTruthy();
  });

  it("errors 段保留", () => {
    expect(Array.isArray(payload.errors)).toBeTruthy();
  });

  it("trend 段保留", () => {
    expect(payload.trend !== undefined).toBeTruthy();
  });
});

describe("3) execute 层真实退出冒烟（ReportTaskQueue）", () => {
  let surfaced, snap;

  beforeAll(async () => {
    const surface = makeLayerErrorSurface();
    const queue = new ReportTaskQueue({
      executor: async () => { throw new Error("注入故障：生成器崩溃"); },
      warn: (m) => surface.record("execute", m),
    });
    queue.submit({ period: "daily", key: "2026-01-14", startDay: "2026-01-14", endDay: "2026-01-14" });
    surfaced = await pollUntil(() => surface.snapshot().execute.count >= 1);
    snap = surface.snapshot();
  });

  it("队列执行失败经 warn 出口进入 execute 层错误面", () => {
    expect(surfaced).toBe(true);
  });

  it("任务失败消息内容原样记录（含 task 定位）", () => {
    expect(snap.execute.recent[0].message.includes("注入故障：生成器崩溃")).toBeTruthy();
  });

  it("单次失败计数=1", () => {
    expect(snap.execute.count).toBe(1);
  });
});

describe("4) schedule 层真实退出冒烟（ReportScheduler onDue 失败）", () => {
  const probeSchedulerFailure = async () => {
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
      return { surfaced, message: surface.snapshot().schedule.recent[0]?.message };
    } finally {
      scheduler.dispose();
    }
  };

  it("调度提交失败经 warn 出口进入 schedule 层错误面", async () => {
    expect((await probeSchedulerFailure()).surfaced).toBe(true);
  });

  it("调度失败消息内容原样记录", async () => {
    expect((await probeSchedulerFailure()).message?.includes("注入故障：调度提交崩溃")).toBeTruthy();
  });
});

describe("5) apply 集成：装配接线后 /health 携带 layerErrors", () => {
  let savedDshHome, health, payload, disposers = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-errsurf-apply-"));
    savedDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, "dshhome");
    mkdirSync(process.env.DSH_HOME, { recursive: true });
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });

    const { apply, ROUTES } = await import("../../../src/apply/index.ts");
    const routes = [];
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
    health = routes.find((r) => r.path === ROUTES.health);
    payload = health === undefined ? undefined : callSyncHandler(health.handler, fakeReq());
  });

  afterAll(() => {
    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  });

  it("apply 挂载 health 路由", () => {
    expect(health !== undefined).toBeTruthy();
  });

  it("apply 接线后 /health 携带 layerErrors", () => {
    expect(payload?.layerErrors !== undefined).toBeTruthy();
  });

  it("三键齐", () => {
    expect(Object.keys(payload.layerErrors).sort()).toEqual([...LAYER_ERROR_KEYS].sort());
  });

  for (const layer of LAYER_ERROR_KEYS) {
    it(`初始 ${layer}.count=0（无故障时零污染）`, () => {
      expect(payload.layerErrors[layer].count).toBe(0);
    });

    it(`初始 ${layer}.recent 空`, () => {
      expect(payload.layerErrors[layer].recent).toEqual([]);
    });
  }
});
