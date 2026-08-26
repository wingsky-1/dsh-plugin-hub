/**
 * dsh-mcp-manager — 主机端（组合根）。
 *
 * 管理本机的 MCP（Model Context Protocol）服务器并桥接到 DSH：
 *  - 服务器配置持久化在 `~/.dsh/dsh-mcp.json`（版本化，原子写入）；
 *  - 每个服务器一个连接监督器（supervisor）：stdio / streamable-http 两种
 *    传输，指数退避重连，断开后按预算放弃；
 *  - 已连接服务器的工具以 `mcp__<serverName>__<rawName>` 注册进
 *    `ctx.tools`，模型可直接调用（与官方 dsh-mcp-client 同名契约）；
 *  - `/api/dsh-mcp/*` 路由（loopback-only）供 web GUI 分级展示、快速
 *    接入、粘贴 mcpServers JSON 导入；
 *  - 零运行时依赖：MCP 协议客户端（JSON-RPC over stdio / streamable-http）
 *    直接基于 node:child_process 与全局 fetch 实现。
 *
 * 激活：安装进 profile（见 cordis.patch.yml 注释），重启一次 dsh web 后，
 * 侧边栏出现「MCP」入口。
 *
 * 结构：职责按模块拆分（store / transport / protocol / supervisor /
 * routes / catalog / import），本文件保留插件契约、McpManager、
 * normalizeServer、apply 与各模块的 re-export（导出面不变）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
// 官方类型层（issue #16/#48，锁版见 pnpm-workspace catalog；仅 import type，
// 编译期擦除，禁止运行时值导入——contract-check 有门禁）。
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
// 类型面加载（declare module 合并）：dsh-agent 注入 agent/* 事件（含 pre-step
// waterfall）、dsh-tools 注入 ctx.tools、dsh-system-prompt 注入 ctx.systemPrompt。
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import type { ServerConfig, ClientUiConfig } from "./types.ts";
import type { CatalogCache, CatalogDecision, CatalogMessage, SupervisorLite, CatalogAgent } from "./catalog.ts";

// 组合根内部使用的依赖（re-export 见文件底部）。
import { normalizeServer } from "./normalize.ts";
import {
  Config,
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  normalizeUiConfig,
  buildConfigUiPatch,
} from "./config-schema.ts";
import { McpManager, MIDDLEWARE_GLOBAL_ROOT } from "./manager.ts";
import { defaultStorePath, McpStore } from "./store.ts";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, DEFAULT_RESULT_TRUNCATE_BYTES, ConnectionSupervisor } from "./supervisor.ts";
import {
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  normalizeScope,
} from "./scope.ts";
import {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  summarizeToolDescriptions,
  resolveCatalogInjection,
} from "./catalog.ts";
import { makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame } from "./routes.ts";
import {
  McpMiddleware,
  msgOf,
  normalizeMiddlewareMode,
  registerMiddlewareTools,
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  type MiddlewareMode,
  type ProjectUnit,
} from "./middleware.ts";

/** 稳定的 cordis 插件名。 */
export const name = "mcp-manager";

/** 需要已初始化的工具注册表、web 服务器与提示词组装器。 */
export const inject = ["tools", "webServer", "systemPrompt"];


// 浮窗定位/层级/断点纯函数：实现在 placement-math.ts（零依赖单一事实源，
// 客户端 bundle 与宿主端共用同一份），此处 re-export 保持导出面不变。
export {
  DEFAULT_Z_INDEX_BASE,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  Z_INDEX_PANEL_DELTA,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  clampZIndexBase,
  panelZIndexFor,
  breakpointForWidth,
  clampPointToViewport,
} from "./placement-math.ts";
export type { FloatBreakpoint, ViewportPoint } from "./placement-math.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPosition } from "./placement-math.ts";

// -------------------------------------------------------------- 提示词

/** 向 Agent 宣告插件（announceToAgent 开启时注入）。能力清单由动态目录
 * （<available_mcp_servers>，见 L1）承担，此处只说明管理界面与使用约束。 */
export const MCP_GUIDANCE =
  "本机已安装 dsh-mcp-manager 插件（DSH MCP 管理器）：会话界面右上角浮窗管理 MCP 服务器（全局配置 ~/.dsh/dsh-mcp.json；项目级配置 <项目根>/.dsh/mcp.json，跟随会话切换展示并连接对应项目的服务器；支持 stdio / streamable-http，可粘贴 mcpServers JSON 导入，不预设任何服务器）。已配置服务器的能力清单见会话内的 <available_mcp_servers>（仅描述能力，不代表连接状态）。项目级 MCP 工具经 ws_mcp_search/ws_mcp_call 调用（先用 ws_mcp_search 检索，再 ws_mcp_call 调用）；全局服务器连接后其工具以 mcp__<server>__<tool> 注册可用。限制：MCP 工具在真实服务器上执行，先确认再操作；stdio 服务器的子进程继承宿主权限；工具结果可能含敏感信息。用户提到「MCP / mcp 服务 / 上下文服务器」时即指本插件，请据此协作。";

