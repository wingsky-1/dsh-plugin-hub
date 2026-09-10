/**
 * dsh-mcp-manager — catalog/injection.ts：能力目录注入决策（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（injection 域）：pre-step 监听器的目录注入决策纯函数，
 * 完全复刻官方 dsh-tool-skill 的 catalog 语义（根治重复注入）。
 */

import { composeCatalogEntries, findCatalogMessage, readCatalogEntries, renderMcpCatalogMessage, renderMcpCatalogUpdate, DEFAULT_CATALOG_MAX_ENTRIES } from "./entries.ts";
import type { CatalogCache, SupervisorLite } from "./entries.ts";
import { digestCatalogEntries } from "./digest.ts";
import { catalogHistory } from "./history.ts";
import type { CatalogAgent } from "./history.ts";

/** 会话消息最小面（pre-step decision.messages / session.snapshotEvents()）。 */
export interface CatalogMessage {
  id?: unknown;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  source?: { kind?: string; form?: unknown; entries?: unknown };
}

/** pre-step 决策最小面。 */
export interface CatalogDecision {
  kind: string;
  messages: CatalogMessage[];
}

/**
 * 目录注入决策（纯函数，pre-step 监听器薄调用，便于单测）。
 * 完全复刻官方 dsh-tool-skill 的 catalog 语义（根治重复注入）：
 * 1. 历史（session.snapshotEvents()）digest 相同 → 本轮不注入（撤销本轮已注入的）——**去重源是历史而非本轮消息**；
 * 2. 历史 digest 不同 → 注入"更新"消息（声明替换旧目录）；
 * 3. 从未发布且无服务器 → 不注入；
 * 4. compaction/resume 后旧目录不可见 → 重新注入（events-based 重建）。
 * @param decision next() 的决策。
 * @param messages 本轮输入消息（签名兼容）。
 * @param supervisors manager.supervisors。
 * @param maxEntries 目录条目上限。
 * @param cache 目录缓存。
 * @param agent pre-step 的 agent（session.snapshotEvents() 来源）。
 * @returns 新决策。
 */
export function resolveCatalogInjection(
  decision: CatalogDecision,
  messages: CatalogMessage[],
  supervisors: Map<string, SupervisorLite>,
  maxEntries = DEFAULT_CATALOG_MAX_ENTRIES,
  cache?: CatalogCache,
  agent?: CatalogAgent,
  mode?: string,
): CatalogDecision {
  if (decision.kind === "reject") return decision;
  const entries = composeCatalogEntries(supervisors, maxEntries, cache);
  const digest = digestCatalogEntries(entries);
  const history = catalogHistory(agent);
  const existing = findCatalogMessage(decision.messages);

  if (history.visibleDigest === digest) {
    // 历史已发布相同目录 → 本轮不注入；撤销本轮刚注入的（幂等）。
    return existing === undefined ? decision : {
      kind: "enter",
      messages: decision.messages.filter((message) => message.id !== existing.id),
    };
  }
  if (existing !== undefined) {
    const existingEntries = readCatalogEntries(existing.source);
    if (existingEntries !== undefined && digestCatalogEntries(existingEntries) === digest) return decision;
  }
  if (!history.published && entries.length === 0) {
    return existing === undefined ? decision : {
      kind: "enter",
      messages: decision.messages.filter((message) => message.id !== existing.id),
    };
  }
  const catalog = history.published ? renderMcpCatalogUpdate(entries, mode) : renderMcpCatalogMessage(entries, mode);
  return {
    kind: "enter",
    messages: existing === undefined ? [...decision.messages, catalog] : decision.messages.map((message) => (message.id === existing.id ? catalog : message)),
  };
}