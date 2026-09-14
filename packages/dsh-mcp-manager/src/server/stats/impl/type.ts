/**
 * dsh-mcp-manager — MCP 调用统计与渐进式披露指标类型定义。
 *
 * 遵循 Metadata-Only 原则：绝不记录用户参数（arguments）与返回值（content），
 * 仅记录计数、状态、耗时与渐进式披露漏斗元数据。
 */

export interface ToolCallMetric {
  calls: number;
  success: number;
  errors: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  lastCalledAt?: string;
  lastError?: string;
}

export interface ServerStats {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  tools: Record<string, ToolCallMetric>;
}

export interface ProgressiveDisclosureStats {
  /** ws_mcp_search 搜索词调用频次（query -> 次数） */
  searches: Record<string, number>;
  /** ws_mcp_list 查询频次（serverFilter -> 次数；空串代表全量盘点） */
  lists: Record<string, number>;
  /** ws_mcp_detail schema 查询频次（server/tool -> 次数） */
  details: Record<string, number>;
}

export interface McpStatsSnapshot {
  startedAt: string;
  updatedAt: string;
  servers: Record<string, ServerStats>;
  disclosure: ProgressiveDisclosureStats;
}

export interface DebugConfig {
  callStats: boolean;
  statsFile: string;
}
