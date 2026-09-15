/**
 * dsh-mcp-manager — server/pipeline/impl/authorize/type.ts：策略过滤类型落点（#767 W11b2a）。
 *
 * 目录外消费经 pipeline/interface.ts 门面转出。
 */

/** 策略过滤模式。 */
export interface MiddlewarePolicy {
  /** server 名（裸名，不含 @root 前缀）→ 允许的工具 glob（空 = 全部允许）。 */
  allowTools?: Record<string, string[]>;
  /** server 名（裸名）→ 拒绝的工具 glob（deny 优先）。 */
  denyTools?: Record<string, string[]>;
}
