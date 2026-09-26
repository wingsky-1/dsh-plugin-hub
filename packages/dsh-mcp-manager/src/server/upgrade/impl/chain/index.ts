/**
 * upgrade 域与共享升级链的唯一接缝：本域只提供「包名 / 步骤表 / 刻度落点」三样业务事实，
 * 链驱动（待办步筛选、逐步 await 串行、每步回写、失败即抛、跑后对账）统一在
 * `shared/upgrade-chain.js`，此处不再有一份实现。
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpgradeDeps } from "../../deps.ts";
import {
  pluginVersion,
  runUpgradeChain as runSharedChain,
} from "../../../../../../../shared/upgrade-chain.js";
import { STEPS } from "../steps/index.ts";
import { readStoredVersion, writeStoredVersion } from "../version/index.ts";

/** 本模块运行时目录：shared 的 pluginVersion 收起点而不自定位（产物形态与白盒单测深度不同）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function runUpgradeChain(deps: UpgradeDeps): Promise<void> {
  return runSharedChain({
    label: "dsh-mcp-manager",
    steps: STEPS,
    deps,
    readScale: readStoredVersion,
    writeScale: writeStoredVersion,
    targetVersion: pluginVersion(MODULE_DIR),
    logger: deps.logger,
  });
}
