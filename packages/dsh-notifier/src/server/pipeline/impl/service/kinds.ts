/**
 * dsh-notifier pipeline 域 —— 通知种类与展示强度的词汇表。
 *
 * 事实源在 src/shared/kinds.ts（两端共享面）：客户端设置页的事件卡与免打扰豁免读同一张表，
 * 此前两端各写一份逐字相同的副本。本文件只做转出——域内与域外的引用路径不变，符号集与
 * 收口前逐项相同（`NotifySeverity` 仍从 channels 一侧的 deps 来，本文件不新增出口）。
 */
export {
  BUILTIN_KINDS,
  KIND_SEVERITY,
  NOTIFY_SEVERITIES,
  isBuiltinKind,
  isNotifySeverity,
} from "../../../../shared/interface.ts";
export type { BuiltinKind, ExternalKind, NotifyKind } from "../../../../shared/interface.ts";
