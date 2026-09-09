/**
 * dsh-mcp-manager — connection/interface.ts：连接域唯一对外引用面（D10，#664 阶段 3）。
 *
 * 连接域 = orchestrator（仲裁/双轨/summary/事件出口）+ runtime（supervisor 代际/
 * 中间层池/transport/protocol/limits）。目标形态 src/connection/{orchestrator,runtime}
 * （v3 §二）；阶段 3 完成「文件内重组」——已收敛纯逻辑段（重连策略、展示投影）落位
 * 子层，类主体（McpManager/ConnectionSupervisor/McpMiddleware）仍在 src 根目录对应
 * 文件，阶段 6 集中搬移。
 *
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 */
export { stripMcpPrefix } from "./orchestrator/interface.ts";
export type { McpManager } from "./orchestrator/interface.ts";
export { RECONNECT_DEFAULTS, resolveReconnect } from "./runtime/interface.ts";
export type { ReconnectPolicy } from "./runtime/interface.ts";