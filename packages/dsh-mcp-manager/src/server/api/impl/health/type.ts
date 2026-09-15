/**
 * dsh-mcp-manager — server/api/impl/health/type.ts：服务器运行状态摘要类型落点（#767 W11b2a）。
 *
 * health/列表接口的返回形态；目录外消费经 api/interface.ts 门面转出。
 */

/** 服务器运行状态摘要（health/列表接口返回）。 */
export interface ServerStatus {
  state: string;
  connectedAt?: number;
  error?: string;
  [key: string]: unknown;
}
