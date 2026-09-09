/**
 * dsh-mcp-manager — 中间层工具注册（ws_mcp_search / ws_mcp_call /
 * ws_mcp_list / ws_mcp_detail + 策略 guard）。
 *
 * 注册四个中间层工具与策略 guard 层；类型自 middleware-types.ts 取，
 * 连接池类（McpMiddleware）自 middleware.ts import type（防运行值环）。
 * all 模式全局可见性（评审 A）：search/list/detail 合并查询「项目 root 单元 +
 * @global 单元」；call 放行 @global root。off/project 模式行为不变。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, PreToolDecision } from "@deepseek-ai/dsh-tools";
import type { McpMiddleware } from "./middleware.ts";
import {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./middleware-const.ts";
import { withTimeout } from "./pipeline/interface.ts";
import {
  policyAllows,
  policyDenialReason,
  isToolDenied,
  toolDisabledReason,
} from "./middleware-utils.ts";
import { searchCatalogMulti, listCatalog, findToolDetail } from "./catalog/interface.ts";
import { parseFullServerName, fullServerName, MIDDLEWARE_GLOBAL_ROOT } from "./workspace/interface.ts";
import type { MiddlewareMode, DisabledToolsMap } from "./types/interface.ts";
import type { McpStatsCollector } from "./stats/interface.ts";

/** 工具执行与组装上下文。 */
interface MiddlewareToolContext {
  mw: McpMiddleware;
  resolveRoot: (agent: unknown) => Promise<string | undefined>;
  mode: MiddlewareMode;
  stats?: McpStatsCollector;
}

/** 空 query 搜索无命中时的可归因提示（纯 render 文案，C 项）。 */
const SEARCH_EMPTY_HINT =
  "(No matching MCP tools found in current workspace; use ws_mcp_list for full inventory or verify server/tool names before searching)";

/** 项目级可见服务器名列表（A1 归因文案用；排序去重）。 */
function visibleProjectServers(mw: McpMiddleware, root: string): string[] {
  const names: string[] = [];
  for (const unit of mw.units.values()) {
    if (unit.root === root) {
      for (const serverName of unit.catalog.keys()) names.push(serverName);
    }
  }
  return [...new Set(names)].sort();
}

/** 等待 in-flight 连接/发现（8s 预算，与 search 对齐；超时不阻塞返回已有目录）。 */
async function waitForDiscovery(unit: NonNullable<Awaited<ReturnType<McpMiddleware["projectUnitFor"]>>>): Promise<void> {
  const inflight = [...unit.inFlight.values()];
  if (inflight.length === 0) return;
  try {
    await withTimeout(Promise.allSettled(inflight), 8000, "等待连接/发现超时");
  } catch {
    // 超时不阻塞（返回已有目录）
  }
}

/**
 * all 模式可见单元集合：项目 root + @global（评审 A 全局可见性修复）。
 * root 本身为 @global 时去重（防 all 模式无项目 cwd 下服务器翻倍）。
 */
function visibleMiddlewareRoots(root: string | undefined, mode: MiddlewareMode): string[] {
  if (root === undefined) return [];
  if (mode !== "all") return [root];
  return root === "@global" ? ["@global"] : [root, "@global"];
}

/**
 * 路由一致性校验（detail/call 共用；A2）：目标 root 必须等于当前 root，
 * 或 all 模式下的 @global（全局配置跨工作空间共享，语义成立）。
 * project 模式传全局级服务器 → 引导改用 mcp__ 直呼（全局 mcp__ 工具在该
 * 模式下仍注册可用）；非 global 的其他 root / 未知 @global 服务器一律硬拒绝
 * （防跨空间串台与 project 模式经 @global 路由绕过）。
 * @returns 校验通过的 root；抛错则拒绝。
 */
