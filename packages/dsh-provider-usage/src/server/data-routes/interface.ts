/**
 * dsh-provider-usage — server/data-routes 域对外门面（#768 D10：由 domain1 路由目录改名迁入，零行为变更）。
 *
 * 域承诺 = 用量统计与历史面板路由（stats.ts：GET /stats、GET /history）+
 * 适配器管理路由（adapters.ts：GET /adapters.json、POST /select、POST /inspect、
 * POST /add）：目录外（apply 装配）一律经本文件消费，目录内实现文件互引
 * 保持直接相对 import。最小面 = 逐个命名导出实际被消费的「函数 + 类型」，
 * 禁整文件 re-export。
 *
 * 路由注册单点见 apply/apply.ts 的 ROUTES（本域只收路径参数，不自定路径字面量）；
 * 全部 handler 入口先经 guardLoopbackMethod 回环围栏（403 先于 405），
 * 注入面见 deps.ts。
 */

// ------------------------------------------------------------------ stats/history 路由（stats.ts）

export { handleStats, handleHistory, createStatsRoutes } from "./stats.ts";
export type { StatsRoutesContext } from "./stats.ts";

// ------------------------------------------------------------------ 适配器管理路由（adapters.ts）

export {
  handleAdapters,
  handleSelect,
  handleInspect,
  handleAdd,
  createAdapterRoutes,
} from "./adapters.ts";
export type { AdapterRoutesContext } from "./adapters.ts";
