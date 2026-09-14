/**
 * dsh-mcp-manager — 跨端服务器状态契约单点（D5，#767 B1.5a）。
 *
 * 六态键集合与计数键同时是宿主投影（summary().counts）的输出与客户端分组/取数的输入，
 * 两端必须逐字节一致；物理定义只在本文件，两端一律经 shared/interface.ts 引用同一份。
 * 纯展示数据（展示顺序、CSS 类名、中文标签、图标）不是契约，留在客户端原处。
 */

/** 六态状态键（宿主投影与客户端分组共用的键名）。 */
export const SERVER_STATES = {
  connected: "connected",
  connecting: "connecting",
  reconnecting: "reconnecting",
  disabled: "disabled",
  stopped: "stopped",
  failed: "failed",
} as const;

/** 服务器状态（六态键的值域；跨端 DTO 的 status 取值域）。 */
export type ServerState = (typeof SERVER_STATES)[keyof typeof SERVER_STATES];

/**
 * 投影兜底：六态计数全零，键序即 summary().counts 的 JSON 键序。
 * 消费方必须展开成新对象再计数——这份单例是两端共享的只读面，就地改动会污染另一端。
 */
export const EMPTY_STATUS_COUNTS: Record<ServerState, number> = {
  connected: 0,
  connecting: 0,
  reconnecting: 0,
  disabled: 0,
  stopped: 0,
  failed: 0,
};
