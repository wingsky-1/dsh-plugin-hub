/**
 * dsh-notifier pipeline 域 —— 裁决块自己的形状。
 */

/** 事件开关在设置里的键名。 */
export type KindSwitchKey =
  | "notifyAsk"
  | "notifyQuestion"
  | "notifyTaskDone"
  | "notifySubagentDone"
  | "notifyTaskError"
  | "notifyTurnEnd";

/**
 * 压制原因：随记录写进历史，是「为什么我没收到」的唯一答案来源。`unlisted` = 动态 kind
 * 还没被用户确认；`quiet` 不改名——它是持久格式，盘上记录与设置页判定都按这个字面量。
 */
export type SuppressReason = "disabled" | "kind-off" | "unlisted" | "quiet" | "no-target";

/** 裁决结果：留或弃；弃必有原因。 */
export type Verdict = { ok: true } | { ok: false; reason: SuppressReason };