// -------------------------------------------------------------- 挂载

/**
 * 挂载 MCP 管理器：加载存储、启动已启用服务器、注册路由与提示词。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 宿主插件上下文。
 * @param config 解析后的插件配置。
 */
export async function apply(ctx: Context, config: Record<string, unknown> | undefined): Promise<void> {
  const enabled = config?.enabled !== false;
  const announceToAgent = config?.announceToAgent !== false;
  const storePath = typeof config?.storePath === "string" && config.storePath !== ""
    ? config.storePath
    : defaultStorePath();

  // 感知增强配置（对抗性评审 v2）。默认值引用具名常量（单一事实源）。
  const announceCatalog = (config?.announceCatalog as boolean | undefined) ?? DEFAULT_ANNOUNCE_CATALOG;
  const catalogMaxEntries = Number.isFinite(config?.catalogMaxEntries) && (config?.catalogMaxEntries as number) > 0 ? Math.floor(config?.catalogMaxEntries as number) : DEFAULT_CATALOG_MAX_ENTRIES;
  const enhanceEmptyDescriptions = (config?.enhanceEmptyDescriptions as boolean | undefined) ?? DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS;
  const resultTruncateBytes = Number.isFinite(config?.resultTruncateBytes) && (config?.resultTruncateBytes as number) > 0 ? Math.floor(config?.resultTruncateBytes as number) : DEFAULT_RESULT_TRUNCATE_BYTES;

  const store = new McpStore(storePath);
  await store.load();
  const manager = new McpManager(ctx, store);
  manager.enhancement = { enhanceEmptyDescriptions, resultTruncateBytes };

  // 插件自身 Config schema（标准 cordis 配置注入路径）：position/offset 不再藏于
  // 隐藏命名空间，设置页插件卡可编辑；配置变更经既有 SSE events 通道广播一帧，
  // 客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置（无需重启/轮询）。
  const broadcastUiConfigChanged = () => {
    for (const res of manager.sseConnections ?? []) {
      try {
        res.write(uiConfigChangedFrame());
      } catch {
        // 连接已断，等待 close 事件清理
      }
    }
  };
  installSettingsNamespace(ctx, "dsh-mcp-manager", Config, config ?? {}, {
    setSource: (source) => {
      manager.uiConfigSource = source as () => any;
    },
    onChange: () => {
      broadcastUiConfigChanged();
    },
  });

  // 写入 sink：设置页卡片经 POST /api/dsh-mcp/config 写配置时，通过 settings 服务
  // 的 namespace update 落盘并触发 scope.watch → onChange → SSE 广播。settings 服务
  // 未挂载时 uiUpdate 保持 undefined → 写路由返回「不可写」（卡片/设置页本就不渲染）。
  if (typeof ctx.inject === "function") {
    ctx.inject(["settings"], (sctx) => {
      // sctx 注入 settings 服务（cordis 类型面未声明该服务，经 unknown 中转取最小面）。
      const settings = (sctx as unknown as { settings?: { update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown> } } | undefined)?.settings;
      if (settings && typeof settings.update === "function") {
        // settings.update 是 cordis 服务方法，不绑 this（内部访问 this.write）——直接
        // 解构后调用会丢 this → this.write undefined（回归 #125 保存 400）。这里保留
        // 本地引用并以 call(settings) 把服务对象本身作为 this 传入；同时规避 TS 对
        // 可选属性 settings.update 的收窄在闭包内丢失（2722）。
        const update = settings.update;
        manager.uiUpdate = (patch) => update.call(settings, "dsh-mcp-manager", patch);
      }
    });
  }


  let disposeRoutes = () => {};
  let disposeSection = () => {};
  let disposeInjection = () => {};
  let disposeMiddleware = () => {};
  let watchCleanup: () => void = () => {};

  if (enabled) {
    await manager.startAll();
    await manager.loadCatalogCache();

    // 中间层（ws_mcp_search / ws_mcp_call）：按 Config.middleware 模式注册。
    // project 模式：项目级服务器不再注册 mcp__ 工具，改经中间层路由调用；
    // 全局服务器仍 mcp__ 直呼（双轨迁移默认）。
    // 默认值与 Config schema 一致（project）；宿主未 parse 原始 config 时兜底。
    const middlewareMode = normalizeMiddlewareMode(config?.middleware ?? "project");
    if (middlewareMode !== "off") {
      const mw = await manager.initMiddleware(middlewareMode, (config?.middlewarePolicy as Record<string, unknown> | undefined) ?? {});
      // 路由输入：exec.agent 当前 cwd = agent.session.header.cwd（实证已闭合）。
      // all 模式：cwd 无项目（或无项目配置）时 fallback 到全局虚拟 root @global。
      const resolveRoot = async (agent: unknown): Promise<string | undefined> => {
        if (typeof agent !== "object" || agent === null) return undefined;
        const session = (agent as { session?: { header?: { cwd?: unknown } } }).session;
        const cwd = session?.header?.cwd;
        const root = await manager.normalizedProjectRoot(typeof cwd === "string" ? cwd : undefined);
        if (root !== undefined) return root;
        if (middlewareMode === "all") {
          const globalServers = manager.globalServers().filter((server) => server.enabled !== false);
          if (globalServers.length > 0) return MIDDLEWARE_GLOBAL_ROOT;
        }
        return undefined;
      };
      disposeMiddleware = registerMiddlewareTools(manager.ctx, mw, resolveRoot);
      // startAll 在中间层注册前执行（off 语义），此处立即 reconcile：停掉
      // 项目级（all 含全局）supervisor（改由中间层接管），防同一 server 双进程。
      manager.reconcileServers();
      manager.logger.info(`dsh-mcp-manager: middleware mode=${middlewareMode}`);
    }

    // L1 能力目录注入（history-based 去重，仿 dsh-tool-skill catalog）：
    // 决策逻辑在 resolveCatalogInjection（纯函数，可单测）。
    if (announceCatalog) {
      // 官方强类型 payload：PreStepDecision waterfall（{kind:'reject'}|{kind:'enter';messages}）。
      // 目录决策逻辑在纯函数 resolveCatalogInjection（自建 CatalogDecision 宽面，
      // 可单测），此处仅做边界收窄/放宽。
      disposeInjection = ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
        const decision = await next();
        signal.throwIfAborted();
        // 目录数据源按会话 cwd 计算（工作区缓存），不跟随 host 的"当前工作区"
        // 实时状态——切换工作区不改变本会话目录集合，MCP 没变化就不重复注入。
        const supervisors = await manager.catalogServersFor(agent?.session?.header?.cwd);
        // 边界放宽：纯函数吃自建宽面 CatalogDecision，返回值即本轮 PreStepDecision
        return resolveCatalogInjection(
          decision as unknown as CatalogDecision,
          messages as CatalogMessage[],
          supervisors as Map<string, SupervisorLite>,
          catalogMaxEntries,
          manager.catalogCache,
          agent as unknown as CatalogAgent | undefined
        ) as unknown as PreStepDecision;
      });
    }

    disposeRoutes = ctx.effect(() => {
      const routes = makeRoutes(manager);
      const eventsRoute = makeEventsRoute(manager);
      const healthRoute = makeHealthRoute(manager);
      const disposers = [...routes, eventsRoute, healthRoute].map((route) => ctx.webServer.register(route));
      // 状态变化 → 广播 SSE 帧（连接集合在 makeEventsRoute 中惰性创建）。
      const unsubscribeStatus = manager.onStatus(() => {
        for (const res of manager.sseConnections ?? []) {
          try {
            res.write(sseData({ type: "summary" }));
          } catch {
            // 连接已断，等待 close 事件清理
          }
        }
      });
      return () => {
        unsubscribeStatus();
        for (const dispose of disposers) dispose();
        // 先清 SSE 心跳定时器（#268）：disposer 显式清 interval，不依赖
        // 下方 res.destroy() 触发 close 的异步时序。
        for (const stopHeartbeat of manager.sseHeartbeatCleanups ?? []) stopHeartbeat();
        manager.sseHeartbeatCleanups?.clear();
        for (const res of manager.sseConnections ?? []) {
          try {
            res.destroy();
          } catch {
            // 已关闭
          }
        }
        if (manager.sseConnections !== undefined) manager.sseConnections.clear();
      };
    }, "dsh-mcp-manager: routes");

    // 变更点驱动（#111）：fs.watch 监听全局与当前项目 mcp.json 配置目录，
    // 外部编辑/落盘 → 防重入 reconcile（运行中排队补跑）。取代 mtime 轮询。
    try {
      const fs = await import("node:fs");
      const watchers: Array<{ close(): void }> = [];
      const watched = new Set<string>();
      const watchConfig = (dir: string) => {
        if (watched.has(dir)) return;
        watched.add(dir);
        let busy = false;
        let rerun = false;
        const run = () => {
          if (busy) {
            rerun = true;
            return;
          }
          busy = true;
          void (async () => {
            try {
              await manager.refreshFromDisk();
            } finally {
              busy = false;
              if (rerun) {
                rerun = false;
                run();
              }
            }
          })();
        };
        try {
          const watcher = fs.watch(dir, { persistent: false }, () => run());
          // 目录被删/重命名等场景 FSWatcher 会 emit error；无监听器会抛
          // uncaught exception 崩溃宿主进程（P1 修复）。
          watcher.on("error", () => {
            // 目录消失/权限变化：移除 watcher（配置写路径仍会 reconcile）。
            const index = watchers.indexOf(watcher);
            if (index >= 0) watchers.splice(index, 1);
            try {
              watcher.close();
            } catch {
              // 已关闭
            }
          });
          watchers.push(watcher);
        } catch {
          // watch 不可用（某些平台/只读目录）：降级无 watcher（写路径仍会 reconcile）。
        }
      };
      watchConfig(dirname(manager.store.path));
      if (manager.projectStore !== undefined) watchConfig(dirname(manager.projectStore.path));
      // 会话切换时项目 store 变化 → 重新挂 watcher。
      const unwatchProject = manager.onStatus(() => {
        if (manager.projectStore !== undefined) watchConfig(dirname(manager.projectStore.path));
      });
      watchCleanup = () => {
        unwatchProject();
        for (const watcher of watchers.splice(0)) {
          try {
            watcher.close();
          } catch {
            // 已关闭
          }
        }
      };
    } catch {
      // fs.watch 不可用：保持既有行为（写路径仍会 reconcile）。
    }
    if (announceToAgent) {
      // 官方 SystemPrompt.section(opts) 签名（PromptSection）；此处传参满足其形状，
      // 经 unknown 中转以维持局部最小面写法。
      disposeSection = (ctx.systemPrompt as unknown as { section(opts: Record<string, unknown>): () => void }).section({
        name: "plugin:dsh-mcp-manager",
        order: 160,
        text: MCP_GUIDANCE,
      });
    }
  }

  ctx.effect(() => () => {
    disposeInjection();
    disposeSection();
    disposeRoutes();
    disposeMiddleware();
    watchCleanup();
    void manager.dispose();
  }, "dsh-mcp-manager: dispose");
}

