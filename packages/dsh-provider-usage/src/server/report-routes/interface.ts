/**
 * dsh-provider-usage — server/report-routes 域对外门面（#768 D11：由 domain2/routes/reports.ts 迁入，零行为变更）。
 *
 * 域承诺 = 报告配置读写（handleReportConfig：GET 配置 + providers + dirs 候选，
 * POST 归一化 + preset + 串行写盘）+ 模型发现（handleReportModels）+ 历史索引
 * （handleReports）+ 详情（handleReportDetail）+ 手动生成（handleReportGenerate：
 * 202 入队 / 200 幂等复用）+ 状态轮询（handleReportStatus）+ 双白名单校验
 * （isReportPeriodValid/isReportKeyValid/isTaskIdValid）：目录外（apply 装配）
 * 一律经本文件消费，目录内实现文件互引保持直接相对 import。最小面 = 逐个命名
 * 导出实际被消费的「函数 + 类型」，禁整文件 re-export。
 *
 * 路由注册单点见 apply/apply.ts 的 ROUTES（本域只收路径参数，不自定路径字面量）；
 * 全部 handler 入口先经 guardLoopbackMethod 回环围栏（403 先于 405），
 * 注入面见 deps.ts（配置服务窄口 + 任务队列窄口 + ReportRoutesContext
 * 调度注入；执行器由队列内嵌，经 server/execute 工厂在组合根装配，不直引）。
 */

// ------------------------------------------------------------------ 报告配置/历史/详情/手动生成路由（reports.ts）

export {
  handleReportConfig,
  handleReportModels,
  handleReports,
  handleReportDetail,
  handleReportGenerate,
  handleReportStatus,
  createReportRoutes,
  isReportPeriodValid,
  isReportKeyValid,
  isTaskIdValid,
} from "./reports.ts";
export type { ReportRoutesContext } from "./reports.ts";
