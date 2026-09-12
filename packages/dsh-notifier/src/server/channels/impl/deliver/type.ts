/** dsh-notifier channels 域 —— 投递的输入输出形状（消息与结果是投递这件事的两端）。 */

/** 展示强度（severity 仅展示；过滤语义归 kind）。 */
export type NotifySeverity = "info" | "success" | "warning" | "failure";

/** 待投递消息：正文已渲染；无出口身份，`kind` / `ts` 是「这是什么、何时发生」而非收件人。 */
export interface NotifyMessage {
  title: string;
  body: string;
  severity?: NotifySeverity;
  kind: string;
  ts: number;
}

/** 证据上限（通道能力决定，不是本次结果）：HTTP 2xx / 退出码 0 为 `delivered`，浏览器帧为 `accepted`。 */
export type DeliverStage = "accepted" | "delivered";

/** 逐出口投递结果（与目标清单下标同序，不带出口身份）；分成两支让失败分支的字段成为必答项。 */
export type DeliverResult =
  | { status: "ok"; stage: DeliverStage }
  // retryable 是出口对失败的分类，不是它自己去重试：次数、退避与在途上限全在管线
  | { status: "failed"; stage: DeliverStage; reason: string; retryable: boolean };
