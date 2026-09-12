/**
 * dsh-notifier stores 域 —— 通知历史（jsonl）自己的形状。
 *
 * 记录与装配入参都归这里：它们只对历史这一块成立，另一块存储用不上，因此不进
 * `shared/`（那里只收跨域、无单一归属的公共语言）。
 *
 * `read` 返回本域自己的记录类型而非宽泛记录：本域是这些行的唯一写方，宽泛形状
 * 等于没有契约，且消费方按 `ts` / `kind` / `title` / `message` / `suppressed`
 * 逐字段取值。
 */
import type { LoggerPort } from "../../../shared/type.ts";

/** 单条历史记录（与通知文案同源，不含工具参数等敏感信息）。 */
export interface HistoryEntry {
  ts: number;
  kind: string;
  title: string;
  message: string;
  suppressed?: string;
}

/** 通知历史的装配入参。 */
export interface HistoryDeps {
  /** 历史保留天数读取器（配置变更后立即生效，故取 getter 而非快照值）。 */
  maxAgeDays(): number;
  /** 写入失败出口（append 为 fire-and-forget，失败无返回值可承载）。 */
  logger: LoggerPort;
}
