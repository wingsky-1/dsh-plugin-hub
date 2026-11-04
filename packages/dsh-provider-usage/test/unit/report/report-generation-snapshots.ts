/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  TREND_ROW_VERSION,
  buildStatsSnapshot,
  type StatsSnapshot,
  type TrendCell,
  type TrendHourRow,
} from "./report-generation-support.ts";

describe("buildStatsSnapshot：窗口过滤 / totals 聚合 / byProvider 降序 / 环比基准", () => {
  let s: StatsSnapshot;
  beforeAll(() => {
    const cell = (calls: number, input: number | null): TrendCell => ({
      input,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    const buckets = [
      { day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(2, 100) }] },
      {
        day: "2026-09-03",
        providers: [
          { provider: "p1", model: "m1", cell: cell(1, 50) },
          { provider: "p2", model: null, cell: cell(3, 30) },
        ],
      },
      { day: "2026-09-10", providers: [{ provider: "p1", model: "m1", cell: cell(9, 999) }] }, // 窗口外
    ];
    s = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-03",
      buckets,
      prevTotal: 120,
    });
  });

  it("窗口内 calls 聚合（2+1+3）", () => {
    expect(s.totals.calls).toBe(6);
  });

  it("token null-aware 聚合（100+50+30）", () => {
    expect(s.totals.input).toBe(180);
  });

  it("逐日总量（窗口外不计）", () => {
    expect(s.byDay).toEqual([
      { day: "2026-09-02", total: 100 },
      { day: "2026-09-03", total: 80 },
    ]);
  });

  it("byProvider calls 降序（p1:3）", () => {
    expect(s.byProvider[0].provider).toBe("p1");
  });

  it("p2 次之", () => {
    expect(s.byProvider[1].calls).toBe(3);
  });

  it("环比基准透传", () => {
    expect(s.prevTotal).toBe(120);
  });

  it("total=四项之和", () => {
    expect(s.totals.total).toBe(180);
  });

  // #532 年报派生维度
  it("峰值日=byDay 最大（并列取最早）", () => {
    expect(s.peakDay).toEqual({ day: "2026-09-02", total: 100 });
  });

  it("活跃天数=窗口内有数据天数", () => {
    expect(s.activeDays).toBe(2);
  });

  it("窗口天数（含无数据日）", () => {
    expect(s.windowDays).toBe(2);
  });

  it("活跃日均=total/activeDays", () => {
    expect(s.avgPerActiveDay).toBe(90);
  });

  it("最长连续=日历日差1 连续（09-02/09-03）", () => {
    expect(s.longestStreak).toBe(2);
  });

  it("环比比值=total/prevTotal（180/120）", () => {
    expect(s.wowRatio).toBe(1.5);
  });

  // 星期分布：2026-09-02=周三(idx2)、09-03=周四(idx3)
  it("byWeekday 周三桶", () => {
    expect(s.byWeekday[2]).toBe(100);
  });

  it("byWeekday 周四桶", () => {
    expect(s.byWeekday[3]).toBe(80);
  });

  it("byWeekday 总和=total", () => {
    expect(s.byWeekday.reduce((a, b) => a + b, 0)).toBe(180);
  });
});

describe("#532 派生维度：空窗口 / 除零 / 跨月连续 / 名称防御", () => {
  let empty: StatsSnapshot;
  let zeroPrev: StatsSnapshot;
  let crossMonth: StatsSnapshot;
  let hostile: StatsSnapshot;

  beforeAll(() => {
    const cell = (calls: number, input: number | null): TrendCell => ({
      input,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    // 空窗口：全 null/0，wowRatio null（防 Infinity），不抛
    empty = buildStatsSnapshot({
      period: "weekly",
      startDay: "2026-09-01",
      endDay: "2026-09-07",
      buckets: [],
      prevTotal: null,
    });
    // 除零：prevTotal=0 → null（防 Infinity 被 JSON.stringify 静默转 null 的语义错误）
    zeroPrev = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-02",
      buckets: [
        { day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(1, 50) }] },
      ],
      prevTotal: 0,
    });
    // 跨月连续：01-31 → 02-01 日历日差=1（streak=2，非字典序判断）
    crossMonth = buildStatsSnapshot({
      period: "weekly",
      startDay: "2026-01-31",
      endDay: "2026-02-01",
      buckets: [
        { day: "2026-01-31", providers: [{ provider: "p1", model: "m1", cell: cell(1, 10) }] },
        { day: "2026-02-01", providers: [{ provider: "p1", model: "m1", cell: cell(1, 20) }] },
      ],
      prevTotal: null,
    });
    // provider/model 名防御：控制字符剥离（C0 + DEL + C1）+ 80 字符截断
    const longName = "x".repeat(100);
    hostile = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-02",
      buckets: [
        {
          day: "2026-09-02",
          providers: [
            { provider: `a\u0000b${longName}`, model: `m\nevil\u009b`, cell: cell(1, 10) },
          ],
        },
      ],
      prevTotal: null,
    });
  });

  it("空窗口 peakDay=null", () => {
    expect(empty.peakDay).toBeNull();
  });

  it("空窗口 activeDays=0", () => {
    expect(empty.activeDays).toBe(0);
  });

  it("空窗口 windowDays=7", () => {
    expect(empty.windowDays).toBe(7);
  });

  it("空窗口 avgPerActiveDay=null", () => {
    expect(empty.avgPerActiveDay).toBeNull();
  });

  it("空窗口 streak=0", () => {
    expect(empty.longestStreak).toBe(0);
  });

  it("prevTotal=null → wowRatio=null", () => {
    expect(empty.wowRatio).toBeNull();
  });

  it("空窗口 byWeekday 全 0", () => {
    expect(empty.byWeekday).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("prevTotal=0 → wowRatio=null（不做对比）", () => {
    expect(zeroPrev.wowRatio).toBeNull();
  });

  it("跨月 01-31→02-01 按日历日判定连续", () => {
    expect(crossMonth.longestStreak).toBe(2);
  });

  it("provider 控制字符已剥离", () => {
    expect(hostile.byProvider[0].provider.includes("\u0000")).toBeFalsy();
  });

  it("provider 截断至 80 字符", () => {
    expect(hostile.byProvider[0].provider.length).toBe(80);
  });

  it("model 控制字符已剥离", () => {
    expect(hostile.byProvider[0].model!.includes("\n")).toBeFalsy();
  });

  it("model C1 控制字符已剥离（复核 P1-2）", () => {
    expect(hostile.byProvider[0].model!.includes("\u009b")).toBeFalsy();
  });
});

