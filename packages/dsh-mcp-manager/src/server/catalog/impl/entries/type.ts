/**
 * dsh-mcp-manager — server/catalog/impl/entries/type.ts：目录条目类型落点（#767 W11b2a）。
 *
 * 目录外消费经 catalog/interface.ts 门面转出。
 */

/** 目录中的单服务器条目。 */
export interface CatalogServer {
  /** 发现时间戳。 */
  discoveredAt: number;
  /** 工具列表（裸名 → 描述 + schema 摘要）。 */
  tools: Map<string, CatalogTool>;
  /** 发现失败原因（unavailable 段）。 */
  unavailable?: string;
}

/** 目录中的单工具。 */
export interface CatalogTool {
  description: string;
  inputSchema: Record<string, unknown>;
}
