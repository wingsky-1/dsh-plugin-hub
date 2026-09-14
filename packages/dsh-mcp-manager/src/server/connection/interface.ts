/**
 * dsh-mcp-manager — connection/interface.ts：连接域唯一对外引用面（D10，#664 阶段 3/6）。
 *
 * 连接域 = orchestrator（仲裁/双轨/summary/事件出口，manager）+ runtime（supervisor
 * 代际/中间层池/transport/protocol/limits），阶段 6 集中搬移完成（v3 §二）。
 * 目录外模块**只能**从这里引用本域自有符号（verify-dir-imports 静态强制）。
 *
 * runtime 子层的值面不再经本门面转出（#767 B2a-wire W10）：本门面只留类型出口，那 26 个值
 * 符号的消费者直接引 `connection/runtime/interface.ts`。「门面 → 子层门面」的值复导本身就是
 * 一条模块级值边（I2① `connection|connection/runtime`），而它只转发、不承载语义。
 */
export type { McpManager } from "./orchestrator/interface.ts";
export type { ReconnectPolicy } from "./runtime/interface.ts";
