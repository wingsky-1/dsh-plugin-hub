/**
 * dsh-provider-usage — upgrade 域升级步骤表（业务割接 + 空步登记）。
 *
 * 步骤表的唯一职责是登记**本包**的存储形态代际：迁移动作做什么归各 step 文件，链怎么驱动归
 * chain/index.ts 的适配器，步骤的形状（UpgradeStep）归 shared/upgrade-chain.d.ts。
 */
import type { UpgradeStep } from "../../../../../shared/upgrade-chain.js";
import { migrateLastRun } from "./last-run-morph.ts";
import { migrateReportConfig } from "./config-morph.ts";
import { migrateStorageLayout } from "./storage-layout.ts";
import type { UpgradeDeps } from "./deps.ts";
import { tickUpgradeVersion } from "../../../../../shared/upgrade-tick.js";

/**
 * 步骤表。**新增版本时必须在此追加一项**，哪怕这一步没有数据要改（run 指共享空步）：
 * 链的推进以步骤为刻度，漏掉的版本会让存储刻度永久停在旧值上。
 *
 * fromVersion 取原点而不是某个历史版本：.upgrade-version 是本次才新增的刻度，所有存量安装
 * 的刻度都从 0.0.0 起算，第一步必须对它们全部待办；后两步以前一步目标为起点，失败即停在
 * 上一步刻度，下次从失败步重跑（同刻度多步会让失败步的重试被已推进的刻度跳过）。
 * targetVersion 是**存储形态的代际**（0.2.3 存储归位 / 0.2.4 配置割接 / 0.2.5 last-run），
 * 与 package.json 的 0.2.5 对齐在最后一步（链跑完的对账会把漂移报出来）。
 * 按目标版本升序维护；执行顺序由链驱动排序决定，此处顺序只为便于阅读。
 */
/** 0.2.5 → 0.2.6：用量呈现与模板落盘（#940）+ 节假日判定（#945）+ 存储清理诊断（#934）——新文件缺失即种、余下纯逻辑，无既有形态割接，空步推进刻度。 */
export const STEPS: readonly UpgradeStep<UpgradeDeps>[] = [
  { fromVersion: "0.0.0", targetVersion: "0.2.3", run: migrateStorageLayout },
  { fromVersion: "0.2.3", targetVersion: "0.2.4", run: migrateReportConfig },
  { fromVersion: "0.2.4", targetVersion: "0.2.5", run: migrateLastRun },
  // 0.2.5 → 0.2.6 为空步（用量呈现、节假日判定、存储清理诊断，无既有形态割接）：run 指共享空函数。
  { fromVersion: "0.2.5", targetVersion: "0.2.6", run: tickUpgradeVersion },
  // 0.2.6 → 0.2.7 为空步（本版不含 provider-usage 存储形态变化）：run 指共享空函数。
  { fromVersion: "0.2.6", targetVersion: "0.2.7", run: tickUpgradeVersion },
];
