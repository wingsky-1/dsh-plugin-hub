/**
 * dsh-mcp-manager — 客户端常量与状态映射。
 *
 * 状态排序、文案、状态点颜色、API 路径等纯常量，不依赖任何状态。
 */

/** 与宿主端 ROUTES 一致的路径。 */
export const API = {
  servers: "/api/dsh-mcp/servers",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  session: "/api/dsh-mcp/session",
  config: "/api/dsh-mcp/config",
  events: "/api/dsh-mcp/events",
  health: "/api/dsh-mcp/health",
};

/** 状态分组排序（按优先级降序）。 */
export const STATUS_ORDER = [
  { key: "connected", title: "运行中", dot: "var(--dsw-alias-state-success-primary,#0f9d6e)" },
  { key: "connecting", title: "连接中", dot: "var(--dsw-alias-state-business-primary,#2f7bf6)" },
  { key: "reconnecting", title: "重连中", dot: "var(--dsw-alias-state-warn-primary,#e08b1e)" },
  { key: "stopped", title: "未连接", dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "disabled", title: "已停用", dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "failed", title: "失败", dot: "var(--dsw-alias-state-error-primary,#e0483e)" },
];

/** 状态 → 中文文案映射。 */
export const STATUS_TEXT: Record<string, string> = {
  connected: "运行中",
  connecting: "连接中",
  reconnecting: "重连中",
  stopped: "未连接",
  disabled: "已停用",
  failed: "失败",
};

/** 状态点颜色（与 STATUS_ORDER 一致）。 */
export function statusDot(status: string): string {
  const group = STATUS_ORDER.find((entry) => entry.key === status);
  return group !== undefined ? group.dot : "var(--dsw-alias-label-tertiary,#9aa1ad)";
}