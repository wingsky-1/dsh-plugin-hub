/**
 * dsh-mcp-manager — catalog/history.ts：会话内目录历史定位（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（history 域）：从会话持久化日志倒序找最后一条**可见**
 * 的 mcp-catalog 消息——目录注入去重的权威来源。
 */

import { digestCatalogEntries } from "./digest.ts";
import { readCatalogEntries } from "./entries.ts";

/** 目录历史查询结果。 */
export interface CatalogHistoryResult {
  visibleDigest?: string;
  published: boolean;
}

/** agent 最小面（session.snapshotEvents() 倒序找目录消息；0.1.2-rc.1 起 events getter 移除）。 */
export interface CatalogAgent {
  session?: {
    surface?: { nodes?: unknown[] };
    snapshotEvents?: () => ReadonlyArray<{ type?: string; seq?: unknown; data?: { source?: { kind?: string; entries?: unknown } } }>;
  };
}

/**
 * 从会话持久化日志（agent.session.snapshotEvents()）倒序找最后一条**可见**的
 * mcp-catalog 消息。**这是去重的权威来源**（与官方 dsh-tool-skill catalogHistory
 * 同构）：
 * - decision.messages 只含本轮新消息，历史目录消息不在其中——用它定位会导致每轮重复注入；
 * - 可见性（surface.nodes）过滤：compaction/resume 后旧目录不可见 → visibleDigest 为空 → 重新注入。
 */
export function catalogHistory(agent: CatalogAgent | undefined): CatalogHistoryResult {
  const visible = new Set(agent?.session?.surface?.nodes ?? []);
  const events = agent?.session?.snapshotEvents?.() ?? [];
  let published = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    if (event?.data?.source?.kind !== "mcp-catalog") continue;
    const entries = readCatalogEntries(event.data.source);
    if (entries === undefined) continue;
    published = true;
    if (visible.has(event.seq)) return { visibleDigest: digestCatalogEntries(entries), published };
  }
  return { published };
}