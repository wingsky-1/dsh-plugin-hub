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
import {
  withTimeout,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  parseFullServerName,
  fullServerName,
  policyAllows,
  policyDenialReason,
} from "./middleware-utils.ts";
import type { MiddlewareMode } from "./middleware-types.ts";

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
 * 注册 ws_mcp_search / ws_mcp_call / ws_mcp_list / ws_mcp_detail 四个中间层工具。
 * @param host 中间层宿主。
 * @param mw 中间层实例。
 * @param resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。
 * @param mode 中间层模式（all 模式合并查询 @global 单元）。
 */
export function registerMiddlewareTools(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  mode: MiddlewareMode = "project",
): () => void {
  const disposers: Array<() => void> = [];

  /** all 模式可见单元集合：项目 root + @global（评审 A 全局可见性修复）。 */
  const visibleRoots = (root: string | undefined): string[] => {
    if (root === undefined) return [];
    return mode === "all" ? [root, "@global"] : [root];
  };

  const search: ToolDefinition = {
    name: "ws_mcp_search",
    description: "检索当前工作空间的 MCP 工具目录。先用本工具检索，再 ws_mcp_call 调用。空 query 返回能力摘要表。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "意图/关键词；空则列能力摘要" },
        server: { type: "string", description: "可选：@<root>/<server> 全名过滤" },
        limit: { type: "number", description: "返回条数上限（默认 5，上限 10）" },
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          results: { type: "array", items: {} },
          unavailable: { type: "array", items: {} },
        },
        required: ["results", "unavailable"],
        additionalProperties: false,
      },
      render(_args, value: unknown) {
        const v = (value ?? {}) as { results?: Array<Record<string, unknown>>; unavailable?: Array<Record<string, unknown>> };
        const lines = (v.results ?? []).map((hit) => {
          const server = String(hit.server ?? "");
          const tool = String(hit.tool ?? "");
          const description = String(hit.description ?? "");
          return `${server}/${tool}: ${description}`;
        });
        const body = lines.length > 0 ? lines.join("\n") : "（当前工作空间没有匹配的 MCP 工具）";
        const unavailable = (v.unavailable ?? []).map((entry) => `${String(entry.server ?? "")}: ${String(entry.reason ?? "")}`);
        return [{ type: "text", text: unavailable.length > 0 ? `${body}\n\n不可用服务器：\n${unavailable.join("\n")}` : body }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_search: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const query = typeof params.query === "string" ? params.query : "";
      const serverFilter = typeof params.server === "string" ? params.server : undefined;
      const requested = typeof params.limit === "number" ? Math.floor(params.limit) : 5;
      const limit = Math.max(1, Math.min(requested, 10));
      const unit = await mw.projectUnitFor(root);
      if (unit === undefined) {
        return { results: [], unavailable: [] };
      }
      // 等待 in-flight 连接/发现（预算内），再搜索。
      await waitForDiscovery(unit);
      const roots = visibleRoots(root);
      // all 模式：@global 单元可能尚未触达（无 cwd 会话已由 resolveRoot 触达；
      // 有 cwd 会话需显式触达一次，保证全局服务器目录可用）。
      for (const visible of roots) {
        if (visible !== root) await mw.projectUnitFor(visible);
      }
      const { results, unavailable } = searchCatalogMulti(mw.units, roots, query, limit);
      const filtered = serverFilter === undefined ? results : results.filter((hit) => hit.server === serverFilter);
      return { results: filtered, unavailable };
    },
  };

  const call: ToolDefinition = {
    name: "ws_mcp_call",
    description: "调用当前工作空间的一个 MCP 工具。server/tool 来自 ws_mcp_search 返回（已知时可直呼，免搜索）。",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "必须：@<root>/<server> 全名（来自 ws_mcp_search）" },
        tool: { type: "string", description: "必须：远端工具裸名（来自 ws_mcp_search）" },
        arguments: { type: "object", additionalProperties: true, description: "参数，匹配 ws_mcp_search 返回的 inputSchema" },
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
      render(_args, value: unknown) {
        const v = (value ?? {}) as { content?: unknown };
        const content = Array.isArray(v.content) ? v.content : [];
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block !== "object" || block === null) {
            parts.push("[unsupported MCP content]");
            continue;
          }
          const rec = block as Record<string, unknown>;
          if (rec.type === "text" && typeof rec.text === "string") {
            parts.push(rec.text);
            continue;
          }
          if (rec.type === "resource" || rec.type === "resource_link") {
            parts.push("[resource: content discarded]");
            continue;
          }
          parts.push(`[${String(rec.type ?? "unknown")} content]`);
        }
        return [{ type: "text", text: parts.length > 0 ? parts.join("\n") : "(MCP tool returned no content)" }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: CONNECT_TIMEOUT_MS + DISCOVERY_TIMEOUT_MS + CALL_TIMEOUT_MS + 5000,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_call: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const server = typeof params.server === "string" ? params.server : "";
      const tool = typeof params.tool === "string" ? params.tool : "";
      if (server === "" || tool === "") throw new Error("ws_mcp_call: server 与 tool 均为必填");
      const parsed = parseFullServerName(server);
      // all 模式放行 @global root（全局配置跨工作空间共享，语义成立）；
      // 仍拒绝非当前 root 的其他项目 root（防跨空间串台）。
      const allowedRoot = mode === "all" ? "@global" : undefined;
      if (parsed === undefined || (parsed.root !== root && parsed.root !== allowedRoot)) {
        throw new Error(
          `ws_mcp_call: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
        );
      }
      const unit = await mw.projectUnitFor(parsed.root);
      if (unit === undefined) throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(parsed.root)} 无项目级 MCP 配置`);
      await mw.ensureConnected(parsed.root, parsed.server);
      return mw.callTool(server, tool, params.arguments, exec.signal);
    },
  };

  const list: ToolDefinition = {
    name: "ws_mcp_list",
    description:
      "完整盘点当前工作空间的 MCP 服务器与每台服务器全部工具（不受关键词/limit 截断；工具数受 perServerLimit 保护）。先 ws_mcp_list 全量盘点，再 ws_mcp_detail 查单工具完整 schema，需要执行时 ws_mcp_call。空返回 message 说明原因（未配置或发现中）。",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "可选：@<root>/<server> 全名或裸名过滤（全名 root 不属于当前工作空间 → 抛路由一致性错误）",
        },
        perServerLimit: {
          type: "number",
          description: `可选：每服务器工具条数上限（默认 ${LIST_DEFAULT_TOOLS_PER_SERVER}，上限 ${LIST_MAX_TOOLS_PER_SERVER}；超过置 toolsTruncated=true，模型可按需调大）`,
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
      render(_args, value: unknown) {
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
        const lines = servers.map((entry) => {
          const server = String(entry.server ?? "");
          const tools = Array.isArray(entry.tools) ? (entry.tools as Array<Record<string, unknown>>) : [];
          const head = tools.length > 0 ? `${server}（${tools.length} 个工具）：\n${tools.map((t) => `  - ${String(t.tool ?? "")}: ${String(t.description ?? "")}`).join("\n")}` : `${server}（0 个工具）`;
          const disabled = entry.disabled === true ? " [disabled]" : "";
          const unavailable = typeof entry.unavailable === "string" && entry.unavailable !== "" ? ` [unavailable: ${entry.unavailable}]` : "";
          const truncated = entry.toolsTruncated === true ? " [toolsTruncated: 工具数已达上限，可调大 perServerLimit 后重试]" : "";
          return `${head}${disabled}${unavailable}${truncated}`;
        });
        const prefix = `工作空间 ${String(v.workspace ?? "")}（mode=${String(v.mode ?? "")}）：共 ${String(v.totalServers ?? 0)} 台服务器 / ${String(v.totalTools ?? 0)} 个工具`;
        const body = lines.length > 0 ? lines.join("\n\n") : String(v.message ?? "（当前工作空间没有 MCP 服务器）");
        const truncated = v.toolsTruncated === true ? "\n（部分服务器工具清单被截断，可按需调大 perServerLimit）" : "";
        return [{ type: "text", text: `${prefix}\n\n${body}${truncated}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_list: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const serverFilter = typeof params.server === "string" && params.server !== "" ? params.server : undefined;
      const requested = typeof params.perServerLimit === "number" ? Math.floor(params.perServerLimit) : LIST_DEFAULT_TOOLS_PER_SERVER;
      const toolLimit = Math.max(1, Math.min(requested, LIST_MAX_TOOLS_PER_SERVER));
      const unit = await mw.projectUnitFor(root);
      if (unit === undefined) {
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
      await waitForDiscovery(unit);
      const roots = visibleRoots(root);
      for (const visible of roots) {
        if (visible !== root) await mw.projectUnitFor(visible);
      }
      const emptyHint =
        mode === "all"
          ? "当前工作空间没有可用 MCP 服务器（项目级与全局均未发现；若刚添加配置，请稍后重试）"
          : "当前工作空间没有可用 MCP 服务器（未配置项目级服务器；若刚添加配置，请稍后重试）";
      return listCatalog(mw.units, roots, serverFilter, toolLimit, mode, emptyHint);
    },
  };

  const detail: ToolDefinition = {
    name: "ws_mcp_detail",
    description:
      "按 @<root>/<server> + tool 裸名精确查询单个 MCP 工具的完整详情（完整 inputSchema：properties/required/enum/description），不受关键词与 limit 截断。server/tool 来自 ws_mcp_list / ws_mcp_search 返回。错误三分：server 发现失败（附原因）/ server 未连接或未发现 / tool 不存在。",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "必须：@<root>/<server> 全名（来自 ws_mcp_list / ws_mcp_search）" },
        tool: { type: "string", description: "必须：远端工具裸名（兼容 mcp__<server>__<tool> 前缀）" },
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
      render(_args, value: unknown) {
        const v = (value ?? {}) as { server?: unknown; tool?: unknown; description?: unknown; inputSchema?: unknown; fresh?: unknown; disabled?: unknown };
        const server = String(v.server ?? "");
        const tool = String(v.tool ?? "");
        const description = typeof v.description === "string" && v.description !== "" ? v.description : "（无描述）";
        const schema = v.inputSchema === undefined ? "{}" : JSON.stringify(v.inputSchema, null, 2);
        const fresh = v.fresh === true ? "fresh" : "stale";
        const disabled = v.disabled === true ? " [disabled]" : "";
        return [{ type: "text", text: `${server}/${tool}（${fresh}${disabled}）：${description}\n\ninputSchema:\n${schema}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec: { signal?: AbortSignal; agent?: unknown }) {
      const root = await resolveRoot(exec.agent);
      if (root === undefined) throw new Error("ws_mcp_detail: 无法确定工作空间，请先选择工作区");
      const params = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const server = typeof params.server === "string" ? params.server : "";
      const tool = typeof params.tool === "string" ? params.tool : "";
      if (server === "" || tool === "") throw new Error("ws_mcp_detail: server 与 tool 均为必填");
      // all 模式放行 @global root（与 ws_mcp_call 同口径）。
      const parsed = parseFullServerName(server);
      const allowedRoot = mode === "all" ? "@global" : undefined;
      if (parsed === undefined || (parsed.root !== root && parsed.root !== allowedRoot)) {
        throw new Error(
          `ws_mcp_detail: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
        );
      }
      const unit = await mw.projectUnitFor(parsed.root);
      if (unit !== undefined) await waitForDiscovery(unit);
      return findToolDetail(mw.units, parsed.root, server, tool);
    },
  };

  disposers.push(ctx.tools.register(search));
  disposers.push(ctx.tools.register(call));
  disposers.push(ctx.tools.register(list));
  disposers.push(ctx.tools.register(detail));

  // 策略 guard 层（方案 v2）：tools/pre-execute 全局唯一执行点，防其他插件/
  // 入口绕行 ws_mcp_call 直接调用远端工具。对 ws_mcp_call 的调用统一过策略
  // （deny 优先）；其余工具放行（不干扰 mcp__ 直呼兼容路径；ws_mcp_list /
  // ws_mcp_detail 纯读本地目录，与 ws_mcp_search 一致不触达策略 guard）。
  if (typeof ctx.on === "function") {
    const guardDispose = ctx.on(
      "tools/pre-execute",
      async (exec: { name?: string; arguments?: unknown }, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        if (exec?.name !== "ws_mcp_call") return next();
        const params = (typeof exec.arguments === "object" && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>;
        const server = typeof params.server === "string" ? params.server : "";
        const tool = typeof params.tool === "string" ? params.tool : "";
        const parsed = parseFullServerName(server);
        if (parsed === undefined || parsed.server === "") return next();
        // 策略键支持全名（@root/server）或裸名。
        const policyKey = fullServerName(parsed.root, parsed.server);
        if (!policyAllows(mw.policy, policyKey, tool)) {
          const reason = policyDenialReason(mw.policy, policyKey, tool);
          return { kind: "deny", reason: reason ?? `ws_mcp_call: 工具被策略拒绝` };
        }
        return next();
      },
    );
    disposers.push(guardDispose);
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
