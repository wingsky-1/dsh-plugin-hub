/**
 * dsh-notifier channels 域 —— 投递的输入输出形状。
 *
 * 消息与结果是**投递这件事**的两端：调用方构造消息、投递域产出结果；两者都只对
 * 投递成立，因此归投递块而不是包级公共层——「将来会有别人用」不是共享理由，真有
 * 第三个消费者时再上移。
 */

/** 展示强度（severity 仅展示；过滤语义归 kind）。 */
export type NotifySeverity = "info" | "success" | "warning" | "failure";

/**
 * 待投递消息：正文已渲染、已脱敏。
 *
 * 无出口身份：同一条消息派发给几个出口，各出口看到的是同一份内容——把「发给谁」
 * 写进消息，就等于让出口自己判断该不该理它。
 */
export interface NotifyMessage {
  title: string;
  body: string;
  severity?: NotifySeverity;
}

/**
 * 逐出口投递结果（与目标清单**下标同序**）。
 *
 * 结果不带出口身份——「我是谁」是配置层与裁决层的概念，投递层不需要。
 */
export interface DeliverResult {
  status: "ok" | "failed";
  /**
   * 该通道能给出的**证据上限**，由通道能力决定，不是调用方选的：
   * 对端确认接收（HTTP 2xx / OS 退出码 0）为 `delivered`；浏览器帧只能交到
   * 传输通道，为 `accepted`——`ok` 不代表页面已弹出。
   */
  stage: "accepted" | "delivered";
  /** 失败原因（不含凭据；ok 时缺省）。 */
  reason?: string;
}
