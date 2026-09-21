/**
 * dsh-provider-usage — server/shared last-run 纯面叶子（#768 A波4）。
 *
 * LAST_RUN_SCHEMA / LastRunRecord / isClosedWindowRecord / deriveLastRun /
 * alignLastRun 的 canonical 落点（由 server/schedule/due.ts 纯面逐字下沉，
 * 零行为变更；updateLastRun 有状态临界区留 schedule 域不动）。
 * 共享层准入：无单一所有者（schedule 启动校准 + upgrade 迁移双消费）、
 * 零值进口域（仅值引 src/shared 日界 + type-only 引 ReportPeriod）、≥2 正当消费者。
 * 目录外经 server/shared/interface.ts 消费，旧址 server/schedule/due.ts 保留
 * re-export 门面（生产与测试同源，均经 shared 门面）。
 */
import { dayKey } from "../../shared/interface.ts";
import type { ReportPeriod } from "../config/interface.ts";

/** last-run.json schema 版本（v2 = daily 候选键语义统一为「已闭环窗口」）。 */
export const LAST_RUN_SCHEMA = 2;

/** 迁移/推导输入：index.jsonl 单条记录的最小字段（鸭子类型，避免与 runner 循环依赖）。 */
export interface LastRunRecord {
  period: ReportPeriod;
  key: string;
  generatedAt: number;
  endDay: string;
  ok: boolean;
}

/**
 * 「窗口已闭环」判定：生成时刻所在本地日 > 窗口结束日。
 * 纯字符串日期序（dayKey(generatedAt) > endDay），与 addDays/dayKey 同源构造：
 * - 旧语义 daily「当天」记录（发起日 = endDay 当天）恒不闭环（窗口未走完）；
 * - 新语义 daily「昨天」记录（发起日 = endDay+1）恒闭环；
 * - weekly/monthly 生成时刻天然晚于窗口结束。
 * 禁用时间戳 + 23:59:59 构造：Date.parse("…T23:59:59") 无时区按 UTC 解析，
 * UTC+8 下会把新语义闭环记录误判为未闭环（无限补跑）且 CI 时区盲区不可测。
 */
export function isClosedWindowRecord(r: LastRunRecord): boolean {
  return r.ok === true && dayKey(r.generatedAt) > r.endDay;
}

/**
 * 由 index.jsonl 事实推导 lastRun（迁移 + 长期一致性口径）：
 * 「lastRun = 各期最新已闭环窗口的键」——与读侧投影同构：index 是事实日志，
 * lastRun 是投影，任何时刻可重算（幂等、可重放、自动修复旧语义污染键）。
 * - 有闭环记录 → 取最晚键（已扣期语义不变：候选键 <= lastRun 即跳过）；
 * - 无闭环记录（从未生成 / index 清理过 / 旧语义「当天」污染）→ 不设键（恢复补跑，
 *   最多重生成最近一期，幂等安全）。
 */
export function deriveLastRun(records: LastRunRecord[]): Partial<Record<ReportPeriod, string>> {
  const out: Partial<Record<ReportPeriod, string>> = {};
  for (const period of ["daily", "weekly", "monthly"] as const) {
    let maxKey: string | undefined;
    for (const r of records) {
      if (r.period !== period || !isClosedWindowRecord(r)) continue;
      if (maxKey === undefined || r.key > maxKey) maxKey = r.key;
    }
    if (maxKey !== undefined) out[period] = maxKey;
  }
  return out;
}

/**
 * schema 已新（>=2）时的温和校准：仅「该期 index 存在已闭环记录」才把 lastRun
 * 对齐到最新闭环键（修旧语义污染/遮蔽事故的滞后与超前），否则保留原值——
 * 保护「首次启用预置扣期」键（preset 键在 index 中天然无对应记录，
 * 全量重算会删掉它导致首次启用被立即补跑）。
 */
export function alignLastRun(
  lastRun: Partial<Record<ReportPeriod, string>>,
  records: LastRunRecord[],
): Partial<Record<ReportPeriod, string>> {
  const out = { ...lastRun };
  for (const period of ["daily", "weekly", "monthly"] as const) {
    let maxKey: string | undefined;
    for (const r of records) {
      if (r.period !== period || !isClosedWindowRecord(r)) continue;
      if (maxKey === undefined || r.key > maxKey) maxKey = r.key;
    }
    if (maxKey !== undefined) out[period] = maxKey;
  }
  return out;
}
