/** api 域流块自己的形状。 */
import type { ConfigPort, LoggerPort, NotifyFrame, NotifyKind } from "../../deps.ts";

/** SSE 帧（宿主 → 客户端**线协议**）。字段名与内部帧刻意不同名（客户端读 `message` / `playOnly`，内部帧叫
 * `body` / `pop`）：线协议是与**已发布客户端**的约定，让内部词汇直接上线就等于每次内部改名都可能悄悄改掉线上
 * 字段；`seq` 在帧里而不在信封外——客户端靠它去重与断线补拉。 */
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
      /** 页面可见时是否也弹：可见性只有页面自己知道，故随帧下发，渲染端不必回查可能已变的配置。
       *  0.2.3 的帧没有这个字段，不读它的旧客户端不受影响。 */
      whenVisible: boolean;
    }
  | { type: "ping" };

/** 流块要的设置能力：只读连接上限，设置页那两面与它无关。 */
export type StreamConfigPort = Pick<ConfigPort, "readConfig">;

/** 流块的装配入参。 */
export interface StreamDeps {
  /** 失败出口（心跳停止、连接回收都经它出声）。 */
  logger: LoggerPort;
  /** 设置读面：连接上限实时读，用户调小之后下一次淘汰就该按新值来。 */
  config: StreamConfigPort;
}
