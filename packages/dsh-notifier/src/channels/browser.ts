/**
 * dsh-notifier — 内置 browser 频道（包一层 SSE 枢纽，M8 注入面）。
 *
 * 职责：把 sse.broadcast 适配为 NotifyChannel（帧契约 {type,kind,title,message,
 * ts,seq} 不变，只加 sound/playOnly 字段——向后兼容，旧客户端无 sound 帧回落
 * 快照兜底）。注入面显式化为 {sse, current}：声音策略在投递时刻实时读取
 * （#640/#641：弹窗与声音组合分派——弹 toast / 只响不弹 / 静默）。
 * 对 server 域只 import type SseHub（值不跨域：sse 实例由装配层注入）。
 */
import { resolveSoundSetting } from "../config/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
import type { SseHub } from "../server/interface.ts";
import { BUILTIN_CHANNELS } from "../sdk/interface.ts";
import type { NotifyChannel, NotifySeverity } from "../sdk/interface.ts";

/**
 * 创建内置 browser 频道。
 * @param options.sse 装配层注入的 SSE 推送枢纽（值依赖经注入面，不跨域 import）。
 * @param options.current 当前生效配置实时读取器（声音/弹窗开关在投递时刻取值）。
 */
export function createBrowserChannel(options: { sse: SseHub; current: () => NotifyConfig }): NotifyChannel {
  const { sse, current } = options;

  /** browser 频道分派（帧级 sound，P0-1）：
   *  弹窗开 → SSE notify 帧（附服务端解析的 sound 策略，客户端帧级权威）；
   *  弹窗关 + 声音开（只响不弹）→ SSE 只响不弹帧（play-only 标记），客户端
   *  自播不弹实体；两者皆关 → 频道根本不进投递集合（allChannels 已过滤）。 */
  function dispatchBrowser(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }): void {
    const cfg = current();
    const pop = cfg.browserNotify === true;
    const sound = resolveSoundSetting(cfg, "browser");
    if (pop) {
      sse.broadcast({
        type: "notify",
        kind: payload.kind,
        title: payload.title,
        message: payload.body,
        ts: payload.ts,
        sound: { mode: sound === false ? "silent" : sound === true ? "system" : "selfplay", tone: typeof sound === "string" ? sound : undefined },
      });
      return;
    }
    // 只响不弹：声音非静音才会进投递集合；发 play-only 帧（客户端不弹实体）。
    // true（跟随系统默认）在此场景没有可依赖的「OS 弹窗发声」——弹窗关 = 无
    // 通知实体 = OS 不会发声，故编码为 selfplay + tone:undefined（客户端默认
    // 旋律），与 system 通道 pop=false + true 的「默认事件音自播」语义对齐
    // （复核 P1-1：原 mode:"system" 会让客户端既不弹也不播 → 纯静默误导）。
    sse.broadcast({
      type: "notify",
      kind: payload.kind,
      title: payload.title,
      message: payload.body,
      ts: payload.ts,
      playOnly: true,
      sound: { mode: "selfplay", tone: typeof sound === "string" ? sound : undefined },
    });
  }

  return {
    name: BUILTIN_CHANNELS.browser,
    capabilities: { titleMaxLen: 64, maxBodyLen: 2048 },
    send(payload) {
      dispatchBrowser(payload);
    },
  };
}