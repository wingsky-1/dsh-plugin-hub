/**
 * upgrade 域实现：迁移编排（同步跑完；失败即抛，组合根装配随之失败）。
 *
 * 三态（可单测）：缺失→播种并锚定；已锚定→空转；未来版本→fail-closed 拒绝启动并提示。
 * writeStoredVersion 只经本域 migrate 调用（D7/T1 闭环；config 域仅提供读写原语）。
 * 路径与版本语义复用 config 域门面（单一事实源）：BASELINE 字面 "0.0.0" 与上报口径 "0"
 * 数值等价（compareVersions 缺位补零），报告 from 统一为 "0"。
 */
import {
  BASELINE_VERSION,
  compareVersions,
  readStoredVersion,
  writeStoredVersion,
} from "../../config/interface.ts";
import type { ConfigDeps } from "../../config/interface.ts";
import type { UpgradeDeps } from "../deps.ts";
import { ensureSeeded } from "./steps.ts";

/** 存储目标刻度（与包版本独立：它是磁盘形态刻度，不是发布版本）。 */
export const STORAGE_TARGET = "0.2.6";

/** 迁移报告。 */
export interface MigrateReport {
  readonly from: string;
  readonly to: string;
  readonly seeded: string[];
}

/** config 域版本原语的注入适配（upgrade 的 io 面是其超集，结构兼容直传）。 */
function configPorts(deps: UpgradeDeps): ConfigDeps {
  return { io: deps.io, logger: deps.logger };
}

/** 跑迁移链（同步；抛错即装配失败，不写刻度，下次启动重跑同一步）。 */
export function migrate(deps: UpgradeDeps): MigrateReport {
  const target = deps.targetOverride ?? STORAGE_TARGET;
  const raw = readStoredVersion(deps.home, configPorts(deps));
  const stored = raw === BASELINE_VERSION ? "0" : raw;
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
  const seeded = ensureSeeded(deps.home, deps.seedDefaults(), deps.io);
  writeStoredVersion(deps.home, target, configPorts(deps));
  if (deps.logger.info !== undefined)
    deps.logger.info("dsh-decision-gateway: 存储已锚定 " + stored + " → " + target);
  return { from: stored, to: target, seeded };
}

/** 装配升级域（同步跑完迁移链；失败即抛，apply 随之失败）。门面只转出本函数。 */
export function installUpgrade(deps: UpgradeDeps): MigrateReport {
  return migrate(deps);
}
