/**
 * dsh-provider-usage — unit：#503 会话用量趋势 Aggregator core。
 *
 * 本文件承接 cells/null、日切、回拨、rebuild 与 mergeAggRows；
 * calendar 与 stacked/window 分别在同目录测试文件中覆盖。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendAggregator, mergeAggRows } from "../../../src/server/aggregate/interface.ts";
import type {
  TrendAggRow,
  TrendCell,
  TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import { TREND_ROW_VERSION } from "../../../src/server/shared/interface.ts";
import { DAY0, T0, snapshot } from "./collector-test-support.ts";
import { callOf, cellTotals, counterOf, HOUR } from "./aggregator-test-support.ts";

describe("aggregator：cells 累加与 null 语义", () => {
  let cell: TrendCell;

  beforeAll(() => {
    const agg = new TrendAggregator();
    agg.apply(
      callOf({
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        tokens: null,
      }),
    );
    agg.apply(
      callOf({
        time: T0 + HOUR,
        session: "s1",
        turn: 2,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null },
      }),
    );
    cell = snapshot(cellTotals(agg, DAY0)!);
  });

  it("calls 独立累加", () => {
    expect(cell.calls).toBe(2);
  });

  it("null-aware 求和：null 不污染数字", () => {
    expect(cell.input).toBe(100);
  });

  it("全 null 维度保持 null（非 0）", () => {
    expect(cell.output).toBe(null);
  });

  it("未计轮", () => {
    expect(cell.turns).toBe(0);
  });
});

describe("aggregator：日切压实", () => {
  let bucketsBefore: string;
  let bucketsAfter: string;
  let pendingDays: number;
  let aggRowCount: number;
  let aggRow: TrendAggRow;
  let hourRows: TrendHourRow[];

  beforeAll(() => {
    // 日切压实：cells 不动、pending 移除、聚合行正确
    const agg = new TrendAggregator();
    agg.apply(
      callOf({
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: T0 + HOUR,
        session: "s2",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        tokens: { input: 20, output: 5, cacheRead: null, cacheWrite: null },
      }),
    );
    // toolCalls: 2 超出 0|1 字面（实现按数值累加，旧格式计数行容忍）
    agg.apply(
      counterOf({
        time: T0,
        session: "s1",
        provider: "deepseek",
        model: "chat",
        turns: 1,
        toolCalls: 2,
      }),
    );
    bucketsBefore = JSON.stringify(agg.buckets());
    const rolled = agg.rollupDay(DAY0, DAY0);
    bucketsAfter = JSON.stringify(agg.buckets());
    pendingDays = agg.pendingDays().length;
    const aggRows = rolled.filter((r): r is TrendAggRow => r.kind === "agg");
    aggRowCount = aggRows.length;
    aggRow = snapshot(aggRows[0]);
    hourRows = snapshot(rolled.filter((r): r is TrendHourRow => r.kind === "hour"));
  });

  it("压实只转落盘形态，cells 不动（不双算）", () => {
    expect(bucketsAfter).toBe(bucketsBefore);
  });

  it("压实后 pending 清空", () => {
    expect(pendingDays).toBe(0);
  });

  it("同 (provider,model) 折叠为一行", () => {
    expect(aggRowCount).toBe(1);
  });

  it("聚合 calls", () => {
    expect(aggRow.calls).toBe(2);
  });

  it("聚合 turns", () => {
    expect(aggRow.turns).toBe(1);
  });

  it("聚合 toolCalls", () => {
    expect(aggRow.toolCalls).toBe(2);
  });

  it("聚合 input 求和", () => {
    expect(aggRow.input).toBe(30);
  });

  it("聚合行带 schema 版本", () => {
    expect(aggRow.v).toBe(TREND_ROW_VERSION);
  });

  it("rollupDay 产出 hour 行（同源折算）", () => {
    expect(hourRows.length).toBe(2);
  });

  it("hour12 档（T0 本地 12:00）", () => {
    expect(hourRows[0].hour).toBe(12);
  });

  it("hour13 档（T0+1h 本地 13:00）", () => {
    expect(hourRows[1].hour).toBe(13);
  });

  it("hour12 calls 独立", () => {
    expect(hourRows[0].calls).toBe(1);
  });
});

describe("aggregator：时钟回拨旧日落桶", () => {
  let hasPastBucket: boolean;

  beforeAll(() => {
    // 时钟回拨：旧日事件按其本地日落桶（append-only 容忍）
    const agg = new TrendAggregator();
    const past = new Date(2026, 8, 1, 8, 0, 0).getTime(); // 09-01 < DAY0
    agg.apply(
      callOf({
        time: past,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        tokens: { input: 7, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    hasPastBucket = agg.buckets().some((d) => d.day === dayKey(past));
  });

  it("旧日事件落旧日桶", () => {
    expect(hasPastBucket).toBeTruthy();
  });
});

describe("aggregator：rebuild（agg 行 + 明细/计数行）", () => {
  let cell: TrendCell;

  beforeAll(() => {
    // rebuild：agg 行 + 明细/计数行重建 cells；persisted 标记防二次落盘
    const agg = new TrendAggregator();
    agg.rebuild(
      [
        {
          v: 1,
          kind: "agg",
          day: DAY0,
          provider: "deepseek",
          model: "chat",
          input: 100,
          output: 50,
          cacheRead: null,
          cacheWrite: null,
          calls: 2,
          turns: 1,
          toolCalls: 3,
        },
        {
          v: 1,
          kind: "detail",
          time: T0,
          day: DAY0,
          session: "s9",
          turn: 9,
          step: 1,
          retry: 1,
          provider: "deepseek",
          model: "chat",
          input: 7,
          output: 7,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        },
        {
          v: 1,
          kind: "counter",
          time: T0,
          day: DAY0,
          session: "s9",
          provider: "deepseek",
          model: "chat",
          turns: 1,
          toolCalls: 0,
        },
      ],
      true,
    );
    cell = snapshot(cellTotals(agg, DAY0)!);
  });

  it("重建 calls = agg + 明细", () => {
    expect(cell.calls).toBe(3);
  });

  it("重建 token 合并", () => {
    expect(cell.input).toBe(107);
  });

  it("重建 turns 合并", () => {
    expect(cell.turns).toBe(2);
  });

  it("重建 toolCalls 合并", () => {
    expect(cell.toolCalls).toBe(3);
  });
});

describe("aggregator：mergeAggRows 同键累加、null-aware", () => {
  let merged: TrendAggRow[];

  beforeAll(() => {
    merged = snapshot(
      mergeAggRows(
        [
          {
            v: 1,
            kind: "agg",
            day: DAY0,
            provider: "p",
            model: "m",
            input: 10,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          } as TrendAggRow,
        ],
        [
          {
            v: 1,
            kind: "agg",
            day: DAY0,
            provider: "p",
            model: "m",
            input: 5,
            output: 3,
            cacheRead: null,
            cacheWrite: null,
            calls: 2,
            turns: 1,
            toolCalls: 0,
          } as TrendAggRow,
        ],
      ),
    );
  });

  it("同键合并", () => {
    expect(merged.length).toBe(1);
  });

  it("token 合并", () => {
    expect(merged[0].input).toBe(15);
  });

  it("null + 数字 = 数字", () => {
    expect(merged[0].output).toBe(3);
  });

  it("calls 合并", () => {
    expect(merged[0].calls).toBe(3);
  });
});
