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
import { dshHome } from "../../../shared/dsh-home.js";
import type { ServerConfig } from "./types.ts";

/** 目录条目。 */
export interface CatalogEntry {
  name: string;
  text?: string;
  /** 服务器归属（global/project）；用于区分调用引导（#228 双轨迁移）。 */
  scope?: string;
}

/** supervisor 最小面（manager.supervisors 的条目）。 */
export interface SupervisorLite {
  server: ServerConfig;
  /** 服务器归属（global/project）；目录条目携带用于调用引导（#228）。 */
  scope?: string;
}

/** 目录缓存（连接成功时持久化的工具描述摘要）。 */
export type CatalogCache = Map<string, { summary: string }>;

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

// ------------------------------------------------- 感知增强（对抗性评审 v2）

/** 能力目录默认开启。 */
export const DEFAULT_ANNOUNCE_CATALOG = true;
/** 能力目录最大条目数（防上下文膨胀）。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 6;

// ------------------------------------------------- 目录缓存（L1 数据源）

/** 目录缓存文件（连接成功时把工具描述摘要持久化于此；目录 digest 的稳定数据源）。 */
export function catalogCacheFile() {
  return join(dshHome(), "dsh-mcp-catalog.json");
}

/** 目录摘要总长上限（字符，含前缀与省略号）：目录注入 ≤6 条目，防远端工具描述
 * 堆叠稀释上下文；截断先于 escapeCatalogText 转义，防不可信输入注入超长文本。 */
export const CATALOG_SUMMARY_MAX_CHARS = 240;
/** 目录摘要单句上限（字符）：无句读语言 / 超长描述的安全截断点。 */
export const CATALOG_SUMMARY_PER_TOOL_CHARS = 120;

/**
 * 从工具描述集合计算目录摘要（每工具取首句，按工具名升序 + 精确去重后拼接）。
 *
 * 为什么不再「排序取第一条」（#569）：tavily 等服务器的字典序第一条是次要工具
 * （tavily_crawl），会把搜索服务器描述成爬虫、误导模型。改为每工具贡献首句：
 * - 排序（按工具名而非描述）保证工具列表顺序/描述空白抖动时摘要稳定（重连不触发
 *   缓存更新 → digest 不变）；
 * - 首句提取（firstSentenceOf）防 "1." 编号 / URL / 缩写误切；多字节按字符截断；
 * - 总长与单句均有上限：目录摘要的用途是让模型判断「该不该调这个服务器」，过长
 *   描述（含远端不可信输入）反而稀释上下文；完整能力清单由 ws_mcp_list /
 *   工具注册表承担，不塞进目录。
 */
export function summarizeToolDescriptions(toolMeta: Map<string, { description?: unknown }>): string | undefined {
  // ① 收集 (工具名, 首句)（非空）；全空 → undefined。
  const collected: Array<[string, string]> = [];
  for (const [name, meta] of toolMeta) {
    const sentence = firstSentenceOf(meta?.description);
    if (sentence === "") continue;
    collected.push([name, sentence]);
  }
  if (collected.length === 0) return undefined;
  // ② 按工具名升序（确定性：顺序抖动只变内容不变名序）→ 精确去重。
  collected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const [, sentence] of collected) {
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    sentences.push(sentence.length <= CATALOG_SUMMARY_PER_TOOL_CHARS
      ? sentence
      : `${charTruncate(sentence, CATALOG_SUMMARY_PER_TOOL_CHARS - 1)}…`);
  }
  const prefix = collected.length >= 2 ? `共 ${collected.length} 个工具：` : "";
  // ③ 拼接（"；" 分隔），超总长按句整段回退补 "…"（绝不句中切）。
  let text = prefix;
  for (const sentence of sentences) {
    const separator = text === prefix ? "" : "；";
    if (text.length + separator.length + sentence.length <= CATALOG_SUMMARY_MAX_CHARS - 1) {
      text += separator + sentence;
    } else if (text === prefix) {
      // 前缀后连一句都放不下（极端长句）→ 前缀 + 截断 + 省略号。
      return `${prefix}${charTruncate(sentence, CATALOG_SUMMARY_MAX_CHARS - prefix.length - 1)}…`;
    } else {
      // 已容纳若干句 → 保留完整句，尾部补省略号表示还有更多工具。
      return `${text}…`;
    }
  }
  return text;
}

