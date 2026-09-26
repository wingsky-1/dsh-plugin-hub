/**
 * dsh-mcp-manager — catalog/search.ts：能力目录检索函数族（#664 阶段 5）。
 *
 * 自 src/middleware-utils.ts 迁出（catalog 域检索族）：打分/单/多单元检索/
 * 完整盘点/单工具详情/新鲜判定/装箱。工具级禁用裁决（isToolDenied 等）与
 * globMatch 归 pipeline（authorize 块）。B10 截断事实
 * 口径随迁保持「恰好命中 limit 不误报」。
 */

import { MIDDLEWARE_GLOBAL_ROOT } from "../../shared/interface.ts";
import { LIST_DEFAULT_TOOLS_PER_SERVER } from "../shared/interface.ts";
import { catalogDirectory } from "./impl/directory/index.ts";
import { catalogPorts } from "./impl/service/index.ts";
import type {
  CatalogServer,
  CatalogTool,
  ListCatalogResult,
  ListServerEntry,
  ListToolEntry,
  SearchHit,
  ToolDetail,
} from "./interface.ts";
import type { ProjectUnit } from "../connection/interface.ts";
import type { DisabledToolsMap } from "../store/interface.ts";

/** 简单分词（英文小写 + 中文保留）。 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const words = lowered.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
  return words;
}

/** 跨字段打分：query 词命中 server 名 / 工具名 / description / 参数名。
 * 中文（无空格分词）：query 连续中文串在原始描述中 substring 匹配即可命中
 * （修复：原实现把连续中文当单个 token，中文召回率接近零）。 */
export function scoreTool(
  query: string,
  server: string,
  toolName: string,
  tool: CatalogTool,
): { score: number; matchedTerms: string[] } {
  if (query === "") return { score: 0, matchedTerms: [] };
  const haystack = [
    server,
    toolName,
    tool.description,
    JSON.stringify(Object.keys(tool.inputSchema ?? {})),
  ]
    .join(" ")
    .toLowerCase();
  // 中文子串匹配优先（连续中文段直接 substring 命中原始文本）
  const cjkQuery = query.match(/[\u4e00-\u9fff]+/gu) ?? [];
  if (cjkQuery.length > 0) {
    const cjk = scoreCjkSegments(cjkQuery, haystack);
    if (cjk !== undefined) return cjk;
  }
  const terms = tokenize(query);
  if (terms.length === 0) return { score: 0, matchedTerms: [] };
  return scoreTerms(terms, haystack);
}

/** 连续中文段命中原始文本即计 2 分（≥2 字才算命中）；一个都没命中返回 undefined
 * ——让调用方回落分词打分（中文 query 同时含英文词时两路都试）。 */
export function scoreCjkSegments(
  segments: string[],
  haystack: string,
): { score: number; matchedTerms: string[] } | undefined {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const segment of segments) {
    if (segment.length < 2) continue;
    if (haystack.includes(segment)) {
      score += 2;
      matchedTerms.push(segment);
    }
  }
  return score > 0 ? { score, matchedTerms } : undefined;
}

/** 词元命中原始文本即计 1 分（≥2 字才算命中，单字词元不计）。 */
export function scoreTerms(
  terms: string[],
  haystack: string,
): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    if (haystack.includes(term)) {
      score += 1;
      matchedTerms.push(term);
    }
  }
  return { score, matchedTerms };
}

/** 检索目录：query 为空 → 能力摘要表（每服务器前 N 个工具）。
 * 单 root 实现（searchCatalogMulti 循环调用；兼容既有测试）。
 * truncated：任一服务器存在被 limit 裁掉的结果即 true（B10 截断事实，
 * 供调用方精确标注「是否因 limit 裁掉」——恰好命中 limit 不误报）。 */
export function searchCatalog(
  units: Map<string, ProjectUnit>,
  root: string,
  query: string,
  limit: number,
): {
  results: SearchHit[];
  unavailable: Array<{ server: string; reason: string }>;
  truncated: boolean;
} {
  const {
    connection: { CATALOG_TTL_MS },
    workspace: { fullServerName },
  } = catalogPorts.get();
  if (!units.has(root)) return { results: [], unavailable: [], truncated: false };
  const servers = catalogDirectory.serversFor(root);
  if (servers === undefined) return { results: [], unavailable: [], truncated: false };
  const results: SearchHit[] = [];
  const unavailable: Array<{ server: string; reason: string }> = [];
  let truncated = false;
  for (const [serverName, catalog] of servers) {
    if (catalog.unavailable !== undefined) {
      unavailable.push({ server: fullServerName(root, serverName), reason: catalog.unavailable });
      continue;
    }
    const fresh = Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS;
    const scored: Array<{
      server: string;
      toolName: string;
      tool: CatalogTool;
      score: number;
      matchedTerms: string[];
    }> = [];
    for (const [toolName, tool] of catalog.tools) {
      const { score, matchedTerms } = scoreTool(query, serverName, toolName, tool);
      if (query !== "" && score === 0) continue;
      scored.push({ server: serverName, toolName, tool, score, matchedTerms });
    }
    scored.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));
    if (scored.length > limit) truncated = true;
    for (const hit of scored.slice(0, limit)) {
      results.push({
        server: fullServerName(root, hit.server),
        tool: hit.toolName,
        description: hit.tool.description,
        inputSchema: hit.tool.inputSchema,
        score: hit.score,
        matchedTerms: hit.matchedTerms,
        fresh,
      });
    }
  }
  return { results, unavailable, truncated };
}

