/**
 * dsh-notifier channels 域 —— 浏览器出口。
 * 帧构造是本域唯一的跨端产物（散出去就有了第二份事实源）；帧交给出口即 accepted——
 * 页面弹没弹不是本域能证明的事。
 */
import { displayCaps, truncateCodePoints } from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage } from "../deliver/type.ts";
import type { BrowserSound, BrowserTarget, NotifyFrame } from "./type.ts";

/** 铃声属性 → 播放决议；只响不弹时页面里没有能发系统提示音的实体，只能自播。 */
function resolveSound(pop: boolean, sound?: boolean | string): BrowserSound {
  if (sound === false || sound === undefined) return { mode: "silent" };
  if (sound === true) return pop ? { mode: "system" } : { mode: "selfplay" };
  return { mode: "selfplay", tone: sound };
}

/** 构造跨端通知帧（severity 缺席就不写这个键）。 */
function buildFrame(message: NotifyMessage, target: BrowserTarget): NotifyFrame {
  const frame: NotifyFrame = {
    pop: target.pop,
    sound: resolveSound(target.pop, target.sound),
    title: truncateCodePoints(message.title, displayCaps.browser.titleMax),
    body: truncateCodePoints(message.body, displayCaps.browser.bodyMax),
  };
  if (message.severity !== undefined) frame.severity = message.severity;
  return frame;
}

/** 投递一帧到浏览器出口（交给帧出口即完成）。 */
export function sendBrowser(target: BrowserTarget, message: NotifyMessage): DeliverResult {
  target.emitFrame(buildFrame(message, target));
  return { status: "ok", stage: "accepted" };
}
