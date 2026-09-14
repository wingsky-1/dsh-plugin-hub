/**
 * dsh-mcp-manager — 跨端 SSE 帧契约单点（D5，#767 B1.5a）。
 *
 * 宿主是唯一发帧方、客户端是唯一收帧方，帧名与负载形状必须逐字节一致；物理定义只在
 * 本文件。仓库根 shared/sse-hub.js 另有心跳帧字面量（跨包共享层，本包不拥有），其值与
 * 这里的心跳帧名相同——改一处必须同时核对另一处。
 */

/** SSE data 帧名（宿主发帧与客户端分流共用的字面量）。 */
export const SSE_FRAMES = {
  summary: "summary",
  uiConfigChanged: "ui-config-changed",
  ping: "ping",
} as const;

/** 帧名（SSE_FRAMES 的值域）。 */
export type SseFrame = (typeof SSE_FRAMES)[keyof typeof SSE_FRAMES];

/** 帧负载形状：客户端按 type 分流后自行拉取内容，帧体不携带业务数据。 */
export interface SseFramePayload {
  readonly type: SseFrame;
}
