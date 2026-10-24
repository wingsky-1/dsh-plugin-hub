/** dsh-provider-usage — unit: 目录残差投影。 */
import { beforeAll, describe, expect, it } from "vitest";
import { TREND_ROW_VERSION, TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import { type TrendCallRecord } from "../../../src/server/collect/interface.ts";
import { T0, snapshot } from "./collector-test-support.ts";
import { HOUR } from "./aggregator-test-support.ts";

function loadMixedProjection(day: string, mkAgg: () => TrendAggregator) {
  // (c) 混版日（旧 agg 行 + 新 dir 行并存）→ 残差 = 旧 agg 部分，新 dir 行照常分目录
  const c = mkAgg();
  c.rebuild(
    [
      {
        v: TREND_ROW_VERSION,
        kind: "agg",
        day,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 5000,
        output: 800,
        cacheRead: 120,
        cacheWrite: 10,
        calls: 30,
        turns: 12,
        toolCalls: 40,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day,
        dir: "alpha",
        input: 2000,
        output: 300,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 10,
        turns: 4,
        toolCalls: 12,
      },
    ],
    false,
  );
  const cDirsSorted = snapshot(
    c
      .dirRows()
      .map((r) => [r.dir, r.input, r.calls])
      .sort(),
  );

  return { cDirsSorted };
}

function loadDirectoryOnlyProjection(day: string, mkAgg: () => TrendAggregator) {
  // (d) 只有目录面事实（无聚合面）→ 不补造（残差行只在聚合面 > 目录面时产生）
  const d = mkAgg();
  d.rebuild(
    [
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day,
        dir: "alpha",
        input: 900,
        output: 90,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 9,
        turns: 3,
        toolCalls: 9,
      },
    ],
    false,
  );
  const dDirs = snapshot(d.dirRows().map((r) => r.dir));

  // (e) 已删（H9）：双面总量守恒恒等由 ledger 台账守恒对账更强钉住（四视角逐日逐字段）。

  return { dDirs };
}

function loadSameKeyProjection(day: string, mkAgg: () => TrendAggregator) {
  // (f) 同键唯一：该日 dirDays 已有 (unidentified) 桶 + 残差 > 0（混版日）→ 合并为一行
  const f = mkAgg();
  f.rebuild(
    [
      {
        v: TREND_ROW_VERSION,
        kind: "agg",
        day,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 5000,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        calls: 30,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day,
        dir: TREND_UNIDENTIFIED,
        input: 100,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        calls: 10,
        turns: 0,
        toolCalls: 0,
      },
    ],
    false,
  );
  const fRows = f.dirRows();
  const fRowsLength = fRows.length;
  const fRowValues = snapshot([fRows[0].dir, fRows[0].input, fRows[0].calls]);

  return { fRowsLength, fRowValues };
}

function loadNegativeProjection(day: string, mkAgg: () => TrendAggregator) {
  // (g) 负残差（目录面 > 聚合面，数据异常征兆）→ 不产行、不产生负值，恒等不成立
  const g = mkAgg();
  g.rebuild(
    [
      {
        v: TREND_ROW_VERSION,
        kind: "agg",
        day,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 100,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day,
        dir: "alpha",
        input: 300,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        calls: 3,
        turns: 0,
        toolCalls: 0,
      },
    ],
    false,
  );
  const gDirs = snapshot(g.dirRows().map((r) => [r.dir, r.input, r.calls]));

  return { gDirs };
}

function loadOrderedProjection(
  day: string,
  mkAgg: () => TrendAggregator,
  call: (dir: string, input: number, output: number) => TrendCallRecord,
) {
  // (h) 行序契约：时钟回拨把旧日事件落进过去日桶（cells 插入序乱）→ dirRows 仍按 day 升序
  const h = mkAgg();
  h.apply({
    type: "call",
    record: { ...call("beta", 10, 0), time: new Date(2026, 8, 6, 12).getTime() },
  });
  h.apply({
    type: "call",
    record: { ...call("alpha", 10, 0), time: new Date(2026, 8, 8, 12).getTime() },
  });
  h.apply({
    type: "call",
    record: { ...call("gamma", 10, 0), time: new Date(2026, 8, 7, 12).getTime() },
  });
  const hDays = snapshot(h.dirRows().map((r) => r.day));

  // (i) 已删（H9）：prune 联动删除残差行由 M1(b) 单元面 pruneDays 联动钉住（同生命周期）。

  return { hDays };
}

