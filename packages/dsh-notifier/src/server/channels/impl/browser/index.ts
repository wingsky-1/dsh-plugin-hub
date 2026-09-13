/**
 * dsh-notifier channels 域 —— 浏览器出口。
 * 帧构造是本域唯一的跨端产物（散出去就有了第二份事实源）；帧交给出口即 accepted——
 * 页面弹没弹不是本域能证明的事。
 */
import { displayCaps, truncateCodePoints } from "../deliver/caps.ts";
import type { DeliverResult, NotifyMessage, ToneSetting } from "../deliver/type.ts";
import type { BrowserSound, BrowserTarget, NotifyFrame } from "./type.ts";

/** 铃声属性 → 播放决议；只响不弹时页面里没有能发系统提示音的实体，只能自播。 */
function resolveSound(popup: boolean, sound: ToneSetting): BrowserSound {
  if (sound === false) return { mode: "silent" };
  if (sound === true) return popup ? { mode: "system" } : { mode: "selfplay" };
  return { mode: "selfplay", tone: sound };
}

/** 构造跨端通知帧（severity 缺席就不写这个键）。 */
function buildFrame(message: NotifyMessage, target: BrowserTarget): NotifyFrame {
  const frame: NotifyFrame = {
    pop: target.popup,
    sound: resolveSound(target.popup, target.sound),
    whenVisible: target.whenVisible,
    title: truncateCodePoints(message.title, displayCaps.browser.titleMax),
    body: truncateCodePoints(message.body, displayCaps.browser.bodyMax),
  };
  if (message.severity !== undefined) frame.severity = message.severity;
  return frame;
}

/**
 * 投递一帧到浏览器出口。
 *
 * 弹窗与声音都关掉时**不发帧**：帧一旦出去就会推进序号、进重放缓冲、并让页面认领主标签租约——
 * 用一次真实投递去换一个空动作，代价比什么都不做大得多。这不是「要不要投递」的判断（那在管线，
 * 只看 `enabled`），而是本出口对「发什么」的回答：这一次没有可发的内容。
 */
export function sendBrowser(target: BrowserTarget, message: NotifyMessage): DeliverResult {
  if (!target.popup && target.sound === false) {
    return { status: "skipped", reason: "浏览器频道：弹窗与声音都已关闭" };
  }
  target.emitFrame(buildFrame(message, target));
  return { status: "ok", stage: "accepted" };
}
