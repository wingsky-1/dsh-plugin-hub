/**
 * dsh-mcp-manager — connection/orchestrator/interface.ts：连接域 orchestrator 子层门面（D10）。
 *
 * orchestrator = 仲裁/双轨/summary/事件出口（manager 类主体，阶段 6 集中搬移前实现
 * 仍在 src/manager.ts）；本文件承载已收敛的纯逻辑段对外面与类型承诺。连接域外部
 * 一律经 ../interface.ts 引用，本文件只被连接域内部引用。
 */
export { stripMcpPrefix } from "./tool-names.ts";
export type { McpManager } from "../../manager.ts";