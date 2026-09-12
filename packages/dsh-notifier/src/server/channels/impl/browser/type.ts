/**
 * dsh-notifier channels 域 —— 浏览器出口的投递参数与跨端帧。
 *
 * 帧是线协议（宿主 → 客户端），由客户端契约锁定：它既是本出口的产物，也是
 * api 域经事件消费的载荷，因此与出口参数同住一处——线协议只有一个生产点。
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

/**
 * 帧的宿主事件名。
 *
 * 声明在帧类型同处，而不是消费者那边：帧的生产者在本域，事件名是生产者与消费者
 * 之间的线协议名。搬到消费者名下，等于让生产者的产物去依赖消费者的命名。
 *
 * 名字不登记就只是一个字符串——事件总线按名字索引，`ctx.emit` / `ctx.on` 都查它，
 * 拼错了不会有任何提示，而症状是「帧发出去没人收到」。
 */
declare module "@deepseek-ai/cordis" {
  interface Events {
    "notifier/frame"(frame: NotifyFrame): void;
  }
}

/**
 * 浏览器出口：帧经事件出口发出，本域不持有任何推送设施。
 *
 * `sound` 只是一个铃声属性——用户选了什么，就传什么。至于它该走系统提示音还是
 * 页内自播、用哪段旋律，是这个出口的知识（平台与实现相关），调用方不参与决定。
 */
export interface BrowserTarget {
  type: "browser";
  pop: boolean;
  /** 铃声：false = 不发声；true = 跟随系统；字符串 = 指定音色；缺省视同不发声。 */
  sound?: boolean | string;
  /** 帧出口：由调用方接上宿主事件总线（api 域监听后经 SSE 送页面）。 */
  emitFrame(frame: NotifyFrame): void;
}
