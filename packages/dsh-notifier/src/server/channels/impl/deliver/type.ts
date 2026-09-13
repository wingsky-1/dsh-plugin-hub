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

/**
 * 频道实例上的未知键（值已按 string/number 过滤）：README 承诺的「未来参数前向兼容」那一面。
 * 配置域负责保留，出口按需带上——bark 原样写进推送体；webhook 的 body 由模板渲染，故只保留不发送
 * （与重写前一致，模板语义不该被透传键绕开）。
 */
export type ChannelExtras = Record<string, string | number>;
