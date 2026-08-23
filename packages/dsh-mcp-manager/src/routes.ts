/**
 * dsh-mcp-manager — HTTP 路由（依赖 import 模块与仓库共享层）。
 *
 * /api/dsh-mcp/* 路由（loopback-only）供 web GUI 分级展示、快速接入、
 * 导入 mcpServers JSON；events 为 SSE 状态推送通道。
 * 由 lib/index.js 组合根 re-export（ROUTES / makeRoutes）。
 */

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readJsonBody）。
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readJsonBody } from "../../../shared/host-utils.js";
import { parseClaudeJson } from "./import.js";
import { SCOPE_PROJECT, normalizeScope } from "./scope.js";
import type { ServerConfig } from "./types.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
import type { McpStore } from "./store.js";

/** routes 使用的 McpManager 最小面（避免 index↔routes 循环 import）。 */
export interface RoutesManager {
  setSession(cwd: string | undefined): Promise<void>;
  refreshFromDisk(): Promise<void>;
  uiConfig(): Record<string, unknown>;
  summary(): Record<string, unknown>;
  add(server: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  update(name: string, patch: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  remove(name: string, scope?: string): Promise<void>;
  connect(name: string, scope?: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  reconnect(name: string, scope?: string): Promise<void>;
  projectStoreOrThrow(): Promise<McpStore>;
  store: McpStore;
  sseConnections?: Set<ServerResponse>;
  supervisors: Map<string, { status: string; tools: string[] }>;
  catalogCache: Map<string, unknown>;
}

// ------------------------------------------------------------ HTTP 路由

/** 路由路径清单（与客户端一致）。 */
export const ROUTES = {
  servers: "/api/dsh-mcp/servers",
  config: "/api/dsh-mcp/config",
  session: "/api/dsh-mcp/session",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  events: "/api/dsh-mcp/events",
  health: "/api/dsh-mcp/health",
};

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** 组装 /api/dsh-mcp/* 路由。cwd 参数仅用于兼容旧调用（不再被路由使用）。 */
export function makeRoutes(manager: RoutesManager, cwd = process.cwd()): WebRoute[] {
  const guard = (req: Parameters<WebRoute["handler"]>[0], res: Parameters<WebRoute["handler"]>[1], method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "forbidden: loopback-only" });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  };
  const handleError = (res: Parameters<WebRoute["handler"]>[1], error: unknown) => {
    writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  };
  /** 解析 scope 查询参数（缺省 global）。 */
  const scopeParam = (url: URL) => (normalizeScope(queryParam(url, "scope") ?? ""));
  /** 若带 cwd 参数则先切换会话（跟随会话的项目级 MCP）。 */
  const maybeSession = async (url: URL): Promise<void> => {
    const cwdParam = queryParam(url, "cwd");
    if (cwdParam !== undefined && cwdParam !== "") await manager.setSession(cwdParam);
  };

  return [
    {
      kind: "exact",
      path: ROUTES.config,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          writeJson(res, 200, manager.uiConfig());
        } catch (error) {
          handleError(res, error);
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES.servers,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: "forbidden: loopback-only" });
          return;
        }
        if (method === "GET") {
          try {
            await maybeSession(url);
            // 浮窗刷新：重读磁盘配置（全局 + 项目，外部修改 mcp.json 自动生效）
            // 并同步连接集合（新增启动 / 移除断开），无需重启宿主。
            await manager.refreshFromDisk();
            writeJson(res, 200, manager.summary());
          } catch (error) {
            handleError(res, error);
          }
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          if (body === undefined) {
            writeJson(res, 400, { error: "invalid JSON body" });
            return;
          }
          try {
            const rec = body as Record<string, unknown>;
            const scope = normalizeScope(rec.scope as string);
            if (typeof rec.cwd === "string" && rec.cwd !== "") await manager.setSession(rec.cwd);
            const server = await manager.add(rec, scope);
            writeJson(res, 201, { server, summary: manager.summary() });
          } catch (error) {
            handleError(res, error);
          }
          return;
        }
        if (method === "PATCH" || method === "DELETE") {
          const name = queryParam(url, "name");
          if (name === undefined || name === "") {
            writeJson(res, 400, { error: "name query parameter is required" });
            return;
          }
          try {
            await maybeSession(url);
            const scope = scopeParam(url);
            if (method === "DELETE") {
              await manager.remove(name, scope);
              writeJson(res, 200, { ok: true, summary: manager.summary() });
            } else {
              const body = await readJsonBody(req);
              if (body === undefined) {
                writeJson(res, 400, { error: "invalid JSON body" });
                return;
              }
              const server = await manager.update(name, body as Record<string, unknown>, scope);
              writeJson(res, 200, { server, summary: manager.summary() });
            }
          } catch (error) {
            handleError(res, error);
          }
          return;
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` });
      },
    },
    {
      kind: "exact",
      path: ROUTES.session,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined || typeof (body as Record<string, unknown>).cwd !== "string") {
          writeJson(res, 400, { error: "body must include a cwd string" });
          return;
        }
        try {
          await manager.setSession((body as Record<string, unknown>).cwd as string);
          writeJson(res, 200, { ok: true, summary: manager.summary() });
        } catch (error) {
          handleError(res, error);
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES.connect,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = queryParam(url, "name");
        if (name === undefined || name === "") {
          writeJson(res, 400, { error: "name query parameter is required" });
          return;
        }
        try {
          await maybeSession(url);
          await manager.connect(name, scopeParam(url));
          writeJson(res, 200, { ok: true, summary: manager.summary() });
        } catch (error) {
          handleError(res, error);
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES.disconnect,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = queryParam(url, "name");
        if (name === undefined || name === "") {
          writeJson(res, 400, { error: "name query parameter is required" });
          return;
        }
        try {
          await maybeSession(url);
          await manager.disconnect(name);
          writeJson(res, 200, { ok: true, summary: manager.summary() });
        } catch (error) {
          handleError(res, error);
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES.reconnect,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = queryParam(url, "name");
        if (name === undefined || name === "") {
          writeJson(res, 400, { error: "name query parameter is required" });
          return;
        }
        try {
          await maybeSession(url);
          await manager.reconnect(name, scopeParam(url));
          writeJson(res, 200, { ok: true, summary: manager.summary() });
        } catch (error) {
          handleError(res, error);
        }
      },
    },
    {
      kind: "exact",
      path: ROUTES.importJson,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined || typeof (body as Record<string, unknown>).json !== "string") {
          writeJson(res, 400, { error: "body must include a json string" });
          return;
        }
        const imported: string[] = [];
        const skipped: string[] = [];
        try {
          const rec = body as Record<string, unknown>;
          const scope = normalizeScope(rec.scope as string);
          if (typeof rec.cwd === "string" && rec.cwd !== "") await manager.setSession(rec.cwd);
          const store = scope === SCOPE_PROJECT ? await manager.projectStoreOrThrow() : manager.store;
          const servers = parseClaudeJson(rec.json as string);
          for (const server of servers) {
            if (store.find(server.name) !== undefined) {
              if (rec.overwrite !== true) {
                skipped.push(server.name);
                continue;
              }
              await manager.update(server.name, server, scope);
              imported.push(server.name);
              continue;
            }
            await manager.add(server, scope);
            imported.push(server.name);
          }
        } catch (error) {
          handleError(res, error);
          return;
        }
        writeJson(res, 200, { imported, skipped, summary: manager.summary() });
      },
    },
  ];
}

// --------------------------------------------------------- 状态推送（SSE）

/** 序列化一帧 SSE data 行。 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 状态变化推送通道（SSE）：浏览器端 EventSource 订阅，宿主状态变化时
 * 广播 `{ type: "summary" }` 帧（内容不随帧传输，浏览器收到后自行拉取）。
 * 连接集合挂在 manager.sseConnections 上（惰性创建），插件卸载时由
 * apply 的清理函数统一 destroy。
 */
export function makeEventsRoute(manager: RoutesManager): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      const connections = manager.sseConnections ??= new Set();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(sseData({ type: "summary" }));
      connections.add(res);
      res.on("close", () => {
        connections.delete(res);
      });
    },
  };
}

/** 健康检查：插件是否加载、服务器/连接/工具状态（诊断"插件没生效"的标准入口）。 */
export function makeHealthRoute(manager: RoutesManager): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      let servers = 0;
      let connected = 0;
      let tools = 0;
      for (const supervisor of manager.supervisors.values()) {
        servers += 1;
        if (supervisor.status === "connected") connected += 1;
        tools += supervisor.tools.length;
      }
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-mcp-manager",
        servers,
        connected,
        tools,
        catalogCacheEntries: manager.catalogCache.size,
      });
    },
  };
}
