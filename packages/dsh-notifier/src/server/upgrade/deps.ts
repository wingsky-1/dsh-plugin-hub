/** upgrade 域依赖声明：本域只声明「我需要外部什么」，装配由组合根完成；契约与实现都经本文件引用。 */
import type { LoggerPort } from "../shared/interface.ts";
import type { LegacySettingsFace } from "./impl/legacy/type.ts";

/** 装配入参：本域依赖的全部外部。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口（失败与版本落差都在这里出声）。 */
  logger: LoggerPort;
  /** 旧配置的读取面（0.2.3 及更早把配置存在官方 settings 服务里）。它是**显式依赖**：组合根把 `settings`
   * 写进插件的 `inject`，宿主保证服务就绪后才装配本插件，所以这里是一次同步读取——没有就绪回调、没有重试。
   * 存量所在的那份宿主文档由它自报路径（`documentPath`），直接读文件才拿得到未注册命名空间的 user 层。 */
  legacySettings: LegacySettingsFace;
}

/**
 * 本域与 config 域只剩**类型**往来（`RawSettingValue` 表达「任意 JSON」），没有运行时依赖：存量设置由本域
 * 直接读写配置文件。割接只做结构搬运——不校验、不补默认值——所以「什么算合法设置」仍旧只有 config 域
 * 归一化一个答案；config 域装配在本域之后，读到的正是割接后的形态。
 */
export type { RawSettingValue } from "../config/interface.ts";
export type { LegacySettingsFace } from "./impl/legacy/type.ts";
