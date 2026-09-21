/**
 * upgrade 域实现：迁移编排（同步跑完；失败即抛，组合根装配随之失败）。
 *
 * 三态（可单测）：缺失→播种并锚定；已锚定→空转；未来版本→fail-closed 拒绝启动并提示。
 * writeStoredVersion 只经本域调用（D7/T1 闭环；config 域仅提供读写原语，不散调）。
 */
import type { UpgradeDeps } from "../deps.ts";
import { seedMissing } from "./steps.ts";
import { compareVersions, readStoredVersion, writeStoredVersion } from "./version.ts";

/** 存储目标刻度（与包版本独立：它是磁盘形态刻度，不是发布版本）。 */
export const STORAGE_TARGET = "0.2.6";

/** 迁移报告。 */
export interface MigrateReport {
  readonly from: string;
  readonly to: string;
  readonly seeded: string[];
}

/** 跑迁移链（同步；抛错即装配失败，不写刻度，下次启动重跑同一步）。 */
export function migrate(deps: UpgradeDeps): MigrateReport {
  const target = deps.targetOverride ?? STORAGE_TARGET;
  const stored = readStoredVersion(deps.home, deps);
  const order = compareVersions(stored, target);
  if (order > 0) {
    throw new Error(
      "upgrade[500]: unknown future storage version " +
        stored +
        " (target " +
        target +
        "): refusing to start — 请升级插件后再试",
    );
  }
  if (order === 0) return { from: stored, to: target, seeded: [] };
  const seeded = seedMissing(deps.home, deps);
  writeStoredVersion(deps.home, target, deps);
  if (deps.logger.info !== undefined)
    deps.logger.info("dsh-jev-decide: 存储已锚定 " + stored + " → " + target);
  return { from: stored, to: target, seeded };
}
