/**
 * dsh-mcp-manager — 中间层纯函数（命名 / 容错 / 脱敏 / 策略 / 目录检索）。
 *
 * 全部为无副作用纯函数（withTimeout 亦不依赖连接池），类型自 middleware-types.
 * ts 取；被连接池类、工具注册与 manager 共享。
 */

import { CATALOG_TTL_MS, LIST_DEFAULT_TOOLS_PER_SERVER } from "./middleware-const.ts";
import type {
  CatalogTool,
  ListCatalogResult,
  ListServerEntry,
  ListToolEntry,
  MiddlewarePolicy,
  ProjectUnit,
  SearchHit,
  ToolDetail,
  DisabledToolsMap,
} from "./middleware-types.ts";
import type { ServerConfig } from "./types.ts";

// ------------------------------------------------------------ 命名与容错

/** server 全局唯一名：@<root>/<server>。 */
export function fullServerName(root: string, server: string): string {
  return `@${root}/${server}`;
}

/** 中间层全局虚拟 root（全局服务器经中间层访问时的路由 key；与 manager 常量同值）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";

/** 从持久化载荷解析 disabledTools 三层结构（损坏/缺失 → 空；容错不抛）。 */
export function parseDisabledTools(raw: unknown): DisabledToolsMap {
  const out: DisabledToolsMap = new Map();
  if (typeof raw !== "object" || raw === null) return out;
  for (const [root, servers] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof servers !== "object" || servers === null) continue;
    const serverMap = new Map<string, Set<string>>();
    for (const [server, tools] of Object.entries(servers as Record<string, unknown>)) {
      if (!Array.isArray(tools)) continue;
      const set = new Set<string>(tools.filter((tool): tool is string => typeof tool === "string" && tool !== ""));
      if (set.size > 0) serverMap.set(server, set);
    }
    if (serverMap.size > 0) out.set(root, serverMap);
  }
  return out;
}

/** 解析 @<root>/<server> 全名 → { root, server }；非法返回 undefined。
 * root 是绝对路径（以 / 开头），故从最后一个 `/` 分割（server 名不含 `/`）。
 * 特殊形态兼容：`@global/<server>`（单 @，人类/文档/A2 指引形态）归一化为
 * root=`@global`（MIDDLEWARE_GLOBAL_ROOT）；`@@global/<server>`（双 @，内部
 * fullServerName 产物）同样归一化为 `@global`——两种输入等价，杜绝「单 @ 被
 * 路由拒绝、双 @ 放行」的语义分裂（隔离验证 P0 发现，smoke 双 @ 掩盖单 @ 被拒）。 */
export function parseFullServerName(name: string): { root: string; server: string } | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.lastIndexOf("/");
  if (slash <= 1 || slash === name.length - 1) return undefined;
  const rawRoot = name.slice(1, slash);
  // @global/<s> → rawRoot="global"；@@global/<s> → rawRoot="@global"。
  const root = rawRoot === "global" || rawRoot === "@global" ? MIDDLEWARE_GLOBAL_ROOT : rawRoot;
  return { root, server: name.slice(slash + 1) };
}

/** 归一化中间层工具的 tool 参数（模型可能传 mcp__<server>__<tool> 全名）。
 * @param caller 调用方工具名（错误文案前缀；ws_mcp_call / ws_mcp_detail 复用）。 */
export function normalizeToolName(serverName: string, toolName: string, caller = "ws_mcp_call"): string {
  const prefix = `mcp__${serverName}__`;
  let name = toolName;
  if (name.startsWith("mcp__")) {
    while (name.startsWith(prefix)) name = name.slice(prefix.length);
    if (name.startsWith("mcp__")) {
      throw new Error(
        `${caller}: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名`,
      );
    }
  }
  return name;
}

