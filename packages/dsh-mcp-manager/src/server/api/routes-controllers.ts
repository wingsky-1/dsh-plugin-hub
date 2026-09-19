/**
 * dsh-mcp-manager — 路由控制器工厂（#592 阶段二 Batch A：makeRoutes 消峰）。
 *
 * 每个控制器是「buildXxxRoute(manager, helpers) → WebRoute」形态的纯工厂：
 * 拆分前 makeRoutes 单函数圈复杂度 84（全仓第一），复杂度全部来自内联在各
 * 路由 handler 闭包中的方法分流与字段校验分支；拆分后 makeRoutes 退化为
 * 数组装配（comp <= 15），每个控制器的分支彼此独立、可独立理解与测试。
 *
 * 行为约束（与拆分前逐字节等价）：
 * - 路由路径与围栏（方法白名单 / loopback 豁免）取自 shared/routes.ts 单点；
 * - loopback 围栏与 405 分流顺序不变（#473 R2：config GET 豁免 loopback，
 *   白名单外方法先于 loopback 直接 405）；
 * - JSON body 字节上限沿用 readJsonBody 的默认行为（历史上那个显式上限
 *   常量 MAX_JSON_BODY_BYTES 已不存在）。
 *
 * 跨域取数一律经 apiPorts（见 deps.ts 与 impl/service），值为模块求值期绑定：
 * installApi 在包入口顶层完成，handler 内的 get() 取到的一定是装配后的能力。
 */

import { writeJson, readJsonBody, guardLoopbackMethod } from "../../../../../shared/host-utils.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoutesManager } from "../connection/interface.ts";
// 跨端契约常量取自共享层门面（物理定义在 shared/constants.ts），不再经 workspace 门面转出。
import {
  MIDDLEWARE_GLOBAL_ROOT,
  SCOPE_PROJECT,
  ROUTES,
  ROUTE_FENCE,
} from "../../shared/interface.ts";
import type { RouteName } from "../../shared/interface.ts";
import { apiPorts } from "./impl/service/index.ts";
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

/**
 * POST /config 接受的顶层键（M7 白名单）：客户端扁平 UI 形态，与
 * `normalizeUiConfig` 的**扁平**读键集同源（`ui`/`offset` 嵌套形态今天没有仓内调用方，
 * 不接受——否则白名单会退化成第三份形状定义）。
 */
const UI_CONFIG_KEYS: readonly string[] = [
  "position",
  "offsetX",
  "offsetY",
  "blankY",
  "zIndexBase",
];

