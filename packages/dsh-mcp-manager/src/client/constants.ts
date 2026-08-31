/**
 * dsh-mcp-manager — 客户端常量与状态映射。
 *
 * 状态排序、状态点颜色、API 路径等纯常量，不依赖任何状态。
 * i18n（issue #348）：状态文案存字典 key（title/STATUS_TEXT），渲染期经 t 求值
 * （模块加载时 t 尚未装配，不能固化文案字符串）。
 */

import type { McpLocaleKey } from "./locales.ts";

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
  toolDisable: "/api/dsh-mcp/tool-disable",
};

/** 状态分组排序（按优先级降序；titleKey 为字典 key，渲染期 t(titleKey)）。 */
export const STATUS_ORDER = [
  { key: "connected", titleKey: "stConnected" as McpLocaleKey, dot: "var(--dsw-alias-state-success-primary,#0f9d6e)" },
  { key: "connecting", titleKey: "stConnecting" as McpLocaleKey, dot: "var(--dsw-alias-state-business-primary,#2f7bf6)" },
  { key: "reconnecting", titleKey: "stReconnecting" as McpLocaleKey, dot: "var(--dsw-alias-state-warn-primary,#e08b1e)" },
  { key: "stopped", titleKey: "stStopped" as McpLocaleKey, dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "disabled", titleKey: "stDisabled" as McpLocaleKey, dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "failed", titleKey: "stFailed" as McpLocaleKey, dot: "var(--dsw-alias-state-error-primary,#e0483e)" },
];

/** 状态 → 字典 key 映射（渲染期 t(STATUS_TEXT[status])；未知状态回落原始 key 显示）。 */
export const STATUS_TEXT: Record<string, McpLocaleKey> = {
  connected: "stConnected",
  connecting: "stConnecting",
  reconnecting: "stReconnecting",
  stopped: "stStopped",
  disabled: "stDisabled",
  failed: "stFailed",
};

/** 状态点颜色（与 STATUS_ORDER 一致）。 */
export function statusDot(status: string): string {
  const group = STATUS_ORDER.find((entry) => entry.key === status);
  return group !== undefined ? group.dot : "var(--dsw-alias-label-tertiary,#9aa1ad)";
}