/** 归一化 ws_mcp_call 的 arguments 参数（模型可能把参数字典填成 JSON 字符串）。 */
export function normalizeArguments(raw: unknown): unknown {
  let value: unknown = raw ?? {};
  let depth = 0;
  while (typeof value === "string" && depth < 4) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    const head = trimmed.charCodeAt(0);
    const isContainerJson = head === 123 /* { */ || head === 91 /* [ */;
    const isQuotedJson = head === 34 /* " */;
    if (!isContainerJson && !isQuotedJson) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }
    if (parsed !== null && typeof parsed === "object") return parsed;
    const inner = typeof parsed === "string" ? parsed.trim() : "";
    const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
    if (!isQuotedJson || !innerLooksContainer) break;
    value = parsed;
    depth += 1;
  }
  return value;
}

/** 统一错误提取（Error/string/object 三态）。 */
export function msgOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 凭据脱敏器：从服务器配置收集 secret 值，替换错误消息中的出现。 */
export function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      for (const value of Object.values(server.env ?? {})) if (value.length > 0) secrets.add(value);
      const args = server.args ?? [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? "";
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (!/(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)) continue;
        const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
        if (value !== undefined && value.length > 0) secrets.add(value);
      }
      continue;
    }
    for (const value of Object.values(server.headers ?? {})) if (value.length > 0) secrets.add(value);
    const url = server.url;
    if (typeof url === "string" && url !== "") {
      secrets.add(url);
      try {
        const parsed = new URL(url);
        if (parsed.username.length > 0) secrets.add(parsed.username);
        if (parsed.password.length > 0) secrets.add(parsed.password);
        for (const value of parsed.searchParams.values()) if (value.length > 0) secrets.add(value);
      } catch {
        // 非法 URL 忽略
      }
    }
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return (error: unknown): string => {
    let text: string;
    try {
      text = error instanceof Error ? error.message : String(error);
    } catch {
      text = "<unprintable error>";
    }
    for (const secret of ordered) text = text.split(secret).join("[REDACTED]");
    return text;
  };
}

// ------------------------------------------------------------ 策略

/** 工具名匹配 glob（* 通配）。 */
export function globMatch(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/** 策略裁决：deny 优先。serverKey 支持全名（@root/server）或裸名——全名优先匹配（工作空间隔离），未命中回落裸名。返回 true = 允许。 */
export function policyAllows(policy: MiddlewarePolicy | undefined, serverKey: string, tool: string): boolean {
  if (policy === undefined) return true;
  const fullDeny = policy.denyTools?.[serverKey];
  if (fullDeny !== undefined && fullDeny.some((pattern) => globMatch(pattern, tool))) return false;
  const deny = policy.denyTools?.[bareServerName(serverKey)];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) return false;
  const fullAllow = policy.allowTools?.[serverKey];
  if (fullAllow !== undefined && fullAllow.length > 0) {
    return fullAllow.some((pattern) => globMatch(pattern, tool));
  }
  const allow = policy.allowTools?.[bareServerName(serverKey)];
  if (allow === undefined || allow.length === 0) return true;
  return allow.some((pattern) => globMatch(pattern, tool));
}

/** 提取裸名（@root/server → server；无前缀原样返回）。 */
export function bareServerName(name: string): string {
  const parsed = parseFullServerName(name);
  return parsed?.server ?? name;
}

/**
 * 单一裁决：工具是否被用户禁用（工具级禁用，独立于服务器级 enabled）。
 *
 * 三入口统一调用（P0-1）：ws_mcp_call（callTool，先查禁用再查策略）、
 * pre-execute guard（mcp__ 前缀工具）、纪律裸名（dsh-codegraph 侧声明语义）。
 *
 * 语义（P0-2 方案 A，零耦合）：禁用**只作用于 mcp-manager 管辖的 mcp__ 前缀
 * 工具**；纪律裸名（如 codegraph_explore）不受影响，由 dsh-codegraph 侧（#363）
 * 自行声明。禁用原因文案与浮窗 UI 均需同步声明该语义。
 *
 * 判定（P1 三层结构 + P2 超长名）：
 * 1. 目标 root 直接命中 → 查该 root 记录（project 模式按会话 root 隔离）；
 * 2. 未命中且目标 root 非 @global → 回落 @global 共享记录（全局工具跨工作空间
 *    key=@global；对项目 root 的查询是「该 root 无记录」的探测，永不误禁）；
 * 3. 哈希后缀名（>64 字符或含非法字符）不可逆 → 按「未知 server」处理：
 *    不禁用、不误禁（publicToolName 无法反解出 (server, tool)）。
 *
 * @param disabledTools 禁用映射（root → server → Set<tool>）。
 * @param policy 中间层策略（allowTools/denyTools；工具级禁用之外的第二道闸，
 *    仅 ws_mcp_call 路径检查，与既有语义一致）。
 * @param serverKey @<root>/<server> 全名或裸名（策略键；与 policyAllows 同形态）。
 * @param tool 远端工具裸名。
 * @returns true = 拒绝执行（被禁用或策略 deny）。
 */
