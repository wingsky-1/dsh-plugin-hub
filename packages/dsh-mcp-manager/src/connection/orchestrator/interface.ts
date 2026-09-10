/**
 * dsh-mcp-manager — connection/orchestrator/interface.ts：连接域 orchestrator 子层门面（D10）。
 *
 * orchestrator = 仲裁/双轨/summary/事件出口（manager 类，阶段 6 集中搬移落位
 * 本目录）+ 展示投影（tool-names）。连接域外部一律经 ../interface.ts 引用。
 */
export { stripMcpPrefix } from "./tool-names.ts";
export { McpManager } from "./manager.ts";
