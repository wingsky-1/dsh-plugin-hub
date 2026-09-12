/**
 * dsh-notifier pipeline 域 —— 提交体的形状。
 *
 * 种类词汇归本域（它是裁决的坐标系：事件开关、`kindRoutes`、`allowKinds`、bark 紧急度全按
 * 它查），事件适配层只负责往里填。词汇本身的物理定义在 `./kinds.ts`。
 */
import type { NotifySeverity } from "../../deps.ts";
import type { NotifyKind } from "./kinds.ts";

/**
 * 通知请求：一次「发生了什么」的陈述——不是「要通知」，产出它的域不判断该不该发。
 *
 * 与投递域的 `NotifyMessage` 不同：请求是未加工的陈述，消息是已定稿的载荷。
 */
export interface NotifyRequest {
  /** 事件种类：裁决与路由据此查事件开关与频道。 */
  kind: NotifyKind;
  /**
   * 展示强度：只影响出站频道怎么呈现（bark 紧急度、webhook 模板变量），**不参与裁决**。
   *
   * 缺省即没指定，各出口回落自己的默认；内置事件源不填它（内置种类的强度由裁决域按 kind
   * 决定），外部调用方填了照用。
   */
  severity?: NotifySeverity;
  /** 标题与正文（原样，未经下游加工）。 */
  title: string;
  body: string;
  /** 只把裁决结果收窄到这一个频道实例；省略 = 按路由裁决（只有单频道测试会填）。 */
  onlyChannel?: string;
}
