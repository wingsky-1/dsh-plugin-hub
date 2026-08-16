/**
 * dsh-mcp-manager — 共享类型（单一事实源）。
 *
 * ServerConfig 形状以 src/index.ts 的 normalizeServer 产出为准（唯一构造点），
 * import.ts（mcpServers 映射）与 store 持久化共用本类型；运行时零成本
 * （type-only，编译期擦除）。
 */

/** MCP 服务器配置（归一化后）。 */
export interface ServerConfig {
  name: string;
  transport: "stdio" | "streamable-http";
  /** 由 normalizeServer 补齐；导入/持久化数据可能缺省。 */
  enabled?: boolean;
  toolCallTimeoutMs?: number;
  /** 重连策略（透传，形状由 transport/supervisor 消费）。 */
  reconnect?: Record<string, unknown>;
  /** 能力目录的自定义描述（用户手写）。 */
  description?: string;
  // stdio 传输字段
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // streamable-http 传输字段
  url?: string;
  headers?: Record<string, string>;
  /** 运行状态（supervisor 维护，非持久化字段）。 */
  status?: unknown;
  [key: string]: unknown;
}

/** 服务器运行状态摘要（health/列表接口返回）。 */
export interface ServerStatus {
  state: string;
  connectedAt?: number;
  error?: string;
  [key: string]: unknown;
}
