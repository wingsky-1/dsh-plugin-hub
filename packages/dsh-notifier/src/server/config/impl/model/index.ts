/**
 * 设置默认形态。与 `type.ts` 分开：形状与默认值是两套导出面，混在一起会让只想引一个类型
 * 的调用方连同一份值表一起拖进来。
 */
import type { NotifyConfig } from "./type.ts";

/** 默认设置：缺键的兜底值，也是设置页展示的初始形态。 */
export const DEFAULT_CONFIG: NotifyConfig = {
  notifyAsk: true,
  notifyQuestion: true,
  notifyTaskDone: true,
  notifySubagentDone: false,
  notifyTaskError: true,
  notifyTurnEnd: false,

  systemEnabled: true,
  browserEnabled: true,
  systemNotify: true,
  browserNotify: true,
  notifyWhenVisible: false,
  notifySound: true,
  browserSound: true,
  systemSound: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  channels: [],
  kindRoutes: {},
  allowKinds: [],

  historyMaxAgeDays: 0,
  maxConnections: 16,
};
