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
import type { MiddlewareMode } from "./middleware-types.ts";
import { makeRoutes, makeEventsRoute, makeHealthRoute, uiConfigChangedFrame } from "./routes.ts";
import { sseData } from "../../../shared/host-utils.js";

/** 向 Agent 宣告插件（announceToAgent 开启时注入）。能力清单由动态目录
 * （<available_mcp_servers>，见 L1）承担，此处只保留插件存在、安全边界与术语约定，
 * 不再复述 UI 配置路径与调用流程（那部分由能力目录与中间层工具描述承担）。 */
export const MCP_GUIDANCE =
  "本机已安装 dsh-mcp-manager（DSH MCP 管理器）：统一管理 MCP 服务器连接，不预设任何服务器。MCP 工具在真实服务器上执行，stdio 子进程继承宿主权限，结果可能含敏感信息——涉及写/敏感操作先向用户说明并征得同意。用户提到「MCP / mcp 服务 / 上下文服务器」即指本插件；已配置服务器与调用规则见会话内的能力目录。";

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
      // 注入面（内存态不落盘，同名幂等；toolDefinitions 可选封装定义透传 supervisor）
      registerServer: (server: Record<string, unknown>) => manager.registerServer(server),
      unregisterServer: (name: string) => manager.unregisterServer(name),
      // 控制面（通用 MCP 生命周期：注册即连、注销即断的补充控制）
      connect: (name: string, scope?: string) => manager.connect(name, scope),
      disconnect: (name: string, scope?: string) => manager.disconnect(name, scope),
      reconnect: (name: string, scope?: string) => manager.reconnect(name, scope),
      // 查询面（服务状态感知：连接状态 / 工具列表 / 全量摘要）
      getStatus: (name: string) => {
        const servers = (manager.summary().servers ?? []) as Array<Record<string, unknown>>;
        const found = servers.find((s) => s.name === name);
        if (found === undefined) return undefined;
        return found as unknown as import("../../../shared/mcp-manager-service.js").McpServerSummary;
      },
      getTools: (name: string) => {
        // 契约（#382 F4）：getTools 返回**注册名**（mcp__<server>__<tool> 前缀，
        // 与 ctx.tools 注册表一致）；summary().tools 返回**裸名**（展示/禁用表
        // 键口径）。消费方按需自取，勿混用两套键。
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
    // #515：广播收口到共享 hub（未创建 = 尚无 events 订阅，跳过）。
    manager.sseHub?.broadcast(uiConfigChangedFrame());
  };
  // #389：把 settings 命名空间合并面（含用户层保存的 middleware）同步到运行时。
  // 保存路径（routes POST config middleware 分支）写 settings 用户层；apply 启动
  // 读的是组合层 config.middleware（不含用户层覆盖）→ 重启后模式回退 project。
  // 此函数在 settings 注入完成/变化（onChange）与 apply 主体就绪（setMiddlewareMode
  // 赋值后）两处调用：前者覆盖运行期变更，后者覆盖启动时 settings 已就绪的场景。
  const syncMiddlewareFromSettings = (): void => {
    if (typeof manager.setMiddlewareMode !== "function") return;
    const source = manager.uiConfigSource();
    const persisted = typeof source === "object" && source !== null ? (source as Record<string, unknown>).middleware : undefined;
    if (typeof persisted !== "string") return;
    const next = normalizeMiddlewareMode(persisted);
    if (next === manager.middlewareMode) return;
    void manager.setMiddlewareMode(next).catch((error: unknown) => manager.logger.warn(`dsh-mcp-manager: sync middleware from settings failed: ${String(error)}`));
  };
  installSettingsNamespace(ctx, "dsh-mcp-manager", Config, config ?? {}, {
    setSource: (source) => {
      manager.uiConfigSource = source as () => any;
    },
    onChange: () => {
      broadcastUiConfigChanged();
      syncMiddlewareFromSettings();
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
    // F3（#382）：中间层初始化提前到 startAll 之前——start 内部的接管判定
    // （middlewareTakes）依赖 middleware 实例与模式；此前 startAll 先建全部
    // supervisor、中间层初始化完才 reconcile 停掉（all 含全局），「先建后停」
    // 的竞态窗口内 mcp__ 注册残留，中间层防双进程探测命中且无重试 → 热更新后
    // 全局服务器掉线。重排后 all 模式启动直接走 @global 单元惰性连接，不建
    // supervisor；project 模式全局照旧 supervisor。
    // 默认值与 Config schema 一致（project）；宿主未 parse 原始 config 时兜底。
    // #389 M2：settings 合并面（scope.get()）就绪时直接取持久化的 middleware 模式，
    // 避免「先按 config 默认 project 起 supervisor、再热切换 all」的启动抖动（连→断→连）。
    // settings 不可用/未注入时 uiConfigSource 为默认值（无 middleware）→ 回落 config。
    const settingsSource = manager.uiConfigSource();
    const persistedMiddleware =
      typeof settingsSource === "object" && settingsSource !== null
        ? (settingsSource as Record<string, unknown>).middleware
        : undefined;
    const middlewareMode = normalizeMiddlewareMode(
      typeof persistedMiddleware === "string" ? persistedMiddleware : config?.middleware ?? "project",
    );
    // 路由输入：exec.agent 当前 cwd = agent.session.header.cwd（实证已闭合）。
    // all 模式：cwd 无项目（或无项目配置）时 fallback 到全局虚拟 root @global。
    const resolveRoot = async (agent: unknown): Promise<string | undefined> => {
      if (typeof agent !== "object" || agent === null) return undefined;
      const session = (agent as { session?: { header?: { cwd?: unknown } } }).session;
      const cwd = session?.header?.cwd;
      const root = await manager.normalizedProjectRoot(typeof cwd === "string" ? cwd : undefined);
      if (root !== undefined) return root;
      if (manager.middlewareMode === "all") {
        const globalServers = manager.globalServers().filter((server) => server.enabled !== false);
        if (globalServers.length > 0) return MIDDLEWARE_GLOBAL_ROOT;
      }
      return undefined;
    };
    if (middlewareMode !== "off") {
      const mw = await manager.initMiddleware(middlewareMode, (config?.middlewarePolicy as Record<string, unknown> | undefined) ?? {});
      disposeMiddleware = registerMiddlewareTools(manager.ctx, mw, resolveRoot, middlewareMode, {
        disabledTools: manager.disabledTools,
      });
    }
    await manager.startAll();
    await manager.loadCatalogCache();
    manager.reconcileServers();
    manager.logger.info(`dsh-mcp-manager: middleware mode=${middlewareMode}`);

    // 中间层模式热切换（设置页「中间层模式」下拉；initMiddleware 幂等已有，
    // off↔project/all 需重新注册/卸载中间层工具——dispose 后重建）。
    // 注册在模式分支之外：启动即 off 时也能从设置页切到 project/all。
    manager.setMiddlewareMode = async (mode: MiddlewareMode): Promise<void> => {
      if (normalizeMiddlewareMode(mode) === manager.middlewareMode) return;
      const next = normalizeMiddlewareMode(mode);
      manager.middlewareMode = next;
      disposeMiddleware();
      if (next !== "off") {
        const mw = await manager.initMiddleware(next, (config?.middlewarePolicy as Record<string, unknown> | undefined) ?? {});
        disposeMiddleware = registerMiddlewareTools(manager.ctx, mw, resolveRoot, next, {
          disabledTools: manager.disabledTools,
        });
      }
      // off ↔ project/all：重注册/卸载中间层工具后 reconcile——all 模式下全局
      // supervisor 由 reconcile 停掉、新全局条目经 start 内部接管触达 @global
      // 单元（#382 F3）；off 语义停掉全部中间层接管条目。防同一 server 双进程。
      manager.reconcileServers();
      manager.logger.info(`dsh-mcp-manager: middleware mode=${next} (hot-switched)`);
    };
    // #389：启动阶段把 settings 持久化的 middleware 模式同步到运行时——apply 主体
    // 完成、setMiddlewareMode 已挂载后主动同步一次（onChange 若早于此处触发会被
    // typeof 守卫跳过，这里兜底）。settings 不可用时 uiConfigSource 无 middleware，
    // 读取结果为 undefined → 保持 config 默认，行为与历史一致。
    syncMiddlewareFromSettings();

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
          // 热切换后目录文案按当前模式渲染（#362 设置页中间层模式下拉）。
          manager.middlewareMode,
        ) as unknown as PreStepDecision;
      });
    }

    disposeRoutes = ctx.effect(() => {
      const routes = makeRoutes(manager);
      const eventsRoute = makeEventsRoute(manager);
      const healthRoute = makeHealthRoute(manager);
      const disposers = [...routes, eventsRoute, healthRoute].map((route) => ctx.webServer.register(route));
      // 状态变化 → 广播 SSE 帧（hub 在 makeEventsRoute 中惰性创建，#515）。
      const unsubscribeStatus = manager.onStatus(() => {
        manager.sseHub?.broadcast(sseData({ type: "summary" }));
      });
      return () => {
        unsubscribeStatus();
        for (const dispose of disposers) dispose();
        // #515：hub.dispose() 统一停心跳 + destroy 全部连接（幂等，不依赖
        // close 事件异步时序）；取代旧 sseHeartbeatCleanups 逐连接清理。
        manager.sseHub?.dispose();
        manager.sseHub = undefined;
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