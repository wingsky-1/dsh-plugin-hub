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
 * 该通道能给出的**证据上限**，由通道能力决定，不是调用方选的：
 * 对端确认接收（HTTP 2xx / OS 退出码 0）为 `delivered`；浏览器帧只能交到
 * 传输通道，为 `accepted`——`ok` 不代表页面已弹出。
 */
export type DeliverStage = "accepted" | "delivered";

/**
 * 逐出口投递结果（与目标清单**下标同序**）。
 *
 * 结果不带出口身份——「我是谁」是配置层与裁决层的概念，投递层不需要。
 *
 * 分成两支而不是一个带可选字段的形状：失败分支里的 `retryable` 是**必答项**，于是每个
 * 失败点都必须对「这次失败能不能重试」表态，漏答是编译错误。用可选字段的话，漏答会
 * 静默落进"未标注"那个语义里，而那个语义只在调用方一侧才看得见。
 */
export type DeliverResult =
  /** 出口完成/受理了这次投递；`stage` 说明它拿得出什么证据。 */
  | { status: "ok"; stage: DeliverStage }
  /**
   * 出口失败了。
   *
   * `retryable` 是出口对失败的**分类**（它才分得清 4xx 与 5xx、网络超时与参数错误），
   * 而不是它自己去重试：重试次数、退避与在途上限是管线的事（`pipeline/impl/dispatch/`），
   * 出口答完这一句就没有后续动作。
   */
  | { status: "failed"; stage: DeliverStage; reason: string; retryable: boolean };
