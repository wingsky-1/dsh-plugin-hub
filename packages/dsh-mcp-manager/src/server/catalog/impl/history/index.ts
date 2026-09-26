/**
 * dsh-mcp-manager — catalog/impl/history/index.ts：会话内目录历史定位（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（history 域）：从会话持久化日志倒序找最后一条**可见**
 * 的能力目录消息——目录注入去重的权威来源。新旧两代 source 形态都认（#723）。
 */

import { digestCatalogEntries } from "../digest/index.ts";
import { isCatalogSource, resolveCatalogEntries } from "../entries/index.ts";
import type { CatalogSourceLike } from "../entries/index.ts";

/** 目录历史查询结果。 */
export interface CatalogHistoryResult {
  visibleDigest?: string;
  published: boolean;
}

/** agent 最小面（session.snapshotEvents() 倒序找目录消息；0.1.2-rc.1 起 events getter 移除）。 */
export interface CatalogAgent {
  session?: {
    surface?: { nodes?: unknown[] };
    snapshotEvents?: () => ReadonlyArray<{
      type?: string;
      seq?: unknown;
      data?: { source?: CatalogSourceLike };
    }>;
  };
}

/** 判定单条会话事件是否为可定位的目录消息：回答「这条事件带目录吗？」——
 * 类型 + 来源身份 + 条目解析三关，任一不符即非目录事件（调用方继续倒序）。
 * 可见性判定（surface.nodes）留在 catalogHistory 内（不同问题）。
 * @returns 可定位时返回目录条目；否则 undefined。 */
function matchCatalogEvent(
  event: { type?: string; data?: { source?: CatalogSourceLike } } | undefined,
): ReturnType<typeof resolveCatalogEntries> {
  if (event?.type !== "user/message") return undefined;
  if (!isCatalogSource(event.data?.source)) return undefined;
  return resolveCatalogEntries(event.data?.source);
}

/** 会话面上本块要的两件输入：当前可见的节点集 + 持久化事件流。宿主面可能整段缺席
 *  （agent 缺席 / 无 session / 无 surface / 0.1.2-rc.1 前无 snapshotEvents），
 *  一律读成空面而不是抛——「读不到历史」与「历史为空」同义，调用方都走重新注入。 */
interface CatalogSession {
  visible: Set<unknown>;
  events: ReadonlyArray<{ type?: string; seq?: unknown; data?: { source?: CatalogSourceLike } }>;
}

function readCatalogSession(agent: CatalogAgent | undefined): CatalogSession {
  const session = agent?.session;
  return {
    visible: new Set(session?.surface?.nodes ?? []),
    events: session?.snapshotEvents?.() ?? [],
  };
}

/**
 * 从会话持久化日志（agent.session.snapshotEvents()）倒序找最后一条**可见**的
 * 能力目录消息。**这是去重的权威来源**（与官方 dsh-tool-skill catalogHistory
 * 同构）：
 * - decision.messages 只含本轮新消息，历史目录消息不在其中——用它定位会导致每轮重复注入；
 * - 可见性（surface.nodes）过滤：compaction/resume 后旧目录不可见 → visibleDigest 为空 → 重新注入；
 * - 只认 snapshot 形态的目录消息（旧 kind:mcp-catalog 落盘走修复脚本迁移）。
 */
export function catalogHistory(agent: CatalogAgent | undefined): CatalogHistoryResult {
  const { visible, events } = readCatalogSession(agent);
  let published = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const entries = matchCatalogEvent(event);
    if (entries === undefined) continue;
    published = true;
    if (visible.has(event?.seq)) return { visibleDigest: digestCatalogEntries(entries), published };
  }
  return { published };
}
