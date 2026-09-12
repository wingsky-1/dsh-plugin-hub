/**
 * dsh-notifier api 域 —— 流块自己的形状。
 */
import type { LoggerPort, NotifyFrame, NotifyKind } from "../../deps.ts";

/**
 * SSE 帧信封（宿主 → 客户端线协议）。
 *
 * `seq` 在信封而不在帧里：帧是「弹什么」，序号是「这是第几条」。客户端靠后者去重与
 * 断线补拉，两者混在一起就会让「重放」和「重弹」变得无法区分。
 */
export type StreamEvent =
  | { type: "notify"; seq: number; kind: NotifyKind; frame: NotifyFrame }
  | { type: "ping" };

/** 流块的装配入参。 */
export interface StreamDeps {
  /** 失败出口（心跳停止、连接回收都经它出声）。 */
  logger: LoggerPort;
}
