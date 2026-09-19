/**
 * dsh-mcp-manager — 中间层工具注册（ws_mcp_search / ws_mcp_call /
 * ws_mcp_list / ws_mcp_detail + 策略 guard）。
 *
 * 注册四个中间层工具与工具级禁用 guard 层；类型面自各域门面（store/interface.ts 的
 * DisabledToolsMap）与 stats/interface.ts（McpStatsCollector）取，连接池类
 * McpMiddleware 自
 * connection/runtime/interface.ts 只作 `import type`（防运行值环）。跨域取数一律经
 * `injectPorts.get()`（端口声明见 ../deps.ts）——catalog 检索族、runtime 限额常量、pipeline
 * 裁决族与超时兜底、workspace 全名解析，本文件对四个提供域没有值 import。跨端契约常量
 * MIDDLEWARE_GLOBAL_ROOT 与值常量 LIST_DEFAULT_TOOLS_PER_SERVER 直接取自共享层门面（W3b 迁移）。
 * 全局可见性（评审 A）：search/list/detail 恒合并查询「项目 root 单元 + @global 单元」；
 * call 放行 @global root。单池（#767 笔 1a/笔 2）后没有模式分支。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolExecution, PreToolDecision } from "@deepseek-ai/dsh-tools";
import type { McpMiddleware } from "../connection/runtime/interface.ts";
import { LIST_DEFAULT_TOOLS_PER_SERVER } from "../shared/interface.ts";
import type { ModelContentBlock } from "../shared/interface.ts";
import { MIDDLEWARE_GLOBAL_ROOT } from "../../shared/interface.ts";
import type { McpStatsCollector } from "../stats/interface.ts";
import type { DisabledToolsMap } from "../store/interface.ts";
import { injectPorts } from "./impl/service/index.ts";
import { projectImageAdmission, type ImageAdmissionFaces } from "./impl/image-admission/index.ts";

/**
 * #770-A4 统计落盘脱敏：回答「stats.json 的 lastError 怎么不存明文？」——收集器
 * （McpStatsCollector）保持纯（不引 pipeline），调用方（本文件 executeCall 的
 * catch）在传入前先脱敏：复用 C 快照（mw.host.redactionServers()，manager
 * .getRedactionServers 的展开后快照）+ pipeline.createRedactor。脱敏失败时回落
 * 省略 lastError（仍计 errors，不把原文落盘）。
 *
 * 模块函数而非类成员：本文件无类，纯函数便于单测直调（不经完整工具注册链）。
 */
function redactedStatsError(mw: McpMiddleware, error: unknown): string | undefined {
  try {
    const {
      pipeline: { msgOf, createRedactor },
    } = injectPorts.get();
    const redactor = createRedactor([...mw.host.redactionServers()]);
    return redactor(new Error(msgOf(error))).slice(0, 200);
  } catch {
    return undefined;
  }
}

/** 工具执行与组装上下文。 */
interface MiddlewareToolContext {
  mw: McpMiddleware;
  resolveRoot: (agent: unknown) => Promise<string | undefined>;
  stats?: McpStatsCollector;
  /**
   * A+ 图片准入的模型面投影表。键是**本次 exec 对象身份**（宿主在 `execute` 与
   * `finalizeContent` 之间递的是同一个对象，官方也以它做 WeakMap 键）——不用模块级单例，
   * 并发调用之间不会串投影。
   */
  projections: WeakMap<ToolExecution, ModelContentBlock[]>;
  /** 图片准入要用的宿主能力（晚读 thunk）；接线点省略时退化成纯诊断（不抛）。 */
  faces: ImageAdmissionFaces;
}

/** 空 query 搜索无命中时的可归因提示（纯 render 文案，C 项）。 */
const SEARCH_EMPTY_HINT =
  "(No matching MCP tools found in current workspace; use ws_mcp_list for full inventory or verify server/tool names before searching)";

