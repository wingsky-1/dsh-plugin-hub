/**
 * dsh-provider-usage — domain2/execute/ 报告执行/产出层对外门面（E4）。
 *
 * 目录化约定（#670 D9）：目录外（domain2 其他层 / apply）一律经本文件消费，
 * 目录内实现文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的
 * 「类型 + 函数」，禁 `export * from` 整文件 re-export。
 *
 * executor 工厂深封装（#670 D8）：本面只暴露 `makeDueReportExecutor` 工厂与其
 * 依赖类型（DueExecutorDeps），执行器闭包内部（幂等下沉 → LLM 生成 → lastRun
 * 推进 → 错误脱敏）一概不进入本面——工厂为 E4 唯一构造入口，错误经
 * sanitizeDiagnostic 脱敏为工厂契约字段。listDirs 同理收敛为注入式查询面工厂
 * （makeListDirs）。
 */

// ------------------------------------------------------------------ 执行接线与索引读取（runner.ts）

export {
  readReportIndex,
  prevWindowTotal,
  runDueReport,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  notifyReport,
  optionalNotifier,
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
} from "./runner.ts";

// ------------------------------------------------------------------ 报告生成（generate.ts）

export { generateReport, applyPromptTemplate, buildStatsSnapshot, PERIOD_BUCKETS } from "./generate.ts";
export type {
  ReportMeta,
  ReportResult,
  ReportStatsSnapshot,
  ReportLlmService,
  ReportTokenUsage,
} from "./generate.ts";

// ------------------------------------------------------------------ 正文渲染（format.ts）

export { reportBodyToHtml } from "./format.ts";

// ------------------------------------------------------------------ 执行器工厂（executor.ts，D8 深封装）

export { makeDueReportExecutor } from "./executor.ts";
export type { DueExecutorDeps } from "./executor.ts";

// ------------------------------------------------------------------ 目录候选查询工厂（list-dirs.ts）

export { makeListDirs } from "./list-dirs.ts";