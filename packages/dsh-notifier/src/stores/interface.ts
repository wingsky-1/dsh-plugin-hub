/**
 * dsh-notifier — stores/interface.ts：存储域唯一对外引用面。
 *
 * 目录外代码只能从这里引用：通知历史存储（jsonl 写队列原子写）与频道投递
 * 状态存储（debounce 落盘）。写队列串行化 + tmp+rename 原子写是本域对外的
 * 持久化承诺（verify-dir-imports 静态强制）。
 */
export { HISTORY_LIMIT, createHistoryStore } from "./history.ts";
export type { HistoryEntry, HistoryStore } from "./history.ts";
export { createStatusStore } from "./status.ts";
export type { ChannelStatusEntry, StatusStore } from "./status.ts";