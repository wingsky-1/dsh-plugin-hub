/**
 * dsh-provider-usage — server/ui-routes 域对外门面（#768 D12：由 domain2/routes/ui.ts
 * 迁入，一域四块 + 跨块装配形状，零行为变更）。
 *
 * 域承诺 = 健康检查（health.ts：GET /health，适配器快照 + errsurf per-layer 段）+
 * 趋势查询（trend.ts：clampTrendN 窗口封顶 + GET /trend provider/目录双面）+
 * UI 配置读写（ui-config.ts：GET/POST /ui-config，归一化 + 串行写盘 + SSE 广播）+
 * SSE 通道（events.ts：GET /events，连通帧 + 注册 + close 移除，非可靠无补帧）+
 * 装配形状与创建面（context.ts：UiRoutesContext 深封装 + createUiRoutes）。
 * 目录外（apply 装配）一律经本文件消费，目录内实现文件互引保持直接相对 import。
 * 最小面 = 逐个命名导出实际被消费的「函数 + 类型」，禁整文件 re-export。
 *
 * 路由注册单点见 apply/apply.ts 的 ROUTES（本域只收路径参数，不自定路径字面量）；
 * 全部 handler 入口先经 guardLoopbackMethod 回环围栏（403 先于 405），
 * 注入面见 deps.ts（广播窄口；实例经 UiRoutesContext 参数传递，组合根装配）。
 */

// ------------------------------------------------------------------ 装配形状与创建面（context.ts）

export { UiRoutesContext, createUiRoutes } from "./context.ts";
export type { UiRoutesContextOptions } from "./context.ts";

// ------------------------------------------------------------------ 健康检查（health.ts）

export { handleHealth } from "./health.ts";

// ------------------------------------------------------------------ 趋势查询（trend.ts）

export { clampTrendN, handleTrend } from "./trend.ts";

// ------------------------------------------------------------------ UI 配置读写（ui-config.ts）

export { handleUiConfig } from "./ui-config.ts";

// ------------------------------------------------------------------ SSE 通道（events.ts）

export { handleEvents } from "./events.ts";
