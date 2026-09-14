/**
 * upgrade 域升级链驱动：读刻度 → 取刻度仍停在起点的步骤 → 逐步执行并回写刻度 → 与插件版本对账。
 * **任何一步失败即抛出，启动随之中止**（存储没升完就被按错误形态解释，比不启动糟得多）；步骤按
 * **目标版本**排序执行，不按声明顺序。
 */
import type { UpgradeDeps, UpgradeLogger } from "../../deps.ts";
import { STEPS } from "../steps/index.ts";
import {
  compareVersions,
  pluginVersion,
  readStoredVersion,
  writeStoredVersion,
} from "../version/index.ts";
import type { UpgradeStep } from "./type.ts";

/**
 * 装配前跑一遍升级链（组合根在 `apply` 期 `await`）。必须在各域装配**之前**：升级会重写存储文件，
 * 先装配就等于让各域先读到旧形态，再让它们带着旧形态继续跑。
 */
export async function runUpgradeChain(deps: UpgradeDeps): Promise<void> {
  const recorded = await readStoredVersion();
  for (const step of pendingSteps(STEPS, recorded)) await applyStep(step, deps);
  reportGap(await readStoredVersion(), pluginVersion(), deps.logger);
}

/**
 * 刻度还停在这一步起点或更早的待办步，按**目标版本升序**（声明顺序只是便于阅读，不是执行顺序——
 * 漏排序会让后一步读到前一步尚未改进的形态）。步骤表作为入参是为了让本域用例能直接喂合成表，
 * 断言排序与起点边界；对外契约面仍只有 `installUpgrade` / `releaseUpgrade`。
 */
export function pendingSteps(steps: readonly UpgradeStep[], recorded: string): UpgradeStep[] {
  return [...steps]
    .sort((left, right) => compareVersions(left.targetVersion, right.targetVersion))
    .filter((step) => compareVersions(step.fromVersion, recorded) >= 0);
}

/**
 * 执行一步，成功后回写刻度。回写在 `run` **之后**而不是之前：刻度是「这一步做完了」的凭证，
 * 先写刻度等于把凭证发给一件还没做完的事，而失败时那个刻度会让下次启动跳过它。失败与回写失败
 * 都带上目标版本，是为了让「哪一步」出现在启动失败的现场。
 */
async function applyStep(step: UpgradeStep, deps: UpgradeDeps): Promise<void> {
  try {
    await step.run(deps);
  } catch (cause) {
    throw new Error(`dsh-mcp-manager: 存储升级到 ${step.targetVersion} 失败 — ${reasonOf(cause)}`, {
      cause,
    });
  }
  try {
    await writeStoredVersion(step.targetVersion);
  } catch (cause) {
    throw new Error(
      `dsh-mcp-manager: 存储版本号回写失败（${step.targetVersion}）— ${reasonOf(cause)}`,
      { cause },
    );
  }
}

/** 失败现场要的是消息，不是异常对象本身；非 Error 抛出物（字符串、undefined）也要落到文案里。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 链跑完后的对账。三种落差分开报，因为它们要人去改的地方完全不同：落后 = 这一步的升级函数还没写
 * （开发期漏项）；超前且步骤表本身也超前 = 步骤表与 package.json 没同步；超前而步骤表没超前 =
 * 装的是更旧的包（降级）。三者都不中止启动——它们不是迁移动作失败，而静默地把刻度改成看起来对的值更糟。
 */
export function reportGap(recorded: string, target: string, logger: UpgradeLogger): void {
  const gap = compareVersions(recorded, target);
  if (gap === 0) return;

  if (gap < 0) {
    logger.warn(
      `dsh-mcp-manager: 存储版本 ${recorded} 落后于插件版本 ${target}，缺少对应的升级步骤`,
    );
    return;
  }

  const newest = newestTargetVersion(STEPS);
  if (newest !== "" && compareVersions(newest, target) > 0) {
    logger.warn(
      `dsh-mcp-manager: 升级链的目标版本 ${newest} 高于插件版本 ${target}（存储已升到 ${recorded}）——步骤表与 package.json 不同步`,
    );
    return;
  }
  logger.warn(`dsh-mcp-manager: 存储版本 ${recorded} 高于插件版本 ${target}，本插件的升级链不回退`);
}

/** 步骤表里最高的目标版本；空表时给空串。 */
function newestTargetVersion(steps: readonly UpgradeStep[]): string {
  let newest = "";
  for (const step of steps) {
    if (newest === "" || compareVersions(step.targetVersion, newest) > 0) {
      newest = step.targetVersion;
    }
  }
  return newest;
}
