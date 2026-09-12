/**
 * dsh-notifier channels 域 —— 浏览器出口的投递参数与跨端帧。
 * 帧是线协议（宿主 → 客户端），由客户端契约锁定：与出口参数同住一处，线协议只有一个生产点。
 */
import type { NotifySeverity } from "../deliver/type.ts";

/** 浏览器播放决议。 */
export interface BrowserSound {
  mode: "silent" | "system" | "selfplay";
  tone?: string;
}

/** 跨端通知帧（宿主 → 客户端线协议）。 */
export interface NotifyFrame {
  pop: boolean;
  sound: BrowserSound;
  title: string;
  body: string;
  severity?: NotifySeverity;
}

/** 浏览器出口：帧经帧出口发出，本域不持有推送设施、不等待回执。 */
export interface BrowserTarget {
  type: "browser";
  pop: boolean;
  /** 铃声：false = 不发声；true = 跟随系统；字符串 = 指定音色；缺省视同不发声。 */
  sound?: boolean | string;
  /** 帧出口：由调用方接上帧总线（api 域监听后经 SSE 送页面）。 */
  emitFrame(frame: NotifyFrame): void;
}
