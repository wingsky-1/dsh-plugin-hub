/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  GEN,
  HOUR,
  T0,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  TrendCollector,
  TrendTracker,
  buildStatsSnapshot,
  dayKey,
  fakeLlm,
  generateReport,
  join,
  mkdirSync,
  mkdtempSync,
  textOf,
  tmpdir,
  writeFileSync,
  type StatsSnapshot,
  type TrendDirRow,
} from "./report-generation-support.ts";

type LegacyState = {
  todayKey: string;
  bucketsLen: number;
  sByDirectory: unknown;
  sTotalsCalls: number;
  sTotalsTotal: number | null;
  liveProjection: Array<Array<string | number>>;
  sLiveByDirectory: unknown;
  sByDay: unknown;
  s0ByDirectory: unknown;
  stripS: unknown;
  stripS0: unknown;
  rMetaOk: boolean;
  injectedHasDirBucket: boolean;
  hostileDir: string;
};

function registerLegacyAssertions(state: LegacyState): void {
  it("旧格式分片重建：过去日 agg 权威行 + 当日明细两日全量入内存（不抛错）", () => {
    expect(state.bucketsLen).toBe(2);
  });

  it("byDirectory 未识别桶计入正确数值（窗口外 dir 行不计）", () => {
    expect(state.sByDirectory).toEqual([{ dir: TREND_UNIDENTIFIED, calls: 1, total: 33 }]);
  });

  it("历史输出不缺失：calls 与升级前一致（30+1）", () => {
    expect(state.sTotalsCalls).toBe(31);
  });

  it("历史 token 总量不缺失（5930+1551，四项 null-aware 之和）", () => {
    expect(state.sTotalsTotal).toBe(7481);
  });

  it("真实 dirRows：旧 agg-only 日经残差补入未识别桶（当日明细行亦归未识别）", () => {
    expect(state.liveProjection).toEqual([
      ["2026-09-03", TREND_UNIDENTIFIED, 30],
      [state.todayKey, TREND_UNIDENTIFIED, 1],
    ]);
  });

  it("报告链路端到端：byDirectory 覆盖全窗口（= totals 口径，历史不再从报告消失）", () => {
    expect(state.sLiveByDirectory).toEqual([{ dir: TREND_UNIDENTIFIED, calls: 31, total: 7481 }]);
  });

  it("byDay 旧数据完整（两日总量一致）", () => {
    expect(state.sByDay).toEqual([
      { day: "2026-09-03", total: 5930 },
      { day: state.todayKey, total: 1551 },
    ]);
  });

  it("无 dir 行 → byDirectory 空数组（加性可选维度，不补造）", () => {
    expect(state.s0ByDirectory).toEqual([]);
  });

  it("byProvider/byDay/totals/派生维度与无 dir 维度时完全一致（零回归）", () => {
    expect(state.stripS).toEqual(state.stripS0);
  });

  it("旧格式数据报告生成不抛错且成功", () => {
    expect(state.rMetaOk).toBe(true);
  });

  it("{stats} 注入面含未识别目录桶（dir=TREND_UNIDENTIFIED）", () => {
    expect(state.injectedHasDirBucket).toBeTruthy();
  });

  it("dir 控制字符进快照前已剥离", () => {
    expect(state.hostileDir.includes("\n")).toBeFalsy();
  });

  it("dir 截断至 80 字符（与 byProvider 同口径）", () => {
    expect(state.hostileDir.length).toBe(80);
  });
}

describe("#633 分片 a D1：旧格式（无 cwd/dir 键）报告生成链路回归", () => {
  const todayKey = dayKey(T0);
  const state: LegacyState = { todayKey } as LegacyState;

  beforeAll(async () => {
    const { root, today } = registerLegacyFixture();
    const tracker = await registerLegacyTracker(root);
    await registerLegacyReport(state, tracker, today);
    await tracker.dispose();
    registerLegacyHostileDir(state, today);
  });

  registerLegacyAssertions(state);
});

function registerLegacyFixture(): { root: string; today: string } {
  const root = mkdtempSync(join(tmpdir(), "dou-report-d1-legacy-"));
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(aggDir, { recursive: true });
  mkdirSync(detDir, { recursive: true });
  const today = dayKey(T0); // 2026-09-04
  // 旧格式行（无 dir 键；形态同 unit-trend A2 fixture）：过去日 agg 权威行 + 当日明细/计数行
  const legacyAgg = {
    v: TREND_ROW_VERSION,
    kind: "agg",
    day: "2026-09-03",
    provider: "deepseek",
    model: "deepseek-chat",
    input: 5000,
    output: 800,
    cacheRead: 120,
    cacheWrite: 10,
    calls: 30,
    turns: 12,
    toolCalls: 40,
  };
  const legacyDetail = {
    v: TREND_ROW_VERSION,
    kind: "detail",
    time: T0 - HOUR,
    day: today,
    session: "旧会话-甲",
    turn: 3,
    step: 2,
    retry: 1,
    provider: "deepseek",
    model: "deepseek-chat",
    input: 1200,
    output: 300,
    cacheRead: 45,
    cacheWrite: 6,
    calls: 1,
  };
  const legacyCounter = {
    v: TREND_ROW_VERSION,
    kind: "counter",
    time: T0 - HOUR,
    day: today,
    session: "旧会话-甲",
    provider: "deepseek",
    model: "deepseek-chat",
    turns: 1,
    toolCalls: 1,
  };
  writeFileSync(join(aggDir, "2026-09-03.jsonl"), `${JSON.stringify(legacyAgg)}\n`);
  writeFileSync(
    join(detDir, `${today}.jsonl`),
    `${JSON.stringify(legacyDetail)}\n${JSON.stringify(legacyCounter)}\n`,
  );
  // 链路 1/2（启动重建 + 统计/趋势查询面）：不抛错、两日全量入内存
  return { root, today };
}