/**
 * 项目级可见服务器名列表（A1 归因文案用；排序去重）。
 *
 * 数据源是 catalog 域的目录读口（#767 S1-3b）：`units` 已不再持目录，根过滤由读口自己做
 * ——单元在册但目录没有任何服务器时给空表，与「单元不在册」在下游都不产生文案差异。
 */
function visibleProjectServers(root: string): string[] {
  const { catalog } = injectPorts.get();
  return [...new Set(catalog.catalogDirectory.serverNamesFor(root))].sort();
}

/** 等待 in-flight 连接/发现（8s 预算，与 search 对齐；超时不阻塞返回已有目录）。 */
async function waitForDiscovery(
  unit: NonNullable<Awaited<ReturnType<McpMiddleware["projectUnitFor"]>>>,
): Promise<void> {
  const {
    pipeline: { withTimeout },
  } = injectPorts.get();
  const inflight = [...unit.inFlight.values()];
  if (inflight.length === 0) return;
  try {
    await withTimeout(Promise.allSettled(inflight), 8000, "等待连接/发现超时");
  } catch {
    // 超时不阻塞（返回已有目录）
  }
}

/**
 * 可见单元集合：项目 root + @global（评审 A 全局可见性修复）。
 * root 本身为 @global 时去重（防无项目 cwd 下服务器翻倍）。
 *
 * 单池（#767 笔 1a）：@global 恒可见——「按模式合并」的分支已删。
 */
function visibleMiddlewareRoots(root: string | undefined): string[] {
  if (root === undefined) return [];
  return root === "@global" ? ["@global"] : [root, "@global"];
}

/**
 * 路由一致性校验（detail/call 共用；A2）：目标 root 必须等于当前 root，或 @global
 * （全局配置跨工作空间共享，语义成立）。
 *
 * 单池（#767 笔 1a）：原「@global 且非 all 模式 → 拒绝」那道门已删——可达性
 * 三件套之一。全局服务器不再有 mcp__ 直呼面，@global 必须对所有调用方可达。
 * 「其他 root（≠ 当前 root 且 ≠ @global）恒拒」逐字保持（防跨空间串台）。
 * @returns 校验通过的 root；抛错则拒绝。
 */
