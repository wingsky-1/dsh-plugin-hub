/**
 * dsh-mcp-manager — stats/interface.ts：服务/统计域门面（D10，#664 阶段 6）。
 *
 * 统计域 = 调用统计收集器（collector）+ 统计/调试类型（types）。目录外模块
 * **只能**从这里引用（verify-dir-imports 静态强制）。
 */
export { defaultStatsPath, McpStatsCollector } from "./collector.ts";
export type {
  ToolCallMetric,
  ServerStats,
  ProgressiveDisclosureStats,
  McpStatsSnapshot,
  DebugConfig,
} from "./types.ts";
