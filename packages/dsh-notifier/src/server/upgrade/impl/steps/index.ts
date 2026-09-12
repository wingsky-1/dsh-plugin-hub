/**
 * dsh-notifier upgrade 域 —— 升级链的步骤表。
 *
 * **新增版本时必须在此追加一项**，哪怕这一步没有数据要改（`run` 给空实现）：
 * 链的推进以步骤为刻度，漏掉的版本会让存储刻度永久停在旧值上，而链驱动只能报
 * 一句「落后于插件版本」——它无从知道那个版本该做什么。
 *
 * 依赖方向：只引用 `../chain/type.ts` 与本目录的步骤实现。
 */
import type { UpgradeStep } from "../chain/type.ts";
import { migrateStorageLayout } from "./storage-layout.ts";

/** 按目标版本升序维护；执行顺序由链驱动排序决定，此处顺序只为便于阅读。 */
export const STEPS: readonly UpgradeStep[] = [
  { fromVersion: "0.2.3", targetVersion: "0.2.4", run: migrateStorageLayout },
];
