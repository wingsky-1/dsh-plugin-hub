/**
 * dsh-notifier — 内置 system 频道（包一层系统通知，M8 注入面）。
 *
 * 职责：把 SystemNotifier.notify 适配为 NotifyChannel（节流/超时/降级语义在
 * SystemNotifier 内；终态经 promise 决议——自播失败/命令失败 → failed（B4））。
 * 注入面显式化为 {system, current}：声音策略经 resolveSoundSetting 在读面权威
 * 回落（缺省/旧别名 notifySound）后在投递时刻实时取值。
 * 对 server 域只 import type SystemNotifier（值不跨域：实例由装配层注入）。
 */
import { resolveSoundSetting } from "../config/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
import type { SystemNotifier } from "../server/interface.ts";
import { BUILTIN_CHANNELS } from "../sdk/interface.ts";
import type { NotifyChannel, NotifySeverity } from "../sdk/interface.ts";

/**
 * 创建内置 system 频道。
 * @param options.system 装配层注入的系统通知通道（值依赖经注入面，不跨域 import）。
 * @param options.current 当前生效配置实时读取器（弹窗/声音在投递时刻取值）。
 */
export function createSystemChannel(options: { system: SystemNotifier; current: () => NotifyConfig }): NotifyChannel {
  const { system, current } = options;

  /** system 频道分派（弹 toast / 只自播 / 静默 由 SystemNotifier 承载；消息实时传入）。 */
  function dispatchSystem(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }): Promise<void> {
    const cfg = current();
    const pop = cfg.systemNotify === true;
    const sound = resolveSoundSetting(cfg, "system");
    // 声音 false 时频道不会进投递集合；此处统一走 system.notify 决议终态。
    // notify resolve false（自播失败/命令失败）→ throw → promise reject →
    // deliver 的 emitFail（B4 异步终态 failed）。reject 不在此吞掉（复核 P2-1：
    // onRejected 返回 undefined 会让 promise resolve → 误走 emitOk 成功上报）。
    return system.notify(pop, sound, payload.title, payload.body).then((ok) => {
      if (!ok) throw new Error("system notification failed (self-play or command error)");
    });
  }

  return {
    name: BUILTIN_CHANNELS.system,
    capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
    send(payload) {
      return dispatchSystem(payload);
    },
  };
}