describe("#662 时段维度：全量覆盖 → 时段字段注入", () => {
  let full: ReturnType<typeof buildStatsSnapshot>;
  beforeAll(() => {
    const hourRow = (
      day: string,
      hour: number,
      calls: number,
      input: number | null,
      output: number | null = null,
    ): TrendHourRow => ({
      v: TREND_ROW_VERSION,
      kind: "hour",
      day,
      hour,
      input,
      output,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    full = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-03",
      buckets: [],
      hourRows: [
        hourRow("2026-09-02", 9, 2, 100),
        hourRow("2026-09-02", 21, 1, 80),
        hourRow("2026-09-03", 9, 3, 60),
        hourRow("2026-09-10", 9, 9, 999), // 窗口外
      ],
      prevTotal: null,
    });
  });

  it("coveredDays=窗口内有 hour 事实的天数（窗口外不计）", () => {
    expect(full.coveredDays).toBe(2);
  });

  it("覆盖充足 → byHour 注入", () => {
    expect(full.byHour).not.toBeNull();
  });

  it("byHour 24 项全量（hour 0..23）", () => {
    expect(full.byHour!.length).toBe(24);
  });

  it("byHour 同钟点跨日合并 calls（2+3）", () => {
    expect(full.byHour![9].calls).toBe(5);
  });

  it("byHour 同钟点跨日合并 total（100+60）", () => {
    expect(full.byHour![9].total).toBe(160);
  });

  it("晚间钟点 calls 独立", () => {
    expect(full.byHour![21].calls).toBe(1);
  });

  it("无数据钟点 calls=0（零 usage 语义）", () => {
    expect(full.byHour![0].calls).toBe(0);
  });

  it("无数据钟点 total=null", () => {
    expect(full.byHour![0].total).toBeNull();
  });

  it("byPeriod 四档（凌晨0-5/上午6-11/下午12-17/晚间18-23）", () => {
    expect(full.byPeriod).toEqual([
      { period: "凌晨", calls: 0, total: null },
      { period: "上午", calls: 5, total: 160 },
      { period: "下午", calls: 0, total: null },
      { period: "晚间", calls: 1, total: 80 },
    ]);
  });

  it("peakHour=total 判峰（并列取最早）", () => {
    expect(full.peakHour).toEqual({ hour: 9, calls: 5, total: 160 });
  });
});

describe("#662 时段维度：覆盖不足 → 整段降级 null（防「1/7 天代表整周」误导）", () => {
  let partial: ReturnType<typeof buildStatsSnapshot>;
  let none: ReturnType<typeof buildStatsSnapshot>;
  beforeAll(() => {
    const hourRow = (
      day: string,
      hour: number,
      calls: number,
      input: number | null,
      output: number | null = null,
    ): TrendHourRow => ({
      v: TREND_ROW_VERSION,
      kind: "hour",
      day,
      hour,
      input,
      output,
      cacheRead: null,
      cacheWrite: null,
      calls,
      turns: calls,
      toolCalls: 0,
    });
    partial = buildStatsSnapshot({
      period: "weekly",
      startDay: "2026-09-01",
      endDay: "2026-09-07",
      buckets: [],
      hourRows: [hourRow("2026-09-01", 9, 2, 100)],
      prevTotal: null,
    });
    // 无 hour 事实（旧数据物理缺失）：全 null、coveredDays=0
    none = buildStatsSnapshot({
      period: "daily",
      startDay: "2026-09-02",
      endDay: "2026-09-02",
      buckets: [],
      prevTotal: null,
    });
  });

  it("部分覆盖 coveredDays=1", () => {
    expect(partial.coveredDays).toBe(1);
  });

  it("coveredDays < windowDays → byHour 整体 null", () => {
    expect(partial.byHour).toBeNull();
  });

  it("coveredDays < windowDays → byPeriod 整体 null", () => {
    expect(partial.byPeriod).toBeNull();
  });

  it("coveredDays < windowDays → peakHour 整体 null", () => {
    expect(partial.peakHour).toBeNull();
  });

  it("无 hourRows → coveredDays=0", () => {
    expect(none.coveredDays).toBe(0);
  });

  it("无 hour 事实 → byHour null", () => {
    expect(none.byHour).toBeNull();
  });

  it("无 hour 事实 → byPeriod null", () => {
    expect(none.byPeriod).toBeNull();
  });

  it("无 hour 事实 → peakHour null", () => {
    expect(none.peakHour).toBeNull();
  });
});