export function isToolDenied(
  disabledTools: DisabledToolsMap | undefined,
  policy: MiddlewarePolicy | undefined,
  serverKey: string,
  tool: string,
): boolean {
  const parsed = parseFullServerName(serverKey);
  if (parsed !== undefined) {
    const server = parsed.server;
    const set = disabledTools?.get(parsed.root)?.get(server);
    if (set !== undefined && set.size > 0 && set.has(tool)) return true;
    if (parsed.root !== MIDDLEWARE_GLOBAL_ROOT) {
      const globalSet = disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server);
      if (globalSet !== undefined && globalSet.size > 0 && globalSet.has(tool)) return true;
    }
  }
  return !policyAllows(policy, serverKey, tool);
}

/** 策略拒绝原因（供 denialReason 提示）。 */
export function policyDenialReason(policy: MiddlewarePolicy | undefined, serverKey: string, tool: string): string | undefined {
  if (policyAllows(policy, serverKey, tool)) return undefined;
  const deny = policy?.denyTools?.[serverKey] ?? policy?.denyTools?.[bareServerName(serverKey)];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) {
    return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 被 denyTools 策略拒绝`;
  }
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 不在 allowTools 白名单内，被策略拒绝`;
}

/** 工具级禁用的拒绝原因文案（三入口统一；P0-2 语义声明）。 */
export function toolDisabledReason(serverKey: string, tool: string): string {
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 已被用户在「MCP」浮窗禁用；工具级禁用只作用于 mcp__ 前缀工具，纪律裸名不受影响（如需恢复请到浮窗重新勾选）`;
}

// ------------------------------------------------------------ 目录检索

/** 简单分词（英文小写 + 中文保留）。 */
function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const words = lowered.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? [];
  return words;
}

/** 跨字段打分：query 词命中 server 名 / 工具名 / description / 参数名。
 * 中文（无空格分词）：query 连续中文串在原始描述中 substring 匹配即可命中
 * （修复：原实现把连续中文当单个 token，中文召回率接近零）。 */
export function scoreTool(query: string, server: string, toolName: string, tool: CatalogTool): { score: number; matchedTerms: string[] } {
  if (query === "") return { score: 0, matchedTerms: [] };
  const haystack = [
    server,
    toolName,
    tool.description,
    JSON.stringify(Object.keys(tool.inputSchema ?? {})),
  ].join(" ").toLowerCase();
  // 中文子串匹配（连续中文段直接 substring 命中原始文本）
  const cjkQuery = query.match(/[\u4e00-\u9fff]+/gu) ?? [];
  if (cjkQuery.length > 0) {
    let score = 0;
    const matchedTerms: string[] = [];
    for (const segment of cjkQuery) {
      if (segment.length < 2) continue;
      if (haystack.includes(segment)) {
        score += 2;
        matchedTerms.push(segment);
      }
    }
    if (score > 0) return { score, matchedTerms };
  }
  const terms = tokenize(query);
  if (terms.length === 0) return { score: 0, matchedTerms: [] };
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
 * 单 root 实现（searchCatalogMulti 循环调用；兼容既有测试）。 */
export function searchCatalog(
  units: Map<string, ProjectUnit>,
  root: string,
  query: string,
  limit: number,
): { results: SearchHit[]; unavailable: Array<{ server: string; reason: string }> } {
  const unit = units.get(root);
  if (unit === undefined) return { results: [], unavailable: [] };
  const results: SearchHit[] = [];
  const unavailable: Array<{ server: string; reason: string }> = [];
  for (const [serverName, catalog] of unit.catalog) {
    if (catalog.unavailable !== undefined) {
      unavailable.push({ server: fullServerName(root, serverName), reason: catalog.unavailable });
      continue;
    }
    const fresh = Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS;
    const scored: Array<{ server: string; toolName: string; tool: CatalogTool; score: number; matchedTerms: string[] }> = [];
    for (const [toolName, tool] of catalog.tools) {
      const { score, matchedTerms } = scoreTool(query, serverName, toolName, tool);
      if (query !== "" && score === 0) continue;
      scored.push({ server: serverName, toolName, tool, score, matchedTerms });
    }
    scored.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));
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
  return { results, unavailable };
}

/** 多单元合并检索（all 模式：项目 root 单元 + @global 单元合并查询）。
 * 与 searchCatalog 同语义，仅数据源扩展为多个 root；off/project 模式行为不变。
 * 单 root 直接委托 searchCatalog（保持原顺序，不引入跨单元排序变化）；
 * 多 root 合并后统一排序并按全局 limit 截断。 */
export function searchCatalogMulti(
  units: Map<string, ProjectUnit>,
  roots: readonly string[],
  query: string,
  limit: number,
): { results: SearchHit[]; unavailable: Array<{ server: string; reason: string }> } {
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
  // 合并后统一截断（limit 为全局上限，而非每 root 上限）。
  return { results: results.slice(0, limit), unavailable };
}

/**
 * 完整盘点：列出当前工作空间全部服务器 + 每台完整工具清单（不受关键词/limit
 * 截断服务器，工具数受 perServerLimit 保护）。
 * @param units 连接池单元集合。
 * @param roots 参与盘点的 root 列表（all 模式含 @global）。
 * @param serverFilter 可选：@<root>/<server> 全名或裸名过滤。
 * @param toolLimit 每服务器工具条数上限（>0；超过置 toolsTruncated）。
 * @param emptyHint 空返回时的 message（按模式区分场景）。
 * @param disabledTools 用户工具级禁用映射（root → server → Set<tool>）；
 *    命中条目在工具行标注禁用（供模型感知）。
 * @throws 全名 root 不属于当前 roots → 路由一致性错误（与 ws_mcp_call 口径一致）。
 */
export function listCatalog(
  units: Map<string, ProjectUnit>,
  roots: readonly string[],
  serverFilter: string | undefined,
  toolLimit: number,
  mode: string,
  emptyHint: string,
  disabledTools?: DisabledToolsMap,
): ListCatalogResult {
  const safeLimit = Number.isFinite(toolLimit) && toolLimit > 0 ? Math.floor(toolLimit) : LIST_DEFAULT_TOOLS_PER_SERVER;
  let rootSet: Set<string> | undefined;
  if (serverFilter !== undefined && serverFilter.startsWith("@")) {
    const parsed = parseFullServerName(serverFilter);
    if (parsed === undefined || !roots.includes(parsed.root)) {
      throw new Error(
        `ws_mcp_list: server ${JSON.stringify(serverFilter)} 不属于当前工作空间（${JSON.stringify(roots)}）；路由一致性校验失败（防跨空间串台）`,
      );
    }
    rootSet = new Set([parsed.root]);
  }
  const servers: ListServerEntry[] = [];
  let totalTools = 0;
  let anyTruncated = false;
  for (const root of roots) {
    if (rootSet !== undefined && !rootSet.has(root)) continue;
    const unit = units.get(root);
    if (unit === undefined) continue;
    for (const [serverName, catalog] of unit.catalog) {
      if (serverFilter !== undefined && serverName !== serverFilter && fullServerName(root, serverName) !== serverFilter) continue;
      const entry: ListServerEntry = {
        server: fullServerName(root, serverName),
        tools: [],
        toolsTruncated: false,
      };
      if (unit.userDisabled.has(serverName)) entry.disabled = true;
      if (catalog.unavailable !== undefined) {
        entry.unavailable = catalog.unavailable;
      } else {
        const tools: ListToolEntry[] = [];
        let truncated = false;
        let index = 0;
        for (const [toolName, tool] of catalog.tools) {
          if (index >= safeLimit) {
            truncated = true;
            break;
          }
          // 工具级禁用标注（与服务器级 disabled 并列；查询面供模型感知）。
          // 条件赋值而非 `disabled: x || undefined`——显式 undefined 键会被宿主
          // lossless JSON 输出校验（dsh-util-values walkJsonValue）判非法
          // （#381：ws_mcp_list 报 "value is not lossless JSON"）。
          const rootTools = disabledTools?.get(root)?.get(serverName);
          const globalTools = root === MIDDLEWARE_GLOBAL_ROOT ? undefined : disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(serverName);
          const disabledByUser = (rootTools !== undefined && rootTools.has(toolName)) || (globalTools !== undefined && globalTools.has(toolName));
          const toolEntry: ListToolEntry = { tool: toolName, description: tool.description };
          if (disabledByUser) toolEntry.disabled = true;
          tools.push(toolEntry);
          index += 1;
        }
        entry.tools = tools;
        entry.toolsTruncated = truncated;
        if (truncated) anyTruncated = true;
        totalTools += tools.length;
      }
      servers.push(entry);
    }
  }
  // 稳定排序（root 出现序 + 服务器名）：跨单元合并不依赖 Map 插入序。
  const rootIndex = new Map(roots.map((root, index) => [root, index]));
  servers.sort((a, b) => {
    const ra = parseFullServerName(a.server)?.root ?? "";
    const rb = parseFullServerName(b.server)?.root ?? "";
    const oa = rootIndex.get(ra) ?? Number.MAX_SAFE_INTEGER;
    const ob = rootIndex.get(rb) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    const sa = parseFullServerName(a.server)?.server ?? a.server;
    const sb = parseFullServerName(b.server)?.server ?? b.server;
    return sa.localeCompare(sb);
  });
  const result: ListCatalogResult = {
    workspace: roots[0] ?? "@global",
    mode,
    servers,
    totalServers: servers.length,
    totalTools,
    toolsTruncated: anyTruncated,
  };
  if (servers.length === 0) result.message = emptyHint;
  return result;
}

/**
 * 单工具详情：按 @<root>/<server> + tool 裸名精确命中，返回完整 inputSchema。
 * 错误三分：
 * 1. server 发现失败（catalog.unavailable）→ 附原因；
 * 2. 单元/服务器未发现 → 「server 未连接或未发现」；
 * 3. 工具不存在 → 「tool 不存在」。
 * @param units 连接池单元集合。
 * @param root 目标 root（all 模式可为 @global）。
 * @param server @<root>/<server> 全名。
 * @param tool 远端工具裸名（兼容 mcp__ 前缀，复用 normalizeToolName）。
 */
export function findToolDetail(
  units: Map<string, ProjectUnit>,
  root: string,
  server: string,
  tool: string,
): ToolDetail {
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
  const catalog = unit.catalog.get(parsed.server);
  if (catalog === undefined || catalog.tools.size === 0) {
    if (catalog?.unavailable !== undefined) {
      throw new Error(`ws_mcp_detail: server 发现失败：${JSON.stringify(server)}（${catalog.unavailable}）`);
    }
    if (unit.userDisabled.has(parsed.server)) {
      throw new Error(`ws_mcp_detail: server 未连接或未发现：${JSON.stringify(server)}（已被用户禁用）`);
    }
    throw new Error(`ws_mcp_detail: server 未连接或未发现：${JSON.stringify(server)}`);
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

/** 等待带超时（race 兜底）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(message));
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}