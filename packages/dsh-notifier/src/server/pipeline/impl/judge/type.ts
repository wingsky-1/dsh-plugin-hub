/**
 * dsh-notifier pipeline 域 —— 裁决块自己的形状。
 */

/**
 * 事件开关在设置里的键名。事实源在 src/shared/kinds.ts（与 kind→开关键表同处）——那张表是
 * 两端共用的，键名类型跟着表走，免得两处各写一份联合。
 */
export type { KindSwitchKey } from "../../../../shared/interface.ts";

/**
 * 压制原因：随记录写进历史，是「为什么我没收到」的唯一答案来源。`unlisted` = 动态 kind
 * 还没被用户确认；`quiet` 不改名——它是持久格式，盘上记录与设置页判定都按这个字面量。
 */
export type SuppressReason = "disabled" | "kind-off" | "unlisted" | "quiet" | "no-target";

/** 裁决结果：留或弃；弃必有原因。 */
export type Verdict = { ok: true } | { ok: false; reason: SuppressReason };
