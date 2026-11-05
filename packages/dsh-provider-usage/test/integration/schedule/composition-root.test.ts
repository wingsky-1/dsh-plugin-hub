/**
 * dsh-provider-usage — integration：调度域组合根三维度（#768 计划表 rev2 D2 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/schedule 门面活装配），落盘一律进
 * mkdtemp 隔离目录（产物零污染）。三维度（对应任务书“组合根经门面消费”）：
 * - D2一 经域门面装配：ReportScheduler/ReportTaskQueue/lastRun 原语只经
 *   server/schedule/interface.ts，不直连域实现文件（due/scheduler/tasks/store），
 *   不走旧 domain2 入口；execute/routes/upgrade 的调度消费同样收口本门面；
 * - D2二 根内无业务判断：apply/ 装配逻辑内不得出现候选窗口/幂等/
 *   lastRun 读写链调用与 schema 常量（构造 + 提交 + 热更回调是装配，不算判断）；
 * - D2三 串行执行（锁）+ 轮询/预热汇入 getStats：队列尾链串行与同窗口去重、
 *   per-root 链防 lost-update、默认 60s tick 与 5min 预热线路保持——拆坏任一条必须红
 *   （同文件“探针 + 朴素实现对照”证明 detector 不失明）。
 *
 * 扫描面 = src/apply/apply.ts（装配逻辑；#768 D13 删空锚点 src/apply/interface.ts，模块归属随锚点消除）
 * + 各消费方源文件（执行器/读侧/路由/迁移）：src/apply/index.ts 是 lib 导出面
 * （符号转发），不是判断——它的符号集由 export-surface-snapshot 门禁锁定，
 * 不在本用例扫描面内（误扫即把转发当判断）。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件“探针：脏输入必被 flag”与
 * “对照：朴素实现丢更新（链断即丢）”——同一 detector 在脏夹具上必须报出
 * 违规，detector 失明则探针先红。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import { registerScheduleChainCases } from "./schedule-composition-chain.ts";
import * as coordinatorCases from "./schedule-composition-coordinator.ts";
import { registerScheduleFacadeCases } from "./schedule-composition-facade.ts";
import * as forceCases from "./schedule-composition-force.ts";
import { registerScheduleIdentityCases } from "./schedule-composition-identity.ts";
import { registerSchedulePollGuardCases } from "./schedule-composition-poll-guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applySrcFlat = applySrc.replace(/\s+/g, " ").replace(/,\s*}/g, " }");
const indexSrc = readFileSync(join(srcDir, "index.ts"), "utf8");
const applyIndexSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const retryPolicySrc = readFileSync(join(srcDir, "server", "schedule", "retry-policy.ts"), "utf8");
const retryLedgerSrc = readFileSync(join(srcDir, "server", "schedule", "retry-ledger.ts"), "utf8");
// #768 D13：空锚点 src/apply/interface.ts 已删，扫描面只剩 apply.ts（本文件不再读该路径）。
const schedulerSrc = readFileSync(join(srcDir, "server", "schedule", "scheduler.ts"), "utf8");
const storeSrc = readFileSync(join(srcDir, "server", "schedule", "store.ts"), "utf8");
// #768 D13：domain2/common/ 目录已消除（消费者全切 server/shared 门面），本文件不再读旧门面。
const executorSrc = readFileSync(join(srcDir, "server", "execute", "executor.ts"), "utf8");
const runnerSrc = readFileSync(join(srcDir, "server", "execute", "runner.ts"), "utf8");
const reportsSrc = readFileSync(join(srcDir, "server", "report-routes", "reports.ts"), "utf8");
const morphSrc = readFileSync(join(srcDir, "server", "upgrade", "last-run-morph.ts"), "utf8");
const storageLayoutSrc = readFileSync(
  join(srcDir, "server", "upgrade", "storage-layout.ts"),
  "utf8",
);

registerScheduleFacadeCases({
  applySrcFlat,
  applySrc,
  executorSrc,
  runnerSrc,
  reportsSrc,
  morphSrc,
  storageLayoutSrc,
  srcDir,
});

registerScheduleIdentityCases({
  indexSrc,
  applyIndexSrc,
  retryPolicySrc,
  retryLedgerSrc,
});

registerScheduleChainCases({
  schedulerSrc,
  storeSrc,
  applySrcFlat,
});

registerSchedulePollGuardCases({
  applySrc,
  schedulerSrc,
});

describe("#1010 B2b coordinator/scheduler/queue 纵向切片", () => {
  coordinatorCases.registerScheduleCommitCases();
  coordinatorCases.registerScheduleStateReconcileCases();
  coordinatorCases.registerScheduleApplyReconcileCases();
  coordinatorCases.registerScheduleSchedulerReconcileCases();
  coordinatorCases.registerScheduleReadyRecoveryCases();
  coordinatorCases.registerScheduleForceCycleCases();
  forceCases.registerScheduleForcePrepareOrderCases();
  forceCases.registerScheduleForcePendingCases();
  forceCases.registerScheduleForceTailCases();
  forceCases.registerScheduleForceFallbackCases();
});
