/**
 * dsh-notifier config 域 —— **对上依赖申报表**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。依赖集中在此，
 * 实现块经本文件引用，不直连他域。
 */
/**
 * 跨域形状：频道配置的投递字段与投递域同源，不在两侧各定义一遍。
 *
 * 配置是投递参数的**用户层投影**：多出来的只有身份与开关（id / enabled /
 * 校验后的取值范围），投递需要的字段本身没有第二种定义。
 */
export type { BarkTarget, WebhookTarget } from "../channels/interface.ts";
