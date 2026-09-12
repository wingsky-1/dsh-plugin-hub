/** config 域依赖声明：只声明「我需要外部什么」；设置只有两个来源（配置文件与设置页提交），没有「组合层默认层」。 */
import type { LoggerPort } from "../shared/interface.ts";

/** 跨域形状：频道配置的投递字段与投递域同源——配置是投递参数的**用户层投影**，多出来的只有身份与开关。 */
export type { BarkTarget, WebhookTarget } from "../channels/interface.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface ConfigDeps {
  /** 写入失败出口（读面失败由归一化兜住，只有写面需要它）。 */
  logger: LoggerPort;
}
