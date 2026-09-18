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
    // settle 路径只用 logger：`storePath`/`statsFile` 传空串——takenOver 是 LAYOUT 层的概念，
    // 与项目级无关。
    storePath: "",
    statsFile: "",
  });
}