async function checkMiddlewareRoot(
  caller: string,
  server: string,
  root: string,
): Promise<string | undefined> {
  const {
    workspace: { parseFullServerName },
  } = injectPorts.get();
  const parsed = parseFullServerName(server);
  if (parsed === undefined) {
    throw new Error(`${caller}: server 参数格式非法，应为 @<root>/<server>`);
  }
  if (parsed.root !== root && parsed.root !== MIDDLEWARE_GLOBAL_ROOT) {
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
  const v = (value ?? {}) as {
    results?: Array<Record<string, unknown>>;
    unavailable?: Array<Record<string, unknown>>;
    truncated?: unknown;
  };
  const lines = (v.results ?? []).map(formatSearchHit);
  let body = lines.length > 0 ? lines.join("\n") : SEARCH_EMPTY_HINT;
  if (v.truncated === true) {
    body +=
      "\n(Results reached limit and may be incomplete — increase limit or use ws_mcp_list for full audit)";
  }
  const unavailable = (v.unavailable ?? []).map(formatUnavailableServer);
  const text =
    unavailable.length > 0 ? `${body}\n\nUnavailable servers:\n${unavailable.join("\n")}` : body;
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
  const roots = visibleMiddlewareRoots(root);
  const unit = await toolCtx.mw.projectUnitFor(root);
  if (unit === undefined) {
    return { results: [], unavailable: [], truncated: false };
  }
  // 等待 in-flight 连接/发现（预算内），再搜索。对可见全部单元
  // （含 @global 首次触达）都等待——否则全局目录首次为空（P1-3 修复）。
  for (const visible of roots) {
    const visibleUnit = visible === root ? unit : await toolCtx.mw.projectUnitFor(visible);
    if (visibleUnit !== undefined) await waitForDiscovery(visibleUnit);
  }
  const {
    catalog: { searchCatalogMulti },
  } = injectPorts.get();
  const { results, unavailable, truncated } = searchCatalogMulti(
    toolCtx.mw.units,
    roots,
    query,
    limit,
  );
  // truncated 由检索函数返回截断事实（恰好命中 limit 不误报，B10 修正——
  // 旧实现按过滤前 results.length >= limit 判定，恰恰等于 limit 也误报
  // 「可能未列全」）；serverFilter 过滤在截断判定之后，纯展示层过滤。
  const filtered =
    serverFilter === undefined ? results : results.filter((hit) => hit.server === serverFilter);
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
        query: {
          type: "string",
          description: "Search query / keywords; empty returns capability summary",
        },
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
          truncated: {
            type: "boolean",
            description:
              "结果是否因 limit 截断（results 达到 limit 时为 true，提示模型可能未列全）",
          },
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
  return [
    {
      type: "text" as const,
      text: parts.length > 0 ? parts.join("\n") : "(MCP tool returned no content)",
    },
  ];
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
  /**
   * 完整执行身份。为什么不是 `Pick<ToolRunContext, ...>`：图片准入的投影要以**本 exec 对象**
   * 为键存进 WeakMap，而 `finalizeContent` 收到的是 `ToolExecution`——两处必须是同一个类型，
   * 否则同一对象在两侧被读成不同形状（`ToolRunContext extends ToolExecution`，收窄无损）。
   */
  exec: ToolExecution,
) {
  const root = await toolCtx.resolveRoot(exec.agent);
  if (root === undefined) throw new Error("ws_mcp_call: 无法确定工作空间，请先选择工作区");
  const { server, tool, arguments: callArguments } = parseCallParams(args);
  if (server === "" || tool === "") throw new Error("ws_mcp_call: server 与 tool 均为必填");
  const {
    workspace: { parseFullServerName },
  } = injectPorts.get();
  const parsed = parseFullServerName(server);
  if (parsed === undefined)
    throw new Error("ws_mcp_call: server 参数格式非法，应为 @<root>/<server>");
  const targetRoot = await checkMiddlewareRoot("ws_mcp_call", server, root);
  if (targetRoot === undefined) {
    throw new Error(
      `ws_mcp_call: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
    );
  }
  const unit = await toolCtx.mw.projectUnitFor(targetRoot);
  if (unit === undefined)
    throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(targetRoot)} 无项目级 MCP 配置`);
  await toolCtx.mw.ensureConnected(targetRoot, parsed.server);
  // #767 笔 1b 交付物 C（F4 收口）：这里的 agent 交给 dispatch 后**只服务封装直呼分支**
  // （它的 execute 依赖 agent.session.header.cwd 做 projectPath 补全）；远端转发分支不再携带
  // agent（去 agent 后官方那次图片准入退化成本包自持的 image-admission，见 executeCall 尾部）。
  // callId/rootCallId/token 供 dispatch 合成子调用 id 并透传 parent（#767 S1-4d）。
  const startTime = Date.now();
  let value: unknown;
  try {
    value = await toolCtx.mw.callTool(server, tool, callArguments, exec.signal, {
      agent: exec.agent,
      callId: exec.callId,
      ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }),
      // token 即本次调用的身份：子调用以它为 parent，guard 据此区分「模型直呼」与「我方转发」。
      ...(exec.token === undefined ? {} : { parent: exec.token }),
    });
    const durationMs = Date.now() - startTime;
    if (toolCtx.stats?.isEnabled()) {
      toolCtx.stats.recordCall(parsed.server, tool, durationMs, true);
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    if (toolCtx.stats?.isEnabled()) {
      // #770-A4：先脱敏再传入（复用 C 快照 + 展开，见 redactedStatsError）；
      // 收集器保持纯，不在内部引 pipeline。回落 undefined 时仍计 errors、不存原文。
      const redacted = redactedStatsError(toolCtx.mw, error);
      if (redacted === undefined) toolCtx.stats.recordCall(parsed.server, tool, durationMs, false);
      else toolCtx.stats.recordCall(parsed.server, tool, durationMs, false, redacted);
    }
    throw error;
  }
  // 交付物 B（A+ 自持图片准入）：远端原始图片块出现时才建模型面投影，按 exec 键控存进表；
  // 无图片（或图片块已是模型面形态）时不建映射，finalizeContent 返回 undefined，继续走 render。
  // 投影基于**这里 return 的 value 的 content**（含 dispatch 的 stale 前置提示），不是渲染产物。
  // 任何拒绝都只在投影里落诊断文本，本函数不因图片面抛错。
  const projection = await projectImageAdmission({
    agent: exec.agent,
    content: callValueContent(value),
    signal: exec.signal,
    faces: toolCtx.faces,
    formatBlock: formatCallContentBlock,
  });
  if (projection !== undefined) toolCtx.projections.set(exec, projection);
  return value;
}

/** 取 `mw.callTool` 返回值里的 content 数组（非数组/缺席 → 空表：不可能有图片块）。 */
function callValueContent(value: unknown): readonly unknown[] {
  const content = (value as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

function buildCallTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  const {
    runtime: { CONNECT_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS, CALL_TIMEOUT_MS },
  } = injectPorts.get();
  return {
    name: "ws_mcp_call",
    description:
      "Invoke an MCP tool in the current workspace (executes on live server). Verify parameter schema with ws_mcp_detail beforehand (can invoke directly if server and tool are known); obtain user consent before write or sensitive operations.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Required: @<root>/<server> full name (from ws_mcp_search / ws_mcp_list)",
        },
        tool: {
          type: "string",
          description: "Required: bare remote tool name (from ws_mcp_search / ws_mcp_list)",
        },
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
    /**
     * 官方 `applyFinalContent` 接缝：把本包自持的图片准入投影换进模型面（返回 `undefined`
     * 则保留原内容 = 继续走 `render`）。命中即删——每次执行只消费一次。`isError` 时把内容
     * 交回宿主：错误面不该被换面。
     */
    finalizeContent(exec, result) {
      const projection = toolCtx.projections.get(exec);
      if (projection === undefined) return undefined;
      toolCtx.projections.delete(exec);
      if (result.isError === true) return undefined;
      return projection;
    },
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
    typeof entry.unavailable === "string" && entry.unavailable !== ""
      ? ` [unavailable: ${entry.unavailable}]`
      : "";
  const truncated =
    entry.toolsTruncated === true
      ? " [toolsTruncated: tool count reached limit, increase perServerLimit to retry]"
      : "";
  return `${head}${disabled}${unavailable}${truncated}`;
}

function renderListOutput(_args: unknown, value: unknown) {
  const v = (value ?? {}) as {
    workspace?: unknown;
    servers?: Array<Record<string, unknown>>;
    totalServers?: unknown;
    totalTools?: unknown;
    toolsTruncated?: unknown;
    message?: unknown;
  };
  const servers = v.servers ?? [];
  const lines = servers.map(formatListServerEntry);
  const prefix = `Workspace ${String(v.workspace ?? "")}: ${String(v.totalServers ?? 0)} servers / ${String(v.totalTools ?? 0)} tools in total`;
  const body =
    lines.length > 0
      ? lines.join("\n\n")
      : String(v.message ?? "(No MCP servers found in current workspace)");
  const truncated =
    v.toolsTruncated === true
      ? "\n(Some server tool lists were truncated; increase perServerLimit if needed)"
      : "";
  return [{ type: "text" as const, text: `${prefix}\n\n${body}${truncated}` }];
}

function parseListParams(args: unknown): { serverFilter?: string; toolLimit: number } {
  const {
    runtime: { LIST_MAX_TOOLS_PER_SERVER },
  } = injectPorts.get();
  const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const serverFilter =
    typeof params.server === "string" && params.server !== "" ? params.server : undefined;
  const requested =
    typeof params.perServerLimit === "number"
      ? Math.floor(params.perServerLimit)
      : LIST_DEFAULT_TOOLS_PER_SERVER;
  const toolLimit = Math.max(1, Math.min(requested, LIST_MAX_TOOLS_PER_SERVER));
  return { serverFilter, toolLimit };
}

function resolveEmptyListMessage(
  serverFilter: string | undefined,
  mw: McpMiddleware,
  root: string,
): string {
  if (serverFilter !== undefined) {
    const visible = visibleProjectServers(root);
    const visibleText =
      visible.length > 0
        ? `可见项目级服务器：${visible.join(" / ")}；`
        : "当前工作空间无已发现的项目级服务器；";
    return `没有匹配 server=${JSON.stringify(serverFilter)} 的项目级服务器。${visibleText}全局级服务器不在此列出：请用 ws_mcp_call 按全名访问（全局级写作 @global/<server>，项目级写作 @<root>/<server>；全名从 ws_mcp_list / ws_mcp_search 读），封装定义条目同样经它访问`;
  }
  // 单池后「无项目单元」不再等于「只有项目级可见」：@global 单元同样会被查询。
  return "当前工作空间没有可用 MCP 服务器（项目级与全局均未发现；若刚添加配置，请稍后重试）";
}

async function resolveListWithoutUnit(
  mw: McpMiddleware,
  root: string,
  serverFilter: string | undefined,
  toolLimit: number,
) {
  const {
    catalog: { listCatalog },
  } = injectPorts.get();
  // 单池：单元缺失也查 @global（原「非 all 模式 → 只报项目级未配置」的分支已删）。
  const globalUnit = await mw.projectUnitFor("@global");
  if (globalUnit !== undefined) await waitForDiscovery(globalUnit);
  return listCatalog(
    mw.units,
    ["@global"],
    serverFilter,
    toolLimit,
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
  const roots = visibleMiddlewareRoots(root);
  const unit = await toolCtx.mw.projectUnitFor(root);
  if (unit === undefined) {
    return resolveListWithoutUnit(toolCtx.mw, root, serverFilter, toolLimit);
  }
  // 等待 in-flight 连接/发现（预算内），再搜索。对可见全部单元
  // （含 @global 首次触达）都等待——否则全局目录首次为空（P1-3 修复）。
  for (const visible of roots) {
    const visibleUnit = visible === root ? unit : await toolCtx.mw.projectUnitFor(visible);
    if (visibleUnit !== undefined) await waitForDiscovery(visibleUnit);
  }
  const {
    catalog: { listCatalog },
  } = injectPorts.get();
  const result = listCatalog(
    toolCtx.mw.units,
    roots,
    serverFilter,
    toolLimit,
    "",
    toolCtx.mw.disabledTools,
  );
  // A1：带 serverFilter 过滤后 0 命中 → message 可归因（不谎报「未配置」）。
  if (result.servers.length === 0) {
    result.message = resolveEmptyListMessage(serverFilter, toolCtx.mw, root);
  }
  return result;
}

function buildListTool(toolCtx: MiddlewareToolContext): ToolDefinition {
  const {
    runtime: { LIST_MAX_TOOLS_PER_SERVER },
  } = injectPorts.get();
  return {
    name: "ws_mcp_list",
    description:
      "List all MCP servers and their complete tool inventories in current workspace (not truncated by search limit). Returns full server names, tool names, and descriptions. Does not return inputSchema (use ws_mcp_detail for full schemas). Includes project-level and global servers.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "Optional: @<root>/<server> full name or bare name filter (error if root is not in current workspace)",
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
          servers: { type: "array", items: {} },
          totalServers: { type: "number" },
          totalTools: { type: "number" },
          toolsTruncated: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["workspace", "servers", "totalServers", "totalTools", "toolsTruncated"],
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
  const description =
    typeof v.description === "string" && v.description !== "" ? v.description : "（无描述）";
  const schema = v.inputSchema === undefined ? "{}" : JSON.stringify(v.inputSchema, null, 2);
  const fresh = v.fresh === true ? "fresh" : "stale";
  const disabled = v.disabled === true ? " [disabled]" : "";
  return [
    {
      type: "text" as const,
      text: `${server}/${tool}（${fresh}${disabled}）：${description}\n\ninputSchema:\n${schema}`,
    },
  ];
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
  const {
    workspace: { parseFullServerName },
    catalog: { findToolDetail },
  } = injectPorts.get();
  const parsed = parseFullServerName(server);
  if (toolCtx.stats?.isEnabled()) {
    toolCtx.stats.recordDetail(parsed?.server ?? server, tool);
  }
  const targetRoot = await checkMiddlewareRoot("ws_mcp_detail", server, root);
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
        server: {
          type: "string",
          description: "Required: @<root>/<server> full name (from ws_mcp_list / ws_mcp_search)",
        },
        tool: {
          type: "string",
          description: "Required: bare remote tool name (from ws_mcp_list / ws_mcp_search)",
        },
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
  const {
    workspace: { parseFullServerName, fullServerName },
    pipeline: { isToolDenied, toolDisabledReason },
  } = injectPorts.get();
  const { server, tool } = parseCallParams(args);
  const parsed = parseFullServerName(server);
  if (parsed === undefined || parsed.server === "") return undefined;
  const serverKey = fullServerName(parsed.root, parsed.server);
  if (isToolDenied(mw.disabledTools, serverKey, tool)) {
    return { kind: "deny", reason: toolDisabledReason(serverKey, tool) };
  }
  return undefined;
}

/**
 * 注册名中段 → (root, 裸名) 的反查面。
 *
 * 为什么按入参递入而不是本域自己查：注册名自 #767 S1-4d 换引擎起是 `mcp__<id>__`，id 由
 * (root, name) 分配、只有持账本的一侧知道（池侧是单元表的 entry.id，直连侧是 manager 的
 * 直连账本）。本域若自己 import 那两个域就是新增跨域值边（I2① 硬红），故按调用点入参契约
 * 递进——与既有的 `resolveRoot` 同一形态。
 */
type ServerIdResolver = (id: string) => { root: string; server: string } | undefined;

async function handleDirectMcpGuard(
  name: string,
  agent: unknown,
  disabledTools: DisabledToolsMap | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  resolveServerId?: ServerIdResolver,
): Promise<PreToolDecision | undefined> {
  const {
    workspace: { fullServerName },
    pipeline: { isToolDenied, toolDisabledReason },
  } = injectPorts.get();
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  const segment = rest.slice(0, separator);
  const tool = rest.slice(separator + 2);
  if (tool === "") return undefined;
  // B11（规格化不可逆；#903 B-M4 由 fail-open 改 fail-closed）：server/tool 名含连续
  // 双下划线时，第一个 `__` 分割无法唯一还原 (server, tool)（mcp__my__sv__t 既可能是
  // server="my"+tool="sv__t"，也可能是 server="my__sv"+tool="t"）——tool 段仍含 `__`
  // 即存在歧义。放行会让已禁用的含 __ 工具经直呼路径绕过禁用（dispatch 侧
  // normalizeToolName 对跨 server 前缀是 fail-closed，见 workspace/impl/full-name），
  // 故此处同样 fail-closed：拒绝并指往 ws_mcp_call（裸名确定性裁决，含 __ 工具经由
  // 该路径照常用）。映射表列入后续增强；不改 publicToolName/INVALID_NAME_CHARS
  // （防冲击官方 mcp__ 契约）。
  if (tool.includes("__")) {
    return {
      kind: "deny",
      reason:
        `工具注册名 ${JSON.stringify(name)} 含连续双下划线，无法唯一反解 (server, tool)；` +
        "请经 ws_mcp_call 用服务器裸名与工具裸名调用（该路径确定性裁决）",
    };
  }
  // id 反解（#767 S1-5b 裁定 AG③ / S1-4d 遗留缺口）：注册名中段是 (root, name) 分配的 id，
  // 不是裸服务器名——不反解就把它当 server 名查禁用表，工具级禁用对直呼路径**恒 miss**。
  // 反查不到时按裸名解释：未登记 id 的注册面（旧形态名、测试注入的假条目）口径不变。
  const resolved = resolveServerId?.(segment);
  const server = resolved?.server ?? segment;
  const root = resolved?.root ?? (await resolveRoot(agent));
  if (root === undefined) {
    // 无法解析会话 root：按最宽可见范围放行（仅 @global 共享记录生效）。
    if (disabledTools?.get(MIDDLEWARE_GLOBAL_ROOT)?.get(server)?.has(tool) === true) {
      return {
        kind: "deny",
        reason: toolDisabledReason(`@${MIDDLEWARE_GLOBAL_ROOT}/${server}`, tool),
      };
    }
    return undefined;
  }
  const serverKey = fullServerName(root, server);
  if (isToolDenied(disabledTools, serverKey, tool)) {
    return { kind: "deny", reason: toolDisabledReason(serverKey, tool) };
  }
  return undefined;
}

/**
 * 池侧的反查面：单元表的连接条目就是 id 的唯一事实源（`entry.id` 由装载返回写回）。
 * 跨 root 同名各有一条，故扫描必须遍历全部单元。
 */
function resolveServerIdFor(mw: McpMiddleware): ServerIdResolver {
  return (id: string) => {
    for (const unit of mw.units.values()) {
      for (const [name, entry] of unit.connections) {
        if (entry.id === id) return { root: unit.root, server: name };
      }
    }
    return undefined;
  };
}

function registerPreExecuteGuard(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  /** 装配点给的直连账本反查（可选）；未命中回落池侧反查。 */
  hostResolveServerId?: ServerIdResolver,
): (() => void) | undefined {
  if (typeof ctx.on !== "function") return undefined;
  return ctx.on(
    "tools/pre-execute",
    async function (
      exec: Pick<ToolExecution, "name" | "arguments" | "agent" | "parent">,
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> {
      const name = exec?.name;
      if (typeof name !== "string" || name === "") return next();
      // 裁定 R/Z：判发起者不判名字。我方 dispatch 经 ctx.tools.execute 转发出去的子调用，
      // 其 parent 就是外层 ws_mcp_call 的 token，派发前已登记进 mw.forwarding——这里必须在
      // 任何 mcp__ 解析与 B11 早返回**之前**放行：放行晚一步，阶段 3 的模型面收敛会把自家
      // 转发当成模型直呼误拒（RECON 反例 9）。集合判定即全部裁决，工具级禁用已在 dispatch
      // 侧按 isToolDenied 判过。
      if (exec.parent !== undefined && mw.forwarding.has(exec.parent)) return next();
      if (name === "ws_mcp_call") {
        const decision = handleCallGuard(exec.arguments, mw);
        if (decision !== undefined) return decision;
        return next();
      }
      if (name.startsWith("mcp__")) {
        // 直连账本优先、池侧兜底：project/off 下全局直连条目的 id 只在本层反查得到，
        // 而 all/project 的池条目只在单元表里。
        const poolResolve = resolveServerIdFor(mw);
        const decision = await handleDirectMcpGuard(
          name,
          exec.agent,
          mw.disabledTools,
          resolveRoot,
          (id) => hostResolveServerId?.(id) ?? poolResolve(id),
        );
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
 * 历史上的动机是「模式为 off 时不建中间层实例，pre-execute guard 只在
 * registerMiddlewareTools 内注册 → mcp__ 直呼无禁用拦截」（「工具级禁用三入口」
 * 实际一入口）。本守卫数据源直查禁用表（只读），独立注册路径；单池（#767 笔 1a）
 * 后中间层实例 apply 完成后恒在（pre-step 窗口未装配走 B 兜底），两条注册路径并存
 * 仍是刻意的（守卫不依赖中间层实例）。
 * B11 反解规格化逻辑与 registerMiddlewareTools 内 guard 同源（handleDirectMcpGuard）。
 */
export function registerDirectMcpGuard(
  ctx: Context,
  disabledTools: DisabledToolsMap | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  /**
   * id → (root, 裸名) 反查面（账本由持有者自持，只有调用点给得出来）。位置参数而非
   * options 袋：与 resolveRoot 同为「装配点现造的入参契约」，且签名落在导出面快照的**同一个
   * 声明块**里——带花括号的 options 袋会让提取器在第一个深度 0 的 `}` 截断整块。
   */
  resolveServerId?: ServerIdResolver,
): (() => void) | undefined {
  if (typeof ctx.on !== "function") return undefined;
  return ctx.on(
    "tools/pre-execute",
    async function (
      exec: { name?: string; agent?: unknown },
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> {
      const name = exec?.name;
      if (typeof name !== "string" || name === "" || !name.startsWith("mcp__")) return next();
      const decision = await handleDirectMcpGuard(
        name,
        exec.agent,
        disabledTools,
        resolveRoot,
        resolveServerId,
      );
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
 * @param options 可选配置（支持传入自定义工具级禁用表）。
 *
 * 单池（#767 笔 1a）：不再接受模式入参——可见单元集合恒为「项目 root + @global」；
 * `ws_mcp_list` 的输出里没有模式字段（笔 2 随 `middleware` 配置键一并删除）。
 */
export function registerMiddlewareTools(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  options: {
    /** 工具级禁用映射（root → server → Set<tool>）；缺省取 mw.disabledTools。 */
    disabledTools?: DisabledToolsMap;
    /** 可选调用统计收集器。 */
    stats?: McpStatsCollector;
    /**
     * id → (root, 裸名) 反查面（可选）。装配点递入 manager 账本的反查：只靠池侧反查
     * 会把 id 当裸名、工具级禁用对直呼路径恒 miss。
     * 给出时优先，未命中回落池侧反查（`resolveServerIdFor`）。
     */
    resolveServerId?: ServerIdResolver;
  } = {},
  /**
   * 图片准入要用的宿主能力面（`faces.attachments` / `faces.models` 两条**晚读** thunk）。
   *
   * **为什么是 options 之后的第 5 个位置参数，而不是 options 袋里的一个键**：导出面快照按
   * 「顶层 `export declare` 块」比对，而块提取器在第一个深度 0 的 `}` 处截断（见
   * `registerDirectMcpGuard` 的同款说明）——袋里加键会同时改写基线里
   * `registerMiddlewareTools` 的声明块文本，本笔不许动导出面。省略时退化成纯诊断（不落图）。
   */
  faces?: ImageAdmissionFaces,
): () => void {
  const disposers: Array<() => void> = [];
  // 单一事实源：options 显式传入时同步到 mw（guard 与 callTool 同源，防漂移）。
  const disabledTools = options.disabledTools ?? mw.disabledTools;
  if (options.disabledTools !== undefined) mw.disabledTools = disabledTools;

  const toolCtx: MiddlewareToolContext = {
    mw,
    resolveRoot,
    stats: options.stats,
    projections: new WeakMap(),
    // faces 缺省：两条能力都取不到 → 图片面退化成诊断文本（与「宿主未挂附件库」同一条文案），
    // 不影响任何无图片的调用面。
    faces: faces ?? { attachments: () => undefined, models: () => undefined },
  };
  const tools = [
    buildSearchTool(toolCtx),
    buildCallTool(toolCtx),
    buildListTool(toolCtx),
    buildDetailTool(toolCtx),
  ];
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool));
  }

  const guardDispose = registerPreExecuteGuard(ctx, mw, resolveRoot, options.resolveServerId);
  if (guardDispose !== undefined) {
    disposers.push(guardDispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
