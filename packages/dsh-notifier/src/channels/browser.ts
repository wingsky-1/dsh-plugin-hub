/**
 * dsh-notifier — 内置 browser 频道（帧构造纯函数 + 投递池实例）。
 *
 * 播放决议从「投递时刻实时读 current」上移至裁决时快照解析：本文件
 * 只保留两件事——纯帧构造 buildBrowserFrame(payload, spec)（index.ts 装配的
 * DeliverDeps.play 调用）与可入投递池的 NotifyChannel 实例（id + capabilities；
 * send 已退役——播放经 play 值传递，误触即响亮失败暴露接线缺陷而非静默丢通知）。
 * 实例不持任何依赖（无注入面参数）：SSE 枢纽的真实使用点在装配层的 play 闭包，
 * 故本域对 server 域零依赖（零值边 + 零 type 边，消除 channels→server 倒置边）。
 */
import type { BrowserDispatchSpec } from "../pipeline/interface.ts";
import { BUILTIN_CHANNELS } from "../config/interface.ts";
import type { NotifyChannel, NotifySeverity } from "../sdk/interface.ts";

/**
 * 浏览器通知帧（SSE 帧契约 {type,kind,title,message,ts} 不变，只加 sound/
 * playOnly 字段——向后兼容，旧客户端无 sound 帧回落快照兜底）。
 * playOnly = 只响不弹（pop=false）：客户端自播不弹实体。
 */
export function buildBrowserFrame(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }, spec: BrowserDispatchSpec): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    type: "notify",
    kind: payload.kind,
    title: payload.title,
    message: payload.body,
    ts: payload.ts,
    sound: spec.sound,
  };
  if (!spec.pop) frame.playOnly = true;
  return frame;
}

/**
 * 创建内置 browser 频道实例（仅供投递池：id + capabilities；播放经 play 注入）。
 */
export function createBrowserChannel(): NotifyChannel {
  return {
    name: BUILTIN_CHANNELS.browser,
    capabilities: { titleMaxLen: 64, maxBodyLen: 2048 },
    send() {
      // 播放决议在裁决时快照化并经 DeliverDeps.play 值传递——本实例 send 不可达；
      // 响亮失败暴露错误接线（静默 no-op 会丢通知）
      throw new Error(`dsh-notifier: ${BUILTIN_CHANNELS.browser} 频道投递必须经 DeliverDeps.play（send 已随 D23 退役）`);
    },
  };
}