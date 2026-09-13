/** dsh-notifier stores 域 —— 通知历史（jsonl）自己的形状：记录与装配入参。 */
import type { ConfigPort } from "../../deps.ts";
import type { LoggerPort } from "../../../shared/interface.ts";

/** 单出口投递明细：这一次通知送到了哪个出口、结果如何。 */
export interface ChannelDelivery {
  /** 频道实例 id：配置里的身份，也是设置页定位那一行的键。 */
  channelId: string;
  /** `skipped` = 出口按配置判定这次没有可发的内容：既不是失败，也不该被读成投递成功。 */
  status: "ok" | "failed" | "skipped";
  /** 失败原因或跳过原因（不含凭据）；`ok` 那一支上没有。 */
  reason?: string;
}

/**
 * 单条历史记录（与通知文案同源，不含工具参数等敏感信息）。`kind` 是宽 `string`：历史是持久
 * 格式，可能躺着早已退役的种类，不能因为现在的代码不认识它就把整行丢掉。
 */
export interface HistoryEntry {
  ts: number;
  kind: string;
  title: string;
  message: string;
  /** 被压制的原因；真正投递出去时缺省。 */
  suppressed?: string;
  channels?: ChannelDelivery[];
}

/** 一行 jsonl 的解析结果：坏行是常态，由调用点各自决定去向——读取侧跳过，清理侧保守保留。 */
export type ParsedHistoryLine = { ok: true; entry: HistoryEntry } | { ok: false };

export interface HistoryDeps {
  /** 写入失败出口（append 为 fire-and-forget，失败无返回值可承载）。 */
  logger: LoggerPort;
  /** 设置读面：保留天数归它管，装配期不取值。 */
  config: ConfigPort;
}