/** UI 配置读写（GET 豁免 loopback；写操作 loopback-only，未知顶层键 400）。 */
export function buildConfigRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req: Req, res: Res) => {
      // GET：只读 UI 配置（允许非 loopback，供远程页面读取非敏感的展示配置）。
      if (ROUTE_FENCE.config.loopbackExempt.includes(String(req.method))) {
        try {
          writeJson(res, 200, manager.uiConfig());
        } catch (error) {
          helpers.handleError(res, error);
        }
        return;
      }
      // POST：写入浮窗 UI 配置（position / offsetX / offsetY / blankY / zIndexBase）。
      // 写操作只对 loopback 开放；经设置命名空间落盘（Config.ui），触发
      // scope.watch → onChange → SSE 广播一帧，客户端收到后重新 GET /config 就地更新
      // 浮窗位置，无需重启/轮询。
      //
      // M7：**未知顶层键一律 400 且不落盘**（校验在任何 uiUpdate 之前）。静默丢键会让
      // 调用方以为写入生效——错就要说错，不能把「没生效」写成 200。
      if (ROUTE_FENCE.config.guarded.includes(String(req.method))) {
        if (!guardLoopbackMethod(req, res, ROUTE_FENCE.config.guarded)) return;
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
          const unknownKeys = Object.keys(rec).filter((key) => !UI_CONFIG_KEYS.includes(key));
          if (unknownKeys.length > 0) {
            writeJson(res, 400, { error: `unknown config key(s): ${unknownKeys.join(", ")}` });
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

/** 服务器集合变更（POST 添加 / PATCH 更新 / DELETE 删除）：写操作面，与 GET 快照分离。
 *
 * 回答「如何变更集合？」——读快照（GET）留在 handler 内，方法分流后写操作整体下沉。
 * 返回 true 表示已处理并应答；false 表示方法不在写集合内（调用方继续 405）。 */
async function handleServersMutation(
  method: string,
  url: URL,
  req: Req,
  res: Res,
  manager: RoutesManager,
  helpers: RouteHelpers,
): Promise<boolean> {
  const { workspace } = apiPorts.get();
  if (method === "POST") {
    const body = await readJsonBody(req);
    if (body === undefined) {
      writeJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    try {
      const rec = body as Record<string, unknown>;
      const scope = workspace.normalizeScope(rec.scope as string);
      if (typeof rec.cwd === "string" && rec.cwd !== "") await manager.setSession(rec.cwd);
      const created = await manager.add(rec, scope);
      // #770-L3 只读投影：200 响应 server 字段不再明文回显写路径原文（与 A3 同一红线伞）。
      // 缺省回落原文：外部 RoutesManager 实现未提供 summarize 时自身无秘密可泄（同 redactError 兼容口径）。
      const server =
        typeof manager.summarize === "function" ? manager.summarize(created, scope) : created;
      writeJson(res, 201, { server, summary: manager.summary() });
    } catch (error) {
      helpers.handleError(res, error);
    }
    return true;
  }
  if (method === "PATCH" || method === "DELETE") {
    const name = requireNameParam(url, res);
    if (name === undefined) return true;
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
          return true;
        }
        const updated = await manager.update(name, body as Record<string, unknown>, scope);
        // #770-L3 只读投影：同 POST 分支（与 A3 同一红线伞；缺省回落原文口径同上）。
        const server =
          typeof manager.summarize === "function" ? manager.summarize(updated, scope) : updated;
        writeJson(res, 200, { server, summary: manager.summary() });
      }
    } catch (error) {
      helpers.handleError(res, error);
    }
    return true;
  }
  return false;
}

/** 服务器集合 CRUD：GET 快照（纯读）/ POST 添加 / PATCH 更新 / DELETE 删除。 */
export function buildServersRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.servers,
    handler: async (req: Req, res: Res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE.servers.guarded)) return;
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
      if (await handleServersMutation(method, url, req, res, manager, helpers)) return;
      writeJson(res, 405, { error: `method not allowed: ${method}` });
    },
  };
}

// ------------------------------------------------------------ /session 与 /resume

/** 会话切换（跟随会话的项目级 MCP）。 */
export function buildSessionRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.session,
    handler: async (req: Req, res: Res) => {
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE.session.guarded)) return;
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
    path: ROUTES.resume,
    handler: async (req: Req, res: Res) => {
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE.resume.guarded)) return;
      try {
        if (typeof manager.resumeReconnect !== "function")
          throw new Error("resumeReconnect unavailable");
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
  route: RouteName,
  action: (name: string, scope: string) => Promise<void>,
  manager: RoutesManager,
  helpers: RouteHelpers,
): WebRoute {
  return {
    kind: "exact",
    path: ROUTES[route],
    handler: async (req: Req, res: Res) => {
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE[route].guarded)) return;
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
  return buildNameActionRoute(
    "connect",
    (name, scope) => manager.connect(name, scope),
    manager,
    helpers,
  );
}

/** POST /servers/disconnect：断开单服务器。 */
export function buildDisconnectRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return buildNameActionRoute(
    "disconnect",
    (name, scope) => manager.disconnect(name, scope),
    manager,
    helpers,
  );
}

/** POST /servers/reconnect：重连单服务器。 */
export function buildReconnectRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return buildNameActionRoute(
    "reconnect",
    (name, scope) => manager.reconnect(name, scope),
    manager,
    helpers,
  );
}

