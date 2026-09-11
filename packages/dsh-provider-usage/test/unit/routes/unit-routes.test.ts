/**
 * dsh-provider-usage — unit：路由层纯函数（E5/C6 变异段前置，评审 P1-5）
 *
 * 抽离可测面：clampTrendN（trend 窗口封顶）、isReportPeriodValid/isReportKeyValid/
 * isTaskIdValid（报告路由双白名单校验）。薄 handler 的其余行为经 unit-report/
 * unit-apply/smoke 端到端覆盖。
 */
import { describe, expect, it } from "vitest";
import { clampTrendN } from "../../../src/domain2/routes/ui.ts";
import { isReportPeriodValid, isReportKeyValid, isTaskIdValid } from "../../../src/domain2/routes/reports.ts";

describe("clampTrendN", () => {
  it("null → 默认 day=30", () => {
    expect(clampTrendN(null, "day", 30)).toBe(30);
  });

  it("合法 5 → 5", () => {
    expect(clampTrendN("5", "day", 30)).toBe(5);
  });

  it("超留存 50 → 封顶 30", () => {
    expect(clampTrendN("50", "day", 30)).toBe(30);
  });

  it("非数字 → 默认", () => {
    expect(clampTrendN("abc", "day", 30)).toBe(30);
  });

  it("0 → 默认（>0 才接受）", () => {
    expect(clampTrendN("0", "day", 30)).toBe(30);
  });

  it("负数 → 默认 week=12", () => {
    expect(clampTrendN("-3", "week", 90)).toBe(12);
  });

  it("week 上限 ceil(90/7)=13，10 未超限原样返回", () => {
    expect(clampTrendN("10", "week", 90)).toBe(10);
  });

  it("week 封顶 ceil(90/7)=13", () => {
    expect(clampTrendN("50", "week", 90)).toBe(13);
  });

  it("month 封顶 ceil(90/30)=3", () => {
    expect(clampTrendN("100", "month", 90)).toBe(3);
  });
});

describe("isReportPeriodValid", () => {
  it("daily 合法", () => {
    expect(isReportPeriodValid("daily")).toBe(true);
  });

  it("weekly 合法", () => {
    expect(isReportPeriodValid("weekly")).toBe(true);
  });

  it("monthly 合法", () => {
    expect(isReportPeriodValid("monthly")).toBe(true);
  });

  it("yearly 非法", () => {
    expect(isReportPeriodValid("yearly")).toBe(false);
  });

  it("空串非法", () => {
    expect(isReportPeriodValid("")).toBe(false);
  });
});

describe("isReportKeyValid", () => {
  it("daily 合法键 YYYY-MM-DD", () => {
    expect(isReportKeyValid("daily", "2026-09-09")).toBe(true);
  });

  it("daily 缺零填充非法", () => {
    expect(isReportKeyValid("daily", "2026-9-9")).toBe(false);
  });

  it("daily 键只验形状不验日历（RegExp 白名单语义）", () => {
    expect(isReportKeyValid("daily", "2026-09-32")).toBe(true);
  });

  it("weekly 合法键", () => {
    expect(isReportKeyValid("weekly", "2026-09-09")).toBe(true);
  });

  it("monthly 合法键 YYYY-MM", () => {
    expect(isReportKeyValid("monthly", "2026-09")).toBe(true);
  });

  it("monthly 不接受日粒度键", () => {
    expect(isReportKeyValid("monthly", "2026-09-09")).toBe(false);
  });

  it("非法 period → 恒 false", () => {
    expect(isReportKeyValid("yearly", "2026")).toBe(false);
  });

  it("分隔符非法", () => {
    expect(isReportKeyValid("daily", "2026/09/09")).toBe(false);
  });
});

describe("isTaskIdValid", () => {
  it("合法 uuid v4", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
  });

  it("版本位非 4 非法", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-3c3d-8e4f-5a6b7c8d9e0f")).toBe(false);
  });

  it("变体位非 8/9/a/b 非法", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-4c3d-7e4f-5a6b7c8d9e0f")).toBe(false);
  });

  it("空串非法", () => {
    expect(isTaskIdValid("")).toBe(false);
  });

  it("非 uuid 非法", () => {
    expect(isTaskIdValid("not-a-uuid")).toBe(false);
  });
});
