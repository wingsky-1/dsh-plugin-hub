/**
 * dsh-mcp-manager — server/catalog/impl/search/type.ts：检索输出类型落点（#767 W11b2a）。
 *
 * 目录外消费经 catalog/interface.ts 门面转出。
 */

/** ws_mcp_search 单条命中。 */
export interface SearchHit {
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchedTerms: string[];
  fresh: boolean;
}

/** ws_mcp_list 的单个工具条目（完整清单只给摘要，防上下文膨胀）。 */
export interface ListToolEntry {
  tool: string;
  description: string;
  /** 工具级被用户禁用（独立于服务器级 enabled；仅在禁用时置位）。 */
  disabled?: boolean;
}

/** ws_mcp_list 的单个服务器条目。 */
export interface ListServerEntry {
  /** @<root>/<server> 全名。 */
  server: string;
  /** 用户已禁用（工具来自 last-good 目录缓存，明示）。 */
  disabled?: boolean;
  /** 发现失败原因（unavailable 段）。 */
  unavailable?: string;
  tools: ListToolEntry[];
  /** 工具数被 perServerLimit 截断。 */
  toolsTruncated: boolean;
}

/** ws_mcp_detail 的单工具详情（完整 inputSchema）。 */
export interface ToolDetail {
  /** @<root>/<server> 全名。 */
  server: string;
  /** 远端工具裸名（已归一化）。 */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 目录是否新鲜（TTL 内）。 */
  fresh: boolean;
  /** 用户已禁用。 */
  disabled?: boolean;
}

/** ws_mcp_list 输出（多单元合并的完整盘点）。 */
export interface ListCatalogResult {
  /** 当前工作空间 root；无项目 cwd 时为 "@global"。 */
  workspace: string;
  servers: ListServerEntry[];
  totalServers: number;
  totalTools: number;
  /** 任一服务器截断即为 true。 */
  toolsTruncated: boolean;
  /** 空返回时给模型的明确提示。 */
  message?: string;
}