// ------------------------------------------------------------ /import/json

/** 导入 mcpServers JSON（同名 skip，overwrite=true 时更新）。 */
export function buildImportJsonRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.importJson,
    handler: async (req: Req, res: Res) => {
      const { workspace, configModel } = apiPorts.get();
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE.importJson.guarded)) return;
      const body = await readJsonBody(req);
      if (body === undefined || typeof (body as Record<string, unknown>).json !== "string") {
        writeJson(res, 400, { error: "body must include a json string" });
        return;
      }
      const imported: string[] = [];
      const skipped: string[] = [];
      try {
        const rec = body as Record<string, unknown>;
        const scope = workspace.normalizeScope(rec.scope as string);
        if (typeof rec.cwd === "string" && rec.cwd !== "") await manager.setSession(rec.cwd);
        const store = scope === SCOPE_PROJECT ? await manager.projectStoreOrThrow() : manager.store;
        const servers = configModel.parseClaudeJson(rec.json as string);
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

/** 解析 tool-disable 请求体：回答「调用方要禁哪把工具？」——形状与必填校验。
 *
 * 返回携带 server/tool/disabled 的成功体，或写 400 用的错误文案；路由一致性
 * （全名 root 是否属于当前工作空间）与执行留在 handler 内（不同问题）。 */
function parseToolDisableBody(
  body: unknown,
): { ok: true; server: string; tool: string; disabled: boolean } | { ok: false; error: string } {
  if (body === undefined || typeof body !== "object" || body === null) {
    return { ok: false, error: "invalid JSON body" };
  }
  const rec = body as Record<string, unknown>;
  const server = typeof rec.server === "string" ? rec.server : "";
  const tool = typeof rec.tool === "string" ? rec.tool : "";
  const disabled = rec.disabled === true;
  if (server === "" || tool === "") {
    return { ok: false, error: "server 与 tool 均为必填" };
  }
  return { ok: true, server, tool, disabled };
}

/** 工具级禁用开关（PATCH；root 路由一致性校验防跨空间串台）。 */
export function buildToolDisableRoute(manager: RoutesManager, helpers: RouteHelpers): WebRoute {
  return {
    kind: "exact",
    path: ROUTES.toolDisable,
    handler: async (req: Req, res: Res) => {
      const { workspace } = apiPorts.get();
      if (!guardLoopbackMethod(req, res, ROUTE_FENCE.toolDisable.guarded)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = await readJsonBody(req);
      const parsedBody = parseToolDisableBody(body);
      if (!parsedBody.ok) {
        writeJson(res, 400, { error: parsedBody.error });
        return;
      }
      const { server, tool, disabled } = parsedBody;
      // 路由一致性：server 全名 root 必须属于当前工作空间（或 @global）。
      const parsed = workspace.parseFullServerName(server);
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
        writeJson(res, 400, {
          error: `server ${JSON.stringify(server)} 不属于当前工作空间；路由一致性校验失败（防跨空间串台）`,
        });
        return;
      }
      if (typeof manager.setToolDisabled !== "function") {
        writeJson(res, 400, { error: "tool-disable not writable: middleware unavailable" });
        return;
      }
      try {
        // #392 遗留④：tool 参数先归一化（剥 mcp__<id>__ 直呼前缀）再入禁用表——
        // 旧客户端/手工 API 可能提交带前缀名，此前原样存键导致 guard 层查裸名不命中、
        // 禁用静默无效。跨 server 前缀（剥后仍 mcp__ 开头）由 normalizeToolName 抛错。
        const toolName = workspace.normalizeToolName(parsed.server, tool, "tool-disable");
        await manager.setToolDisabled(root, parsed.server, toolName, disabled);
        writeJson(res, 200, { ok: true, summary: manager.summary() });
      } catch (error) {
        helpers.handleError(res, error);
      }
    },
  };
}
