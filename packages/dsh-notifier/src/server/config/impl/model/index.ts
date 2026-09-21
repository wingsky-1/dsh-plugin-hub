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

  // 渠道形态只有一处表达：下面两条内置条目。0.2.3 的顶层渠道键在升级时被搬进条目并删除。
  quietHours: { enabled: false, windows: [{ start: "22:00", end: "08:00" }] },
  // 内置频道恒在场且恒在最前：默认表就带它们，读面物化才有「与默认表逐字一致」的比对基准。
  channels: [
    { type: "browser", id: "browser", enabled: true, popup: true, sound: true, whenVisible: false },
    { type: "system", id: "system", enabled: true, popup: true, sound: true },
  ],
  kindRoutes: {},
  allowKinds: [],

  historyMaxAgeDays: 0,
};
