/**
 * dsh-mcp-manager — server/workspace/impl/mode/type.ts：中间层模式类型落点（#767 W11b2a）。
 *
 * 目录外消费经 workspace/interface.ts 门面转出。
 */

/** 中间层模式：off = 直呼（默认兼容）；project = 项目级走中间层；all = 全部走中间层。 */
export type MiddlewareMode = "off" | "project" | "all";