/** 多单元合并检索（项目 root 单元 + @global 单元合并查询）。
 * 与 searchCatalog 同语义，仅数据源扩展为多个 root。
 * 单 root 直接委托 searchCatalog（保持原顺序，不引入跨单元排序变化）；
 * 多 root 合并后统一排序并按全局 limit 截断（truncated=合并后曾有超限结果）。 */
export function searchCatalogMulti(
  units: Map<string, ProjectUnit>,
  roots: readonly string[],
  query: string,
  limit: number,
): {
  results: SearchHit[];
  unavailable: Array<{ server: string; reason: string }>;
  truncated: boolean;
} {
  if (roots.length === 1) {
    return searchCatalog(units, roots[0] as string, query, limit);
  }
  const results: SearchHit[] = [];
  const unavailable: Array<{ server: string; reason: string }> = [];
  for (const root of roots) {
    const single = searchCatalog(units, root, query, limit);
    results.push(...single.results);
    unavailable.push(...single.unavailable);
  }
  // 跨单元排序（评分降序，工具名升序）——与单单元检索同序。
  results.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));
  // 合并后统一截断（limit 为全局上限，而非每 root 上限）；截断事实供调用方标注。
  const truncated = results.length > limit;
  return { results: results.slice(0, limit), unavailable, truncated };
}

/** 构建单服务器工具条目（含禁用标注与截断）：回答「这台服务器列出哪些工具？」——
 * 逐工具裁禁用（本 root 段 + @global 段并集命中即标注）+ perServerLimit 截断；
 * 盘点范围解析与跨单元排序在 listCatalog 内（不同问题）。
 *
 * 条件赋值而非 `disabled: x || undefined`——显式 undefined 键会被宿主
 * lossless JSON 输出校验（dsh-util-values walkJsonValue）判非法
 * （#381：ws_mcp_list 报 "value is not lossless JSON"）。
 */
function buildListToolEntries(
  tools: Map<string, CatalogTool>,
  safeLimit: number,
  disabledTools: DisabledToolsMap | undefined,
  root: string,
  serverName: string,
): { entries: ListToolEntry[]; truncated: boolean } {
  const entries: ListToolEntry[] = [];
  let truncated = false;
  let index = 0;
  for (const [toolName, tool] of tools) {
    if (index >= safeLimit) {
      truncated = true;
      break;
    }
    const toolEntry: ListToolEntry = { tool: toolName, description: tool.description };
    if (isToolDisabledForEntry(disabledTools, root, serverName, toolName))
      toolEntry.disabled = true;
    entries.push(toolEntry);
    index += 1;
  }
  return { entries, truncated };
}

/** 工具级禁用标注判定（本 root 段 + @global 段并集命中即禁用；@global 自身不重复继承）。 */
export function isToolDisabledForEntry(
  disabledTools: DisabledToolsMap | undefined,
  root: string,
  serverName: string,
  toolName: string,
): boolean {
  if (disabledTools?.get(root)?.get(serverName)?.has(toolName) === true) return true;
  if (root === MIDDLEWARE_GLOBAL_ROOT) return false;
  return disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(serverName)?.has(toolName) === true;
}

/** 解析盘点范围：回答「哪些 root 参与盘点？」——@全名过滤定 root，root 越界抛
 * 路由一致性错误（与 ws_mcp_call 口径一致）；无过滤时全 root 参与。
 * 工具条目构建与排序在 listCatalog 内（不同问题）。 */
function resolveListRoots(
  roots: readonly string[],
  serverFilter: string | undefined,
): Set<string> | undefined {
  if (serverFilter !== undefined && serverFilter.startsWith("@")) {
    const {
      workspace: { parseFullServerName },
    } = catalogPorts.get();
    const parsed = parseFullServerName(serverFilter);
    if (parsed === undefined || !roots.includes(parsed.root)) {
      throw new Error(
        `ws_mcp_list: server ${JSON.stringify(serverFilter)} 不属于当前工作空间（${JSON.stringify(roots)}）；路由一致性校验失败（防跨空间串台）`,
      );
    }
    return new Set([parsed.root]);
  }
  return undefined;
}

