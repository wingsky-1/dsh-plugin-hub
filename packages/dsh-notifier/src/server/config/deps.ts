/**
 * dsh-notifier config 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 *
 * 设置只有两个来源：本插件的配置文件，与设置页提交的改动。没有「组合层默认层」——
 * 那是宿主 settings 体系里的概念，而这里是自建存储；留一层半活的默认值，只会让人
 * 以为某处配过什么，而它永远是空的。
 */
import type { LoggerPort } from "../shared/type.ts";

/**
 * 跨域形状：频道配置的投递字段与投递域同源，不在两侧各定义一遍。
 *
 * 配置是投递参数的**用户层投影**：多出来的只有身份与开关（id / enabled /
 * 校验后的取值范围），投递需要的字段本身没有第二种定义。
 */
export type { BarkTarget, WebhookTarget } from "../channels/interface.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface ConfigDeps {
  /** 写入失败出口（读面失败由归一化兜住，只有写面需要它）。 */
  logger: LoggerPort;
}
