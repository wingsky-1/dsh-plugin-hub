/**
 * dsh-mcp-manager — catalog/injection.ts：能力目录注入决策（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（injection 域）：pre-step 监听器的目录注入决策纯函数，
 * 完全复刻官方 dsh-tool-skill 的 catalog 语义（根治重复注入）。
 */

import { composeCatalogEntries, findCatalogMessage, resolveCatalogEntries, renderMcpCatalogMessage, renderMcpCatalogUpdate, DEFAULT_CATALOG_MAX_ENTRIES } from "./entries.ts";
import type { CatalogCache, SupervisorLite } from "./entries.ts";
import { digestCatalogEntries } from "./digest.ts";
import { catalogHistory } from "./history.ts";
import type { CatalogAgent } from "./history.ts";

/**
 * 目录注入时机（设置页「目录注入时机」下拉，见 ConfigSchema.catalogInjection）：
 * - `auto`（默认）：目录按需刷新——服务器集合变化时注入一条替换帧，未变化不注入；
 * - `once`：只在会话首次注入一次，此后不再重复注入，也不再为"目录是否已变"做
 *   每轮重算（省 token 也省 pre-step 的每轮开销）。
 * 字面量联合就地声明（与 config/model/config-schema.ts 同口径），避免为取一个
 * 类型经 catalog/**interface.ts** 门面新增跨域边（dir-imports 单调基线只许降）。
 */
export type CatalogInjectionMode = "auto" | "once";

/** 会话消息最小面（pre-step decision.messages / session.snapshotEvents()）。 */
export interface CatalogMessage {
  id?: unknown;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  source?: { kind?: unknown; plugin?: unknown; form?: unknown; entries?: unknown; sections?: unknown };
}

/** pre-step 决策最小面。 */
export interface CatalogDecision {
  kind: string;
  messages: CatalogMessage[];
}

/**
 * 目录注入决策（纯函数，pre-step 监听器薄调用，便于单测）。
 * 完全复刻官方 dsh-tool-skill 的 catalog 语义（根治重复注入）：
 * 1. 历史（session.events）digest 相同 → 本轮不注入（撤销本轮已注入的）——**去重源是历史而非本轮消息**；
 * 2. 历史 digest 不同 → 注入"更新"消息（声明替换旧目录）；
 * 3. 从未发布且无服务器 → 不注入；
 * 4. compaction/resume 后旧目录不可见 → 重新注入（events-based 重建）。
 * @param decision next() 的决策。
 * @param messages 本轮输入消息（签名兼容）。
 * @param supervisors manager.supervisors。
 * @param maxEntries 目录条目上限。
 * @param cache 目录缓存。
 * @param agent pre-step 的 agent（session.events 来源）。
 * @param mode 中间层模式（渲染引导文案）。
 * @param injectionMode 注入时机：`once` = 会话内已发布过目录就直接返回，不再重算/刷新。
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
  injectionMode: CatalogInjectionMode = "auto",
): CatalogDecision {
  if (decision.kind === "reject") return decision;
  const history = catalogHistory(agent);
  // `once`：本会话已发布过目录 → 一次都不再注入（也不再为 digest 变化做重算）。
  // 判据用 published（历史里存在可见或已滚出的目录）而非 visibleDigest：
  // 用户要的是"整个会话只出现一次"，compaction 后也不重新注入。
  if (injectionMode === "once" && history.published) {
    const existing = findCatalogMessage(decision.messages);
    return existing === undefined ? decision : {
      kind: "enter",
      messages: decision.messages.filter((message) => message.id !== existing.id),
    };
  }

  const entries = composeCatalogEntries(supervisors, maxEntries, cache);
  const digest = digestCatalogEntries(entries);
  const existing = findCatalogMessage(decision.messages);

  if (history.visibleDigest === digest) {
    // 历史已发布相同目录 → 本轮不注入；撤销本轮刚注入的（幂等）。
    return existing === undefined ? decision : {
      kind: "enter",
      messages: decision.messages.filter((message) => message.id !== existing.id),
    };
  }
  if (existing !== undefined) {
    const existingEntries = resolveCatalogEntries(existing.source);
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