async function checkMiddlewareRoot(
  caller: string,
  server: string,
  root: string,
  mode: MiddlewareMode,
  mw: McpMiddleware,
): Promise<string | undefined> {
  const parsed = parseFullServerName(server);
  if (parsed === undefined) {
    throw new Error(`${caller}: server 参数格式非法，应为 @<root>/<server>`);
  }
  if (parsed.root !== root && parsed.root !== MIDDLEWARE_GLOBAL_ROOT) {
    throw new Error(
      `${caller}: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
    );
  }
  if (parsed.root === MIDDLEWARE_GLOBAL_ROOT && mode !== "all") {
    const bare = parsed.server;
    const known = mw.host.isGlobalServer(bare) || mw.units.get(MIDDLEWARE_GLOBAL_ROOT)?.catalog.has(bare) === true;
    if (known) {
      throw new Error(
        `${caller}: server ${JSON.stringify(server)} 是全局级（global scope）服务器，中间层只覆盖项目级服务器；请直接用 mcp__${bare}__<tool> 前缀工具调用（project 模式全局工具仍直呼注册）`,
      );
    }
    throw new Error(
      `${caller}: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
    );
  }
  return parsed.root;
}

// ---------------------------------------------------------------------------
// 1. ws_mcp_search
// ---------------------------------------------------------------------------

function formatSearchHit(hit: Record<string, unknown>): string {
  const server = String(hit.server ?? "");
  const tool = String(hit.tool ?? "");
  const description = String(hit.description ?? "");
  return `${server}/${tool}: ${description}`;
}

function formatUnavailableServer(entry: Record<string, unknown>): string {
  return `${String(entry.server ?? "")}: ${String(entry.reason ?? "")}`;
}

function renderSearchOutput(_args: unknown, value: unknown) {
  const v = (value ?? {}) as { results?: Array<Record<string, unknown>>; unavailable?: Array<Record<string, unknown>>; truncated?: unknown };
  const lines = (v.results ?? []).map(formatSearchHit);
  let body = lines.length > 0 ? lines.join("\n") : SEARCH_EMPTY_HINT;
  if (v.truncated === true) {
    body += "\n(Results reached limit and may be incomplete — increase limit or use ws_mcp_list for full audit)";
  }
  const unavailable = (v.unavailable ?? []).map(formatUnavailableServer);
  const text = unavailable.length > 0 ? `${body}\n\nUnavailable servers:\n${unavailable.join("\n")}` : body;
  return [{ type: "text" as const, text }];
}

function parseSearchParams(args: unknown): { query: string; serverFilter?: string; limit: number } {
  const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const query = typeof params.query === "string" ? params.query : "";
  const serverFilter = typeof params.server === "string" ? params.server : undefined;
  const requested = typeof params.limit === "number" ? Math.floor(params.limit) : 5;
  const limit = Math.max(1, Math.min(requested, 10));
  return { query, serverFilter, limit };
}

async function executeSearch(
  toolCtx: MiddlewareToolContext,
  args: unknown,
  exec: { signal?: AbortSignal; agent?: unknown },
) {
  const root = await toolCtx.resolveRoot(exec.agent);
  if (root === undefined) throw new Error("ws_mcp_search: 无法确定工作空间，请先选择工作区");
  const { query, serverFilter, limit } = parseSearchParams(args);
  if (toolCtx.stats?.isEnabled()) {
    toolCtx.stats.recordSearch(query);
  }
  const roots = visibleMiddlewareRoots(root, toolCtx.mode);
  const unit = await toolCtx.mw.projectUnitFor(root);
  if (unit === undefined) {
    return { results: [], unavailable: [], truncated: false };
  }
  // 等待 in-flight 连接/发现（预算内），再搜索。all 模式对可见全部单元
  // （含 @global 首次触达）都等待——否则全局目录首次为空（P1-3 修复）。
  for (const visible of roots) {
    const visibleUnit = visible === root ? unit : await toolCtx.mw.projectUnitFor(visible);
    if (visibleUnit !== undefined) await waitForDiscovery(visibleUnit);
  }
  const { results, unavailable, truncated } = searchCatalogMulti(toolCtx.mw.units, roots, query, limit);
  // truncated 由检索函数返回截断事实（恰好命中 limit 不误报，B10 修正——
  // 旧实现按过滤前 results.length >= limit 判定，恰恰等于 limit 也误报
  // 「可能未列全」）；serverFilter 过滤在截断判定之后，纯展示层过滤。
  const filtered = serverFilter === undefined ? results : results.filter((hit) => hit.server === serverFilter);
  return { results: filtered, unavailable, truncated };
}

function buildSearchTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  return {
    name: "ws_mcp_search",
    description:
      "Search workspace MCP tools catalog by keyword (matches server, tool, description, and parameter names). Search first, then invoke with ws_mcp_call; use ws_mcp_list for full inventory audits. Empty query returns capability summary.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query / keywords; empty returns capability summary" },
        server: { type: "string", description: "Optional: @<root>/<server> full name filter" },
        limit: { type: "number", description: "Max results to return (default 5, max 10)" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          results: { type: "array", items: {} },
          unavailable: { type: "array", items: {} },
          truncated: { type: "boolean", description: "结果是否因 limit 截断（results 达到 limit 时为 true，提示模型可能未列全）" },
        },
        required: ["results", "unavailable", "truncated"],
        additionalProperties: false,
      },
      render: renderSearchOutput,
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeSearch(toolCtx, args, exec),
  };
}

// ---------------------------------------------------------------------------
// 2. ws_mcp_call
// ---------------------------------------------------------------------------

function formatCallContentBlock(block: unknown): string {
  if (typeof block !== "object" || block === null) {
    return "[unsupported MCP content]";
  }
  const rec = block as Record<string, unknown>;
  if (rec.type === "text" && typeof rec.text === "string") {
    return rec.text;
  }
  if (rec.type === "resource" || rec.type === "resource_link") {
    return "[resource: content discarded]";
  }
  return `[${String(rec.type ?? "unknown")} content]`;
}

function renderCallOutput(_args: unknown, value: unknown) {
  const v = (value ?? {}) as { content?: unknown };
  const content = Array.isArray(v.content) ? v.content : [];
  const parts = content.map(formatCallContentBlock);
  return [{ type: "text" as const, text: parts.length > 0 ? parts.join("\n") : "(MCP tool returned no content)" }];
}

function parseCallParams(args: unknown): { server: string; tool: string; arguments?: unknown } {
  const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const server = typeof params.server === "string" ? params.server : "";
  const tool = typeof params.tool === "string" ? params.tool : "";
  return { server, tool, arguments: params.arguments };
}

