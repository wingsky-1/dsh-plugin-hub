/** upgrade 域依赖声明：本域只声明「我需要外部什么」，装配由组合根完成；契约与实现都经本文件引用。 */
import type { LoggerPort } from "../shared/interface.ts";
import type { LegacySettingsFace } from "./impl/legacy/type.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口（失败与版本落差都在这里出声）。 */
  logger: LoggerPort;
  /** 旧配置的读取面：正式来源固定为 `$DSH_HOME/settings.yaml.imported` 与 `settings.yaml`；
   * 正式文件失败时由 upgrade 边界闭锁，只有它们无数据时才依次使用 describe 与 V0 JSON。 */
  legacySettings: LegacySettingsFace;
}

/**
 * 本域与 config 域只剩**类型**往来（`RawSettingValue` 表达「任意 JSON」），没有运行时依赖：存量设置由本域
 * 直接读写配置文件。割接只做结构搬运——不校验、不补默认值——所以「什么算合法设置」仍旧只有 config 域
 * 归一化一个答案；config 域装配在本域之后，读到的正是割接后的形态。
 */
export type { RawSettingValue } from "../config/interface.ts";
export type { LegacySettingsFace } from "./impl/legacy/type.ts";