/**
 * 完整盘点：列出当前工作空间全部服务器 + 每台完整工具清单（不受关键词/limit
 * 截断服务器，工具数受 perServerLimit 保护）。
 * @param units 连接池单元集合。
 * @param roots 参与盘点的 root 列表（当前项目 root + @global）。
 * @param serverFilter 可选：@<root>/<server> 全名或裸名过滤。
 * @param toolLimit 每服务器工具条数上限（>0；超过置 toolsTruncated）。
 * @param emptyHint 空返回时的 message。
 * @param disabledTools 用户工具级禁用映射（root → server → Set<tool>）；
 *    命中条目在工具行标注禁用（供模型感知）。
 * @throws 全名 root 不属于当前 roots → 路由一致性错误（与 ws_mcp_call 口径一致）。
 */
export function listCatalog(
  units: Map<string, ProjectUnit>,
  roots: readonly string[],
  serverFilter: string | undefined,
  toolLimit: number,
  emptyHint: string,
  disabledTools?: DisabledToolsMap,
): ListCatalogResult {
  const {
    workspace: { fullServerName },
  } = catalogPorts.get();
  const safeLimit = safeToolLimit(toolLimit);
  const rootSet = resolveListRoots(roots, serverFilter);
  const servers: ListServerEntry[] = [];
  let totalTools = 0;
  let anyTruncated = false;
  for (const root of roots) {
    if (!rootParticipates(root, rootSet)) continue;
    const unit = units.get(root);
    if (unit === undefined) continue;
    const rootCatalog = catalogDirectory.serversFor(root);
    if (rootCatalog === undefined) continue;
    for (const [serverName, catalog] of rootCatalog) {
      if (!matchesServerFilter(serverName, root, serverFilter, fullServerName)) continue;
      const built = buildListServerEntry(
        serverName,
        root,
        catalog,
        unit.userDisabled,
        safeLimit,
        disabledTools,
        fullServerName,
      );
      servers.push(built.entry);
      if (built.truncated) anyTruncated = true;
      totalTools += built.toolCount;
    }
  }
  return finalizeListResult(servers, roots, totalTools, anyTruncated, emptyHint);
}

/** 每服务器工具条数上限：非有限数或非正回落缺省；正数向下取整（历史口径）。 */
export function safeToolLimit(toolLimit: number): number {
  if (!Number.isFinite(toolLimit) || toolLimit <= 0) return LIST_DEFAULT_TOOLS_PER_SERVER;
  return Math.floor(toolLimit);
}

/** 该 root 是否参与盘点：显式过滤集命中即参与，无过滤集则全参与。 */
export function rootParticipates(root: string, rootSet: Set<string> | undefined): boolean {
  return rootSet === undefined || rootSet.has(root);
}

/** 盘点过滤：serverFilter 为空即全收；给定后裸名或 @全名任一命中即收。 */
export function matchesServerFilter(
  serverName: string,
  root: string,
  serverFilter: string | undefined,
  fullServerName: (root: string, server: string) => string,
): boolean {
  if (serverFilter === undefined) return true;
  return serverName === serverFilter || fullServerName(root, serverName) === serverFilter;
}

/** 单台服务器的盘点条目：用户禁用标注 + 目录失败原因，或工具清单（含截断与工具数结算）。 */
export function buildListServerEntry(
  serverName: string,
  root: string,
  catalog: CatalogServer,
  userDisabled: ReadonlySet<string>,
  safeLimit: number,
  disabledTools: DisabledToolsMap | undefined,
  fullServerName: (root: string, server: string) => string,
): { entry: ListServerEntry; truncated: boolean; toolCount: number } {
  const entry: ListServerEntry = {
    server: fullServerName(root, serverName),
    tools: [],
    toolsTruncated: false,
  };
  if (userDisabled.has(serverName)) entry.disabled = true;
  if (catalog.unavailable !== undefined) {
    entry.unavailable = catalog.unavailable;
    return { entry, truncated: false, toolCount: 0 };
  }
  const built = buildListToolEntries(catalog.tools, safeLimit, disabledTools, root, serverName);
  entry.tools = built.entries;
  entry.toolsTruncated = built.truncated;
  return { entry, truncated: built.truncated, toolCount: built.entries.length };
}

/** 定序组装盘点结果：回答「结果按什么顺序摆？」——稳定排序（root 出现序 +
 * 服务器名，跨单元合并不依赖 Map 插入序）+ 空结果提示；范围与条目构建在
 * listCatalog 内（不同问题）。 */
