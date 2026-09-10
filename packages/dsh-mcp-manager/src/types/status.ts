/**
 * dsh-mcp-manager — types/status.ts：服务器运行状态摘要类型（#664 阶段 6 收敛）。
 *
 * 自 src/types.ts 拆出（status 域）：health/列表接口返回形态。
 */

/** 服务器运行状态摘要（health/列表接口返回）。 */
export interface ServerStatus {
  state: string;
  connectedAt?: number;
  error?: string;
  [key: string]: unknown;
}