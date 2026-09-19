/** upgrade 域依赖声明：本域只声明「我需要外部什么」，装配由组合根完成；契约与实现都经本文件引用。 */

/**
 * 升级链的诊断出口。本域只用到 `warn`：版本落差与「旧文件比目标新」都在这里出声，链本身不打印、
 * 也不因为出声改变动作（迁移动作只由磁盘事实决定）。
 *
 * 写成最小结构面而不是宿主 logger 类型：组合根递进来的 `ctx.logger` 结构上满足它，而本域不需要
 * 认识它的其余能力。
 */
export interface UpgradeLogger {
  warn(message: string): void;
}

/** 装配入参：本域依赖的全部外部。 */
export interface UpgradeDeps {
  /** 升级链的诊断出口。 */
  logger: UpgradeLogger;
  /**
   * 用户**显式**配置的全局服务器配置路径（插件 apply 配置键 `storePath`，见 `server/config/config-schema.ts`）；
   * 空串 = 未配置。
   *
   * 必须是「显式值」而不是解析后的**生效路径**：未配置时生效路径恰恰是待迁移的旧默认落点
   * （`src/index.ts` 的 `resolveStorePath` 回落），照生效值判断会把每一次默认安装都当成「用户接管了路径」，
   * 于是迁移整段跳过、刻度照常推进——静默丢用户配置。
   */
  storePath: string;
}
