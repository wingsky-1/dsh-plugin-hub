/**
 * dsh-mcp-manager — HTTP 路由（依赖 import 模块与仓库共享层）。
 *
 * /api/dsh-mcp/* 路由（loopback-only）供 web GUI 分级展示、快速接入、
 * 导入 mcpServers JSON；events 为 SSE 状态推送通道。
 * 例外：/api/dsh-mcp/config 是只读 UI 配置接口，允许非 loopback 访问，
 * 便于远程页面读取 position/offset 等非敏感展示配置。
 * 由 lib/index.js 组合根 re-export（ROUTES / makeRoutes）。
 */

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readJsonBody / sseData）。
import { writeJson, readJsonBody, sseData, guardLoopbackMethod } from "../../../shared/host-utils.js";
import { createSseHub } from "../../../shared/sse-hub.js";
import type { SseHub } from "../../../shared/sse-hub.js";
import { parseClaudeJson } from "./import.ts";
import { SCOPE_PROJECT, normalizeScope } from "./scope.ts";
import { parseFullServerName, MIDDLEWARE_GLOBAL_ROOT, normalizeToolName } from "./middleware-utils.ts";
import { normalizeMiddlewareMode } from "./middleware-const.ts";
import type { ServerConfig } from "./types.ts";
import type { ClientUiConfig } from "./index.ts";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ServerResponse } from "node:http";
import type { McpStore } from "./store.ts";