async function executeCall(
  toolCtx: MiddlewareToolContext,
  args: unknown,
  exec: { signal?: AbortSignal; agent?: unknown },
) {
  const root = await toolCtx.resolveRoot(exec.agent);
  if (root === undefined) throw new Error("ws_mcp_call: 无法确定工作空间，请先选择工作区");
  const { server, tool, arguments: callArguments } = parseCallParams(args);
  if (server === "" || tool === "") throw new Error("ws_mcp_call: server 与 tool 均为必填");
  const parsed = parseFullServerName(server);
  if (parsed === undefined) throw new Error("ws_mcp_call: server 参数格式非法，应为 @<root>/<server>");
  const targetRoot = await checkMiddlewareRoot("ws_mcp_call", server, root, toolCtx.mode, toolCtx.mw);
  if (targetRoot === undefined) {
    throw new Error(`ws_mcp_call: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`);
  }
  const unit = await toolCtx.mw.projectUnitFor(targetRoot);
  if (unit === undefined) throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(targetRoot)} 无项目级 MCP 配置`);
  await toolCtx.mw.ensureConnected(targetRoot, parsed.server);
  // #413：透传 exec.agent 给 callTool（封装直呼分支的 execute 依赖
  // agent.session.header.cwd 做 projectPath 补全）。
  const startTime = Date.now();
  try {
    const result = await toolCtx.mw.callTool(server, tool, callArguments, exec.signal, exec.agent);
    const durationMs = Date.now() - startTime;
    if (toolCtx.stats?.isEnabled()) {
      toolCtx.stats.recordCall(parsed.server, tool, durationMs, true);
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    if (toolCtx.stats?.isEnabled()) {
      toolCtx.stats.recordCall(parsed.server, tool, durationMs, false, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function buildCallTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  return {
    name: "ws_mcp_call",
    description:
      "Invoke an MCP tool in the current workspace (executes on live server). Verify parameter schema with ws_mcp_detail beforehand (can invoke directly if server and tool are known); obtain user consent before write or sensitive operations.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Required: @<root>/<server> full name (from ws_mcp_search / ws_mcp_list)" },
        tool: { type: "string", description: "Required: bare remote tool name (from ws_mcp_search / ws_mcp_list)" },
        arguments: {
          type: "object",
          additionalProperties: true,
          description:
            "Arguments matching inputSchema from ws_mcp_detail (properties/required/enum/description); check with ws_mcp_detail when uncertain",
        },
      },
      required: ["server", "tool"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          structuredContent: {},
        },
        required: ["content"],
        additionalProperties: false,
      },
      render: renderCallOutput,
    },
    isConcurrencySafe: () => true,
    timeoutMs: CONNECT_TIMEOUT_MS + DISCOVERY_TIMEOUT_MS + CALL_TIMEOUT_MS + 5000,
    execute: (args, exec) => executeCall(toolCtx, args, exec),
  };
}

// ---------------------------------------------------------------------------
// 3. ws_mcp_list
// ---------------------------------------------------------------------------

function formatListTool(t: Record<string, unknown>): string {
  return `  - ${String(t.tool ?? "")}: ${String(t.description ?? "")}`;
}

function formatListServerEntry(entry: Record<string, unknown>): string {
  const server = String(entry.server ?? "");
  const tools = Array.isArray(entry.tools) ? (entry.tools as Array<Record<string, unknown>>) : [];
  const head =
    tools.length > 0
      ? `${server} (${tools.length} tools):\n${tools.map(formatListTool).join("\n")}`
      : `${server} (0 tools)`;
  const disabled = entry.disabled === true ? " [disabled]" : "";
  const unavailable =
    typeof entry.unavailable === "string" && entry.unavailable !== "" ? ` [unavailable: ${entry.unavailable}]` : "";
  const truncated =
    entry.toolsTruncated === true
      ? " [toolsTruncated: tool count reached limit, increase perServerLimit to retry]"
      : "";
  return `${head}${disabled}${unavailable}${truncated}`;
}

function renderListOutput(_args: unknown, value: unknown) {
  const v = (value ?? {}) as {
    workspace?: unknown;
    mode?: unknown;
    servers?: Array<Record<string, unknown>>;
    totalServers?: unknown;
    totalTools?: unknown;
    toolsTruncated?: unknown;
    message?: unknown;
  };
  const servers = v.servers ?? [];
  const lines = servers.map(formatListServerEntry);
  const prefix = `Workspace ${String(v.workspace ?? "")} (mode=${String(v.mode ?? "")}): ${String(v.totalServers ?? 0)} servers / ${String(v.totalTools ?? 0)} tools in total`;
  const body = lines.length > 0 ? lines.join("\n\n") : String(v.message ?? "(No MCP servers found in current workspace)");
  const truncated =
    v.toolsTruncated === true ? "\n(Some server tool lists were truncated; increase perServerLimit if needed)" : "";
  return [{ type: "text" as const, text: `${prefix}\n\n${body}${truncated}` }];
}

function parseListParams(args: unknown): { serverFilter?: string; toolLimit: number } {
  const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const serverFilter = typeof params.server === "string" && params.server !== "" ? params.server : undefined;
  const requested =
    typeof params.perServerLimit === "number" ? Math.floor(params.perServerLimit) : LIST_DEFAULT_TOOLS_PER_SERVER;
  const toolLimit = Math.max(1, Math.min(requested, LIST_MAX_TOOLS_PER_SERVER));
  return { serverFilter, toolLimit };
}

function resolveEmptyListMessage(
  serverFilter: string | undefined,
  mw: McpMiddleware,
  root: string,
  mode: MiddlewareMode,
): string {
  if (serverFilter !== undefined) {
    const visible = visibleProjectServers(mw, root);
    const visibleText = visible.length > 0 ? `可见项目级服务器：${visible.join(" / ")}；` : "当前工作空间无已发现的项目级服务器；";
    return `没有匹配 server=${JSON.stringify(serverFilter)} 的项目级服务器。${visibleText}全局级服务器不在此列出，请用 mcp__<server>__<tool> 前缀工具访问`;
  }
  return mode === "all"
    ? "当前工作空间没有可用 MCP 服务器（项目级与全局均未发现；若刚添加配置，请稍后重试）"
    : "当前工作空间没有可用 MCP 服务器（未配置项目级服务器；若刚添加配置，请稍后重试）";
}

async function resolveListWithoutUnit(
  mw: McpMiddleware,
  root: string,
  mode: MiddlewareMode,
  serverFilter: string | undefined,
  toolLimit: number,
) {
  if (mode !== "all") {
    return {
      workspace: root,
      mode,
      servers: [],
      totalServers: 0,
      totalTools: 0,
      toolsTruncated: false,
      message: "当前工作空间没有项目级 MCP 配置（可在 <项目根>/.dsh/mcp.json 添加服务器，或切换工作区）",
    };
  }
  const globalUnit = await mw.projectUnitFor("@global");
  if (globalUnit !== undefined) await waitForDiscovery(globalUnit);
  return listCatalog(
    mw.units,
    ["@global"],
    serverFilter,
    toolLimit,
    mode,
    "当前工作空间没有可用 MCP 服务器（项目级与全局均未发现；若刚添加配置，请稍后重试）",
    mw.disabledTools,
  );
}

async function executeList(
  toolCtx: MiddlewareToolContext,
  args: unknown,
  exec: { signal?: AbortSignal; agent?: unknown },
) {
  const root = await toolCtx.resolveRoot(exec.agent);
  if (root === undefined) throw new Error("ws_mcp_list: 无法确定工作空间，请先选择工作区");
  const { serverFilter, toolLimit } = parseListParams(args);
  if (toolCtx.stats?.isEnabled()) {
    toolCtx.stats.recordList(serverFilter);
  }
  const roots = visibleMiddlewareRoots(root, toolCtx.mode);
  const unit = await toolCtx.mw.projectUnitFor(root);
  if (unit === undefined) {
    return resolveListWithoutUnit(toolCtx.mw, root, toolCtx.mode, serverFilter, toolLimit);
  }
  // 等待 in-flight 连接/发现（预算内），再搜索。all 模式对可见全部单元
  // （含 @global 首次触达）都等待——否则全局目录首次为空（P1-3 修复）。
  for (const visible of roots) {
    const visibleUnit = visible === root ? unit : await toolCtx.mw.projectUnitFor(visible);
    if (visibleUnit !== undefined) await waitForDiscovery(visibleUnit);
  }
  const result = listCatalog(toolCtx.mw.units, roots, serverFilter, toolLimit, toolCtx.mode, "", toolCtx.mw.disabledTools);
  // A1：带 serverFilter 过滤后 0 命中 → message 可归因（不谎报「未配置」）。
  if (result.servers.length === 0) {
    result.message = resolveEmptyListMessage(serverFilter, toolCtx.mw, root, toolCtx.mode);
  }
  return result;
}

function buildListTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  return {
    name: "ws_mcp_list",
    description:
      "List all MCP servers and their complete tool inventories in current workspace (not truncated by search limit). Returns full server names, tool names, and descriptions. Does not return inputSchema (use ws_mcp_detail for full schemas). Includes global servers in all mode.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional: @<root>/<server> full name or bare name filter (error if root is not in current workspace)",
        },
        perServerLimit: {
          type: "number",
          description: `Optional: max tools per server (default ${LIST_DEFAULT_TOOLS_PER_SERVER}, max ${LIST_MAX_TOOLS_PER_SERVER}; sets toolsTruncated=true when exceeded)`,
        },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          mode: { type: "string" },
          servers: { type: "array", items: {} },
          totalServers: { type: "number" },
          totalTools: { type: "number" },
          toolsTruncated: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["workspace", "mode", "servers", "totalServers", "totalTools", "toolsTruncated"],
        additionalProperties: false,
      },
      render: renderListOutput,
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeList(toolCtx, args, exec),
  };
}

// ---------------------------------------------------------------------------
// 4. ws_mcp_detail
// ---------------------------------------------------------------------------

function renderDetailOutput(_args: unknown, value: unknown) {
  const v = (value ?? {}) as {
    server?: unknown;
    tool?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    fresh?: unknown;
    disabled?: unknown;
  };
  const server = String(v.server ?? "");
  const tool = String(v.tool ?? "");
  const description = typeof v.description === "string" && v.description !== "" ? v.description : "（无描述）";
  const schema = v.inputSchema === undefined ? "{}" : JSON.stringify(v.inputSchema, null, 2);
  const fresh = v.fresh === true ? "fresh" : "stale";
  const disabled = v.disabled === true ? " [disabled]" : "";
  return [{ type: "text" as const, text: `${server}/${tool}（${fresh}${disabled}）：${description}\n\ninputSchema:\n${schema}` }];
}

function parseDetailParams(args: unknown): { server: string; tool: string } {
  const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const server = typeof params.server === "string" ? params.server : "";
  const tool = typeof params.tool === "string" ? params.tool : "";
  return { server, tool };
}

async function executeDetail(
  toolCtx: MiddlewareToolContext,
  args: unknown,
  exec: { signal?: AbortSignal; agent?: unknown },
) {
  const root = await toolCtx.resolveRoot(exec.agent);
  if (root === undefined) throw new Error("ws_mcp_detail: 无法确定工作空间，请先选择工作区");
  const { server, tool } = parseDetailParams(args);
  if (server === "" || tool === "") throw new Error("ws_mcp_detail: server 与 tool 均为必填");
  const parsed = parseFullServerName(server);
  if (toolCtx.stats?.isEnabled()) {
    toolCtx.stats.recordDetail(parsed?.server ?? server, tool);
  }
  const targetRoot = await checkMiddlewareRoot("ws_mcp_detail", server, root, toolCtx.mode, toolCtx.mw);
  if (targetRoot === undefined) {
    throw new Error(
      `ws_mcp_detail: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
    );
  }
  const unit = await toolCtx.mw.projectUnitFor(targetRoot);
  if (unit !== undefined) await waitForDiscovery(unit);
  return findToolDetail(toolCtx.mw.units, targetRoot, server, tool);
}

function buildDetailTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  return {
    name: "ws_mcp_detail",
    description:
      "Query the exact parameter schema (inputSchema: properties/required/enum/description) of a single MCP tool by @<root>/<server> full name and bare tool name. Used before ws_mcp_call. Does not perform keyword search (use ws_mcp_list or ws_mcp_search to find tools).",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Required: @<root>/<server> full name (from ws_mcp_list / ws_mcp_search)" },
        tool: { type: "string", description: "Required: bare remote tool name (from ws_mcp_list / ws_mcp_search; supports mcp__<server>__<tool> prefix)" },
      },
      required: ["server", "tool"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          server: { type: "string" },
          tool: { type: "string" },
          description: { type: "string" },
          inputSchema: {},
          fresh: { type: "boolean" },
          disabled: { type: "boolean" },
        },
        required: ["server", "tool", "description", "inputSchema", "fresh"],
        additionalProperties: false,
      },
      render: renderDetailOutput,
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => executeDetail(toolCtx, args, exec),
  };
}

// ---------------------------------------------------------------------------
// 5. Pre-execute Guard
// ---------------------------------------------------------------------------

function handleCallGuard(args: unknown, mw: McpMiddleware): PreToolDecision | undefined {
  const { server, tool } = parseCallParams(args);
  const parsed = parseFullServerName(server);
  if (parsed === undefined || parsed.server === "") return undefined;
  const policyKey = fullServerName(parsed.root, parsed.server);
  if (isToolDenied(mw.disabledTools, mw.policy, policyKey, tool)) {
    if (!policyAllows(mw.policy, policyKey, tool)) {
      return { kind: "deny", reason: policyDenialReason(mw.policy, policyKey, tool) ?? "ws_mcp_call: 工具被策略拒绝" };
    }
    return { kind: "deny", reason: toolDisabledReason(policyKey, tool) };
  }
  return undefined;
}

