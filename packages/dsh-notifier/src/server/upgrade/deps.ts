/**
 * dsh-notifier upgrade 域 —— **依赖声明**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。契约与实现块都经
 * 本文件引用，不直连他域。
 */
import type * as configApi from "../config/interface.ts";
import type { LoggerPort } from "../shared/type.ts";
import type { LegacySettingsPort } from "./impl/legacy/type.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口（失败与版本落差都在这里出声）。 */
  logger: LoggerPort;
  /**
   * 旧配置的读取面（0.2.3 及更早把配置存在官方 settings 服务里）。
   *
   * 它是本域唯一与非文件存储打交道的地方，也是本域唯一**不能**在装配期完成的动作：
   * 那个服务可能晚到，也可能根本不来。
   */
  legacySettings: LegacySettingsPort;
  /**
   * config 域的写面：存量设置最终要落进当前配置文件。
   *
   * 走它的写入口而不是自己往磁盘上写：掩码还原、校验、合并、原子落盘、刷新内存快照
   * 都在那里，另开一条路等于让「什么算合法设置」有两个答案。
   */
  config: ConfigPort;
}

/** config 域给本域的能力面。 */
export type ConfigPort = Pick<typeof configApi, "writeConfig">;

export type { LegacySettingsFace, LegacySettingsPort } from "./impl/legacy/type.ts";
export type { RawSettingValue, SettingsPatch } from "../config/interface.ts";
