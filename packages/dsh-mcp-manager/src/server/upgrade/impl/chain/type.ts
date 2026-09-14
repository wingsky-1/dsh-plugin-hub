/** upgrade 域升级链自己的形状。 */
import type { UpgradeDeps } from "../../deps.ts";

/**
 * 一步升级：把存储从 `fromVersion` 的形态推进到 `targetVersion`。两端都写出来而不是只写目标
 * ——「这一步管的是哪一段」要靠与前后步骤比对才能推出来。步骤是**刻度**而不是迁移函数的别名：
 * 没有数据要改的版本也给一步（`run` 空实现）。
 */
export interface UpgradeStep {
  /** 起点版本：这一步处理的存储形态对应的版本（升级**前**的那个版本）。 */
  fromVersion: string;
  /** 目标版本：这一步完成后**回写**进 `version` 文件的刻度。刻度由链驱动统一回写而不是步骤自己写
   * ——「数据改了一半、刻度已经前进」的存储没有任何办法退回。 */
  targetVersion: string;
  /** 迁移动作；入参是本域的外部依赖（旧路径的读写面与用户显式路径）。失败即抛，启动随之中止。 */
  run(deps: UpgradeDeps): Promise<void>;
}