function loadCorrectedProjection(day: string, mkAgg: () => TrendAggregator) {
  // (j) 校正后：旧格式（无 dir 键）明细行 correct → 残差吸收增量（dirRows 随之变化）
  const j = mkAgg();
  j.rebuild(
    [
      {
        v: TREND_ROW_VERSION,
        kind: "detail",
        time: T0 - 24 * HOUR,
        day,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 10,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
      },
    ],
    false,
  );
  const jInputBefore = j.dirRows()[0].input;
  j.apply({
    type: "correct",
    record: {
      session: "s1",
      turn: 1,
      step: 1,
      retry: 1,
      tokens: { input: 50, output: 0, cacheRead: null, cacheWrite: null },
    },
  });
  const jInputAfter = j.dirRows()[0].input;

  return { jInputBefore, jInputAfter };
}

function loadProjectionFixture() {
  // 残差投影纯函数面：cells（聚合面）与 dirDays（目录面）的关系决定是否补造。
  const day = "2026-09-03";
  const mkAgg = () => new TrendAggregator();
  const call = (dir: string, input: number, output: number): TrendCallRecord => ({
    time: T0 - 24 * HOUR,
    session: "s1",
    turn: 1,
    step: 1,
    retry: 1,
    provider: "deepseek",
    model: "deepseek-chat",
    dir,
    tokens: { input, output, cacheRead: null, cacheWrite: null },
  });

  // (b) 已删（H9）：旧格式 agg-only 残差形状由本文件末段真实升级 e2e 钉住
  // （1 行/历史日/未识别/calls/分片不变/面板值）；7 字段逐值精度随删已登记。

  const { cDirsSorted } = loadMixedProjection(day, mkAgg);
  const { dDirs } = loadDirectoryOnlyProjection(day, mkAgg);
  const { fRowsLength, fRowValues } = loadSameKeyProjection(day, mkAgg);
  const { gDirs } = loadNegativeProjection(day, mkAgg);
  const { hDays } = loadOrderedProjection(day, mkAgg, call);
  const { jInputBefore, jInputAfter } = loadCorrectedProjection(day, mkAgg);
  return { cDirsSorted, dDirs, fRowsLength, fRowValues, gDirs, hDays, jInputBefore, jInputAfter };
}

describe("#633 修复：目录面残差投影（纯函数面 c/d/f/g/h/j）", () => {
  let cDirsSorted: Array<Array<string | number | null>>;
  let dDirs: string[];
  let fRowsLength: number;
  let fRowValues: Array<string | number | null>;
  let gDirs: Array<Array<string | number | null>>;
  let hDays: string[];
  let jInputBefore: number | null;
  let jInputAfter: number | null;

  beforeAll(() => {
    ({ cDirsSorted, dDirs, fRowsLength, fRowValues, gDirs, hDays, jInputBefore, jInputAfter } =
      loadProjectionFixture());
  });

  // H9 已删（a/b）：残差 0 不补造由 ledger 守恒对账隐含（多造一行即总量失衡）；
  // 旧 agg-only 三条由末段真实升级 e2e 钉住。混版（c）独无他处 pin，保留：
  it("混版日：残差 = agg − dir（归未识别），新 dir 行照常分目录，两者不重叠", () => {
    expect(cDirsSorted).toEqual([
      ["(unidentified)", 3000, 20],
      ["alpha", 2000, 10],
    ]);
  });

  it("仅目录面事实原样输出，不补造未识别行", () => {
    expect(dDirs).toEqual(["alpha"]);
  });

  // H9 已删（e）：日总量守恒恒等由 ledger 台账守恒对账更强钉住（四视角逐日逐字段）。
  // 同键合并（f）独无他处 pin（A4(d) 只并 dir 行，不并残差入既有未识别桶），保留：
  it("同 (day, dir) 键唯一（残差并入既有未识别桶，不另起一行）", () => {
    expect(fRowsLength).toBe(1);
  });

  it("合并后数值 = 目录桶 + 残差（100+4900 / 10+20），无双行", () => {
    expect(fRowValues).toEqual([TREND_UNIDENTIFIED, 5000, 30]);
  });

  it("负残差不补造行（按 0 处理）：目录面 300/3 > 聚合面 100/1，仅保留既有目录行", () => {
    expect(gDirs).toEqual([["alpha", 300, 3]]);
  });

  it("行序契约：残差行按 day 升序（不依赖 cells 插入序）", () => {
    expect(hDays).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
  });

  // H9 已删（i）：prune 联动删除残差行由 M1(b) 单元面 pruneDays 联动钉住（同生命周期）。
  // 无 dir 键（j）是 A2“旧格式无 dir 行由残差投影承担”边界的纯函数镜像，无他处 pin，保留：
  it("无 dir 键明细行 → 残差 = 10", () => {
    expect(jInputBefore).toBe(10);
  });

  it("correct 校正后残差同步为 50（无 dir 键行不进 dirDays，经残差反映）", () => {
    expect(jInputAfter).toBe(50);
  });
});
