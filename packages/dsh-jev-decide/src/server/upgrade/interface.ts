/**
 * upgrade 域门面：包内跨域引用的唯一入口（只转出，不放实现）。
 *
 * 本域必须在各域装配之前跑（动磁盘者在先）：先跑完存储锚定，各域才读得到 canonical 形态。
 */
export type { LoggerPort, SeedFiles, UpgradeDeps, UpgradeIoPorts } from "./deps.ts";
import type { UpgradeDeps } from "./deps.ts";
export {
  BASELINE_VERSION,
  compareVersions,
  pluginVersion,
  readStoredVersion,
  writeStoredVersion,
} from "./impl/version.ts";
export { configFile, namespaceDir, presetsFile, secretsFile, versionFile } from "./impl/paths.ts";
export { ensureSeeded, seedMissing } from "./impl/steps.ts";
export type { MigrateReport } from "./impl/service.ts";
import type { MigrateReport } from "./impl/service.ts";
import { STORAGE_TARGET, migrate } from "./impl/service.ts";
export { STORAGE_TARGET, migrate };

/** 装配升级域（同步跑完迁移链；失败即抛，apply 随之失败）。 */
export function installUpgrade(deps: UpgradeDeps): MigrateReport {
  return migrate(deps);
}

/** 卸载升级域（无状态可收：写的是文件，无释放动作）。 */
export function releaseUpgrade(): void {}
