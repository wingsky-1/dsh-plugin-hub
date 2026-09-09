// @ts-nocheck
/**
 * dsh-provider-usage — unit：路由层纯函数（E5/C6 变异段前置，评审 P1-5）
 *
 * 抽离可测面：clampTrendN（trend 窗口封顶）、isReportPeriodValid/isReportKeyValid/
 * isTaskIdValid（报告路由双白名单校验）。薄 handler 的其余行为经 unit-report/
 * unit-apply/smoke 端到端覆盖。
 */
import { assert } from "./helpers.ts";
import { clampTrendN } from "../src/domain2/routes/ui.ts";
import { isReportPeriodValid, isReportKeyValid, isTaskIdValid } from "../src/domain2/routes/reports.ts";

// ---- clampTrendN：默认窗口 / 封顶 / 非法回退（ui.ts:22-30）
{
  assert.equal(clampTrendN(null, "day", 30), 30, "null → 默认 day=30");
  assert.equal(clampTrendN("5", "day", 30), 5, "合法 5 → 5");
  assert.equal(clampTrendN("50", "day", 30), 30, "超留存 50 → 封顶 30");
  assert.equal(clampTrendN("abc", "day", 30), 30, "非数字 → 默认");
  assert.equal(clampTrendN("0", "day", 30), 30, "0 → 默认（>0 才接受）");
  assert.equal(clampTrendN("-3", "week", 90), 12, "负数 → 默认 week=12");
  assert.equal(clampTrendN("10", "week", 90), 10, "week 上限 ceil(90/7)=13，10 未超限原样返回");
  assert.equal(clampTrendN("50", "week", 90), 13, "week 封顶 ceil(90/7)=13");
  assert.equal(clampTrendN("100", "month", 90), 3, "month 封顶 ceil(90/30)=3");
}

// ---- isReportPeriodValid / isReportKeyValid：双白名单与错误码语义边界
{
  assert.equal(isReportPeriodValid("daily"), true, "daily 合法");
  assert.equal(isReportPeriodValid("weekly"), true, "weekly 合法");
  assert.equal(isReportPeriodValid("monthly"), true, "monthly 合法");
  assert.equal(isReportPeriodValid("yearly"), false, "yearly 非法");
  assert.equal(isReportPeriodValid(""), false, "空串非法");

  assert.equal(isReportKeyValid("daily", "2026-09-09"), true, "daily 合法键 YYYY-MM-DD");
  assert.equal(isReportKeyValid("daily", "2026-9-9"), false, "daily 缺零填充非法");
  assert.equal(isReportKeyValid("daily", "2026-09-32"), true, "daily 键只验形状不验日历（RegExp 白名单语义）");
  assert.equal(isReportKeyValid("weekly", "2026-09-09"), true, "weekly 合法键");
  assert.equal(isReportKeyValid("monthly", "2026-09"), true, "monthly 合法键 YYYY-MM");
  assert.equal(isReportKeyValid("monthly", "2026-09-09"), false, "monthly 不接受日粒度键");
  assert.equal(isReportKeyValid("yearly", "2026"), false, "非法 period → 恒 false");
  assert.equal(isReportKeyValid("daily", "2026/09/09"), false, "分隔符非法");
}

// ---- isTaskIdValid：uuid v4 白名单
{
  assert.equal(isTaskIdValid("3f8b9c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f"), true, "合法 uuid v4");
  assert.equal(isTaskIdValid("3f8b9c2e-1a2b-3c3d-8e4f-5a6b7c8d9e0f"), false, "版本位非 4 非法");
  assert.equal(isTaskIdValid("3f8b9c2e-1a2b-4c3d-7e4f-5a6b7c8d9e0f"), false, "变体位非 8/9/a/b 非法");
  assert.equal(isTaskIdValid(""), false, "空串非法");
  assert.equal(isTaskIdValid("not-a-uuid"), false, "非 uuid 非法");
}