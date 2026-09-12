/**
 * dsh-notifier stores 域 —— **对外契约**。
 *
 * **职责边界**：通知历史 jsonl 与频道投递状态的**唯一持久化实现**。对外承诺是
 * 「写队列串行化 + tmp+rename 原子写」——调用方不需要重试、不需要加锁；读取语义
 * （滚动上限、按天过滤、内存镜像优先）同样由本域兜住，不上升为调用方的义务。
 *
 * **状态收在实现的闭包里，对外只有动作方法。** 契约里没有任何句柄：外面拿不到
 * 实例，也就造不出第二份写队列——「唯一持久化实现」这句话才有物理含义（能 `new`
 * 出多个，就不再唯一；两个队列指向同一文件、各自串行化、互相不知道对方，
 * 「写队列串行化」会从模块级承诺退化成每个实例各自的承诺）。装配只发生一次。
 *
 * **依赖方向**：只引 `./impl/` 与共享语言；本域无对上依赖，故不建 `deps.ts`。
 */
import type { LoggerPort } from "../shared/type.ts";
import { historyStore } from "./impl/history/index.ts";
import type { HistoryEntry } from "./impl/history/type.ts";
import { statusStore } from "./impl/status/index.ts";
import type { ChannelStatusEntry } from "./impl/status/type.ts";

// 入参类型：只出装配面与写入面要构造的两个。状态条目的形状经 `readStatus()`
// 的签名可达，调用方不必命名它也能读字段。
export type { HistoryEntry } from "./impl/history/type.ts";


/**
 * 装配入参：只剩「本域拿不到的东西」。
 *
 * 落盘位置不在其中——文件名是本域自己的知识，根目录由 DSH home 决定，两者拼在
 * 域内完成；把它做成入参，等于要求每个装配点都知道本域的文件叫什么。
 */
export interface StoreDeps {
  /** 历史保留天数读取器（配置可变，故取 getter 而非装配期快照）。 */
  maxAgeDays(): number;
  /** 写入失败出口（写入是 fire-and-forget，没有同步返回值可承载失败）。 */
  logger: LoggerPort;
}

/**
 * 装配（组合根在 `apply` 期调用一次）。
 *
 * 只交付外部数据与宿主能力，不返回任何句柄——本域的状态由自己持有。
 */
export function installStores(deps: StoreDeps): void {
  historyStore.install({ maxAgeDays: deps.maxAgeDays, logger: deps.logger });
  statusStore.install({ logger: deps.logger });
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

/** 写入：记录一次频道投递终态（错误文本须由调用方先脱敏）。 */
export function recordStatus(channelId: string, status: "ok" | "failed", error?: string): void {
  statusStore.record(channelId, status, error);
}

/** 查询：读取全部频道状态（内存镜像优先，冷启动回落文件）。 */
export async function readStatus(): Promise<Record<string, ChannelStatusEntry>> {
  return statusStore.read();
}
