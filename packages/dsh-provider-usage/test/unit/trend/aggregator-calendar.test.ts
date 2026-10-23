/**
 * dsh-provider-usage — unit：#503 会话用量趋势 Aggregator calendar。
 *
 * 本文件承接日、周、月序列及 metricValue 查询；core 与 stacked/window 分别在
 * 同目录测试文件中覆盖。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import { metricValue } from "../../../src/server/shared/interface.ts";
import { T0, snapshot } from "./collector-test-support.ts";
import { callOf } from "./aggregator-test-support.ts";

describe("aggregator：日序列（空日 null、provider 过滤、total 指标）", () => {
  let dayValues: Array<number | null>;
  let onlyBValues: Array<number | null>;
  let totalValue: number | null;

  beforeAll(() => {
    const agg = new TrendAggregator();
    const d1 = new Date(2026, 8, 3, 10, 0, 0).getTime(); // 周四
    const d2 = T0; // 09-04 周五
    agg.apply(
      callOf({
        time: d1,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "a",
        model: "m",
        tokens: { input: 10, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: d2,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "b",
        model: "m",
        tokens: { input: 20, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    const days = agg.seriesDays(3, d2, "input");
    dayValues = snapshot(days.map((d) => d.value));
    const onlyB = agg.seriesDays(3, d2, "input", "b");
    onlyBValues = snapshot(onlyB.map((d) => d.value));
    totalValue = metricValue(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: null, calls: 9, turns: 0, toolCalls: 0 },
      "total",
    );
  });

  it("日序列空日 null、按日取值", () => {
    expect(dayValues).toEqual([null, 10, 20]);
  });

  it("provider 过滤", () => {
    expect(onlyBValues).toEqual([null, null, 20]);
  });

  it("total = 非空 token 之和", () => {
    expect(totalValue).toBe(6);
  });

  it("output 直取", () => {
    expect(
      metricValue(
        { input: 1, output: 2, cacheRead: 3, cacheWrite: null, calls: 9, turns: 0, toolCalls: 0 },
        "output",
      ),
    ).toBe(2);
  });

  it("cacheRead 直取", () => {
    expect(
      metricValue(
        { input: 1, output: 2, cacheRead: 3, cacheWrite: null, calls: 9, turns: 0, toolCalls: 0 },
        "cacheRead",
      ),
    ).toBe(3);
  });

  it("cacheWrite null 透出", () => {
    expect(
      metricValue(
        { input: 1, output: 2, cacheRead: 3, cacheWrite: null, calls: 9, turns: 0, toolCalls: 0 },
        "cacheWrite",
      ),
    ).toBe(null);
  });
});

describe("aggregator：周序列（周一锚点）", () => {
  let weekDays: string[];
  let weekValues: Array<number | null>;

  beforeAll(() => {
    // 周序列：2026-09-04 为周五，周一起点 = 08-31
    const agg = new TrendAggregator();
    const monday = new Date(2026, 7, 31, 10, 0, 0).getTime(); // 08-31 周一
    agg.apply(
      callOf({
        time: monday,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "a",
        model: "m",
        tokens: { input: 10, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: T0,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "a",
        model: "m",
        tokens: { input: 5, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    const weeks = agg.seriesWeeks(2, T0, "input");
    weekDays = snapshot(weeks.map((w) => w.day));
    weekValues = snapshot(weeks.map((w) => w.value));
  });

  it("周首日键（周一锚点）", () => {
    expect(weekDays).toEqual(["2026-08-24", "2026-08-31"]);
  });

  it("同周聚合（08-31 与 09-04 同周）", () => {
    expect(weekValues).toEqual([null, 15]);
  });
});

describe("aggregator：月序列（月区间跨自然月）", () => {
  let monthDays: string[];
  let monthValues: Array<number | null>;

  beforeAll(() => {
    const agg = new TrendAggregator();
    const aug = new Date(2026, 7, 15, 10, 0, 0).getTime();
    agg.apply(
      callOf({
        time: aug,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "a",
        model: "m",
        tokens: { input: 8, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: T0,
        session: "s",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "a",
        model: "m",
        tokens: { input: 4, output: 0, cacheRead: null, cacheWrite: null },
      }),
    );
    const months = agg.seriesMonths(2, T0, "input");
    monthDays = snapshot(months.map((m) => m.day));
    monthValues = snapshot(months.map((m) => m.value));
  });

  it("月键", () => {
    expect(monthDays).toEqual(["2026-08", "2026-09"]);
  });

  it("月区间聚合", () => {
    expect(monthValues).toEqual([8, 4]);
  });
});
