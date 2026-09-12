/**
 * dsh-notifier channels 域 —— bark 出口的投递参数。
 *
 * 只描述「把消息送到 bark 需要什么」：投递视角，不是用户配置视角（enabled、
 * 校验、默认值属配置层）。调用方负责把自己的配置模型适配成这里的形状。
 */

/** bark 出口。 */
export interface BarkTarget {
  type: "bark";
  baseUrl: string;
  deviceKey: string;
  level?: string;
  group?: string;
  sound?: string;
  timeoutMs?: number;
}
