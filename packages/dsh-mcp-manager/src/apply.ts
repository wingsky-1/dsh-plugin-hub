/**
 * dsh-mcp-manager — 插件挂载主流程（apply）与工具注册（单一事实源）。
 *
 * 加载存储、启动已启用服务器、注册路由/中间层工具/能力目录/提示词；
 * index.ts 仅 re-export（插件契约转发），apply.ts 不 import index.ts（防循环）。
 */

import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import type { CatalogCache, CatalogDecision, CatalogMessage, SupervisorLite, CatalogAgent } from "./catalog.ts";
import { DEFAULT_ANNOUNCE_CATALOG, DEFAULT_CATALOG_MAX_ENTRIES, resolveCatalogInjection } from "./catalog.ts";
import { Config, DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS } from "./config-schema.ts";
import { McpManager, MIDDLEWARE_GLOBAL_ROOT } from "./manager.ts";
import { defaultStorePath, McpStore } from "./store.ts";
import { DEFAULT_RESULT_TRUNCATE_BYTES } from "./supervisor.ts";
import { normalizeMiddlewareMode, registerMiddlewareTools } from "./middleware.ts";
import { makeRoutes, makeEventsRoute, makeHealthRoute, sseData, uiConfigChangedFrame } from "./routes.ts";

/** 向 Agent 宣告插件（announceToAgent 开启时注入）。能力清单由动态目录
 * （<available_mcp_servers>，见 L1）承担，此处只说明管理界面与使用约束。 */
export const MCP_GUIDANCE =
  "本机已安装 dsh-mcp-manager 插件（DSH MCP 管理器）：会话界面右上角浮窗管理 MCP 服务器（全局配置 ~/.dsh/dsh-mcp.json；项目级配置 <项目根>/.dsh/mcp.json，跟随会话切换展示并连接对应项目的服务器；支持 stdio / streamable-http，可粘贴 mcpServers JSON 导入，不预设任何服务器）。已配置服务器的能力清单见会话内的 <available_mcp_servers>（仅描述能力，不代表连接状态）。项目级 MCP 工具经 ws_mcp_list/ws_mcp_search 检索（先 ws_mcp_list 完整盘点服务器与工具，再按需 ws_mcp_detail 查完整 inputSchema），经 ws_mcp_call 调用（先用 ws_mcp_search 检索，再 ws_mcp_call 调用；已知 server/tool 时可直呼免搜索）；全局服务器连接后其工具以 mcp__<server>__<tool> 注册可用。限制：MCP 工具在真实服务器上执行，先确认再操作；stdio 服务器的子进程继承宿主权限；工具结果可能含敏感信息。用户提到「MCP / mcp 服务 / 上下文服务器」时即指本插件，请据此协作。";

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

  // 核心化服务（官方 storageDomain 模式）：对外暴露 ctx.mcpManager，供其他插件
  // 运行时注入/控制/查询 MCP 服务器。
  // 提供时机：store.load 之后（manager 已就绪）。卸载由 mcp-manager 自身 dispose()
  // 全量清理（含 runtime 条目与 supervisor）。
  // 兼容：fake ctx（单元测试 mock）可能无 provide，可选调用静默降级。
  if (typeof (ctx as unknown as { provide?: unknown }).provide === "function") {
    ctx.provide("mcpManager", {
      // 注入面（内存态不落盘，同名幂等）
      registerServer: (server: Record<string, unknown>) => manager.registerServer(server),
      unregisterServer: (name: string) => manager.unregisterServer(name),
      // 控制面（通用 MCP 生命周期：注册即连、注销即断的补充控制）
      connect: (name: string, scope?: string) => manager.connect(name, scope),
      disconnect: (name: string) => manager.disconnect(name),
      reconnect: (name: string, scope?: string) => manager.reconnect(name, scope),
      // 查询面（服务状态感知：连接状态 / 工具列表 / 全量摘要）
      getStatus: (name: string) => {
        const servers = (manager.summary().servers ?? []) as Array<Record<string, unknown>>;
        const found = servers.find((s) => s.name === name);
        if (found === undefined) return undefined;
        return found as unknown as import("../../../shared/mcp-manager-service.js").McpServerSummary;
      },
      getTools: (name: string) => {
        const sup = manager.supervisors.get(name);
        if (sup === undefined) return [];
        const tools: Array<{ name: string; description?: string }> = [];
        for (const [toolName, meta] of sup.toolMeta ?? new Map()) {
          tools.push({
            name: toolName,
            description: typeof meta?.description === "string" ? meta.description : undefined,
          });
        }
        return tools;
      },
      list: () =>
        (manager.summary().servers ?? []) as unknown as Array<import("../../../shared/mcp-manager-service.js").McpServerSummary>,
    });
  }

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
      disposeMiddleware = registerMiddlewareTools(manager.ctx, mw, resolveRoot, middlewareMode);
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
          agent as unknown as CatalogAgent | undefined,
          middlewareMode,
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