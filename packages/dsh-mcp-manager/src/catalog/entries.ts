/**
 * dsh-mcp-manager — catalog/entries.ts：能力目录条目与渲染（#664 阶段 5）。
 *
 * 自 src/catalog.ts 拆出（目录条目域）：条目类型/摘要常量/摘要计算/条目组装/
 * 消息渲染与转义/消息定位读取。digest 与 history 归同域兄弟文件；目录注入决策
 * 归 injection.ts；注入端缓存视图归 cache-view.ts；检索族归 search.ts。
 */

import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../types/interface.ts";
import type { SupervisorLite } from "../types/interface.ts";
import type { CatalogMessage } from "./injection.ts";

/** 目录条目。 */
export interface CatalogEntry {
  name: string;
  text?: string;
  /** 服务器归属（global/project）；用于区分调用引导（#228 双轨迁移）。 */
  scope?: string;
}

/** supervisor 最小面（manager.supervisors 的条目；类型收敛于 types/host-faces.ts，此处 re-export）。 */
export type { SupervisorLite } from "../types/interface.ts";


/** 目录缓存（连接成功时持久化的工具描述摘要）。 */
export type CatalogCache = Map<string, { summary: string }>;

// ------------------------------------------------- 感知增强（对抗性评审 v2）

/** 能力目录默认开启。 */
export const DEFAULT_ANNOUNCE_CATALOG = true;
/** 能力目录最大条目数（防上下文膨胀）。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 6;

/**
 * 能力目录消息的来源身份（#723）：`source.kind` 只能是宿主已登记的通用值
 * `plugin`，本插件的身份由 `source.plugin` 承载。
 *
 * 为什么不再自造 `kind`：宿主 v2→v3 迁移对 surface 消息的 `source.kind` 有一份
 * 封闭白名单（`dsh-session-format-v2-to-v3` 的 `SOURCE_KINDS`），自造值会让升级前
 * 落盘的会话永久无法迁移（原件保留、每次加载同样失败）。官方上下文包
 * （`dsh-time-context` / `dsh-tmux-context`）走的就是 `plugin` + 身份 + snapshot
 * 形态，这里与之一致：形态由宿主校验，身份由本包判定。
 */
export const CATALOG_SOURCE_PLUGIN = "@wingsky-1/dsh-mcp-manager";
/** 目录快照的段名（snapshot 形态下承载渲染后的目录正文）。 */
export const CATALOG_SECTION_NAME = "mcp-catalog";

/** 目录摘要总长上限（字符，含前缀与省略号）：目录注入 ≤6 条目，防远端工具描述
 * 堆叠稀释上下文；截断先于 escapeCatalogText 转义，防不可信输入注入超长文本。 */
export const CATALOG_SUMMARY_MAX_CHARS = 240;
/** 目录摘要单句上限（字符）：无句读语言 / 超长描述的安全截断点。 */
export const CATALOG_SUMMARY_PER_TOOL_CHARS = 120;
/** 目录单条服务器描述上限（字符）：Level 1 发现层防远端超长说明书（如 context7 500 词）
 * 撑爆会话上下文，符合渐进式披露原则。详细使用说明由 ws_mcp_detail / ws_mcp_search 按需承载。 */
export const CATALOG_ENTRY_MAX_CHARS = 180;

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
  const prefix = collected.length >= 2 ? `${collected.length} tools: ` : "";
  // ③ 拼接（"; " 分隔），超总长按句整段回退补 "…"（绝不句中切）。
  let text = prefix;
  for (const sentence of sentences) {
    const separator = text === prefix ? "" : "; ";
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
      const sentence = firstSentenceOf(server.description);
      const raw = sentence !== "" ? sentence : server.description.trim().replace(/\s+/gu, " ");
      text = raw.length <= CATALOG_ENTRY_MAX_CHARS ? raw : `${charTruncate(raw, CATALOG_ENTRY_MAX_CHARS - 1)}…`;
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
    "Project-level servers MUST be accessed via middleware tools: search with `ws_mcp_search`, verify schema with `ws_mcp_detail` if uncertain, then invoke with `ws_mcp_call` (use `ws_mcp_list` for full inventory audits). **Do NOT invoke project-level servers using mcp__ prefixed tools directly**.";
  const globalGuidance =
    mode === "all"
      ? "Global servers are also accessed via middleware in all mode: search with `ws_mcp_search`, then invoke with `ws_mcp_call` using the same `ws_mcp_*` suite."
      : "Global servers are directly invoked using `mcp__<server>__<tool>` prefixed tools (project mode does not route global servers through middleware).";
  const guidance = hasProject
    ? `${projectGuidance} ${globalGuidance}`
    : mode === "all"
      ? globalGuidance
      : `When a task matches a server's capability, call its \`mcp__<server>__<tool>\` tool directly (see tool list for parameters). ${globalGuidance}`;
  const lines = [
    "<system-reminder>",
    "Configured MCP servers in this session (**capability descriptions only, does not reflect active connection status**; tools register once connected via GUI \"MCP\" popup):",
    "",
    "<available_mcp_servers>",
    ...entries.map((entry) => (entry.text === undefined ? `- \`${entry.name}\`` : `- \`${entry.name}\`: ${escapeCatalogText(entry.text)}`)),
    "</available_mcp_servers>",
    "",
    guidance,
    "If a server was available but is now disconnected, do not retry the same tool more than twice. Switch to an alternative method or ask the user to check the \"MCP\" popup.",
    "</system-reminder>",
  ].join("\n");
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: lines }],
    source: {
      kind: "plugin",
      plugin: CATALOG_SOURCE_PLUGIN,
      form: "snapshot",
      sections: [{ name: CATALOG_SECTION_NAME, text: lines }],
    },
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

