/**
 * dsh-mcp-manager — 中间层工具注册（ws_mcp_search / ws_mcp_call + 策略 guard）。
 *
 * 注册两个中间层工具与策略 guard 层；类型自 middleware-types.ts 取，
 * 连接池类（McpMiddleware）自 middleware.ts import type（防运行值环）。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, PreToolDecision } from "@deepseek-ai/dsh-tools";
import type { McpMiddleware } from "./middleware.ts";
import { CONNECT_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS, CALL_TIMEOUT_MS } from "./middleware-const.ts";
import { withTimeout, searchCatalog, parseFullServerName, fullServerName, policyAllows, policyDenialReason } from "./middleware-utils.ts";

/**
 * 注册 ws_mcp_search / ws_mcp_call 两个中间层工具。
 * @param host 中间层宿主。
 * @param mw 中间层实例。
 * @param resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。
 */
export function registerMiddlewareTools(
  ctx: Context,
  mw: McpMiddleware,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
): () => void {
  const disposers: Array<() => void> = [];

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
      const inflight = [...unit.inFlight.values()];
      if (inflight.length > 0) {
        try {
          await withTimeout(Promise.allSettled(inflight), 8000, "等待连接/发现超时");
        } catch {
          // 超时不阻塞搜索（返回已有目录）
        }
      }
      const { results, unavailable } = searchCatalog(mw.units, root, query, limit);
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
      if (parsed === undefined || parsed.root !== root) {
        throw new Error(
          `ws_mcp_call: server ${JSON.stringify(server)} 不属于当前工作空间 ${JSON.stringify(root)}；路由一致性校验失败（防跨空间串台）`,
        );
      }
      // 确保连接已建立（等待 in-flight + 单次连接）。
      const unit = await mw.projectUnitFor(root);
      if (unit === undefined) throw new Error(`ws_mcp_call: 工作空间 ${JSON.stringify(root)} 无项目级 MCP 配置`);
      await mw.ensureConnected(root, parsed.server);
      return mw.callTool(server, tool, params.arguments, exec.signal);
    },
  };

  disposers.push(ctx.tools.register(search));
  disposers.push(ctx.tools.register(call));

  // 策略 guard 层（方案 v2）：tools/pre-execute 全局唯一执行点，防其他插件/
  // 入口绕行 ws_mcp_call 直接调用远端工具。对 ws_mcp_call 的调用统一过策略
  // （deny 优先）；其余工具放行（不干扰 mcp__ 直呼兼容路径）。
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