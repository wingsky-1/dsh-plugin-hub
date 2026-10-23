/**
 * dsh-provider-usage — unit：#503 会话用量趋势 Aggregator stacked/window。
 *
 * 一个原始自然块承载 seriesStacked 前 15 项与 windowSummary 后 18 项；
 * fixture 仅构造一次，登记 helper 只拆分代码形状并保持原执行顺序。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import type { TrendEmit } from "../../../src/server/collect/interface.ts";
import { DAY0, T0, snapshot } from "./collector-test-support.ts";
import { callOf } from "./aggregator-test-support.ts";

type MakeCall = (time: number, provider: string, model: string, input: number) => TrendEmit;

function createFixtureAggregator() {
  // 场景：3 个 provider/model 组合、跨 3 天；dPrev 落在上一窗口（环比基准）
  const agg = new TrendAggregator();
  const d1 = new Date(2026, 8, 3, 10, 0, 0).getTime(); // 周四 09-03
  const dPrev = new Date(2026, 7, 31, 10, 0, 0).getTime(); // 周一 08-31
  const call = (time: number, provider: string, model: string, input: number): TrendEmit =>
    callOf({
      time,
      session: "s",
      turn: 1,
      step: 1,
      retry: 1,
      provider,
      model,
      tokens: { input, output: 0, cacheRead: null, cacheWrite: null },
    });
  agg.apply(call(dPrev, "deepseek", "chat", 7));
  agg.apply(call(d1, "deepseek", "chat", 10));
  agg.apply(call(T0, "deepseek", "reasoner", 20));
  agg.apply(call(T0, "deepseek", "chat", 3));
  agg.apply(call(T0, "openai", "gpt", 5));
  return { agg, d1, call };
}

function buildSeriesFixture(agg: TrendAggregator) {
  // seriesStacked（day，byModel=false）：同 provider 跨 model 并段；空桶 null
  const day = agg.seriesStacked(3, "day", "input", undefined, false, T0);
  const dayKeys = snapshot(day.series.map((p) => p.key));
  const daySeries0 = snapshot(day.series[0]);
  const daySeries1Parts = snapshot(day.series[1].parts);
  const daySeries2Parts = snapshot(day.series[2].parts.map((p) => [p.provider, p.value]));
  const daySeries2Total = day.series[2].total;
  const dayProviders = snapshot(day.providers);

  // seriesStacked（day，byModel=true）：细到 provider+model
  const byModel = agg.seriesStacked(3, "day", "input", undefined, true, T0);
  const byModelParts = snapshot(byModel.series[2].parts.map((p) => [p.provider, p.model, p.value]));
  // prettier-ignore
  const byModelProviders = snapshot(byModel.providers.map((p) => `${p.provider}/${p.model}`).sort());

  // seriesStacked：provider 过滤（段与图例同收）
  const filtered = agg.seriesStacked(3, "day", "input", "deepseek", false, T0);
  const filteredParts = snapshot(filtered.series[2].parts);
  const filteredProviders = snapshot(filtered.providers);
  const filteredTotal = filtered.series[2].total;

  // seriesStacked（week / month）：跨桶聚合与键形态（08-31/09-03/09-04 同一周）
  const weeks = agg.seriesStacked(2, "week", "input", undefined, false, T0);
  const weekKeys = snapshot(weeks.series.map((p) => p.key));
  const weekTotals = snapshot(weeks.series.map((p) => p.total));
  const months = agg.seriesStacked(2, "month", "input", undefined, false, T0);
  const monthKeys = snapshot(months.series.map((p) => p.key));
  const monthTotals = snapshot(months.series.map((p) => p.total));

  return {
    dayKeys,
    daySeries0,
    daySeries1Parts,
    daySeries2Parts,
    daySeries2Total,
    dayProviders,
    byModelParts,
    byModelProviders,
    filteredParts,
    filteredProviders,
    filteredTotal,
    weekKeys,
    weekTotals,
    monthKeys,
    monthTotals,
  };
}

function buildWindowSummaryFixture(agg: TrendAggregator, d1: number, call: MakeCall) {
  // windowSummary：total/calls/peakKey/top/prevTotal（上一窗口 08-30..09-01 含 08-31 的 7）
  const sum = agg.windowSummary(3, "day", "input", undefined, T0);
  const sumTotal = sum.total;
  const sumCalls = sum.calls;
  const sumPeakKey = sum.peakKey;
  const sumTop = snapshot(sum.top);
  const sumTurns = sum.turns;
  const sumPrevTotal = sum.prevTotal;

  // windowSummary：metric=calls 切换（上一窗口 08-31 的调用计入 prevTotal）
  const sumCalls0 = agg.windowSummary(3, "day", "calls", undefined, T0);
  const sumCallsTotal = sumCalls0.total;
  const sumCallsPrevTotal = sumCalls0.prevTotal;

  // windowSummary：provider 过滤（摘要口径与序列同源收窄）
  const sumFiltered = agg.windowSummary(3, "day", "input", "openai", T0);
  const sumFilteredTotal = sumFiltered.total;
  const sumFilteredCalls = sumFiltered.calls;
  const sumFilteredTop = snapshot(sumFiltered.top);
  const sumFilteredPrevTotal = sumFiltered.prevTotal;

  // #503 M2.1：prevComplete（上一窗口起点早于内存数据起点 → 基准不完整，环比不可比）
  const sumPrevComplete = sum.prevComplete;
  const aggFull = new TrendAggregator();
  aggFull.apply(call(d1, "deepseek", "chat", 10)); // 数据起点 09-03，prev 窗口 08-30..09-01 整体在其之前
  aggFull.apply(call(T0, "deepseek", "chat", 20));
  const sumComplete = aggFull.windowSummary(3, "day", "input", undefined, T0);
  const sumCompletePrevComplete = sumComplete.prevComplete;
  const sumCompletePrevTotal = sumComplete.prevTotal;

  // 正例：n=1 时 prev 窗口 = 昨日单桶；数据起点 09-02 早于 09-03 → 完整
  const aggSpan = new TrendAggregator();
  aggSpan.apply(call(d1, "deepseek", "chat", 10)); // 09-03
  aggSpan.apply(call(T0, "deepseek", "chat", 20)); // 09-04
  const sumSpan = aggSpan.windowSummary(1, "day", "input", undefined, T0);
  const sumSpanPrevComplete = sumSpan.prevComplete;
  const sumSpanPrevTotal = sumSpan.prevTotal;

  // #503 M2.1：windowSummary 复用路由已算 stack 序列（结果一致性，消双算）
  const stackForReuse = agg.seriesStacked(3, "day", "input", undefined, false, T0).series;
  const sumReused = agg.windowSummary(3, "day", "input", undefined, T0, stackForReuse);
  const sumReusedSubset = snapshot({
    total: sumReused.total,
    calls: sumReused.calls,
    peakKey: sumReused.peakKey,
    top: sumReused.top,
    prevTotal: sumReused.prevTotal,
    prevComplete: sumReused.prevComplete,
  });
  const sumSubset = snapshot({
    total: sum.total,
    calls: sum.calls,
    peakKey: sum.peakKey,
    top: sum.top,
    prevTotal: sum.prevTotal,
    prevComplete: sum.prevComplete,
  });

  return {
    sumTotal,
    sumCalls,
    sumPeakKey,
    sumTop,
    sumTurns,
    sumPrevTotal,
    sumCallsTotal,
    sumCallsPrevTotal,
    sumFilteredTotal,
    sumFilteredCalls,
    sumFilteredTop,
    sumFilteredPrevTotal,
    sumPrevComplete,
    sumCompletePrevComplete,
    sumCompletePrevTotal,
    sumSpanPrevComplete,
    sumSpanPrevTotal,
    sumReusedSubset,
    sumSubset,
  };
}

function buildStackedWindowFixture() {
  const { agg, d1, call } = createFixtureAggregator();
  return {
    ...buildSeriesFixture(agg),
    ...buildWindowSummaryFixture(agg, d1, call),
  };
}

type StackedWindowFixture = ReturnType<typeof buildStackedWindowFixture>;

function registerSeriesCases(getFixture: () => StackedWindowFixture) {
  it("day 桶键（升序含今日）", () => {
    const { dayKeys } = getFixture();
    expect(dayKeys).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  it("空桶 parts 空且 total=null", () => {
    const { daySeries0 } = getFixture();
    expect(daySeries0).toEqual({ key: "2026-09-02", parts: [], total: null });
  });

  it("byModel=false 段 model=null", () => {
    const { daySeries1Parts } = getFixture();
    expect(daySeries1Parts).toEqual([{ provider: "deepseek", model: null, value: 10 }]);
  });

  it("同 provider 跨 model 并段（20+3）", () => {
    const { daySeries2Parts } = getFixture();
    expect(daySeries2Parts).toEqual([
      ["deepseek", 23],
      ["openai", 5],
    ]);
  });

  it("桶 total = 段之和", () => {
    const { daySeries2Total } = getFixture();
    expect(daySeries2Total).toBe(28);
  });

  it("图例并集（窗口内出现过的段）", () => {
    const { dayProviders } = getFixture();
    expect(dayProviders).toEqual([
      { provider: "deepseek", model: null },
      { provider: "openai", model: null },
    ]);
  });

  it("byModel 拆段含 model", () => {
    const { byModelParts } = getFixture();
    expect(byModelParts).toEqual([
      ["deepseek", "reasoner", 20],
      ["deepseek", "chat", 3],
      ["openai", "gpt", 5],
    ]);
  });

  it("byModel 图例并集细到 model", () => {
    const { byModelProviders } = getFixture();
    expect(byModelProviders).toEqual(["deepseek/chat", "deepseek/reasoner", "openai/gpt"]);
  });

  it("provider 过滤只剩该 provider 段", () => {
    const { filteredParts } = getFixture();
    expect(filteredParts).toEqual([{ provider: "deepseek", model: null, value: 23 }]);
  });

  it("过滤后图例", () => {
    const { filteredProviders } = getFixture();
    expect(filteredProviders).toEqual([{ provider: "deepseek", model: null }]);
  });

  it("过滤后桶 total", () => {
    const { filteredTotal } = getFixture();
    expect(filteredTotal).toBe(23);
  });

  it("week 桶键（周一锚点）", () => {
    const { weekKeys } = getFixture();
    expect(weekKeys).toEqual(["2026-08-24", "2026-08-31"]);
  });

  it("week 桶聚合（7+10+20+3+5）", () => {
    const { weekTotals } = getFixture();
    expect(weekTotals).toEqual([null, 45]);
  });

  it("month 桶键", () => {
    const { monthKeys } = getFixture();
    expect(monthKeys).toEqual(["2026-08", "2026-09"]);
  });

  it("month 桶聚合（08-31 入 8 月桶）", () => {
    const { monthTotals } = getFixture();
    expect(monthTotals).toEqual([7, 38]);
  });
}

function registerWindowSummaryCases(getFixture: () => StackedWindowFixture) {
  it("窗口 total（09-02..09-04）", () => {
    const { sumTotal } = getFixture();
    expect(sumTotal).toBe(38);
  });

  it("窗口 calls 计数（d1 1 次 + 当日 3 次）", () => {
    const { sumCalls } = getFixture();
    expect(sumCalls).toBe(4);
  });

  it("峰值桶 = 取值最大的日桶", () => {
    const { sumPeakKey } = getFixture();
    expect(sumPeakKey).toBe(DAY0);
  });

  it("top 段（byModel=false 视角）", () => {
    const { sumTop } = getFixture();
    expect(sumTop).toEqual({ provider: "deepseek", model: null, value: 23 });
  });

  it("turns 无 counter 记录为 0", () => {
    const { sumTurns } = getFixture();
    expect(sumTurns).toBe(0);
  });

  it("上一窗口指标总量（环比基准）", () => {
    const { sumPrevTotal } = getFixture();
    expect(sumPrevTotal).toBe(7);
  });

  it("calls 指标窗口总量", () => {
    const { sumCallsTotal } = getFixture();
    expect(sumCallsTotal).toBe(4);
  });

  it("calls 指标环比基准", () => {
    const { sumCallsPrevTotal } = getFixture();
    expect(sumCallsPrevTotal).toBe(1);
  });

  it("过滤后窗口 total", () => {
    const { sumFilteredTotal } = getFixture();
    expect(sumFilteredTotal).toBe(5);
  });

  it("过滤后 calls", () => {
    const { sumFilteredCalls } = getFixture();
    expect(sumFilteredCalls).toBe(1);
  });

  it("过滤后 top 段", () => {
    const { sumFilteredTop } = getFixture();
    expect(sumFilteredTop).toEqual({ provider: "openai", model: null, value: 5 });
  });

  it("过滤后上一窗口无数据 prevTotal=null", () => {
    const { sumFilteredPrevTotal } = getFixture();
    expect(sumFilteredPrevTotal).toBe(null);
  });

  it("prev 窗口起点 08-30 早于数据起点 08-31 → 不完整", () => {
    const { sumPrevComplete } = getFixture();
    expect(sumPrevComplete).toBe(false);
  });

  it("数据起点 09-03 晚于 prev 窗口起点 08-30 → 不完整", () => {
    const { sumCompletePrevComplete } = getFixture();
    expect(sumCompletePrevComplete).toBe(false);
  });

  it("不完整时 prevTotal 仍按数据实况返回（null 语义不变）", () => {
    const { sumCompletePrevTotal } = getFixture();
    expect(sumCompletePrevTotal).toBe(null);
  });

  it("prev 单桶 09-03 不早于数据起点 09-03 → 完整", () => {
    const { sumSpanPrevComplete } = getFixture();
    expect(sumSpanPrevComplete).toBe(true);
  });

  it("完整场景 prevTotal 正常返回", () => {
    const { sumSpanPrevTotal } = getFixture();
    expect(sumSpanPrevTotal).toBe(10);
  });

  it("复用 stack 序列与自算结果全等", () => {
    const { sumReusedSubset, sumSubset } = getFixture();
    expect(sumReusedSubset).toEqual(sumSubset);
  });
}

describe("aggregator：堆叠柱序列 seriesStacked / 窗口摘要 windowSummary（#503 M2）", () => {
  let fixture: StackedWindowFixture | undefined;

  beforeAll(() => {
    fixture = buildStackedWindowFixture();
  });

  const getFixture = (): StackedWindowFixture => {
    if (!fixture) throw new Error("stacked/window fixture 尚未初始化");
    return fixture;
  };

  registerSeriesCases(getFixture);
  registerWindowSummaryCases(getFixture);
});
