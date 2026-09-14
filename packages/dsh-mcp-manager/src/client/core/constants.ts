/**
 * dsh-mcp-manager — 客户端常量与状态映射。
 *
 * 状态排序、状态点颜色、API 路径等纯常量，不依赖任何状态。
 * i18n（issue #348）：状态文案存字典 key（title/STATUS_TEXT），渲染期经 t 求值
 * （模块加载时 t 尚未装配，不能固化文案字符串）。
 *
 * 跨端契约（路径清单 / 六态状态键）的物理定义在 src/shared/，本文件只做客户端投影；
 * 展示顺序、CSS 颜色与字典 key 是纯展示数据，留在原处（D5 单一事实源判据）。
 */

import type { McpLocaleKey } from "../locales.ts";
import { ROUTES, SERVER_STATES } from "../../shared/interface.ts";

/** 路径表：逐键取宿主同一份 ROUTES（一致性锁 test/e2e/cross-end-lock.test.ts 盯这条）。 */
export const API = {
  servers: ROUTES.servers,
  connect: ROUTES.connect,
  disconnect: ROUTES.disconnect,
  reconnect: ROUTES.reconnect,
  importJson: ROUTES.importJson,
  session: ROUTES.session,
  resume: ROUTES.resume,
  config: ROUTES.config,
  events: ROUTES.events,
  health: ROUTES.health,
  toolDisable: ROUTES.toolDisable,
};

/** 状态分组排序（按优先级降序；titleKey 为字典 key，渲染期 t(titleKey)）。 */
export const STATUS_ORDER = [
  {
    key: SERVER_STATES.connected,
    titleKey: "stConnected" as McpLocaleKey,
    dot: "var(--dsw-alias-state-success-primary,#0f9d6e)",
  },
  {
    key: SERVER_STATES.connecting,
    titleKey: "stConnecting" as McpLocaleKey,
    dot: "var(--dsw-alias-state-business-primary,#2f7bf6)",
  },
  {
    key: SERVER_STATES.reconnecting,
    titleKey: "stReconnecting" as McpLocaleKey,
    dot: "var(--dsw-alias-state-warn-primary,#e08b1e)",
  },
  {
    key: SERVER_STATES.stopped,
    titleKey: "stStopped" as McpLocaleKey,
    dot: "var(--dsw-alias-label-tertiary,#9aa1ad)",
  },
  {
    key: SERVER_STATES.disabled,
    titleKey: "stDisabled" as McpLocaleKey,
    dot: "var(--dsw-alias-label-tertiary,#9aa1ad)",
  },
  {
    key: SERVER_STATES.failed,
    titleKey: "stFailed" as McpLocaleKey,
    dot: "var(--dsw-alias-state-error-primary,#e0483e)",
  },
];

/** 状态 → 字典 key 映射（渲染期 t(STATUS_TEXT[status])；未知状态回落原始 key 显示）。 */
export const STATUS_TEXT: Record<string, McpLocaleKey> = {
  [SERVER_STATES.connected]: "stConnected",
  [SERVER_STATES.connecting]: "stConnecting",
  [SERVER_STATES.reconnecting]: "stReconnecting",
  [SERVER_STATES.stopped]: "stStopped",
  [SERVER_STATES.disabled]: "stDisabled",
  [SERVER_STATES.failed]: "stFailed",
};

/** 状态点颜色（与 STATUS_ORDER 一致）。 */
export function statusDot(status: string): string {
  const group = STATUS_ORDER.find((entry) => entry.key === status);
  return group !== undefined ? group.dot : "var(--dsw-alias-label-tertiary,#9aa1ad)";
}
