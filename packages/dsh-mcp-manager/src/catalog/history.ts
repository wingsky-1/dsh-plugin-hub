/**
 * dsh-mcp-manager — catalog/history.ts：会话内目录历史定位（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（history 域）：从会话事件日志倒序找最后一条**可见**的
 * 能力目录消息——目录注入去重的权威来源。新旧两代 source 形态都认（#723）。
 *
 * 事件源要**跨宿主版本**取（目录注入时机）：上游在 `dsh-v0.1.2-alpha.4` 删掉了
 * `Session.events` getter、改成 `snapshotEvents()`（#443）。两条宿主线都在野：
 * - 0.1.1-rc.x ~ 0.1.2-alpha.2（含桌面客户端随包分发的 alpha.1）：只有 `events`；
 * - 0.1.2-alpha.4 及以后：只有 `snapshotEvents()`。
 * 取错 API 时这里会**静默返回空历史**（可选链吞掉），去重随即失效 → 每一轮
 * pre-step 都判"从未发布"，把同一条目录重复注入一遍（用户侧实测：一次会话
 * 27 个 pre-step 注入 28 条完全相同的目录消息）。
 */

import { digestCatalogEntries } from "./digest.ts";
import { isCatalogSource, resolveCatalogEntries } from "./entries.ts";
import type { CatalogSourceLike } from "./entries.ts";

/** 目录历史查询结果。 */
export interface CatalogHistoryResult {
  visibleDigest?: string;
  published: boolean;
}

/** 会话事件最小面（只用到事件类型 / 序号 / 来源）。 */
export interface CatalogEventLike {
  type?: string;
  seq?: unknown;
  data?: { source?: CatalogSourceLike };
}

/** agent 最小面（两代宿主的事件源二选一，见文件头）。 */
export interface CatalogAgent {
  session?: {
    surface?: { nodes?: unknown[] };
    /** 老宿主（< 0.1.2-alpha.4）的 append-only 事件日志 getter。 */
    events?: ReadonlyArray<CatalogEventLike>;
    /** 新宿主（>= 0.1.2-alpha.4）的事件快照方法（无参语义与旧 getter 等价）。 */
    snapshotEvents?: () => ReadonlyArray<CatalogEventLike>;
  };
}

/**
 * 解析会话事件源：`snapshotEvents()` 优先（>= 0.1.2-alpha.4 的唯一路径，也是
 * 上游自身与官方 dsh-tool-skill 的现行写法），老宿主的 `events` getter 回落；
 * 都没有 → 空数组（历史不可读，调用方按"未发布"处理）。
 */
function sessionEvents(session: CatalogAgent["session"]): ReadonlyArray<CatalogEventLike> {
  const snapshot = session?.snapshotEvents?.();
  if (Array.isArray(snapshot)) return snapshot;
  const events = session?.events;
  return Array.isArray(events) ? events : [];
}

/**
 * 从会话事件日志（agent.session.events）倒序找最后一条**可见**的能力目录消息。
 * **这是去重的权威来源**（与官方 dsh-tool-skill catalogHistory 同构）：
 * - decision.messages 只含本轮新消息，历史目录消息不在其中——用它定位会导致每轮重复注入；
 * - 可见性（surface.nodes）过滤：compaction/resume 后旧目录不可见 → visibleDigest 为空 → 重新注入；
 * - 新旧两代 source 形态共存（#723 升级前的会话仍是 mcp-catalog + entries）。
 */
export function catalogHistory(agent: CatalogAgent | undefined): CatalogHistoryResult {
  const visible = new Set(agent?.session?.surface?.nodes ?? []);
  const events = sessionEvents(agent?.session);
  let published = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    if (!isCatalogSource(event.data?.source)) continue;
    const entries = resolveCatalogEntries(event.data?.source);
    if (entries === undefined) continue;
    published = true;
    if (visible.has(event.seq)) return { visibleDigest: digestCatalogEntries(entries), published };
  }
  return { published };
}