/** routes 使用的 McpManager 最小面（避免 index↔routes 循环 import）。 */
export interface RoutesManager {
  setSession(cwd: string | undefined): Promise<void>;
  refreshFromDisk(): Promise<void>;
  uiConfig(): ClientUiConfig;
  updateUiConfig(raw: unknown): Promise<ClientUiConfig>;
  summary(): Record<string, unknown>;
  add(server: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  update(name: string, patch: Record<string, unknown>, scope?: string): Promise<ServerConfig>;
  remove(name: string, scope?: string): Promise<void>;
  connect(name: string, scope?: string): Promise<void>;
  disconnect(name: string, scope?: string): Promise<void>;
  reconnect(name: string, scope?: string): Promise<void>;
  /** 设置/解除单个工具禁用（工具级，独立于服务器级 enabled）。 */
  setToolDisabled?(root: string, server: string, tool: string, disabled: boolean): Promise<void>;
  /** 中间层模式热切换（apply 注入；缺省不可用）。 */
  setMiddlewareMode?(mode: string): Promise<void>;
  /** 切回前台受控重建当前工作空间连接（apply 注入；缺省不可用）。 */
  resumeReconnect?(): Promise<void>;
  projectStoreOrThrow(): Promise<McpStore>;
  store: McpStore;
  /** 当前会话项目根（tool-disable 路由一致性校验用）。 */
  projectRoot?: string;
  /** 设置命名空间写入 sink（apply 注入；config 写路由落盘用）。 */
  uiUpdate?: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * SSE 连接枢纽（共享 shared/sse-hub，#515）：makeEventsRoute 惰性创建，
   * apply/广播/卸载 disposer 收口到 hub（连接表 + 心跳 + 上限淘汰 +
   * stalled/maxAge 主动回收）。取代旧 sseConnections Set + per-connection
   * 心跳（#268），消除与 dsh-notifier 的不对称。
   */
  sseHub?: SseHub;
  supervisors: Map<string, { status: string; tools: string[] }>;
  catalogCache: Map<string, unknown>;
  /** 中间层模式（off/project/all；health 计数展示用，缺省 off）。 */
  middlewareMode?: string;
  /** 中间层连接池（health 补中间层计数；结构面与 McpMiddleware.units 兼容）。 */
  middleware?: { units: Map<string, { connections: Map<string, { status: string }> }> } | undefined;
}

// ------------------------------------------------------------ HTTP 路由

/** 路由路径清单（与客户端一致）。 */
export const ROUTES = {
  servers: "/api/dsh-mcp/servers",
  config: "/api/dsh-mcp/config",
  session: "/api/dsh-mcp/session",
  resume: "/api/dsh-mcp/resume",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  events: "/api/dsh-mcp/events",
  health: "/api/dsh-mcp/health",
  toolDisable: "/api/dsh-mcp/tool-disable",
};

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** 组装 /api/dsh-mcp/* 路由。cwd 参数仅用于兼容旧调用（不再被路由使用）。 */
export function makeRoutes(manager: RoutesManager, cwd = process.cwd()): WebRoute[] {
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
        // GET：只读 UI 配置 + 中间层模式（允许非 loopback，供远程页面读取非敏感的展示配置）。
        if (req.method === "GET") {
          try {
            writeJson(res, 200, { ...manager.uiConfig(), middleware: manager.middlewareMode ?? "off" });
          } catch (error) {
            handleError(res, error);
          }
          return;
        }
        // POST：写入浮窗 UI 配置（position / offset），或热切换中间层模式
        // （middleware: off/project/all）。写操作只对 loopback 开放；
        // 经设置命名空间落盘（Config.ui），触发 scope.watch → onChange → SSE 广播一帧，
        // 客户端收到后重新 GET /config 就地更新浮窗位置，无需重启/轮询。
        if (req.method === "POST") {
          if (!guardLoopbackMethod(req, res, ["POST"])) return;
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            writeJson(res, 400, { error: "invalid JSON body" });
            return;
          }
          if (typeof body !== "object" || body === null) {
            writeJson(res, 400, { error: "invalid JSON body" });
            return;
          }
          try {
            const rec = body as Record<string, unknown>;
            if (typeof rec.middleware === "string") {
              // 中间层模式热切换：先热生效（当前进程立即切换），再落盘（重启保留）。
              if (typeof manager.setMiddlewareMode === "function") {
                await manager.setMiddlewareMode(rec.middleware);
              }
              if (typeof manager.uiUpdate === "function") {
                await manager.uiUpdate({ middleware: normalizeMiddlewareMode(rec.middleware) });
              }
              writeJson(res, 200, { ...manager.uiConfig(), middleware: manager.middlewareMode ?? "off" });
              return;
            }
            writeJson(res, 200, await manager.updateUiConfig(body));
          } catch (error) {
            handleError(res, error);
          }
          return;
        }
        // 端点级方法分流先于 loopback 的刻意例外（#473 R2 结构 β）：本 else 对
        // 白名单外方法（PUT/DELETE/OPTIONS 等）直接 405、不查 loopback——非
        // loopback+PUT 返回 405 而非 403 是契约行为，禁止误套守卫（会漂移为 403）。
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      },
    },
    {
      kind: "exact",
      path: ROUTES.servers,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
        if (!guardLoopbackMethod(req, res, ["GET", "POST", "PATCH", "DELETE"])) return;
        if (method === "GET") {
          try {
            // 变更点驱动（#111/#228）：GET /servers 是纯读快照，零副作用——
            // 磁盘变更由 fs.watch 事件驱动 reconcile，状态从内存 store 读。
            // 历史 refreshFromDisk 副作用（mtime 轮询 + reconcile）已移除。
            // cwd 查询参数不处理（#324）：GET 带 cwd 曾触发 setSession → emitStatus
            // → SSE 广播 → 客户端再 GET 的自激循环（多页面互踩）。会话切换只走
            // POST /api/dsh-mcp/session；此处忽略 cwd 以恢复纯读语义。
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
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
      path: ROUTES.resume,
      handler: async (req, res) => {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        try {
          if (typeof manager.resumeReconnect !== "function") throw new Error("resumeReconnect unavailable");
          await manager.resumeReconnect();
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
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = queryParam(url, "name");
        if (name === undefined || name === "") {
          writeJson(res, 400, { error: "name query parameter is required" });
          return;
        }
        try {
          await maybeSession(url);
          await manager.disconnect(name, scopeParam(url));
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
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
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
    {
      kind: "exact",
      path: ROUTES.toolDisable,
      handler: async (req, res) => {
        if (!guardLoopbackMethod(req, res, ["PATCH"])) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const body = await readJsonBody(req);
        if (body === undefined || typeof body !== "object" || body === null) {
          writeJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const rec = body as Record<string, unknown>;
        const server = typeof rec.server === "string" ? rec.server : "";
        const tool = typeof rec.tool === "string" ? rec.tool : "";
        const disabled = rec.disabled === true;
        if (server === "" || tool === "") {
          writeJson(res, 400, { error: "server 与 tool 均为必填" });
          return;
        }
        // 路由一致性：server 全名 root 必须属于当前工作空间（或 all 模式 @global）。
        const parsed = parseFullServerName(server);
        if (parsed === undefined) {
          writeJson(res, 400, { error: "server 格式非法，应为 @<root>/<server>" });
          return;
        }
        const root = parsed.root === MIDDLEWARE_GLOBAL_ROOT ? parsed.root : parsed.root;
        const cwdParam = queryParam(url, "cwd");
        if (cwdParam !== undefined && cwdParam !== "") await manager.setSession(cwdParam);
        const sessionRoot = manager.projectRoot;
        const allowed = root === MIDDLEWARE_GLOBAL_ROOT || root === sessionRoot;
        if (!allowed) {
          writeJson(res, 400, { error: `server ${JSON.stringify(server)} 不属于当前工作空间；路由一致性校验失败（防跨空间串台）` });
          return;
        }
        if (typeof manager.setToolDisabled !== "function") {
          writeJson(res, 400, { error: "tool-disable not writable: middleware unavailable" });
          return;
        }
        try {
          // #392 遗留④：tool 参数先归一化（剥 mcp__<server>__ 前缀）再入禁用表——
          // 旧客户端/手工 API 可能提交带前缀名，此前原样存键导致 guard 层查裸名不命中、
          // 禁用静默无效。跨 server 前缀（剥后仍 mcp__ 开头）由 normalizeToolName 抛错。
          const toolName = normalizeToolName(parsed.server, tool, "tool-disable");
          await manager.setToolDisabled(root, parsed.server, toolName, disabled);
          writeJson(res, 200, { ok: true, summary: manager.summary() });
        } catch (error) {
          handleError(res, error);
        }
      },
    },
  ];
}

// --------------------------------------------------------- 状态推送（SSE）

// sseData 已收敛 shared/host-utils.js（#472）：本文件经顶部共享层 import 使用，
// 导出面由组合根 src/index.ts re-export 保持 lib/index.js 不变。

/** 配置变更 SSE 帧：客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置。 */
export function uiConfigChangedFrame(): string {
  return sseData({ type: "ui-config-changed" });
}

/**
 * SSE 心跳间隔：30s data ping（对齐 dsh-notifier HEARTBEAT_MS 形态，#268）。
 * 必须用 data 而非注释帧——注释帧既不触发客户端 onmessage 也不触发 onerror，
 * 半开连接（移动端切后台系统冻结 JS 并静默掐断 TCP）时客户端零事件无法自愈；
 * data 帧喂客户端 60s watchdog 使其能检测失活并关旧建新。
 * #515 起心跳由共享 hub（shared/sse-hub.js）统一管理，本常量保留兼容导出。
 */
export const SSE_HEARTBEAT_MS = 30_000;
/** 心跳 ping 帧（内容固定，模块级缓存避免逐次序列化；#515 起 hub 内置同帧）。 */
export const SSE_PING_FRAME = sseData({ type: "ping" });

/**
 * 向全部 SSE 连接写出一帧（#515 起收口到共享 hub；本函数保留兼容导出，
 * 接受 hub 或旧 Set 形态）。判死/背压由 hub writeFrame 统一处理。
 */
export function broadcastFrame(connections: SseHub | Set<ServerResponse> | undefined, frame: string): void {
  if (!connections) return;
  if (typeof (connections as SseHub).broadcast === "function") {
    (connections as SseHub).broadcast(frame);
    return;
  }
  for (const res of connections as Set<ServerResponse>) {
    try {
      res.write(frame);
    } catch {
      // 连接已断，等待 close 事件清理
    }
  }
}

/**
 * 状态变化推送通道（SSE）：浏览器端 EventSource 订阅，宿主状态变化时
 * 广播 `{ type: "summary" }` 帧（内容不随帧传输，浏览器收到后自行拉取）。
 *
 * #515 起连接管理收口到共享 hub（shared/sse-hub.js）：manager.sseHub 惰性创建
 * （上限淘汰 + 心跳 + stalled/maxAge 主动回收），本路由只负责入表与首帧——
 * 取代旧裸 Set + per-connection 心跳（#268/#515，消除与 dsh-notifier 不对称）。
 *
 * 半开连接防护（#268，对齐 dsh-notifier）：hub 每 30s 向全部连接写 data ping
 * 心跳——移动端切后台系统冻结 JS 并静默掐断 TCP，两端均收不到 FIN/RST，
 * 无心跳则客户端 watchdog 无失活信号可依。
 */
export function makeEventsRoute(manager: RoutesManager, options?: { heartbeatMs?: number; maxConnections?: number }): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      // 惰性创建共享 hub（上限淘汰 + 心跳 + stalled/maxAge 回收）。
      // maxConnections 默认 16（与 dsh-notifier 对齐，#515 评审）；health 路由
      // 若在 events 之前注册会先建 hub，故 hub 创建不含业务副作用。
      const hub = (manager.sseHub ??= createSseHub({
        getMaxConnections: () => options?.maxConnections ?? 16,
        heartbeatMs: options?.heartbeatMs,
        warn: (message) => {
          // 无 logger 注入面，静默（连接回收是自愈路径，无需告警）
        },
      }));
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(sseData({ type: "summary" }));
      hub.register(res);
    },
  };
}

/** 健康检查：插件是否加载、服务器/连接/工具状态（诊断"插件没生效"的标准入口）。 */
export function makeHealthRoute(manager: RoutesManager): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      let servers = 0;
      let connected = 0;
      let tools = 0;
      for (const supervisor of manager.supervisors.values()) {
        servers += 1;
        if (supervisor.status === "connected") connected += 1;
        tools += supervisor.tools.length;
      }
      // 中间层连接池计数（#228：项目级连接不在 supervisors，需单独投影诊断）。
      let middlewareUnits = 0;
      let middlewareConnections = 0;
      let middlewareConnected = 0;
      for (const unit of manager.middleware?.units.values() ?? []) {
        middlewareUnits += 1;
        for (const entry of unit.connections.values()) {
          middlewareConnections += 1;
          if (entry.status === "connected") middlewareConnected += 1;
        }
      }
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-mcp-manager",
        servers,
        connected,
        tools,
        catalogCacheEntries: manager.catalogCache.size,
        middleware: {
          mode: manager.middlewareMode ?? "off",
          units: middlewareUnits,
          connections: middlewareConnections,
          connected: middlewareConnected,
        },
      });
    },
  };
}
