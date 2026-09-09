/**
 * dsh-mcp-manager — connection/runtime/interface.ts：连接域 runtime 子层门面（D10）。
 *
 * runtime = supervisor 代际 / 中间层池 / transport / protocol / limits（阶段 6 集中
 * 搬移前实现仍在 src 根目录对应文件）；本文件承载已收敛的纯逻辑段对外面。连接域
 * 外部一律经 ../interface.ts 引用，本文件只被连接域内部引用。
 */
export { RECONNECT_DEFAULTS, resolveReconnect } from "./reconnect.ts";
export type { ReconnectPolicy } from "./reconnect.ts";
