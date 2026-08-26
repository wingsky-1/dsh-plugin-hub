/**
 * dsh-mcp-manager — 中间层纯函数（命名 / 容错 / 脱敏 / 策略 / 目录检索）。
 *
 * 全部为无副作用纯函数（withTimeout 亦不依赖连接池），类型自 middleware-types.
 * ts 取；被连接池类、工具注册与 manager 共享。
 */

import { CATALOG_TTL_MS } from "./middleware-const.ts";
import type { CatalogTool, MiddlewarePolicy, ProjectUnit, SearchHit } from "./middleware-types.ts";
import type { ServerConfig } from "./types.ts";

// ------------------------------------------------------------ 命名与容错

/** server 全局唯一名：@<root>/<server>。 */
export function fullServerName(root: string, server: string): string {
  return `@${root}/${server}`;
}

/** 解析 @<root>/<server> 全名 → { root, server }；非法返回 undefined。
 * root 是绝对路径（以 / 开头），故从最后一个 `/` 分割（server 名不含 `/`）。 */
export function parseFullServerName(name: string): { root: string; server: string } | undefined {
  if (!name.startsWith("@")) return undefined;
  const slash = name.lastIndexOf("/");
  if (slash <= 1 || slash === name.length - 1) return undefined;
  return { root: name.slice(1, slash), server: name.slice(slash + 1) };
}

/** 归一化 ws_mcp_call 的 tool 参数（模型可能传 mcp__<server>__<tool> 全名）。 */
export function normalizeToolName(serverName: string, toolName: string): string {
  const prefix = `mcp__${serverName}__`;
  let name = toolName;
  if (name.startsWith("mcp__")) {
    while (name.startsWith(prefix)) name = name.slice(prefix.length);
    if (name.startsWith("mcp__")) {
      throw new Error(
        `ws_mcp_call: tool 参数疑似其他 MCP server 的注册全名（${JSON.stringify(toolName)}，server="${serverName}"）；请传该 server 上的裸名`,
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

/** 策略拒绝原因（供 denialReason 提示）。 */
export function policyDenialReason(policy: MiddlewarePolicy | undefined, serverKey: string, tool: string): string | undefined {
  if (policyAllows(policy, serverKey, tool)) return undefined;
  const deny = policy?.denyTools?.[serverKey] ?? policy?.denyTools?.[bareServerName(serverKey)];
  if (deny !== undefined && deny.some((pattern) => globMatch(pattern, tool))) {
    return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 被 denyTools 策略拒绝`;
  }
  return `ws_mcp_call: 工具 ${JSON.stringify(`${serverKey}/${tool}`)} 不在 allowTools 白名单内，被策略拒绝`;
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

/** 检索目录：query 为空 → 能力摘要表（每服务器前 N 个工具）。 */
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