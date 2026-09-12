/**
 * dsh-notifier api 域 —— 流块自己的形状。
 */
import type { LoggerPort, NotifyFrame, NotifyKind } from "../../deps.ts";

/**
 * SSE 帧（宿主 → 客户端**线协议**）。
 *
 * 字段名与内部帧刻意不同名：客户端读 `message` 与 `playOnly`，内部帧叫 `body` 与
 * `pop`。翻译只在本域发生——线协议是与**已发布客户端**的约定，让内部词汇直接上线，
 * 就等于每次内部改名都可能悄悄改掉线上字段，而症状是「通知还在，只是内容空了」。
 *
 * `seq` 在帧里而不在信封外：帧是「弹什么」，序号是「这是第几条」。客户端靠后者去重
 * 与断线补拉，两者混在一起就会让「重放」和「重弹」变得无法区分。
 */
export type StreamEvent =
  | {
      type: "notify";
      seq: number;
      kind: NotifyKind;
      title: string;
      message: string;
      ts: number;
      sound: NotifyFrame["sound"];
      /** 只响不弹。缺席即「照常弹」——客户端判的是 `=== true`，不是真假值。 */
      playOnly?: true;
    }
  | { type: "ping" };

/** 流块的装配入参。 */
export interface StreamDeps {
  /** 失败出口（心跳停止、连接回收都经它出声）。 */
  logger: LoggerPort;
}
