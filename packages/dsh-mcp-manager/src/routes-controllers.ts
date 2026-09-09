/**
 * dsh-mcp-manager — 路由控制器工厂（#592 阶段二 Batch A：makeRoutes 消峰）。
 *
 * 每个控制器是「buildXxxRoute(manager, helpers) → WebRoute」形态的纯工厂：
 * 拆分前 makeRoutes 单函数圈复杂度 84（全仓第一），复杂度全部来自内联在各
 * 路由 handler 闭包中的方法分流与字段校验分支；拆分后 makeRoutes 退化为
 * 数组装配（comp <= 15），每个控制器的分支彼此独立、可独立理解与测试。
 *
 * 行为约束（与拆分前逐字节等价）：
 * - 路由路径沿用 ROUTES 常量单一事实源；
 * - loopback 围栏与 405 分流顺序不变（#473 R2：config GET 豁免 loopback，
 *   白名单外方法先于 loopback 直接 405）；
 * - JSON body 字节上限沿用 readJsonBody 默认行为（MAX_JSON_BODY_BYTES 保留
 *   兼容导出，历史上为显式上限占位）。
 */

import { writeJson, readJsonBody, guardLoopbackMethod } from "../../../shared/host-utils.js";
import { parseClaudeJson } from "./import.ts";
import { SCOPE_PROJECT, normalizeScope } from "./scope.ts";
import { parseFullServerName, MIDDLEWARE_GLOBAL_ROOT, normalizeToolName } from "./middleware-utils.ts";
import { normalizeMiddlewareMode } from "./middleware-const.ts";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoutesManager } from "./routes.ts";
import { queryParam } from "./routes-helpers.ts";

/** 控制器共享 helpers（原 makeRoutes 闭包三件套，提升为显式参数）。 */
export interface RouteHelpers {
  handleError(res: ServerResponse, error: unknown): void;
  scopeParam(url: URL): string;
  maybeSession(url: URL): Promise<void>;
}

type Req = IncomingMessage;
type Res = ServerResponse;

/** 提取 name 查询参数；缺失时写 400 并返回 undefined。 */
function requireNameParam(url: URL, res: Res): string | undefined {
  const name = queryParam(url, "name");
  if (name === undefined || name === "") {
    writeJson(res, 400, { error: "name query parameter is required" });
    return undefined;
  }
  return name;
}

// ------------------------------------------------------------ /config

/** 只读 UI 配置 + 中间层模式热切换（GET 豁免 loopback；写操作 loopback-only）。 */
export function buildConfigRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/config",
    handler: async (req: Req, res: Res) => {
      // GET：只读 UI 配置 + 中间层模式（允许非 loopback，供远程页面读取非敏感的展示配置）。
      if (req.method === "GET") {
        try {
          writeJson(res, 200, { ...manager.uiConfig(), middleware: manager.middlewareMode ?? "off" });
        } catch (error) {
          helpers.handleError(res, error);
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
            // B7：非法 middleware 显式 400 拒绝——不得静默回落 off 并热切换+落盘
            // （合法集合与 config-schema z.union 同源，勿只依赖 normalize 兜底）。
            if (rec.middleware !== "off" && rec.middleware !== "project" && rec.middleware !== "all") {
              writeJson(res, 400, { error: `invalid middleware mode: ${rec.middleware}` });
              return;
            }
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
          helpers.handleError(res, error);
        }
        return;
      }
      // 端点级方法分流先于 loopback 的刻意例外（#473 R2 结构 β）：本分支对
      // 白名单外方法（PUT/DELETE/OPTIONS 等）直接 405、不查 loopback——非
      // loopback+PUT 返回 405 而非 403 是契约行为，禁止误套守卫（会漂移为 403）。
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };
}

// ------------------------------------------------------------ /servers

/** 服务器集合 CRUD：GET 快照（纯读）/ POST 添加 / PATCH 更新 / DELETE 删除。 */
export function buildServersRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/servers",
    handler: async (req: Req, res: Res) => {
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
          helpers.handleError(res, error);
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
          helpers.handleError(res, error);
        }
        return;
      }
      if (method === "PATCH" || method === "DELETE") {
        const name = requireNameParam(url, res);
        if (name === undefined) return;
        try {
          await helpers.maybeSession(url);
          const scope = helpers.scopeParam(url);
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
          helpers.handleError(res, error);
        }
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${method}` });
    },
  };
}

// ------------------------------------------------------------ /session 与 /resume

/** 会话切换（跟随会话的项目级 MCP）。 */
export function buildSessionRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/session",
    handler: async (req: Req, res: Res) => {
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
        helpers.handleError(res, error);
      }
    },
  };
}

/** 切回前台受控重建当前工作空间连接。 */
export function buildResumeRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/resume",
    handler: async (req: Req, res: Res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      try {
        if (typeof manager.resumeReconnect !== "function") throw new Error("resumeReconnect unavailable");
        await manager.resumeReconnect();
        writeJson(res, 200, { ok: true, summary: manager.summary() });
      } catch (error) {
        helpers.handleError(res, error);
      }
    },
  };
}

// ------------------------------------------------------------ connect / disconnect / reconnect

/** 单服务器连接/断开/重连三兄弟路由（同构：name 必填 + maybeSession + scope）。 */
function buildNameActionRoute(
  path: string,
  action: (name: string, scope: string) => Promise<void>,
  manager: RoutesManager,
  helpers: RouteHelpers,
): WebRoute {
  return {
    kind: "exact",
    path,
    handler: async (req: Req, res: Res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const name = requireNameParam(url, res);
      if (name === undefined) return;
      try {
        await helpers.maybeSession(url);
        await action(name, helpers.scopeParam(url));
        writeJson(res, 200, { ok: true, summary: manager.summary() });
      } catch (error) {
        helpers.handleError(res, error);
      }
    },
  };
}

/** POST /servers/connect：连接单服务器。 */
export function buildConnectRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return buildNameActionRoute("/api/dsh-mcp/servers/connect", (name, scope) => manager.connect(name, scope), manager, helpers);
}

/** POST /servers/disconnect：断开单服务器。 */
export function buildDisconnectRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return buildNameActionRoute("/api/dsh-mcp/servers/disconnect", (name, scope) => manager.disconnect(name, scope), manager, helpers);
}

/** POST /servers/reconnect：重连单服务器。 */
export function buildReconnectRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return buildNameActionRoute("/api/dsh-mcp/servers/reconnect", (name, scope) => manager.reconnect(name, scope), manager, helpers);
}

// ------------------------------------------------------------ /import/json

/** 导入 mcpServers JSON（同名 skip，overwrite=true 时更新）。 */
export function buildImportJsonRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/import/json",
    handler: async (req: Req, res: Res) => {
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
        helpers.handleError(res, error);
        return;
      }
      writeJson(res, 200, { imported, skipped, summary: manager.summary() });
    },
  };
}

// ------------------------------------------------------------ /tool-disable

/** 工具级禁用开关（PATCH；root 路由一致性校验防跨空间串台）。 */
export function buildToolDisableRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: "/api/dsh-mcp/tool-disable",
    handler: async (req: Req, res: Res) => {
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
      const root = parsed.root;
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
        helpers.handleError(res, error);
      }
    },
  };
}