async function handleDirectMcpGuard(
  name: string,
  agent: unknown,
  disabledTools: DisabledToolsMap | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
): Promise<PreToolDecision | undefined> {
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  const server = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (tool === "") return undefined;
  // B11（D5 定稿，规格化不可逆）：server/tool 名含连续双下划线时，第一个 `__`
  // 分割无法唯一还原 (server, tool)（mcp__my__sv__t 既可能是 server="my"+
  // tool="sv__t"，也可能是 server="my__sv"+tool="t"）——tool 段仍含 `__` 即
  // 存在歧义，按未知 server 处理（不禁用不误禁，放行 next()）。映射表列入
  // 后续增强；不改 publicToolName/INVALID_NAME_CHARS（防冲击官方 mcp__ 契约）。
  if (tool.includes("__")) return undefined;
  const root = await resolveRoot(agent);
  if (root === undefined) {
    // 无法解析会话 root：按最宽可见范围放行（仅 @global 共享记录生效）。
    if (disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server)?.has(tool) === true) {
      return { kind: "deny", reason: toolDisabledReason(`@${MIDDLEWARE_GLOBAL_ROOT}/${server}`, tool) };
    }
    return undefined;
  }
  const serverKey = fullServerName(root, server);
  if (isToolDenied(disabledTools, undefined, serverKey, tool)) {
    return { kind: "deny", reason: toolDisabledReason(serverKey, tool) };
  }
  return undefined;
}

