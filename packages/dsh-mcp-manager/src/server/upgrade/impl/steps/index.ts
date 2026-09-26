/**
 * upgrade 域升级链的步骤表。**新增版本时必须在此追加一项**，哪怕这一步没有数据要改（`run` 给空实现）：
 * 链的推进以步骤为刻度，漏掉的版本会让存储刻度永久停在旧值上。
 */
import type { UpgradeStep } from "../chain/type.ts";
import { migrateStorageLayout } from "./storage-layout.ts";
import { tickUpgradeVersion } from "../../../../../../../shared/upgrade-tick.js";

/**
 * 0.0.0 → 0.2.5：存储布局归位（§7.1 的目标布局 + §7.2 的迁移语义），本次迁移唯一的一步。
 *
 * `fromVersion` 取原点而不是某个历史版本：`version` 文件是本次才新增的刻度，所有存量安装的刻度
 * 都从 `0.0.0` 起算，这一步必须对它们全部待办。
 *
 * `targetVersion` 是**存储形态的代际**，不是「当前 package.json 的值」——0.2.4 的代码读的仍是 home 根
 * 下的旧布局，把刻度写成 0.2.4 等于把「已升到新布局」写反。发布时若版本号不是 0.2.5，本表要同笔追加
 * 一步（链跑完的对账会把这种漂移报出来）。
 *
 * 按目标版本升序维护；执行顺序由链驱动排序决定，此处顺序只为便于阅读。
 */
export const STEPS: readonly UpgradeStep[] = [
  { fromVersion: "0.0.0", targetVersion: "0.2.5", run: migrateStorageLayout },
  // 0.2.5 → 0.2.6 为空步（调用超时跟随配置、关面板还焦、客户端类型收窄，无形态变化）：run 指共享空函数。
  { fromVersion: "0.2.5", targetVersion: "0.2.6", run: tickUpgradeVersion },
];
