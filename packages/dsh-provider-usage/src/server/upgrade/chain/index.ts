/**
 * dsh-provider-usage — upgrade 域升级链驱动：读刻度 → 取刻度仍停在起点的步骤 →
 * 逐步执行并回写刻度 → 与插件版本对账。
 * **任何一步失败即抛出，启动随之中止**（存储没升完就被按错误形态解释，比不启动糟得多）；
 * 步骤按**目标版本**排序执行，不按声明顺序。
 *
 * mcp-manager server/upgrade/impl/chain/index.ts 同构：语义逐项对应，落点改为 historyRoot
 *（刻度读写经 version.ts 的 root 参数化原语，不散在 DSH_HOME 根）。
 */
import type { UpgradeDeps } from "../deps.ts";
import { migrateLastRun } from "../last-run-morph.ts";
import { migrateReportConfig } from "../config-morph.ts";
import { migrateStorageLayout } from "../storage-layout.ts";
import {
  compareVersions,
  pluginVersion,
  readStoredVersion,
  writeStoredVersion,
} from "../version.ts";

/**
 * 一步升级：把存储从 fromVersion 的形态推进到 targetVersion。两端都写出来而不是只写目标
 *——「这一步管的是哪一段」要靠与前后步骤比对才能推出来。步骤是**刻度**而不是迁移函数的别名：
 * 没有数据要改的版本也给一步（run 空实现）。
 */
export interface UpgradeStep {
  /** 起点版本：这一步处理的存储形态对应的版本（升级**前**的那个版本）。 */
  readonly fromVersion: string;
  /** 目标版本：这一步完成后**回写**进 .upgrade-version 的刻度（链统一回写，步骤自己不写）。 */
  readonly targetVersion: string;
  /** 迁移动作；入参是本域的外部依赖（S2 窄面）。失败即抛，启动随之中止。 */
  run(deps: UpgradeDeps): Promise<void>;
}

/**
 * 步骤表。**新增版本时必须在此追加一项**，哪怕这一步没有数据要改（run 给空实现）：
 * 链的推进以步骤为刻度，漏掉的版本会让存储刻度永久停在旧值上。
 *
 * fromVersion 取原点而不是某个历史版本：.upgrade-version 是本次才新增的刻度，所有存量安装
 * 的刻度都从 0.0.0 起算，第一步必须对它们全部待办；后两步以前一步目标为起点，失败即停在
 * 上一步刻度，下次从失败步重跑（同刻度多步会让失败步的重试被已推进的刻度跳过）。
 * targetVersion 是**存储形态的代际**（0.2.3 存储归位 / 0.2.4 配置割接 / 0.2.5 last-run），
 * 与 package.json 的 0.2.5 对齐在最后一步（链跑完的对账会把漂移报出来）。
 * 按目标版本升序维护；执行顺序由链驱动排序决定，此处顺序只为便于阅读。
 */
export const STEPS: readonly UpgradeStep[] = [
  { fromVersion: "0.0.0", targetVersion: "0.2.3", run: migrateStorageLayout },
  { fromVersion: "0.2.3", targetVersion: "0.2.4", run: migrateReportConfig },
  { fromVersion: "0.2.4", targetVersion: "0.2.5", run: migrateLastRun },
];

/**
 * 装配前跑一遍升级链（组合根在 apply 期 await）。必须在各域装配**之前**：升级会重写存储文件，
 * 先装配就等于让各域先读到旧形态，再让它们带着旧形态继续跑。
 */
export async function runUpgradeChain(deps: UpgradeDeps): Promise<void> {
  const root = deps.resolveRoot();
  const recorded = await readStoredVersion(root);
  for (const step of pendingSteps(STEPS, recorded)) await applyStep(step, deps, root);
  reportGap(await readStoredVersion(root), pluginVersion(), deps.logger);
}

/**
 * 刻度还停在这一步起点或更早的待办步，按**目标版本升序**。步骤表作为入参是为了让本域用例
 * 能直接喂合成表，断言排序与起点边界；对外契约面仍只有 installUpgrade。
 */
export function pendingSteps(steps: readonly UpgradeStep[], recorded: string): UpgradeStep[] {
  return [...steps]
    .sort((left, right) => compareVersions(left.targetVersion, right.targetVersion))
    .filter((step) => compareVersions(step.fromVersion, recorded) >= 0);
}

async function applyStep(step: UpgradeStep, deps: UpgradeDeps, root: string): Promise<void> {
  try {
    await step.run(deps);
  } catch (cause) {
    throw new Error(
      `dsh-provider-usage: 存储升级到 ${step.targetVersion} 失败 — ${reasonOf(cause)}`,
      { cause },
    );
  }
  try {
    await writeStoredVersion(root, step.targetVersion);
  } catch (cause) {
    throw new Error(
      `dsh-provider-usage: 存储版本号回写失败（${step.targetVersion}）— ${reasonOf(cause)}`,
      { cause },
    );
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 链跑完后的对账。三种落差分开报，因为它们要人去改的地方完全不同：落后 = 这一步的升级函数还没写
 *（开发期漏项）；超前且步骤表本身也超前 = 步骤表与 package.json 没同步；超前而步骤表没超前 =
 * 装的是更旧的包（降级）。三者都不中止启动——它们不是迁移动作失败，而静默地把刻度改成看起来对的值更糟。
 */
export function reportGap(recorded: string, target: string, logger: UpgradeDeps["logger"]): void {
  const gap = compareVersions(recorded, target);
  if (gap === 0) return;
  if (gap < 0) {
    logger.warn(
      `dsh-provider-usage: 存储版本 ${recorded} 落后于插件版本 ${target}，缺少对应的升级步骤`,
    );
    return;
  }
  const newest = newestTargetVersion(STEPS);
  if (newest !== "" && compareVersions(newest, target) > 0) {
    logger.warn(
      `dsh-provider-usage: 升级链的目标版本 ${newest} 高于插件版本 ${target}（存储已升到 ${recorded}）——步骤表与 package.json 不同步`,
    );
    return;
  }
  logger.warn(
    `dsh-provider-usage: 存储版本 ${recorded} 高于插件版本 ${target}，本插件的升级链不回退`,
  );
}

function newestTargetVersion(steps: readonly UpgradeStep[]): string {
  let newest = "";
  for (const step of steps) {
    if (newest === "" || compareVersions(step.targetVersion, newest) > 0) {
      newest = step.targetVersion;
    }
  }
  return newest;
}
