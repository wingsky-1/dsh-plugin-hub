/**
 * dsh-mcp-manager — connection/runtime/interface.ts：连接域 runtime 子层门面（D10）。
 *
 * runtime = supervisor 代际 / 中间层池 / transport / protocol / limits（阶段 6
 * 集中搬移完成，实现均已落位本目录）。连接域外部一律经 ../interface.ts 引用，
 * 本文件只被连接域内部与 index.ts 汇聚转发。
 */
export { RECONNECT_DEFAULTS, resolveReconnect } from "./reconnect.ts";
export type { ReconnectPolicy } from "./reconnect.ts";
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  ConnectionSupervisor,
} from "./supervisor.ts";
export { McpMiddleware } from "./middleware.ts";
export { expandEnv, HttpTransport, parseSsePayload, StdioTransport, createTransport } from "./transport.ts";
export { MCPClient } from "./protocol.ts";
export {
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
} from "./limits.ts";
