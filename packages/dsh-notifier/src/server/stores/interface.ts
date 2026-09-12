/**
 * stores 域对外契约：通知历史 jsonl 与频道投递状态的**唯一持久化实现**——写队列串行化 + tmp+rename 原子写，读取语义
 * （滚动上限、按天过滤、内存镜像优先）也由本域兜住。契约里没有任何句柄：外面拿不到实例就造不出第二份写队列。
 */
import type { StoreDeps } from "./deps.ts";
import { historyStore } from "./impl/history/index.ts";
import type { HistoryEntry } from "./impl/history/type.ts";
import { statusStore } from "./impl/status/index.ts";
import type { ChannelStatusEntry } from "./impl/status/type.ts";

// 只导出这两个名字：状态条目的形状经 `readStatus()` 的签名可达，调用方不必命名它。
export type { ChannelDelivery, HistoryEntry } from "./impl/history/type.ts";

/**
 * 装配（组合根在 `apply` 期调用一次）。只交付外部数据与宿主能力，不返回任何句柄——
 * 本域的状态由自己持有。
 */
export function installStores(deps: StoreDeps): void {
  historyStore.install({ logger: deps.logger, config: deps.config });
  statusStore.install({ logger: deps.logger });
}

/**
 * 卸载两个存储，与 `installStores` 配对。写队列里在飞的写不等待：它们各有自己的失败出口，
 * 卸载期阻塞等待会让一次退出卡在磁盘上。重复调用无害。
 */
export function releaseStores(): void {
  historyStore.release();
  statusStore.release();
}

/** 写入：追加一条通知历史（内部队列串行化，失败只记日志）。 */
export function appendHistory(entry: HistoryEntry): void {
  historyStore.append(entry);
}

/** 查询：读取通知历史（尾部截断 + 按天过滤 + 损坏行跳过由本域兜住）。 */
export async function readHistory(): Promise<HistoryEntry[]> {
  return historyStore.read();
}

/** 清空通知历史，返回被清空条数。 */
export async function clearHistory(): Promise<number> {
  return historyStore.clear();
}

/** 写入：记录一次频道投递终态（错误文本会落盘并被设置页读出，不要放凭据）。 */
export function recordStatus(channelId: string, status: "ok" | "failed", error?: string): void {
  statusStore.record(channelId, status, error);
}

/** 查询：读取全部频道状态（内存镜像优先，冷启动回落文件）。 */
export async function readStatus(): Promise<Record<string, ChannelStatusEntry>> {
  return statusStore.read();
}
