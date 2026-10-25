/** upgrade service 域测试的专属 fixture：只提供事实与记录，不重写被测决策。 */
import {
  CONFIG_FILE_NAME,
  VERSION_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { readFileSync } from "node:fs";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { newestTargetVersion } from "../../../../../shared/upgrade-chain.js";
import { installUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger } from "../../helpers.ts";

/** 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。 */
export function newestTarget(): string {
  return newestTargetVersion(STEPS);
}

export type UpgradeServiceHome = { readonly dir: string; dispose: () => void };

export { releaseUpgrade } from "../../../src/server/upgrade/interface.ts";

/** 存量命名空间记录：本域只读 `ns` 与 `user` 两项，官方描述符的其余字段与判据无关。 */
export type LegacyEntry = { ns: string; user?: unknown };

/**
 * 假 settings 读面：同步给出一份命名空间记录，并记下被读过几次——「割接失败时不读存量」这条判据
 * 靠它证伪（读面被碰过就说明半完成的迁移还在往前走）。
 */
export function makeLegacy(entries: readonly LegacyEntry[] = []) {
  let reads = 0;
  const face = {
    describe: () => {
      reads += 1;
      return entries as unknown as ReturnType<UpgradeDeps["legacySettings"]["describe"]>;
    },
  };
  return { face, reads: () => reads };
}

/** 装配一次升级域（链在装配期异步跑完，故本 helper 收 Promise）。 */
export async function assembleUpgrade(options: { legacy?: ReturnType<typeof makeLegacy> } = {}) {
  const logger = makeLogger();
  const legacy = options.legacy ?? makeLegacy();
  const deps: UpgradeDeps = { logger, legacySettings: legacy.face };
  await installUpgrade(deps);
  return { logger, legacy, deps };
}

/** 磁盘上的配置文件；没写过即抛出（判据要的是内容，不是「读不到也算过」）。 */
export function configOnDisk(): Record<string, unknown> {
  return JSON.parse(readConfigText()) as Record<string, unknown>;
}

/** 磁盘上的配置文件正文；幂等判据要逐字比较。 */
export function readConfigText(): string {
  return readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8");
}

/** 磁盘上的存储版本；失败路径必须能直接证明它没有被写动。 */
export function storedVersionOnDisk(): string {
  return readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim();
}

/** 把链固定在首个真实升级边界，失败前后就能比较同一份刻度。 */
export function seedStoredVersion(version: string): void {
  writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${version}\n`);
}
