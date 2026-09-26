/**
 * upgrade 域升级链的装配面：把本域的刻度落点与步骤表接进共享链骨架（shared/upgrade-chain.js）。
 *
 * 骨架（读刻度 → 取待办步 → 逐步 await 执行并逐步回写 → 与插件版本对账）由共享层单一实现，本文件
 * 只声明本包的事实：刻度落在哪个文件、读刻度是 fail-closed 还是 fail-safe、步骤表是什么。**任何一步
 * 失败即抛出，装配随之中止**（存储没升完就被按错误形态解释，比不启动糟得多）。
 *
 * **本包的刻度提交语义本轮有变**：下沉前本包是「全链全部成功后才提交最终刻度」（失败时不写中间
 * 版本，避免半完成迁移被下一次启动误判为已完成），现随骨架统一为「每步成功后立刻回写」。两者都可
 * 辩护，取舍见 shared/upgrade-chain.js 文件头：按步对齐让「失败后从同一步重跑」成立（对齐
 * .dsh/skills/dsh-plugin-hub-refactor/SKILL.md 第 6 章的幂等硬要求），代价是链中途失败时磁盘上会停在
 * 一个中间刻度而非原刻度——这要求每一步自身幂等，本包四个业务 step 均满足。**这是本包存储行为契约的
 * 变更，不是一次重构细节。**
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginVersion,
  runUpgradeChain as runSharedChain,
} from "../../../../../../../shared/upgrade-chain.js";
import type { UpgradeDeps } from "../../deps.ts";
import { STEPS } from "../steps/index.ts";
import { readStoredVersion, writeStoredVersion } from "../version/index.ts";

/** 本模块运行时目录：shared 的 pluginVersion 收起点而不自定位（产物形态与白盒单测深度不同）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 装配前跑一遍升级链（组合根在 `apply` 期 `await`）。必须在各域装配**之前**：升级会重写配置文件与
 * 存储文件，先装配就等于让各域先读到旧形态，再让它们带着旧形态继续跑。
 *
 * 刻度原语在本包是**同步 + 返回值**语义（`writeStoredVersion` 失败给 `{ok:false}` 而不是抛），而共享
 * 执行器靠抛错感知失败——故接缝在这里转一层：失败转成抛，抛的**只有原始 reason**（包名前缀与目标版本
 * 由共享层统一包装成「存储版本号回写失败（版本）— 原因」，这里再拼一遍就成了同一句话说两次）。
 */
export function runUpgradeChain(deps: UpgradeDeps): Promise<void> {
  return runSharedChain({
    label: "dsh-notifier",
    steps: STEPS,
    deps,
    readScale: () => readStoredVersion(),
    writeScale: (version) => {
      const written = writeStoredVersion(version);
      if (!written.ok) throw new Error(written.reason);
    },
    targetVersion: pluginVersion(MODULE_DIR),
    logger: deps.logger,
  });
}
