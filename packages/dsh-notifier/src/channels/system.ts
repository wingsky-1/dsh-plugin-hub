/**
 * dsh-notifier — 内置 system 频道（投递池实例，播放经 play 注入）。
 *
 * 播放决议随裁决快照解析并经 DeliverDeps.play(target, payload) 值传递——
 * system.notify(spec.pop, spec.sound, ...) 的调用在 index.ts 装配处（对照落位
 * 移前的 dispatchSystem：notify resolve false → throw → 终态 failed）。
 * 本实例仅供投递池（id + capabilities），send 已退役（误触响亮失败，防静默丢
 * 通知）。实例不持任何依赖（无注入面参数），故本域对 server 域零依赖
 * （零值边 + 零 type 边，消除 channels→server 倒置边）。
 */
import { BUILTIN_CHANNELS } from "../config/interface.ts";
import type { NotifyChannel } from "../sdk/interface.ts";

/**
 * 创建内置 system 频道实例（仅供投递池：id + capabilities；播放经 play 注入）。
 */
export function createSystemChannel(): NotifyChannel {
  return {
    name: BUILTIN_CHANNELS.system,
    capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
    send() {
      // 播放决议在裁决时快照化并经 DeliverDeps.play 值传递——本实例 send 不可达；
      // 响亮失败暴露错误接线（静默 no-op 会丢通知）
      throw new Error(`dsh-notifier: ${BUILTIN_CHANNELS.system} 频道投递必须经 DeliverDeps.play（send 已随 D23 退役）`);
    },
  };
}