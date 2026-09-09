/**
 * dsh-notifier — 免打扰时段判定。
 *
 * 纯函数模块（零依赖）：配置形状、紧急例外白名单、"HH:MM" 解析与
 * 免打扰命中判定。config.ts 的 normalizeConfig 依赖 parseHHMM 做
 * 时/分范围校验，故本模块必须保持无内部依赖（避免环形引用）。
 */

/** 免打扰时段配置。 */
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  /** 免打扰期间仍放行的通知 kind（紧急例外，如审批/提问——卡着的任务需要叫醒）。 */
  allowKinds?: string[];
}

/**
 * 免打扰豁免可选 kind（issue #421：扩至全部内置事件，支持选择「所有已启用的事件通知」）。
 * 与客户端 EVENT_KEYS 的事件 kind 集合一致（ask/question/done/subagent-done/error/turn-end）；
 * 默认豁免保持 ask/question/error（高频阻塞型——卡着的任务需要叫醒），done 类有
 * doneMergeWindowMs 聚合防刷屏治理、不默认豁免（避免升级后默认行为漂移）。
 * 注意：本常量同时是 config.ts 免打扰豁免写入白名单的**兜底语义提示**（放开后仅作
 * 展示/默认候选，不再过滤未知项——见 config.ts normalizeConfig）。
 */
export const QUIET_ALLOW_KINDS = ["ask", "question", "done", "subagent-done", "error", "turn-end"] as const;

/** "HH:MM" → 分钟数（校验 0-23 时 / 0-59 分）。 */
export function parseHHMM(text: string): number {
  const m = /^(\d{2}):(\d{2})$/u.exec(text);
  if (m === null) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

/** 是否处于免打扰时段（支持跨午夜：start > end）。 */
export function isInQuietHours(now: Date, quietHours: QuietHoursConfig | undefined): boolean {
  if (quietHours?.enabled !== true) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}
