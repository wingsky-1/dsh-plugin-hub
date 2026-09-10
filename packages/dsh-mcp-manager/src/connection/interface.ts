/**
 * dsh-mcp-manager — connection/interface.ts：连接域唯一对外引用面（D10，#664 阶段 3/6）。
 *
 * 连接域 = orchestrator（仲裁/双轨/summary/事件出口，manager）+ runtime（supervisor
 * 代际/中间层池/transport/protocol/limits），阶段 6 集中搬移完成（v3 §二）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 */
export { stripMcpPrefix, McpManager } from "./orchestrator/interface.ts";
export {
  RECONNECT_DEFAULTS,
  resolveReconnect,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  ConnectionSupervisor,
  McpMiddleware,
  expandEnv,
  HttpTransport,
  parseSsePayload,
  StdioTransport,
  createTransport,
  MCPClient,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./runtime/interface.ts";
export type { ReconnectPolicy } from "./runtime/interface.ts";
