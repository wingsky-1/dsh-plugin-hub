/**
 * dsh-provider-usage — domain1/routes/ 路由层对外门面（C6 域1侧）。
 *
 * 只含 stats/adapters 路由注册面（UiRoutesContext 深封装属 domain2/routes/ui.ts，
 * 不在本层）。目录外（apply 装配）一律经本文件消费，目录内互引直连。
 * 最小面 = 逐个命名导出，禁整文件 re-export。
 */

// ------------------------------------------------------------------ stats/history 路由（stats.ts）

export { handleStats, handleHistory, createStatsRoutes } from "./stats.ts";
export type { StatsRoutesContext } from "./stats.ts";

// ------------------------------------------------------------------ 适配器管理路由（adapters.ts）

export { handleAdapters, handleSelect, handleInspect, handleAdd, createAdapterRoutes } from "./adapters.ts";
export type { AdapterRoutesContext } from "./adapters.ts";