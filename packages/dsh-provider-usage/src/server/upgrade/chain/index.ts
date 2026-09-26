/**
 * dsh-provider-usage — upgrade 域链适配器：把 shared 升级链骨架接到本包的三处落点上
 * （本包步骤表、historyRoot 下的刻度文件、本包 logger 端口）。
 *
 * 链驱动本身（筛选与排序、逐步 await、每步回写、跑完对账、失败文案包装）归
 * shared/upgrade-chain.js；本文件只留接缝，不再是链驱动的一份副本。
 *
 * 落点差异一处：本包刻度随 historyDir 走（刻度读写带 root 参数，见 version.ts），故
 * readScale / writeScale 在这里各包一层闭包；resolveRoot 仍在跑链前调一次，不逐步重解析。
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginVersion,
  runUpgradeChain as runSharedChain,
} from "../../../../../../shared/upgrade-chain.js";
import type { UpgradeDeps } from "../deps.ts";
import { STEPS } from "../steps.ts";
import { readStoredVersion, writeStoredVersion } from "../version.ts";

/** 本模块运行时目录：shared 的 pluginVersion 收起点而不自定位（产物形态与白盒单测深度不同）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 装配前跑一遍升级链（组合根在 apply 期 await）。必须在各域装配**之前**：升级会重写存储文件，
 * 先装配就等于让各域读到旧形态，再让它们带着旧形态继续跑。
 */
export function runUpgradeChain(deps: UpgradeDeps): Promise<void> {
  const root = deps.resolveRoot();
  return runSharedChain({
    label: "dsh-provider-usage",
    steps: STEPS,
    deps,
    readScale: () => readStoredVersion(root),
    writeScale: (version) => writeStoredVersion(root, version),
    targetVersion: pluginVersion(MODULE_DIR),
    logger: deps.logger,
  });
}
