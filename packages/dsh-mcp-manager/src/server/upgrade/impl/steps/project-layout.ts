/**
 * upgrade 域：项目级配置归位——把旧扁平形态 `<项目根>/.dsh/mcp.json` 收进包分区形态
 * `<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json`（§2.3）。
 *
 * Just-in-time 迁移：调用方（S2-b 经 orchestrator 端口接线）在读写项目级配置前调它；
 * 本笔只落函数 + 单测，不接调用方。语义直接复用 `settleOne`：目标存在→只归档不覆盖 /
 * 源缺→**不建初始形态**（initial=null；项目级缺文件即空 store，见
 * `server/store/impl/store.ts:41-47`，建空文件会改变「外部删除=清空配置」语义）/
 * 否则搬运 + 归档 `.migrated.bak`。
 */
import { legacyProjectConfigFile, projectConfigFile } from "../../../shared/interface.ts";
import type { UpgradeLogger } from "../../deps.ts";
import { settleOne } from "./storage-layout.ts";

/**
 * 落定一份项目级配置（幂等，语义见 `settleOne`）。
 *
 * 为什么不是 `export async function`：与 `installUpgrade` 同因——注入面对账
 * （`verify-dir-imports` 的 `analyzeInjectionFaces`）按 `export function installXxx(`
 * 采点，`async` 前缀会让这条对账静默失明——签名保持同步形态、返回值是 Promise。
 */
export function settleProjectConfig(root: string, logger: UpgradeLogger): Promise<void> {
  return settleOne(legacyProjectConfigFile(root), projectConfigFile(root), null, {
    logger,
    // settle 路径只用 logger：`storePath` 传空串——takenOver 是 LAYOUT 层的概念，
    // 与项目级无关。
    storePath: "",
  });
}

/**
 * 项目级配置的 settle 作用域包装（#767 S2-D，反转装饰）：先落定包分区新形态、
 * 再跑读动作，两段 `await` 串行——触发时机由包装内卡，调用方只给「落定后读什么」。
 *
 * 为什么是回调形态而不是直接回 store：本域不认业务（复核 1a）——`new McpStore`
 * 留在调用方（manager 经既有 ConfigStorePort），本域只递落定后的新形态路径；
 * 因此本文件零值 import store（M0a 护栏），读动作的失败语义也归调用方。
 *
 * 失败穿透：落定失败即抛，读回调不执行——禁回落 undefined（fail-closed 冲突 +
 * 重试风暴，复核 1d）；仅 reload 路保留有声 warn（见 manager 的缓存命中分支）。
 *
 * 为什么不是 `export async function`：与 `settleProjectConfig` 同因——注入面对账
 * 按 `export function installXxx(` 采点，保持同步形态返回 Promise。
 */
export function withSettledProjectConfig<T>(
  root: string,
  logger: UpgradeLogger,
  useSettled: (settledPath: string) => Promise<T>,
): Promise<T> {
  return settleProjectConfig(root, logger).then(() => useSettled(projectConfigFile(root)));
}
