/**
 * dsh-provider-usage — domain2/routes/ 路由层对外门面（E5，宿主）。
 *
 * 目录化约定（#670 D9）：目录外（apply 装配）一律经本文件消费，目录内实现
 * 文件互引保持直接相对 import。最小面 = 逐个命名导出实际被消费的符号，禁
 * `export * from` 整文件 re-export。
 *
 * UiRoutesContext 深封装（#670 D9「路由 context 类」）：路由依赖
 * （statsService/trend/uiConfig/sseClients/broadcast/layerErrors）收敛为类实例，
 * 目录外只经构造入口装配依赖并交给 createUiRoutes；路由内部实现仍经类字段取用
 * （与 StatsService 门面 / executor 工厂同一深封装纪律）。
 */

// ------------------------------------------------------------------ 健康/趋势/UI 配置/SSE 路由（ui.ts）

export { createUiRoutes, clampTrendN, handleHealth, handleTrend, handleUiConfig, handleEvents } from "./ui.ts";
export type { UiRoutesContext, UiRoutesContextOptions } from "./ui.ts";

// ------------------------------------------------------------------ 报告配置/历史/详情/手动生成路由（reports.ts）

export {
  createReportRoutes,
  handleReportStatus,
  isReportPeriodValid,
  isReportKeyValid,
  isTaskIdValid,
} from "./reports.ts";
export type { ReportRoutesContext } from "./reports.ts";