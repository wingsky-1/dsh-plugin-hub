/** upgrade 域升级链的步骤表。**新增版本时必须在此追加一项**，哪怕这一步没有数据要改（`run` 给空实现）：链的推进
 * 以步骤为刻度，漏掉的版本会让存储刻度永久停在旧值上。 */
import type { UpgradeDeps } from "../../deps.ts";
import type { UpgradeStep } from "../chain/type.ts";
import { migrateConfigShape } from "./config-shape.ts";
import { migrateQuietWindows } from "./quiet-windows.ts";
import { migrateReasonShape } from "./reason-shape.ts";
import { migrateStorageLayout } from "./storage-layout.ts";
import { tickUpgradeVersionSync } from "../../../../../../../shared/upgrade-tick.js";

/** 0.2.3 → 0.2.4：存储布局归位 + 配置形态割接 + 投递理由形态割接——同一次版本迁移的三半，合成一步。 */
function migrateToNewLayout(deps: UpgradeDeps): void {
  // 顺序有意义：布局归位先建出新位置的初始形态，理由割接才有文件可读（旧位置的文件已被搬走）。
  migrateStorageLayout();
  migrateConfigShape(deps.legacySettings);
  migrateReasonShape();
}

/** 0.2.5 → 0.2.6：免打扰多时间窗（#936）——旧的 start/end 搬进 windows[0] 并删除旧键。 */
function migrateToV026(): void {
  migrateQuietWindows();
}

/** 按目标版本升序维护；执行顺序由链驱动排序决定，此处顺序只为便于阅读。 */
export const STEPS: readonly UpgradeStep[] = [
  { fromVersion: "0.2.3", targetVersion: "0.2.4", run: migrateToNewLayout },
  // 0.2.4 → 0.2.5 为空步（客户端半区分层重构，无形态变化）：run 指共享空函数，不再为新版本加空函数。
  { fromVersion: "0.2.4", targetVersion: "0.2.5", run: tickUpgradeVersionSync },
  { fromVersion: "0.2.5", targetVersion: "0.2.6", run: migrateToV026 },
];
