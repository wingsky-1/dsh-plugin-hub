/**
 * dsh-notifier pipeline 域 —— **对上依赖申报表**。
 *
 * 本域声明「我需要外部什么」，不关心谁满足它——装配由组合根完成。依赖集中在此，
 * 实现块经本文件引用，不直连他域。
 *
 * 这里没有一样形状是本域自己定义的。配置模型、投递消息、历史记录、通知请求各有
 * 归属域，本域只是它们的消费者——在本地抄一份，等于给每处改动预备一次静默失配的
 * 机会，而失配的表现是「某一类通知的行为和别人不一样」。
 */
import type { NotifyFrame, deliver } from "../channels/interface.ts";
import type { readConfig } from "../config/interface.ts";

/** 投递能力：与 channels 契约同源，不在两侧各写一遍签名。 */
export type DeliverPort = typeof deliver;

/**
 * 当前生效设置：与 config 读面同源。
 *
 * 取读面的返回类型，而不是请 config 域把设置模型再导出一个名字：那个模型已经完整
 * 地被 `readConfig()` 的签名承载，多一个出口就多一份要同步的事实源。
 */
export type EffectiveConfig = ReturnType<typeof readConfig>;

/**
 * 帧出口（宿主 → 客户端）：与浏览器出口声明的帧同一形状。
 *
 * 帧经宿主事件总线发出，所以它到本域手上时已经是一个函数——组合根把总线那一头接好，
 * 本域只负责在造浏览器目标时把它填进去。
 */
export type FramePort = (frame: NotifyFrame) => void;

export type { NotifyFrame };
export type { DeliveryTarget, NotifyMessage } from "../channels/interface.ts";
export type { NotifyKind, NotifyRequest } from "../events/interface.ts";
export type { HistoryEntry } from "../stores/interface.ts";
