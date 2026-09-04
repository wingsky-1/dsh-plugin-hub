/**
 * dsh-provider-usage/report — 触发调度纯函数（#503 M3）。
 *
 * 语义（单一模型，三期统一）：
 * - 每期有「锚点触发时刻」：daily=当日 HH:MM；weekly=周起点日 HH:MM（覆盖紧邻的
 *   前 7 天）；monthly=月内 dayOfMonth 日 HH:MM（覆盖上一自然月）；
 * - 候选窗口 = 最近一次「锚点 <= now」的触发；其覆盖区间由 runAt 唯一推导；
 * - 幂等：lastRun[period] 存已生成的窗口键（日期序单调）；候选键 <= lastRun 即已扣期；
 * - 补跑：进程停机跨过锚点后重启，候选键 > lastRun 即自然补生成（只补最近一个，
 *   更早窗口不追溯——文档化口径）；
 * - DST 安全：全部经本地 Date 逐字段构造与逐日回退，禁缓存时区偏移、禁毫秒减法。
 */
import { dayKey } from "../charts.ts";
import { parseHHMM, type ReportConfig, type ReportPeriod } from "./config.ts";

/** 一个到期报告的描述。 */
export interface DueReport {
  period: ReportPeriod;
  /** 窗口键（daily/weekly=日期 key；monthly=YYYY-MM）。幂等标记单位。 */
  key: string;
  /** 覆盖区间的本地日 key（闭区间）。 */
  startDay: string;
  endDay: string;
}

/** 某日 HH:MM 的本地时间戳。 */
function atTime(dateKey: string, time: string): number {
  const hm = parseHHMM(time) ?? { h: 22, m: 0 };
  const [y, mo, d] = dateKey.split("-").map(Number);
  return new Date(y, mo - 1, d, hm.h, hm.m, 0, 0).getTime();
}

/** 当日（now 所在日）HH:MM 的本地时间戳。 */
function todayAt(now: number, time: string): number {
  const d = new Date(now);
  return atTime(dayKey(d.getTime()), time);
}

/** 距 now 最近的一次「星期为 dow、时刻为 time」且 <= now 的本地时间戳（dow: 0=周日/1=周一）。 */
function lastWeekAnchor(now: number, dow: 0 | 1, time: string): number {
  const d = new Date(now);
  const back = (d.getDay() - dow + 7) % 7; // 距目标星期几的天数（0–6）
  d.setDate(d.getDate() - back);
  const anchorDate = atTime(dayKey(d.getTime()), time);
  if (anchorDate <= now) return anchorDate;
  // 锚点日当天时刻未到 → 退回上一周（本地逐日回退，DST 安全，禁毫秒减法）
  d.setDate(d.getDate() - 7);
  return atTime(dayKey(d.getTime()), time);
}

/** 距 now 最近的一次「m 月 d 日 HH:MM」且 <= now 的本地时间戳（跨月安全：逐月回退）。 */
function lastMonthAnchor(now: number, dayOfMonth: number, time: string): number {
  const d = new Date(now);
  const candidate = new Date(d.getFullYear(), d.getMonth(), dayOfMonth);
  const hm = parseHHMM(time) ?? { h: 9, m: 0 };
  candidate.setHours(hm.h, hm.m, 0, 0);
  if (candidate.getTime() <= now) return candidate.getTime();
  // 本月锚点未到 → 上月（setMonth 自动处理跨年/月长差异）
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, dayOfMonth);
  prev.setHours(hm.h, hm.m, 0, 0);
  return prev.getTime();
}

/** 日 key 的 +n 天（本地逐日回退/推进，DST 安全）。 */
function addDays(dateKey: string, n: number): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt.getTime());
}

/**
 * 给定周期的候选窗口（最近一次锚点 <= now 的触发及其覆盖区间）。
 * 不读 lastRun——幂等判定在 pendingReports。
 */
export function candidateWindow(period: ReportPeriod, cfg: ReportConfig, now: number): DueReport {
  if (period === "daily") {
    // 候选锚点日：now 已过当日时刻 → 当日（报告覆盖今天至今）；未过 → 昨日（全天）
    const runDay = todayAt(now, cfg.daily.time) <= now ? dayKey(now) : addDays(dayKey(now), -1);
    return { period, key: runDay, startDay: runDay, endDay: runDay };
  }
  if (period === "weekly") {
    const runAt = lastWeekAnchor(now, cfg.weekly.weekStartsOn, cfg.weekly.time);
    const runDay = dayKey(runAt);
    // 覆盖紧邻前 7 天：[runDay-7, runDay-1]
    const end = addDays(runDay, -1);
    return { period, key: addDays(runDay, -7), startDay: addDays(runDay, -7), endDay: end };
  }
  // monthly
  const runAt = lastMonthAnchor(now, cfg.monthly.dayOfMonth, cfg.monthly.time);
  const runDate = new Date(runAt);
  // 覆盖上一自然月
  const start = new Date(runDate.getFullYear(), runDate.getMonth() - 1, 1);
  const end = new Date(runDate.getFullYear(), runDate.getMonth(), 0); // 本月 0 日 = 上月末
  const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return { period, key, startDay: dayKey(start.getTime()), endDay: dayKey(end.getTime()) };
}

/**
 * 计算当前到期的报告集合（调度 tick 数据源）：
 * 对每个启用期，取候选窗口；窗口键 > lastRun[period]（日期字典序）即到期。
 * lastRun 缺失视为从未生成（首次挂载即补生成最近窗口——补跑语义）。
 */
export function pendingReports(cfg: ReportConfig, now: number, lastRun: Partial<Record<ReportPeriod, string>>): DueReport[] {
  const out: DueReport[] = [];
  const periods: ReportPeriod[] = ["daily", "weekly", "monthly"];
  for (const period of periods) {
    if (!cfg[period].enabled) continue;
    const cand = candidateWindow(period, cfg, now);
    const done = lastRun[period];
    // 候选已触发过（含为更晚窗口生成过）→ 已扣期跳过
    if (done !== undefined && done >= cand.key) continue;
    out.push(cand);
  }
  return out;
}
