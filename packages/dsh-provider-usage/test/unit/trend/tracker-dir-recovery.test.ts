/** dsh-provider-usage — unit: 目录恢复、prune 与校正。 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_ROW_VERSION } from "../../../src/server/shared/interface.ts";
import {
  TrendAggregator,
  TrendStore,
  type TrendStackPart,
  type TrendStackPoint,
} from "../../../src/server/aggregate/interface.ts";
import {
  TrendCollector,
  type TrendAggRow,
  type TrendCell,
  type TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import { type TrendDirRow } from "../../../src/server/shared/interface.ts";
import { DAY0, HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { cellTotals, HOUR } from "./aggregator-test-support.ts";
import { tmpdir } from "node:os";

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function loadPruneFixture() {
  const day1 = "2026-09-03";
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      {
        v: 1,
        kind: "agg",
        day: day1,
        provider: "p",
        model: "m",
        input: 1,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: 1,
        kind: "dir",
        day: day1,
        dir: "stale",
        input: 1,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: 1,
        kind: "agg",
        day: DAY0,
        provider: "p",
        model: "m",
        input: 2,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: 1,
        kind: "dir",
        day: DAY0,
        dir: "keep",
        input: 2,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ],
    false,
  );
  const prunedDays = agg.pruneDays(DAY0);
  const daysHasDay1 = agg["days"].has(day1);
  const dirDaysHasDay1 = agg["dirDays"].has(day1);
  const keptDirInput = agg["dirDays"].get(DAY0)?.get("keep")?.input;

  return { prunedDays, daysHasDay1, dirDaysHasDay1, keptDirInput };
}

async function loadRecoveryFixture() {
  // M1(b)：复核 M1 修复——自愈压实路径 dir 行为 + pruneDays 联动删除（P1-1 口径更新）。
  // 自愈：过去日明细（含 dir）无聚合分片 → start 重建 + rollupDay 压实；dir 折算
  // 同源走 pending 行（takeDirUnpersisted 不过滤 persisted），重建行折算不丢——
  // P1-1 后 rebuild 明细/计数分支平行折算进 dirDays（与 cells 同策略双面入账，
  // dirDays 为唯一事实源、dirRows 纯快照），自愈后内存查询面立即恢复该日目录
  // 行（修复前随 dropPending 消失，须重启读回）。
  const root = createRoot("dou-trend-m1-heal-");
  const day1 = "2026-09-03";
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  writeFileSync(
    join(detDir, `${day1}.jsonl`),
    [
      JSON.stringify({
        v: 1,
        kind: "detail",
        time: T0 - 24 * HOUR,
        day: day1,
        session: "sx",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        dir: "heal",
        input: 7,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
      }),
      JSON.stringify({
        v: 1,
        kind: "counter",
        time: T0 - 24 * HOUR,
        day: day1,
        session: "sx",
        provider: "p",
        model: "m",
        dir: "heal",
        turns: 1,
        toolCalls: 1,
      }),
      "",
    ].join("\n"),
  );
  const tracker = await TrendTracker.start({
    makeCollector: (o) => new TrendCollector(o),
    root,
    now: () => T0,
    flushDebounceMs: 60000,
  });
  const healedDirRows = snapshot(
    (await new TrendStore({ root }).readAggDayShard(day1)).filter((r) => r.kind === "dir"),
  );
  const healDirDayCell = snapshot(tracker["aggregator"]["dirDays"].get(day1)?.get("heal"));
  const dirRowsForDay = snapshot(tracker.dirRows().filter((r) => r.day === day1));
  const healedCells = tracker.buckets().find((d) => d.day === day1)!.providers[0].cell.calls;
  await tracker.dispose();

  return { healedDirRows, healDirDayCell, dirRowsForDay, healedCells };
}

describe("复核 M1(a)：混存分片重启重建后 dirDays 恢复（dir 行真读回）", () => {
  let dirMapExists: boolean;
  let dirMapValues: Array<{
    dir: string;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  }>;
  let cellValues: {
    input: number | null;
    output: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let pendingRows: number;

  beforeAll(async () => {
    // M1(a)：复核 M1 修复——混存分片（agg+dir）重启重建后内存 dirDays 恢复：
    // rebuildFromDisk 走 readAggDayShard 真读回 dir 行（经 rebuild dir 分支进
    // dirDays，该分支由死分支变可达）；dir 行不进 cells/pending（防双计语义不变）。
    // dirDays 当前无查询面消费，恢复断言走白盒（tracker.aggregator.dirDays）+
    // cells 行为面锚定（读回不双算）。
    const root = createRoot("dou-trend-m1-rebuild-");
    let nowMs = T0;
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent(
      { id: "s2" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 5),
    );
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 6));
    nowMs = T0 + 24 * HOUR;
    await tracker.flushNow(); // 压实：agg+dir 混存落盘、明细分片删除
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => undefined,
    });
    // 白盒：privates 经 bracket 访问（元素访问不触发可见性检查；运行时同形）。
    const dirMap = tracker["aggregator"]["dirDays"].get(DAY0);
    dirMapExists = dirMap !== undefined;
    dirMapValues = snapshot(
      [...dirMap!.entries()].map(([dir, c]) => ({
        dir,
        input: c.input,
        output: c.output,
        cacheRead: c.cacheRead,
        cacheWrite: c.cacheWrite,
        calls: c.calls,
        turns: c.turns,
        toolCalls: c.toolCalls,
      })),
    );
    const cell = tracker.buckets().find((d) => d.day === DAY0)!.providers[0].cell;
    cellValues = snapshot({
      input: cell.input,
      output: cell.output,
      calls: cell.calls,
      turns: cell.turns,
      toolCalls: cell.toolCalls,
    });
    pendingRows = tracker["aggregator"].stats().pendingRows;
    await tracker.dispose();
  }, 60_000);

  it("重启重建：dirDays 恢复该日目录桶（M1 修复前恒空）", () => {
    expect(dirMapExists).toBeTruthy();
  });

  it("dirDays 恢复值与分片 dir 行逐字段一致（读回不丢不变形）", () => {
    expect(dirMapValues).toEqual([
      {
        dir: "alpha",
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 1,
        toolCalls: 0,
      },
      {
        dir: "beta",
        input: 7,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 1,
      },
    ]);
  });

  it("dir 行读回不双算进 cells（agg 行权威，calls=2 而非 4）", () => {
    expect(cellValues).toEqual({ input: 17, output: 12, calls: 2, turns: 1, toolCalls: 1 });
  });

  it("dir 行不进 pending（不二次落盘）", () => {
    expect(pendingRows).toBe(0);
  });
});

describe("复核 M1(b)：自愈压实 dir 行 + pruneDays 联动删除 dirDays", () => {
  let healedDirRows: Array<TrendAggRow | TrendDirRow | TrendHourRow>;
  let healDirDayCell: TrendCell | undefined;
  let dirRowsForDay: TrendDirRow[];
  let healedCells: number;

  beforeAll(async () => {
    ({ healedDirRows, healDirDayCell, dirRowsForDay, healedCells } = await loadRecoveryFixture());
  }, 60_000);

  it("自愈压实：dir 行从 pending 重建行同源折算，calls/turns/toolCalls 不丢", () => {
    expect(healedDirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: "heal",
        input: 7,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });

  it("rebuild 明细/计数行平行折算进 dirDays（P1-1：过去日桶保留，与分片 dir 行值一致不重）", () => {
    expect(healDirDayCell).toEqual({
      input: 7,
      output: 3,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 1,
      toolCalls: 1,
    });
  });

  it("自愈后目录查询面立即恢复（不随 dropPending 消失，修复前须重启读回）", () => {
    expect(dirRowsForDay).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: "heal",
        input: 7,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });

  it("自愈重建 cells 行为不变", () => {
    expect(healedCells).toBe(1);
  });

  describe("pruneDays 联动（单元面）", () => {
    // pruneDays 联动（单元面）：dirDays 与 days 同生命周期，cutoff 前日桶同步删除
    // （M1 修复前只删 days，dirDays 泄漏有界但违背同生命周期口径）。
    let prunedDays: number;
    let daysHasDay1: boolean;
    let dirDaysHasDay1: boolean;
    let keptDirInput: number | null | undefined;

    beforeAll(() => {
      ({ prunedDays, daysHasDay1, dirDaysHasDay1, keptDirInput } = loadPruneFixture());
    });

    it("pruneDays 返回 days 侧删除日数（语义不变）", () => {
      expect(prunedDays).toBe(1);
    });

    it("pruneDays：cutoff 前 days 日桶删除", () => {
      expect(daysHasDay1).toBe(false);
    });

    it("pruneDays：dirDays 联动删除（与 dropPending 对称）", () => {
      expect(dirDaysHasDay1).toBe(false);
    });

    it("cutoff 内 dirDays 日桶不受连坐", () => {
      expect(keptDirInput).toBe(2);
    });
  });
});

describe("复核 P1-1(a)：常驻运行期跨天（压实后 Day0 目录面保留）", () => {
  let day0DirRows: TrendDirRow[];
  let stackedDay0: TrendStackPoint | undefined;
  let stackedTodayParts: TrendStackPart[] | undefined;

  beforeAll(async () => {
    // 复核 P1-1(a)：常驻运行期跨天——Day0 写入并压实（flushInner 日切）→ 不重启
    // 继续 Day1 apply → byDir 面（dirStacked）Day0 柱非 null 且数值正确。
    // 修复前：dropPending 联动删除过去日 dirDays，dirRows 纯内存无分片回读 →
    // Day0 柱恒 null（实测空柱）；修复后 dirDays 只随 pruneDays 收缩。
    const root = createRoot("dou-trend-p11-crossday-");
    let nowMs = T0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 3));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 4));
    nowMs = T0 + 24 * HOUR; // Day1 日切
    await tracker.flushNow(); // Day0 压实（修复前此处联动删除 dirDays[Day0]）
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), nowMs, 5));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(3, 3), nowMs, 6));
    day0DirRows = snapshot(tracker.dirRows().filter((r) => r.day === DAY0));
    // dirStacked 确定性来自注入时钟（this.now），第 5 实参为历史死参（多余实参运行时恒忽略）。
    const stacked = tracker.dirStacked(2, "day", "input", undefined);
    stackedDay0 = snapshot(stacked.series.find((p) => p.key === DAY0));
    stackedTodayParts = snapshot(stacked.series.find((p) => p.key === dayKey(nowMs))?.parts);
    await tracker.dispose();
  }, 60_000);

  it("跨天不重启：压实后 Day0 目录行保留（修复前恒空）", () => {
    expect(day0DirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "alpha",
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "beta",
        input: 7,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("byDir 面 Day0 柱非 null：alpha=10/beta=7 按 dir 拆段", () => {
    expect(stackedDay0).toEqual({
      key: DAY0,
      parts: [
        { provider: "alpha", model: null, value: 10 },
        { provider: "beta", model: null, value: 7 },
      ],
      total: 17,
    });
  });

  it("Day1 当日柱照常（跨天压实不波及当日目录桶）", () => {
    expect(stackedTodayParts).toEqual([{ provider: "alpha", model: null, value: 3 }]);
  });
});

describe("复核 P1-1(b)：重启恢复后同日继续 apply（dirRows 当日 = 真实值）", () => {
  let dirRows: TrendDirRow[];
  let stackedTotal: number | null;

  beforeAll(async () => {
    // 复核 P1-1(b)：重启恢复后同日继续 apply——dirRows()/dirStacked 当日数值 =
    // 真实值（重启前 10 + 重启后 7 = 17，非 2× 非丢数）。
    // 修复前：重启后当日重建明细行（persisted=true）与 dirDays（apply 事实）并存
    // 两个事实源，折算侧 seen 按键去重只挡同键——互补事实被挡掉（实测 dirRows=7
    // 丢重启前 10），同事实并存则 2×。P1-1 后 rebuild 明细行平行折算进 dirDays、
    // dirRows 纯快照单源，结构性无重无漏。
    const root = createRoot("dou-trend-p11-sameday-");
    const nowMs = T0; // 当日（detail 分片 day === today，不走自愈压实）
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/w/alpha",
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    await tracker.flushNow(); // 当日明细落盘（persisted=true，pending 保留）
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/w/alpha",
    });
    // 重启后：当日无聚合分片 → dirDays 该日为空，重建明细行的 dir 事实在 rebuild
    // 时折算入桶；同日续 apply 在同桶上平行累加（单源相加 = 真实值）。
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0 + HOUR, 3));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0 + HOUR, 4));
    dirRows = snapshot(tracker.dirRows());
    stackedTotal = tracker.dirStacked(1, "day", "input", undefined).series[0].total;
    await tracker.dispose();
  }, 60_000);

  it("同日重启+续 apply：dirRows 当日 = 真实值 17（非 2× 非丢数）", () => {
    expect(dirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "alpha",
        input: 17,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("dirStacked 当日 total=17（双算防线下真实值）", () => {
    expect(stackedTotal).toBe(17);
  });
});

describe("复核 P1-1(c)：correct 校正双面同步（dirDays 不漂移）", () => {
  let cellPair: { input: number | null; output: number | null };
  let dirDayCell: TrendCell | undefined;

  beforeAll(() => {
    // 复核 P1-1(c)：correct 校正双面同步——dirDays 随 retokenCell 修正，目录查询
    // 面与 cells/落盘明细一致（旧实现只修 cells、靠折算侧取 pending 新值掩盖漂移，
    // 单源化后不同步即固化错值）。
    const agg = new TrendAggregator();
    agg.apply({
      type: "call",
      record: {
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        dir: "proj",
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    });
    // correct 记录无 time 字段（同上，死字段删除）。
    agg.apply({
      type: "correct",
      record: {
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const cell = cellTotals(agg, DAY0)!;
    cellPair = snapshot({ input: cell.input, output: cell.output });
    dirDayCell = snapshot(agg["dirDays"].get(DAY0)?.get("proj"));
  });

  it("correct：cells 修正（既有语义零回归）", () => {
    expect(cellPair).toEqual({ input: 200, output: 60 });
  });

  it("correct：dirDays 同步修正（目录查询面不漂移）", () => {
    expect(dirDayCell).toEqual({
      input: 200,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 1,
      turns: 0,
      toolCalls: 0,
    });
  });
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
