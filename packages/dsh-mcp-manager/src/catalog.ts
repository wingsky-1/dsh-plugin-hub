/**
 * dsh-mcp-manager — L1 能力目录与目录缓存（独立模块）。
 *
 * 能力目录：向模型宣告已配置 MCP 服务器（数据源不依赖实时连接状态，
 * digest 只含服务器集合，history-based 去重防重复注入）。
 * 目录缓存：连接成功时把工具描述摘要持久化于磁盘，作为 digest 的稳定数据源。
 * 由 lib/index.js 组合根 re-export。
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerConfig } from "./types.js";

/** 目录条目。 */
export interface CatalogEntry {
  name: string;
  text?: string;
}

/** supervisor 最小面（manager.supervisors 的条目）。 */
export interface SupervisorLite {
  server: ServerConfig;
}

/** 目录缓存（连接成功时持久化的工具描述摘要）。 */
export type CatalogCache = Map<string, { summary: string }>;

/** 会话消息最小面（pre-step decision.messages / session.events）。 */
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

/** 目录历史查询结果。 */
export interface CatalogHistoryResult {
  visibleDigest?: string;
  published: boolean;
}

/** agent 最小面（session.events 倒序找目录消息）。 */
export interface CatalogAgent {
  session?: {
    surface?: { nodes?: unknown[] };
    events?: Array<{ type?: string; seq?: unknown; data?: { source?: { kind?: string; entries?: unknown } } }>;
  };
}

// ------------------------------------------------- 感知增强（对抗性评审 v2）

/** 能力目录默认开启。 */
export const DEFAULT_ANNOUNCE_CATALOG = true;
/** 能力目录最大条目数（防上下文膨胀）。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 6;

// ------------------------------------------------- 目录缓存（L1 数据源）

/** 目录缓存文件（连接成功时把工具描述摘要持久化于此；目录 digest 的稳定数据源）。 */
export function catalogCacheFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-mcp-catalog.json");
}

/**
 * 从工具描述集合计算目录摘要（排序后取第一个非空，**完整返回不截断**）：
 * 排序保证工具列表顺序变化时摘要稳定（重连不触发缓存更新 → digest 不变）。
 */
export function summarizeToolDescriptions(toolMeta: Map<string, { description?: unknown }>): string | undefined {
  const descriptions = [...toolMeta.values()]
    .map((meta) => (typeof meta?.description === "string" ? meta.description : ""))
    .map((text) => text.trim().replace(/\s+/gu, " "))
    .filter((text) => text !== "")
    .sort();
  const first = descriptions[0];
  return first === undefined ? undefined : first;
}

// --------------------------------------------- L1 能力目录（感知增强）

/**
 * 生成能力目录条目（**数据源不依赖用户配置、不依赖实时连接状态**）：
 * ① 服务器自定义 description（用户可选补充，优先）→
 * ② 目录缓存摘要（连接成功时自动持久化的工具描述摘要，磁盘数据，与连接状态解耦）
 * ③ 都没有 → 只显示服务器名。
 * 连接/断开/重连不改变缓存内容 → digest 稳定 → 不触发重复注入。
 * @param supervisors manager.supervisors（name → supervisor）。
 * @param maxEntries 最大条目数。
 * @param cache 目录缓存（manager.catalogCache）。
 * @returns 目录条目。
 */
export function composeCatalogEntries(supervisors: Map<string, SupervisorLite>, maxEntries = DEFAULT_CATALOG_MAX_ENTRIES, cache?: CatalogCache): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [name, supervisor] of supervisors) {
    if (entries.length >= maxEntries) break;
    const server = supervisor.server;
    let text;
    if (typeof server.description === "string" && server.description !== "") {
      text = server.description;
    } else {
      const cached = cache?.get(name);
      if (typeof cached?.summary === "string" && cached.summary !== "") text = cached.summary;
    }
    // 无描述时剥离 text 属性（不产出 `text: undefined`）：条目保持干净可
    // JSON 序列化，否则目录消息 append 为 user/message 事件会被 dsh-session
    // 序列化校验拒绝（issue #192）。
    entries.push(text === undefined ? { name } : { name, text });
  }
  return entries;
}

/**
 * 目录条目 digest（sha256）——**只含服务器集合（name），不含描述文本**。
 *
 * 为什么：MCP 服务器的工具描述集合不稳定（按需注册/动态描述，实测 code-graph
 * 等服务器不同时刻的摘要都不同）。若 digest 含描述文本，缓存摘要一更新就触发
 * 替换注入——永远追不上抖动。digest 只含 name 后：
 * - 服务器增删 → digest 变 → 原位替换（合理）
 * - 描述/缓存更新 → digest 不变 → 本会话目录保持快照（静态能力地图语义，
 *   与消息声明"仅描述能力、不代表当前连接状态"一致），跨会话才反映新缓存
 */