function finalizeListResult(
  servers: ListServerEntry[],
  roots: readonly string[],
  totalTools: number,
  anyTruncated: boolean,
  emptyHint: string,
): ListCatalogResult {
  const {
    workspace: { parseFullServerName },
  } = catalogPorts.get();
  const rootIndex = new Map(roots.map((root, index) => [root, index]));
  servers.sort(listOrderComparator(rootIndex, parseFullServerName));
  const result: ListCatalogResult = {
    workspace: roots[0] ?? "@global",
    servers,
    totalServers: servers.length,
    totalTools,
    toolsTruncated: anyTruncated,
  };
  if (servers.length === 0) result.message = emptyHint;
  return result;
}

/** 盘点定序比较器：root 出现序优先（不在列表里的排后），同 root 内按裸名升序。 */
export function listOrderComparator(
  rootIndex: ReadonlyMap<string, number>,
  parseFullServerName: (full: string) => { root: string; server: string } | undefined,
): (a: ListServerEntry, b: ListServerEntry) => number {
  return (a, b) => {
    const keyA = listOrderKey(a, rootIndex, parseFullServerName);
    const keyB = listOrderKey(b, rootIndex, parseFullServerName);
    if (keyA.rootOrder !== keyB.rootOrder) return keyA.rootOrder - keyB.rootOrder;
    return keyA.server.localeCompare(keyB.server);
  };
}

/** 条目排序键两格：root 出现序（不在 roots 列表里的排到末尾）+ root 内裸名。 */
export function listOrderKey(
  entry: ListServerEntry,
  rootIndex: ReadonlyMap<string, number>,
  parseFullServerName: (full: string) => { root: string; server: string } | undefined,
): { rootOrder: number; server: string } {
  const parsed = parseFullServerName(entry.server);
  return {
    rootOrder: rootIndex.get(parsed?.root ?? "") ?? Number.MAX_SAFE_INTEGER,
    server: parsed?.server ?? entry.server,
  };
}

/**
 * 单工具详情：按 @<root>/<server> + tool 裸名精确命中，返回完整 inputSchema。
 * 错误三分：
 * 1. server 发现失败（catalog.unavailable）→ 附原因；
 * 2. 单元/服务器未发现 → 「server 未连接或未发现」；
 * 3. 工具不存在 → 「tool 不存在」。
 * @param units 连接池单元集合。
 * @param root 目标 root（可为 @global）。
 * @param server @<root>/<server> 全名。
 * @param tool 远端工具裸名（兼容 mcp__ 前缀，复用 normalizeToolName）。
 */
export function findToolDetail(
  units: Map<string, ProjectUnit>,
  root: string,
  server: string,
  tool: string,
): ToolDetail {
  const {
    connection: { CATALOG_TTL_MS },
    workspace: { parseFullServerName, normalizeToolName },
  } = catalogPorts.get();
  const parsed = parseFullServerName(server);
  if (parsed === undefined || parsed.root !== root) {
    throw new Error(
      `ws_mcp_detail: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
    );
  }
  const unit = units.get(root);
  if (unit === undefined) {
    throw new Error(`ws_mcp_detail: server 未连接或未发现：${JSON.stringify(server)}`);
  }
  const catalog = catalogDirectory.entryFor(root, parsed.server);
  if (catalog === undefined || catalog.tools.size === 0) {
    throw toolDetailMissError(catalog, server, unit.userDisabled.has(parsed.server));
  }
  const toolName = normalizeToolName(parsed.server, tool, "ws_mcp_detail");
  const found = catalog.tools.get(toolName);
  if (found === undefined) {
    throw new Error(`ws_mcp_detail: tool 不存在：${JSON.stringify(`${server}/${toolName}`)}`);
  }
  const fresh = Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS;
  const detail: ToolDetail = {
    server,
    tool: toolName,
    description: found.description,
    inputSchema: found.inputSchema,
    fresh,
  };
  if (unit.userDisabled.has(parsed.server)) detail.disabled = true;
  return detail;
}

/** 目录里没有可用工具时的错误三分：发现失败（附原因）> 用户禁用（附说明）> 未连接。 */
export function toolDetailMissError(
  catalog: CatalogServer | undefined,
  server: string,
  userDisabled: boolean,
): Error {
  if (catalog?.unavailable !== undefined) {
    return new Error(
      `ws_mcp_detail: server 发现失败：${JSON.stringify(server)}（${catalog.unavailable}）`,
    );
  }
  if (userDisabled) {
    return new Error(
      `ws_mcp_detail: server 未连接或未发现：${JSON.stringify(server)}（已被用户禁用）`,
    );
  }
  return new Error(`ws_mcp_detail: server 未连接或未发现：${JSON.stringify(server)}`);
}
// 两个纯函数（新鲜判定 / 装箱）自 #767 S1-3b 起物理落点在 impl/directory：
// 目录投影本体要用它们，而本文件要用目录读口——留在本文件会形成文件级值环。
// 公开导出面不变（仍经 catalog/interface.ts 从本文件转出）。
export { boundCatalogTools, isCatalogFresh } from "./impl/directory/index.ts";
