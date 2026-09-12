/**
 * dsh-notifier upgrade 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都
 * 经本文件引用，不直连他域。
 */
import type { LoggerPort } from "../shared/type.ts";

/**
 * 配置的存储形态：升级要按配置语义改写旧文件（剔除装配键、拆声音键），形状必须与
 * 配置域同源，否则「哪些是配置键」会变成两份各自漂移的认知。
 */
export type { StoredSettings } from "../config/interface.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口（失败与版本落差都在这里出声）。 */
  logger: LoggerPort;
}
