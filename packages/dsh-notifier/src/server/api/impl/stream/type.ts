/** api 域流块自己的形状。 */
import type { LoggerPort, NotifyFrame, NotifyKind, SseHub } from "../../deps.ts";

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

/** 流块的装配入参。 */
export interface StreamDeps {
  /** 失败出口（心跳停止、连接回收都经它出声）。 */
  logger: LoggerPort;
}

/**
 * 建面端口：`install` 依赖的两样进程事实——读回上次序号、建起连接表与心跳。
 *
 * 为什么把它们收成端口、而不是留在 `install` 里直接调：那两行**都抛不了**
 * （`readTextFileSync` 吞掉全部错误回 `{ok:false}`，`createSseHub` 只建 Map + setInterval），
 * 而「装的第一步就失败」这一格在装配面两头都够不着：真实输入造不出它（这正是本端口要解决的），
 * 在收口之前 api 域的 `try` 也罩不到它（闸与建面都排在 try 之外，那次失败没人回滚）。
 * 端口把这一格变成可注入的事实，生产恒用真实建面（`REAL_BUILD`）——
 * 故这是本来就该有的进程事实边界，不是为测试开的后门。
 *
 * 端口只在本块 impl 内可达：不 re-export 到包的导出面（见 `src/index.ts` 的导出面快照门禁）。
 */
export interface StreamBuildPort {
  /** 打开一次流面。**抛错即建面失败**，由调用方整单回滚（此时本块的 `installed` 已翻成 true）。 */
  open(file: string): { readonly seq: number; readonly hub: SseHub };
}
