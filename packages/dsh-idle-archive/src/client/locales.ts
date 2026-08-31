/**
 * dsh-idle-archive — 客户端文案字典（issue #348：复用官方 dsh-client-locale）。
 *
 * 双语平衡：`zh` 为 key 源；`en` 必须覆盖全部 key（`satisfies keyof typeof zh`
 * 编译期锁平衡）。动态数据用 `{name}` 占位模板，渲染期由 t 插值。
 * 宿主端稳定标识/事件名/配置键不翻译（官方原则：数据不翻译）。
 */

/** 简体中文字典（key 源）。 */
export const zh = {
  // 相对时间（fmtRelative）
  justNow: "刚刚",
  minutesAgo: "{n} 分钟前",
  hoursAgo: "{n} 小时前",
  daysAgo: "{n} 天前",
  // 弹窗
  modalTitle: "会话闲置提醒",
  closeTitle: "全部暂不归档（Y 小时内不再提醒）",
  desc: "以下 {count} 个会话超过 {hours} 小时未对话。归档后从会话列表隐藏，会话记录仍保留；「暂不归档」后 {snooze} 小时内不再提醒该会话。",
  hint: "× / Esc：仅关闭（1 小时内不重复提醒）；「全部暂不归档」：按静默时长不提醒",
  allSnooze: "全部暂不归档",
  rowLastSeen: "最后对话 {rel}（{abs}）",
  archive: "归档",
  snoozeRow: "暂不归档",
  // toast
  archivedOk: "已归档会话",
  archivedFail: "归档失败：{msg}",
  // 设置卡
  settingsLoading: "会话闲置提醒：加载中…",
  savedOk: "已保存",
  savedFail: "保存失败：{msg}",
  disabledHint: "会话闲置提醒已禁用",
  noCandidates: "暂无需要归档的会话",
  settingsName: "会话闲置提醒",
  settingsDescription: "闲置阈值 / 静默时长 / 扫描间隔 / 立即检查",
  enable: "启用",
  idleHours: "闲置阈值（小时）",
  snoozeHours: "拒绝后静默（小时）",
  scanMinutes: "扫描间隔（分钟）",
  checkNow: "立即检查",
  save: "保存",
} as const;

/** 字典 key 并集（LocaleNamespaceMap 声明合并用）。 */
export type IdleArchiveLocaleKey = keyof typeof zh;

/** 英文词典：必须与 zh key 完整对齐。 */
export const en: Record<IdleArchiveLocaleKey, string> = {
  justNow: "just now",
  minutesAgo: "{n} minutes ago",
  hoursAgo: "{n} hours ago",
  daysAgo: "{n} days ago",
  modalTitle: "Idle session reminder",
  closeTitle: "Snooze all (no reminder for Y hours)",
  desc: "{count} session(s) idle for over {hours} hours. Archiving hides them from the session list but keeps their history; snoozing silences the reminder for {snooze} hours.",
  hint: "× / Esc: close only (won't remind again for 1 hour); snooze-all uses the configured duration",
  allSnooze: "Snooze all",
  rowLastSeen: "Last seen {rel} ({abs})",
  archive: "Archive",
  snoozeRow: "Snooze",
  archivedOk: "Session archived",
  archivedFail: "Archive failed: {msg}",
  settingsLoading: "Idle archive: loading…",
  savedOk: "Saved",
  savedFail: "Save failed: {msg}",
  disabledHint: "Idle session reminder is disabled",
  noCandidates: "No sessions to archive",
  settingsName: "Idle archive",
  settingsDescription: "Idle threshold / snooze duration / scan interval / check now",
  enable: "Enabled",
  idleHours: "Idle threshold (hours)",
  snoozeHours: "Snooze after decline (hours)",
  scanMinutes: "Scan interval (minutes)",
  checkNow: "Check now",
  save: "Save",
};