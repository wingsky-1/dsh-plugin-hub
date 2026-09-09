/**
 * dsh-mcp-manager — connection/runtime/reconnect.ts：重连策略解析（连接域 runtime 单一事实源）。
 *
 * 从 supervisor.ts 迁入（#664 阶段 3 连接域逻辑收敛）：supervisor 与中间层两路径
 * 的重连退避/预算口径统一从这里取（B18），避免「同一 server.reconnect 配置在两
 * 条路径行为不一致」。默认值对齐官方 dsh-mcp-client。
 */

/** 重连策略（解析后）。 */
export interface ReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/** 重连默认策略（与官方 dsh-mcp-client 一致）。 */
export const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
});

/** 解析重连策略（含默认值）。 */
export function resolveReconnect(config: Record<string, unknown> | undefined): ReconnectPolicy {
  return {
    enabled: (config?.enabled as boolean | undefined) ?? RECONNECT_DEFAULTS.enabled,
    initialDelayMs: (config?.initialDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.initialDelayMs,
    maxDelayMs: (config?.maxDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.maxDelayMs,
    maxAttempts: (config?.maxAttempts as number | undefined) ?? RECONNECT_DEFAULTS.maxAttempts,
  };
}
