/**
 * dsh-notifier channels 域 —— 浏览器出口。
 *
 * 投递动作是把帧交给事件出口，两件事都由结构决定、没有待定的业务，因此这里
 * 是写实的：帧构造是本域唯一的跨端产物（线协议宿主侧唯一生产点），散出去就
 * 会多出第二份事实源。
 *
 * 本域不持有推送设施、不等待回执：帧发出即 `accepted`，页面是否弹出不是本域
 * 能证明的事。
 *
 * 依赖方向：只引用本目录与共享语言，不引用 `interface.ts`。
 */
import type { DeliverResult, NotifyMessage } from "../deliver/type.ts";
import type { BrowserSound, BrowserTarget, NotifyFrame } from "./type.ts";

/**
 * 铃声属性 → 播放决议。
 *
 * 这一步是**出口自己的知识**，不是调用方的：同一个铃声在「跟随系统」与「页内
 * 自播」下是两种行为，而只响不弹时页面里没有可发系统提示音的实体，只能自播。
 * 调用方只说用户选了什么，怎么发声在这里定。
 */
function resolveSound(pop: boolean, sound?: boolean | string): BrowserSound {
  void pop;
  void sound;
  throw new Error("not implemented: resolveSound");
}

/** 构造跨端通知帧。 */
function buildFrame(message: NotifyMessage, target: BrowserTarget): NotifyFrame {
  return {
    pop: target.pop,
    sound: resolveSound(target.pop, target.sound),
    title: message.title,
    body: message.body,
    severity: message.severity,
  };
}

/** 投递一帧到浏览器出口（交给事件出口即完成）。 */
export function sendBrowser(target: BrowserTarget, message: NotifyMessage): DeliverResult {
  target.emitFrame(buildFrame(message, target));
  return { status: "ok", stage: "accepted" };
}