/** 是否为本插件注入的能力目录消息（新旧两代 source 形态都认，#723 跨版本兼容）。 */
export function isCatalogSource(source: { kind?: unknown; plugin?: unknown } | undefined): boolean {
  if (source === undefined) return false;
  if (source.kind === "mcp-catalog") return true;
  return source.kind === "plugin" && source.plugin === CATALOG_SOURCE_PLUGIN;
}

/** 从消息列表里定位既有的能力目录消息（新旧两代 source 形态都认）。 */
export function findCatalogMessage(messages: CatalogMessage[]): CatalogMessage | undefined {
  for (const message of messages) {
    if (isCatalogSource(message?.source)) return message;
  }
  return undefined;
}

/**
 * 取回一条目录消息所发布的条目。
 *
 * 新旧两代形态（#723）：
 * - 旧形态 `{ kind: "mcp-catalog", form: "catalog", entries }`：逐条还原条目，
 *   digest 与升级前完全一致；
 * - 新形态 `{ kind: "plugin", form: "snapshot", sections: [{ name, text }] }`：
 *   从快照正文的 `<available_mcp_servers>` 块还原条目（格式化是单射的），使
 *   digest 与 `composeCatalogEntries` 的条目 digest 同口径——否则每次启动都会
 *   误判"目录已变"而注入一条修正帧。
 *
 * 坏数据返回 undefined（按"不是本插件的目录"处理）：本函数在 step 监听器里被调用，
 * 抛错会让该会话每一轮都失败。
 */
export function resolveCatalogEntries(source: CatalogSourceLike | undefined): CatalogEntry[] | undefined {
  if (!isCatalogSource(source)) return undefined;
  if (source?.kind === "plugin") {
    const sections = source.sections;
    if (!Array.isArray(sections)) return undefined;
    const section = sections.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { name?: unknown }).name === CATALOG_SECTION_NAME &&
        typeof (candidate as { text?: unknown }).text === "string",
    ) as { text: string } | undefined;
    if (section === undefined) return undefined;
    return parseCatalogBody(section.text);
  }
  const entries = source?.entries;
  if (!Array.isArray(entries)) return undefined;
  const readable: CatalogEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { name, text } = entry as { name?: unknown; text?: unknown };
    if (typeof name !== "string" || name === "") return undefined;
    readable.push({ name, text: typeof text === "string" ? text : undefined });
  }
  return readable;
}

/** 还原渲染时的反转义（escapeCatalogText 的逆；`&amp;` 最后解，避免二次解码）。 */
function unescapeCatalogText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * 从目录快照正文解析条目：格式化是单射的（`- \`name\`` 或 `- \`name\`: text`），
 * 解析失败按"不是本插件的目录"返回 undefined。
 */
function parseCatalogBody(body: string): CatalogEntry[] | undefined {
  const lines = body.split("\n");
  const start = lines.indexOf("<available_mcp_servers>");
  if (start < 0) return undefined;
  const end = lines.indexOf("</available_mcp_servers>", start + 1);
  if (end < 0) return undefined;
  const entries: CatalogEntry[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = /^- `([^`]+)`(?:: (.*))?$/u.exec(line);
    if (match === null) return undefined;
    entries.push(match[2] === undefined ? { name: match[1] } : { name: match[1], text: unescapeCatalogText(match[2]) });
  }
  return entries;
}

/**
 * 防御性读取目录 source 里的条目（坏数据返回 undefined）。
 *
 * 保留旧签名与旧语义（只读已发布形态的 `entries`）：它是包导出面与既有单测的契约，
 * 新形态的读取走 {@link resolveCatalogEntries}。
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

/** 目录 source 最小面（新旧两代形态；判定见 {@link isCatalogSource}）。 */
export interface CatalogSourceLike {
  kind?: unknown;
  plugin?: unknown;
  entries?: unknown;
  sections?: unknown;
}

/** 渲染"目录更新"消息（历史旧目录无法删除，新消息声明作废——与 tool-skill 同语义）。 */
export function renderMcpCatalogUpdate(entries: CatalogEntry[], mode?: string): CatalogMessage {
  const body = renderMcpCatalogMessage(entries, mode);
  const inner = body.content![0].text!.split("\n").slice(3).join("\n");
  const text = [
    "<system-reminder>",
    "MCP server configuration has changed. **This catalog replaces all previous available_mcp_servers lists**:",
    "",
    inner,
    "</system-reminder>",
  ].join("\n");
  return { ...body, content: [{ type: "text", text }] };
}