export function digestCatalogEntries(entries: CatalogEntry[]): string {
  const canonical = entries.map((entry) => entry.name).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** 渲染能力目录消息（source 标记供定位替换）。 */
export function renderMcpCatalogMessage(entries: CatalogEntry[]): CatalogMessage {
  const lines = [
    "<system-reminder>",
    "本会话已配置以下 MCP 服务器（**仅描述能力，不代表当前连接状态**；服务器在 GUI「MCP」浮窗中连接后，其工具才会注册可用）：",
    "",
    "<available_mcp_servers>",
    ...entries.map((entry) => (entry.text === undefined ? `- \`${entry.name}\`` : `- \`${entry.name}\`: ${escapeCatalogText(entry.text)}`)),
    "</available_mcp_servers>",
    "",
    "任务匹配某服务器能力时，直接调用其 `mcp__<server>__<tool>` 工具（具体工具名与参数见工具列表）。",
    "若某服务器此前可用而现在不可用，请勿反复重试同一工具超过两次，改用其他方式或提示用户检查「MCP」浮窗。",
    "</system-reminder>",
  ].join("\n");
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: lines }],
    source: { kind: "mcp-catalog", form: "catalog", entries },
  };
}

/** 转义远程来源文本（防提示注入/标签逃逸；与 skill catalog 的 escapeText 同思路）。
 * 只做安全转义，**不做长度截断**（完整返回描述）。 */
export function escapeCatalogText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n]/gu, " ");
}

/** 从消息列表里定位既有的能力目录消息（source.kind 匹配）。 */
export function findCatalogMessage(messages: CatalogMessage[]): CatalogMessage | undefined {
  for (const message of messages) {
    if (message?.source?.kind === "mcp-catalog") return message;
  }
  return undefined;
}

/**
 * 防御性读取目录 source 里的 entries（坏数据返回 undefined——按"不是本插件的目录"
 * 处理，绝不在 step 监听器里抛错，否则每轮都会失败）。
 */
export function readCatalogEntries(source: { entries?: unknown } | undefined): CatalogEntry[] | undefined {
  const entries = source?.entries;
  if (!Array.isArray(entries)) return undefined;
  const readable: CatalogEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { name, text } = entry;
    if (typeof name !== "string" || name === "") return undefined;
    readable.push({ name, text: typeof text === "string" ? text : undefined });
  }
  return readable;
}

/**
 * 从会话持久化日志（agent.session.events）倒序找最后一条**可见**的 mcp-catalog 消息。
 * **这是去重的权威来源**（与官方 dsh-tool-skill catalogHistory 同构）：
 * - decision.messages 只含本轮新消息，历史目录消息不在其中——用它定位会导致每轮重复注入；
 * - 可见性（surface.nodes）过滤：compaction/resume 后旧目录不可见 → visibleDigest 为空 → 重新注入。
 */
export function catalogHistory(agent: CatalogAgent | undefined): CatalogHistoryResult {
  const visible = new Set(agent?.session?.surface?.nodes ?? []);
  const events = agent?.session?.events ?? [];
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

/** 渲染"目录更新"消息（历史旧目录无法删除，新消息声明作废——与 tool-skill 同语义）。 */
export function renderMcpCatalogUpdate(entries: CatalogEntry[]): CatalogMessage {
  const body = renderMcpCatalogMessage(entries);
  const inner = body.content![0].text!.split("\n").slice(3).join("\n");
  const text = [
    "<system-reminder>",
    "MCP 服务器集合已变化。**本目录替换此前所有 available_mcp_servers 列表**：",
    "",
    inner,
    "</system-reminder>",
  ].join("\n");
  return { ...body, content: [{ type: "text", text }] };
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
 * @returns 新决策。
 */
export function resolveCatalogInjection(
  decision: CatalogDecision,
  messages: CatalogMessage[],
  supervisors: Map<string, SupervisorLite>,
  maxEntries = DEFAULT_CATALOG_MAX_ENTRIES,
  cache?: CatalogCache,
  agent?: CatalogAgent
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
  const catalog = history.published ? renderMcpCatalogUpdate(entries) : renderMcpCatalogMessage(entries);
  return {
    kind: "enter",
    messages: existing === undefined ? [...decision.messages, catalog] : decision.messages.map((message) => (message.id === existing.id ? catalog : message)),
  };
}
