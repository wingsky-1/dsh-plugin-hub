/**
 * 设置默认形态。与 `type.ts` 分开：形状与默认值是两套导出面，混在一起会让只想引一个类型
 * 的调用方连同一份值表一起拖进来。
 */
import { DEFAULTS } from "../../../../shared/interface.ts";
import type { NotifyConfig } from "./type.ts";

/** 默认设置：缺键的兜底值，也是设置页展示的初始形态。
 *
 * 顶层默认值来自 src/shared/config-schema.ts 的 `DEFAULTS`（两端共享面的事实源），本域只补
 * `channels` 的两条内置条目——它们只在服务端物化，不进共享表。
 *
 * 逐键铺开而不是 `...DEFAULTS`：铺开会让 `quietHours` / `kindRoutes` / `allowKinds` 与共享表
 * **同引用**，而共享表还随客户端内联——谁就地改写谁就污染了另一个。逐键写死同时把键序也
 * 钉住：`Object.keys(DEFAULT_CONFIG)` 是净化闸的键序来源，顺序变了用户层净化结果的键序就跟着变。 */
export const DEFAULT_CONFIG: NotifyConfig = {
  notifyAsk: DEFAULTS.notifyAsk,
  notifyQuestion: DEFAULTS.notifyQuestion,
  notifyTaskDone: DEFAULTS.notifyTaskDone,
  notifySubagentDone: DEFAULTS.notifySubagentDone,
  notifyTaskError: DEFAULTS.notifyTaskError,
  notifyTurnEnd: DEFAULTS.notifyTurnEnd,

  // 渠道形态只有一处表达：下面两条内置条目。0.2.3 的顶层渠道键在升级时被搬进条目并删除。
  quietHours: {
    enabled: DEFAULTS.quietHours.enabled,
    windows: DEFAULTS.quietHours.windows.map((w) => ({ ...w })),
  },
  // 内置频道恒在场且恒在最前：默认表就带它们，投递投影据此物化；0.2.8 形态清理负责把磁盘上
  // 残缺的内置条目补成同一份形态（判据在 upgrade/steps.test.ts 的「与默认表逐字一致」）。
  channels: [
    { type: "browser", id: "browser", enabled: true, popup: true, sound: true, whenVisible: false },
    { type: "system", id: "system", enabled: true, popup: true, sound: true },
  ],
  kindRoutes: { ...DEFAULTS.kindRoutes },
  allowKinds: [...DEFAULTS.allowKinds],

  historyMaxAgeDays: DEFAULTS.historyMaxAgeDays,
};
