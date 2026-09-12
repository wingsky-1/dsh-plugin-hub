/**
 * dsh-notifier upgrade 域 —— 升级链驱动。
 *
 * 一次启动跑一遍：读刻度 → 取刻度仍停在起点的步骤 → 逐步执行并回写刻度 → 与插件
 * 版本对账。**任何一步失败即抛出，启动随之中止**：存储没升完就被下游按错误的形态
 * 解释，那比不启动糟得多——不启动至少是可见的，而半完成的迁移会安静地把数据读错。
 *
 * 抛出的那一步不会回写刻度，所以下次启动从同一步重跑；迁移函数因此必须自己保证
 * 重跑安全（幂等），这是本域对步骤实现的唯一硬要求。
 *
 * 步骤按目标版本排序执行，不按声明顺序：声明顺序是给人读的，执行顺序是语义，两者
 * 一旦分叉，错的是声明。排序把「步骤表写乱了顺序」从一个静默的错误执行变成一个
 * 无后果的书写习惯问题。
 *
 * 依赖方向：只引用本目录、`../version/`、`../steps/` 与包内共享层。
 */
import type { LoggerPort } from "../../../shared/type.ts";
import { STEPS } from "../steps/index.ts";
import {
  compareVersions,
  pluginVersion,
  readStoredVersion,
  writeStoredVersion,
} from "../version/index.ts";
import type { UpgradeStep } from "./type.ts";

/**
 * 装配前跑一遍升级链（组合根在 `apply` 期调用）。
 *
 * 必须在各域装配**之前**：升级会重写配置文件与存储文件，先装配就等于让各域先读到
 * 旧形态，再让它们带着旧形态继续跑。
 */
export function runUpgradeChain(logger: LoggerPort): void {
  const recorded = readStoredVersion();
  for (const step of pendingSteps(recorded)) applyStep(step);
  reportGap(readStoredVersion(), pluginVersion(), logger);
}

/** 刻度还停在这一步起点或更早的步骤，按目标版本升序。 */
function pendingSteps(recorded: string): UpgradeStep[] {
  return [...STEPS]
    .sort((left, right) => compareVersions(left.targetVersion, right.targetVersion))
    .filter((step) => compareVersions(step.fromVersion, recorded) >= 0);
}

/**
 * 执行一步，成功后回写刻度。
 *
 * 回写在 `run` 之后而不是之前：刻度是「这一步做完了」的凭证，先写刻度等于把凭证
 * 发给一件还没做完的事。失败时抛出的错误带上目标版本，是为了让「哪一步」这件事
 * 出现在启动失败的现场，而不是留给人从存储内容去猜。
 */
function applyStep(step: UpgradeStep): void {
  try {
    step.run();
  } catch (cause) {
    throw new Error(
      `dsh-notifier: 存储升级到 ${step.targetVersion} 失败 — ${cause instanceof Error ? cause.message : "未知原因"}`,
      { cause },
    );
  }
  const written = writeStoredVersion(step.targetVersion);
  if (!written.ok) {
    throw new Error(`dsh-notifier: 存储版本号回写失败（${step.targetVersion}）— ${written.reason}`);
  }
}

/**
 * 链跑完后的对账。
 *
 * 三种落差分开报，因为它们要人去改的地方完全不同：落后 = 这一步的升级函数还没写
 * （开发期漏项）；超前且步骤表本身也超前 = 步骤表与 package.json 没同步（改的是
 * 版本号，不是迁移函数）；超前而步骤表没超前 = 装的是更旧的包（降级）。
 *
 * 三者都不中止启动——它们不是迁移动作失败，但都会让数据被按错误的形态解释，
 * 静默地把刻度改成看起来对的值更糟。
 */
function reportGap(recorded: string, target: string, logger: LoggerPort): void {
  const gap = compareVersions(recorded, target);
  if (gap === 0) return;

  if (gap < 0) {
    logger.warn(`dsh-notifier: 存储版本 ${recorded} 落后于插件版本 ${target}，缺少对应的升级步骤`);
    return;
  }

  const newest = newestTargetVersion();
  if (newest !== "" && compareVersions(newest, target) > 0) {
    logger.warn(
      `dsh-notifier: 升级链的目标版本 ${newest} 高于插件版本 ${target}（存储已升到 ${recorded}）——步骤表与 package.json 不同步`,
    );
    return;
  }
  logger.warn(`dsh-notifier: 存储版本 ${recorded} 高于插件版本 ${target}，本插件的升级链不回退`);
}

/** 步骤表里最高的目标版本；空表时给空串。 */
function newestTargetVersion(): string {
  let newest = "";
  for (const step of STEPS) {
    if (newest === "" || compareVersions(step.targetVersion, newest) > 0)
      newest = step.targetVersion;
  }
  return newest;
}