// ------------------------------------------------------------ re-export
// 导出面与拆分前 lib/index.js 完全一致（smoke 验收契约）。

// 服务器配置归一化（纯函数单一事实源）
export { SERVER_NAME_PATTERN, normalizeServer } from "./normalize.ts";

// 插件 Config schema 与配置归一化（类型自 types.ts 取）
export {
  DEFAULT_UI_CONFIG,
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
} from "./config-schema.ts";
export type { UiPlacementConfig, ClientUiConfig } from "./types.ts";

// 管理器 / 中间层全局虚拟 root
export { McpManager, MIDDLEWARE_GLOBAL_ROOT } from "./manager.ts";

// 存储
export { defaultStorePath, McpStore } from "./store.ts";
// 传输
export { expandEnv, HttpTransport, parseSsePayload, StdioTransport, createTransport } from "./transport.ts";
// 协议
export { MCPClient } from "./protocol.ts";
// 连接监督器 / 工具定义（含命名、截断、schema 校验）
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  RECONNECT_DEFAULTS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  ConnectionSupervisor,
  resolveReconnect,
} from "./supervisor.ts";
// 能力目录 / 目录缓存
export {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  summarizeToolDescriptions,
  composeCatalogEntries,
  digestCatalogEntries,
  renderMcpCatalogMessage,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
} from "./catalog.ts";
// mcpServers JSON 导入
export { fromClaudeEntry, parseClaudeJson } from "./import.ts";
// 中间层（工作空间 MCP 路由：连接池 / 目录 / ws_mcp_search / ws_mcp_call）
export {
  McpMiddleware,
  normalizeMiddlewareMode,
  registerMiddlewareTools,
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeArguments,
  msgOf,
  createRedactor,
  globMatch,
  policyAllows,
  policyDenialReason,
  scoreTool,
  searchCatalog,
  withTimeout,
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
} from "./middleware.ts";
// 路由
export { ROUTES, makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame, broadcastFrame, SSE_HEARTBEAT_MS, SSE_PING_FRAME } from "./routes.ts";
export { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./scope.ts";
// 仓库共享层（loopback 围栏 / writeJson / readJsonBody）
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readJsonBody } from "../../../shared/host-utils.js";
