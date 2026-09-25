/**
 * dsh-provider-usage — server/schedule 域对外门面（#768 D2：schedule 新域）。
 *
 * 域承诺 = 到期判定（候选窗口/幂等：due.ts）+ 串行执行（60s 轮询 ReportScheduler
 * + 任务队列 ReportTaskQueue）+ lastRun 持久化原语（读/写/per-root 临界区链/
 * 迁移校准：store.ts）：两题不拆，同域收拢（D1 配置面归 server/config 后，
 * 本域只剩调度面；D2 把调度面整域搬过来，per-root 链与 schema 归属明确）。
 *
 * 目录化约定：目录外一律经本文件消费，禁 `export * from` 整文件 re-export。
 * 复用边界（与 D1 config 域同形）：
 * - 业务域（execute/routes）经本门面复用纯面（窗口/幂等纯函数 + 类型）与
 *   读面（readLastRun）；有状态的 ReportScheduler/ReportTaskQueue
 *   只由组合根构造、经参数传递，不直引；
 * - 迁移域（upgrade/last-run-morph.ts）经本门面只复用纯函数
 *   （LAST_RUN_SCHEMA / deriveLastRun / alignLastRun，零 node 依赖），
 *   不调业务实例（read/write/update/ensure 均不导入）；
 * - lastRun 仍由 store.ts 的既有 per-root 链消费；#1010 B2b 的 retry-ledger
 *   与 report/index → monotonic lastRun → ledger clear 事务由 scheduler.ts
 *   内的 historyRoot-scoped coordinator 统一编排；
 * - 本域无聚合安装器：调度器/队列由组合根直接构造
 *   （参见 deps.ts 注记），本门面只做收口。
 */

// ------------------------------------------------------------------ 到期判定纯函数（due.ts）

export {
  candidateWindow,
  pendingReports,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  deriveLastRun,
  alignLastRun,
  isClosedWindowRecord,
  LAST_RUN_SCHEMA,
} from "./due.ts";
export type { DueReport, LastRunRecord } from "./due.ts";

// ------------------------------------------------------------------ 重试纯状态机（retry-policy.ts）

export {
  RETRY_BACKOFF_MS,
  RETRY_MAX_ATTEMPTS,
  beginAttempt,
  beginForce,
  createInitialEntry,
  addRetryObservation,
  usageAfterRetryObservation,
  emptyRetryAttemptTokens,
  emptyRetryUsage,
  recordFailure,
  recover,
  shouldReconcileRetry,
} from "./retry-policy.ts";
export type {
  RetryAttemptObservation,
  RetryAttemptTokens,
  RetryClaim,
  RetryEntry,
  RetryFailure,
  RetryFailureKind,
  RetryIndexKey,
  RetryPhase,
  RetryRouteSnapshot,
  RetrySeed,
  RetryTerminalReason,
  RetryUsageTotals,
} from "./retry-policy.ts";

// ------------------------------------------------------------------ 重试状态账本（retry-ledger.ts）

export {
  RETRY_LEDGER_SCHEMA,
  RetryLedgerError,
  createRetryLedger,
  retryLedgerFile,
} from "./retry-ledger.ts";
export type {
  RetryAttemptInput,
  RetryLedgerErrorCode,
  RetryLedgerOptions,
  RetryLedgerPort,
} from "./retry-ledger.ts";

// ------------------------------------------------------------------ 报告状态事务协调器（scheduler.ts）

export { createReportStateCoordinator, retryFenceFile } from "./scheduler.ts";
export type {
  ReportStateCommitInput,
  ReportStateCoordinator,
  ReportStateCoordinatorOptions,
  ReportStateIndexReconcileInput,
  RetryFenceMarker,
} from "./scheduler.ts";

// ------------------------------------------------------------------ 调度器（scheduler.ts）

export { ReportScheduler } from "./scheduler.ts";
export type { ReportSchedulerOptions } from "./scheduler.ts";

// ------------------------------------------------------------------ 报告任务队列（tasks.ts）

export { ReportTaskQueue } from "./tasks.ts";
export type {
  ReportTask,
  ReportTaskInput,
  ReportTaskResult,
  ReportTaskStatus,
  ReportTaskQueueOptions,
} from "./tasks.ts";

// ------------------------------------------------------------------ lastRun 持久化原语（store.ts）

export {
  readLastRun,
  writeLastRun,
  updateLastRun,
  ensureLastRunMigrated,
  __lastRunChainForTests,
} from "./store.ts";
