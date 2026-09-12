/**
 * dsh-notifier stores 域 —— 通知历史（jsonl）自己的形状。
 *
 * 记录与装配入参都归这里：它们只对历史这一块成立，另一块存储用不上，因此不进
 * `shared/`（那里只收跨域、无单一归属的公共语言）。
 */
import type { ConfigPort } from "../../deps.ts";
import type { LoggerPort } from "../../../shared/type.ts";

/** 单出口投递明细：这一次通知送到了哪个出口、结果如何。 */
export interface ChannelDelivery {
  /** 频道实例 id：配置里的身份，也是设置页定位那一行的键。 */
  channelId: string;
  status: "ok" | "failed";
  /** 失败原因（由投递出口给出，不含凭据；ok 时缺省）。 */
  reason?: string;
}

/**
 * 单条历史记录（与通知文案同源，不含工具参数等敏感信息）。
 *
 * `kind` 是宽 `string` 而不是那个内置种类联合：历史是**持久格式**，里面可能躺着早已
 * 退役的种类，读的时候不能因为「现在的代码不认识它」就把整行当成坏数据丢掉。
 */
export interface HistoryEntry {
  ts: number;
  kind: string;
  title: string;
  message: string;
  /** 被压制的原因；真正投递出去时缺省。 */
  suppressed?: string;
  /** 逐出口投递明细；被压制时缺省。 */
  channels?: ChannelDelivery[];
}

/** 通知历史的装配入参。 */
export interface HistoryDeps {
  /** 设置：保留天数在每次读时取——设置可变，装配期快照会在用户改设置后失效。 */
  config: ConfigPort;
  /** 写入失败出口（append 为 fire-and-forget，失败无返回值可承载）。 */
  logger: LoggerPort;
}
