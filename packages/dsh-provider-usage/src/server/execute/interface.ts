/**
 * dsh-provider-usage — server/execute 域对外门面（#768 D3：execute 新域）。
 *
 * 域承诺 = 报告索引解析（report-index.ts 纯解析，由 domain2/common 迁入，
 * 本域所有）+ 读侧投影记忆化（runner.ts indexCache stat 失效键）+ 执行接线
 * （runDueReport/persistReport/notifyReport）+ LLM 生成（generate.ts）+ 正文
 * 渲染（format.ts）+ 执行器工厂（executor.ts：推进经
 * DueExecutorDeps.advanceLastRun 注入 per-root 链能力，任务类型经
 * server/schedule 门面以 type 复用、配置形态经 server/config 门面以 type
 * 复用，#768 B1 值边清零；D2 起双门面口径，D3 随物理定义迁入本域）+
 * 目录候选查询工厂（list-dirs.ts）。
 *
 * 目录化约定：目录外一律经本文件消费，禁 `export * from` 整文件 re-export。
 * 复用边界（与 D2 schedule 域同形）：
 * - 业务域（routes）经本门面复用读面（readReportIndex/reportHtmlFile/
 *   reportMetaFile）与纯面（parseReportIndexLines/prevWindowTotal）；
 *   有状态的执行器只由组合根构造、经参数传递，不直引；
 * - 调度域经本门面只复用纯解析（parseReportIndexLines，零 node 依赖）：
 *   C 波起由组合根装配期经 ScheduleIndexParser 端口注入（store.ts 不直引
 *   本门面），不调业务实例（read/persist/run/notify 均不导入）；
 * - executor 工厂深封装：本面只暴露 `makeDueReportExecutor` 工厂与其
 *   依赖类型（DueExecutorDeps），执行器闭包内部（幂等下沉 → LLM 生成 →
 *   lastRun 推进 → 错误脱敏）一概不进入本面——工厂为本域唯一构造入口，
 *   错误经 sanitizeDiagnostic 脱敏为工厂契约字段。listDirs 同理收敛为
 *   注入式查询面工厂（makeListDirs）。
 */

// ------------------------------------------------------------------ 索引解析纯原语（report-index.ts）

export { parseReportIndexLines } from "./report-index.ts";

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

export {
  generateReport,
  applyPromptTemplate,
  buildStatsSnapshot,
  PERIOD_BUCKETS,
} from "./generate.ts";
export type {
  ReportMeta,
  ReportResult,
  ReportStatsSnapshot,
  ReportLlmService,
  ReportTokenUsage,
} from "./generate.ts";

// ------------------------------------------------------------------ 正文渲染（format.ts）

export { reportBodyToHtml } from "./format.ts";

// ------------------------------------------------------------------ 执行器工厂（executor.ts）

export { makeDueReportExecutor } from "./executor.ts";
export type { DueExecutorDeps } from "./executor.ts";

// ------------------------------------------------------------------ 目录候选查询工厂（list-dirs.ts）

export { makeListDirs } from "./list-dirs.ts";
