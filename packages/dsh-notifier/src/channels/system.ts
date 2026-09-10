/**
 * dsh-notifier — 内置 system 频道（D23：投递池实例，播放经 play 注入）。
 *
 * PR2 播放决议随裁决快照解析并经 DeliverDeps.play(target, payload) 值传递——
 * system.notify(spec.pop, spec.sound, ...) 的调用在 index.ts 装配处（对照落位
 * 移前的 dispatchSystem：notify resolve false → throw → 终态 failed，B4）。
 * 本实例仅供投递池（id + capabilities），send 已退役（误触响亮失败，防静默丢
 * 通知）。对 server 域只 import type SystemNotifier（值不跨域）。
 */
import type { SystemNotifier } from "../server/interface.ts";
import { BUILTIN_CHANNELS } from "../sdk/interface.ts";
import type { NotifyChannel } from "../sdk/interface.ts";

/**
 * 创建内置 system 频道实例（仅供投递池：id + capabilities；播放经 play 注入）。
 * @param options.system 装配层注入的系统通知通道（值依赖经注入面，不跨域 import）。
 */
export function createSystemChannel(options: { system: SystemNotifier }): NotifyChannel {
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