async function registerLegacyTracker(
  root: string,
): Promise<Awaited<ReturnType<typeof TrendTracker.start>>> {
  const tracker = await TrendTracker.start({
    makeCollector: (o) => new TrendCollector(o),
    root,
    now: () => T0,
    flushDebounceMs: 60000,
  });
  return tracker;
}

async function registerLegacyReport(
  state: LegacyState,
  tracker: Awaited<ReturnType<typeof TrendTracker.start>>,
  today: string,
): Promise<void> {
  const buckets = tracker.buckets();
  state.bucketsLen = buckets.length;
  // 链路 3（报告生成）：窗口覆盖两日（weekly 形态）——历史输出不缺失
  // 本节手搓 dirRows 只用于验证 buildStatsSnapshot 自身的窗口裁剪与聚合（窗口外
  // dir 行不计）；真实链路的 dirRows 形态见紧随其后的残差投影端到端断言。
  const dirRows: TrendDirRow[] = [
    {
      v: TREND_ROW_VERSION,
      kind: "dir",
      day: today,
      dir: TREND_UNIDENTIFIED,
      input: 22,
      output: 11,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 1,
      toolCalls: 0,
    },
    {
      v: TREND_ROW_VERSION,
      kind: "dir",
      day: "2026-09-10",
      dir: "窗口外",
      input: 999,
      output: 999,
      cacheRead: null,
      cacheWrite: null,
      calls: 9,
      turns: 9,
      toolCalls: 9,
    },
  ];
  const s = buildStatsSnapshot({
    period: "weekly",
    startDay: "2026-09-03",
    endDay: today,
    buckets,
    dirRows,
    prevTotal: null,
  });
  state.sByDirectory = JSON.parse(JSON.stringify(s.byDirectory));
  state.sTotalsCalls = s.totals.calls;
  state.sTotalsTotal = s.totals.total;
  // 残差投影端到端（本次修复）：真实 tracker.dirRows() 喂入 buildStatsSnapshot——
  // 旧格式日（09-03 只有 agg 行）经残差归未识别桶，byDirectory 与 totals 同口径
  // （修复前此处为空数组：历史在报告里也消失）。手搓 dirRows 掩盖过这一差异。
  const live = tracker.dirRows();
  state.liveProjection = live.map((r) => [r.day, r.dir, r.calls]).sort();
  const sLive = buildStatsSnapshot({
    period: "weekly",
    startDay: "2026-09-03",
    endDay: today,
    buckets,
    dirRows: live,
    prevTotal: null,
  });
  state.sLiveByDirectory = JSON.parse(JSON.stringify(sLive.byDirectory));
  state.sByDay = JSON.parse(JSON.stringify(s.byDay));
  // 零回归：同 buckets 无 dir 维度（dirRows 缺省）时既有字段逐字段完全一致
  const s0 = buildStatsSnapshot({
    period: "weekly",
    startDay: "2026-09-03",
    endDay: today,
    buckets,
    prevTotal: null,
  });
  state.s0ByDirectory = JSON.parse(JSON.stringify(s0.byDirectory));
  const strip = (snap: StatsSnapshot): Record<string, unknown> => {
    const clone: Record<string, unknown> = { ...snap };
    delete clone.byDirectory;
    return clone;
  };
  state.stripS = JSON.parse(JSON.stringify(strip(s)));
  state.stripS0 = JSON.parse(JSON.stringify(strip(s0)));
  // {stats} 注入 → generateReport（fake llm）不抛错且成功，byDirectory 进注入面
  const { llm, seen } = fakeLlm();
  const r = await generateReport(
    GEN({
      llm,
      period: "weekly",
      key: "2026-09-03",
      startDay: "2026-09-03",
      endDay: today,
      statsJson: JSON.stringify(s),
    }),
  );
  state.rMetaOk = r.meta.ok;
  state.injectedHasDirBucket = textOf(seen.calls[0]!.messages[0].content[0]).includes(
    JSON.stringify(s.byDirectory[0]),
  );
}

function registerLegacyHostileDir(state: LegacyState, today: string): void {
  const hostile = buildStatsSnapshot({
    period: "daily",
    startDay: today,
    endDay: today,
    buckets: [],
    dirRows: [
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: today,
        dir: `a\nb${"x".repeat(100)}`,
        input: 1,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ],
    prevTotal: null,
  });
  state.hostileDir = hostile.byDirectory[0].dir;
}