function registerPreExecuteGuard(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
): (() => void) | undefined {
  if (typeof ctx.on !== "function") return undefined;
  return ctx.on(
    "tools/pre-execute",
    async (
      exec: { name?: string; arguments?: unknown; agent?: unknown },
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> => {
      const name = exec?.name;
      if (typeof name !== "string" || name === "") return next();
      if (name === "ws_mcp_call") {
        const decision = handleCallGuard(exec.arguments, mw);
        if (decision !== undefined) return decision;
        return next();
      }
      if (name.startsWith("mcp__")) {
        const decision = await handleDirectMcpGuard(name, exec.agent, mw.disabledTools, resolveRoot);
        if (decision !== undefined) return decision;
        return next();
      }
      return next();
    },
  );
}

/**
 * D8：独立 mcp__ 直呼守卫（guard 挂载与中间层实例解耦）。
 *
 * off 模式不 initMiddleware（无连接池副作用），pre-execute guard 现状只在
 * registerMiddlewareTools 内注册 → mcp__ 直呼无禁用拦截（「工具级禁用三入口」
 * 实际一入口）。本守卫数据源直查禁用表（只读），独立注册路径，三模式一致；
 * ws_mcp_call 守卫依赖策略/中间层实例，仅 project/all 经 registerMiddlewareTools
 * 注册。B11 反解规格化逻辑与 registerMiddlewareTools 内 guard 同源
 * （handleDirectMcpGuard）。
 */
export function registerDirectMcpGuard(
  ctx: Context,
  disabledTools: DisabledToolsMap | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
): (() => void) | undefined {
  if (typeof ctx.on !== "function") return undefined;
  return ctx.on(
    "tools/pre-execute",
    async (
      exec: { name?: string; agent?: unknown },
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> => {
      const name = exec?.name;
      if (typeof name !== "string" || name === "" || !name.startsWith("mcp__")) return next();
      const decision = await handleDirectMcpGuard(name, exec.agent, disabledTools, resolveRoot);
      if (decision !== undefined) return decision;
      return next();
    },
  );
}

// ---------------------------------------------------------------------------
// 6. registerMiddlewareTools 入口函数
// ---------------------------------------------------------------------------

/**
 * 注册 ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail 四个中间层工具。
 * @param ctx Cordis 宿主上下文。
 * @param mw 中间层实例。
 * @param resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。
 * @param mode 中间层模式（all 模式合并查询 @global 单元）。
 * @param options 可选配置（支持传入自定义工具级禁用表）。
 */
export function registerMiddlewareTools(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  mode: MiddlewareMode = "project",
  options: {
    /** 工具级禁用映射（root → server → Set<tool>）；缺省取 mw.disabledTools。 */
    disabledTools?: DisabledToolsMap;
    /** 可选调用统计收集器。 */
    stats?: McpStatsCollector;
  } = {},
): () => void {
  const disposers: Array<() => void> = [];
  // 单一事实源：options 显式传入时同步到 mw（guard 与 callTool 同源，防漂移）。
  const disabledTools = options.disabledTools ?? mw.disabledTools;
  if (options.disabledTools !== undefined) mw.disabledTools = disabledTools;

  const toolCtx: MiddlewareToolContext = { mw, resolveRoot, mode, stats: options.stats };
  const tools = [
    buildSearchTool(toolCtx),
    buildCallTool(toolCtx),
    buildListTool(toolCtx),
    buildDetailTool(toolCtx),
  ];
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool));
  }

  const guardDispose = registerPreExecuteGuard(ctx, mw, resolveRoot);
  if (guardDispose !== undefined) {
    disposers.push(guardDispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