/** 取描述首行的首个完整句（MCP 描述惯例：首行即概要；多行 docstring 的参数
 * 说明留给工具详情/ws_mcp_detail，不进目录摘要）。
 * 句界判定防误切："1." 编号/版本/小数（句读前置数字）、URL / e.g. 缩写（句读后
 * 须空白 + 大写字母/汉字才算新句）；无句读 → 整行返回。
 * @returns 首句；空输入 → ""。 */
function firstSentenceOf(description: unknown): string {
  const raw = typeof description === "string" ? description : "";
  if (raw.trim() === "") return "";
  const firstLine = raw.split(/\r?\n/u)[0] ?? "";
  const text = firstLine.replace(/\s+/gu, " ").trim();
  if (text === "") return "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "。" && ch !== "！" && ch !== "？") continue;
    if (index > 0 && text[index - 1] >= "0" && text[index - 1] <= "9") continue;
    let next = index + 1;
    while (next < text.length && /\s/u.test(text[next])) next += 1;
    if (next >= text.length) return text; // 句读收尾（"…URL."）→ 整行即句，不剥标点
    if (/[A-Za-z\u4e00-\u9fff]/u.test(text[next])) return text.slice(0, index + 1); // 句读后随大写/汉字 → 新句
  }
  return text;
}

/** 按 Unicode 字符截断（防切代理对/emoji；JS length 为 UTF-16 码元）。 */
function charTruncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return [...text].slice(0, maxChars).join("");
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
    const scope = typeof supervisor.scope === "string" ? supervisor.scope : undefined;
    const entry: CatalogEntry = { name };
    if (text !== undefined) entry.text = text;
    if (scope !== undefined) entry.scope = scope;
    entries.push(entry);
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

/** 渲染能力目录消息（source 标记供定位替换）。
 * 按条目 scope 区分调用引导（#228 双轨迁移）：
 * - 含 project 条目 → 引导经 ws_mcp_list/ws_mcp_search/ws_mcp_detail/ws_mcp_call
 *   （项目级走中间层；完整盘点用 ws_mcp_list，查完整 schema 用 ws_mcp_detail）；
 * - 仅 global 条目 → 默认保持 mcp__ 直呼引导（全局服务器不经中间层检索）；
 *   all 模式（mode === "all"）下全局也走中间层 → 同样引导经中间层工具访问。
 * 口径统一（#362 评审修正）：project 模式全局服务器仍以 mcp__ 直呼注册可用，
 * 目录引导区分「经中间层访问」与「mcp__ 直呼」两类服务器，不混用。
 */
export function renderMcpCatalogMessage(entries: CatalogEntry[], mode?: string): CatalogMessage {
  const hasProject = entries.some((entry) => entry.scope === "project");
  const projectGuidance =
    "项目级服务器一律经中间层工具访问：先用 `ws_mcp_search` 检索当前工作空间的 MCP 工具，再用 `ws_mcp_call` 调用（server/tool 取自检索结果；完整盘点全部服务器与工具清单用 `ws_mcp_list`，查单个工具的完整 inputSchema 用 `ws_mcp_detail`）。**项目级服务器不直接调用其 mcp__ 前缀工具**。";
  const globalGuidance =
    mode === "all"
      ? "全局服务器同样经中间层访问（all 模式全局不注册 mcp__ 工具）：先用 `ws_mcp_search` 检索，再经 `ws_mcp_call` 调用，与项目级同一套 `ws_mcp_*` 工具。"
      : "全局服务器仍以 `mcp__<server>__<tool>` 前缀工具直呼调用（project 模式全局不经中间层检索）。";
  const guidance = hasProject
    ? `${projectGuidance}${globalGuidance}`
    : mode === "all"
      ? globalGuidance
      : `任务匹配某服务器能力时，直接调用其 \`mcp__<server>__<tool>\` 工具（具体工具名与参数见工具列表）。${globalGuidance}`;
  const lines = [
    "<system-reminder>",
    "本会话已配置以下 MCP 服务器（**仅描述能力，不代表当前连接状态**；服务器在 GUI「MCP」浮窗中连接后，其工具才会注册可用）：",
    "",
    "<available_mcp_servers>",
    ...entries.map((entry) => (entry.text === undefined ? `- \`${entry.name}\`` : `- \`${entry.name}\`: ${escapeCatalogText(entry.text)}`)),
    "</available_mcp_servers>",
    "",
    guidance,
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

/** 渲染"目录更新"消息（历史旧目录无法删除，新消息声明作废——与 tool-skill 同语义）。 */
export function renderMcpCatalogUpdate(entries: CatalogEntry[], mode?: string): CatalogMessage {
  const body = renderMcpCatalogMessage(entries, mode);
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
