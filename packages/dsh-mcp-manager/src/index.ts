/**
 * dsh-mcp-manager — 主机端（组合根）。
 *
 * 管理本机的 MCP（Model Context Protocol）服务器并桥接到 DSH：
 *  - 服务器配置持久化在本插件私有目录（路径与权限的单一事实源是 server/shared/paths.ts，
 *    版本化，原子写入）；
 *  - 每个服务器一个连接监督器（supervisor）：stdio / streamable-http 两种传输，
 *    指数退避重连，断开后按预算放弃；
 *  - 已连接服务器的工具以 mcp__<serverName>__<rawName> 注册进 ctx.tools，模型可直接
 *    调用（与官方 dsh-mcp-client 同名契约）；
 *  - /api/dsh-mcp/* 路由（loopback-only）供 web GUI 分级展示、快速接入、粘贴
 *    mcpServers JSON 导入；
 *  - 零运行时依赖：MCP 协议客户端（JSON-RPC over stdio / streamable-http）直接基于
 *    node:child_process 与全局 fetch 实现。
 *
 * 激活：安装进 profile（见 cordis.patch.yml 注释），重启一次 dsh web 后，侧边栏出现
 * 「MCP」入口。
 *
 * 结构：#767 W11a 起本文件是唯一的组合根与 apply 装配体——静态端口的模块求值期装配、
 * apply 主流程与配置解析、存量存储迁移的接线、包导出面与声明合并都在这里（原
 * src/bootstrap/** 六文件并入；src 顶层只允许 client / index.ts / server / shared 四项）。
 * 各落点域端口化之后才谈把它再拆出去。
 */

// 类型面加载（declare module 合并）：dsh-agent 注入 agent/* 事件（含 pre-step
// waterfall）、dsh-tools 注入 ctx.tools、dsh-system-prompt 注入 ctx.systemPrompt。
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { dirname } from "node:path";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { sseData } from "../../../shared/host-utils.js";
import type { McpManagerService } from "./shared/interface.ts";
import { installOrchestrator, McpManager } from "./server/connection/orchestrator/interface.ts";
import * as apiApi from "./server/api/interface.ts";
import {
  makeEventsRoute,
  makeHealthRoute,
  makeRoutes,
  uiConfigChangedFrame,
} from "./server/api/interface.ts";
import * as catalogApi from "./server/catalog/interface.ts";
import {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  resolveCatalogInjection,
} from "./server/catalog/interface.ts";
import type {
  CatalogAgent,
  CatalogDecision,
  CatalogMessage,
  SupervisorLite,
} from "./server/catalog/interface.ts";
import * as configModelApi from "./server/config/interface.ts";
import { Config, DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS } from "./server/config/interface.ts";
import * as dispatchApi from "./server/servers/dispatch/interface.ts";
import * as pipelineApi from "./server/pipeline/interface.ts";
import * as runtimeApi from "./server/connection/runtime/interface.ts";
import * as statsApi from "./server/stats/interface.ts";
import type { DebugConfig } from "./server/stats/interface.ts";
import * as storeApi from "./server/store/interface.ts";
import { defaultStorePath, loadDisabledTools, McpStore } from "./server/store/interface.ts";
import {
  installInject,
  registerDirectMcpGuard,
  registerMiddlewareTools,
} from "./server/inject/interface.ts";
import { installUpgrade, releaseUpgrade } from "./server/upgrade/interface.ts";
import { DEFAULT_RESULT_TRUNCATE_BYTES } from "./server/shared/interface.ts";
import { SSE_FRAMES } from "./shared/interface.ts";
import type { McpServerSummary, SseFramePayload } from "./shared/interface.ts";
import type { MiddlewareMode } from "./server/workspace/interface.ts";
import { makeResolveRoot, normalizeMiddlewareMode } from "./server/workspace/interface.ts";
import * as workspaceApi from "./server/workspace/interface.ts";

// 目录域的静态端口装配。三组 Port 全是静态模块引用（不需要宿主 ctx 或配置），故写在入口
// 顶层、模块求值期写定。实参必须是可解析的对象字面量、键集与 catalog/deps.ts 的 CatalogDeps
// 严格相等——由 verify-dir-imports 的注入面对账强制；调用点必须落在入口，写在别处该对账会
// 静默空转（附录 G·G20）。
catalogApi.installCatalog({ store: storeApi, connection: runtimeApi, workspace: workspaceApi });

// 执行管道域的静态端口装配。同上：实参必须是可解析的对象字面量、键集与 pipeline/deps.ts 的
// PipelineDeps 严格相等，且调用点必须落在入口（written elsewhere → 该对账静默空转，附录 G·G20）。
pipelineApi.installPipeline({ workspace: workspaceApi });

// 工具注册域的静态端口装配。同上：实参必须是可解析的对象字面量、键集与 inject/deps.ts 的
// InjectDeps 严格相等，且调用点必须落在入口（written elsewhere → 该对账静默空转，附录 G·G20）。
installInject({
  catalog: catalogApi,
  runtime: runtimeApi,
  pipeline: pipelineApi,
  workspace: workspaceApi,
});

// 连接编排子层的静态端口装配。同上：实参必须是可解析的对象字面量、键集与
// connection/orchestrator/deps.ts 的 OrchestratorDeps 严格相等，且调用点必须落在入口
// （written elsewhere → 该对账静默空转，附录 G·G20）。
installOrchestrator({
  catalog: catalogApi,
  configModel: configModelApi,
  configStore: storeApi,
  runtime: runtimeApi,
  pipeline: pipelineApi,
  stats: statsApi,
  workspace: workspaceApi,
});

// 连接运行时子层的静态端口装配。同上：实参必须是可解析的对象字面量、键集与
// connection/runtime/deps.ts 的 RuntimeDeps 严格相等，且调用点必须落在入口
// （written elsewhere → 该对账静默空转，附录 G·G20）。
runtimeApi.installRuntime({
  catalog: catalogApi,
  configEnv: configModelApi,
  dispatch: dispatchApi,
  pipeline: pipelineApi,
  workspace: workspaceApi,
});

// API 层域的静态端口装配。同上：实参必须是可解析的对象字面量、键集与 api/deps.ts 的
// ApiDeps 严格相等，且调用点必须落在入口（written elsewhere → 该对账静默空转，附录 G·G20）。
// 本域只接 workspace 与 config/model 两条 Port——对 manager 的结构参数消费没有 import 边，
// 命名能力对象不在 W10 的施工面（附录 G·G19；D.3·37），归后续刀。
apiApi.installApi({ workspace: workspaceApi, configModel: configModelApi });

/** 稳定的 cordis 插件名。 */
export const name = "mcp-manager";

/** 需要已初始化的工具注册表、web 服务器与提示词组装器。 */
export const inject = ["tools", "webServer", "systemPrompt"];

// 浮窗定位/层级/断点纯函数：实现在 shared/placement-math.ts（零依赖单一事实源，
// 客户端 bundle 与宿主端共用同一份），此处经 shared 门面 re-export 保持导出面不变。
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
  composerDockedAtBottom,
  bottomAnchorEdge,
} from "./shared/interface.ts";
export type { FloatBreakpoint, ViewportPoint, RectLike } from "./shared/interface.ts";
// 面板锚点判定同为纯函数，随定位数学一起从单一事实源 re-export。
export { panelAnchorForPosition } from "./shared/interface.ts";

// ------------------------------------------------------------ re-export
// 导出面与拆分前 lib/index.js 完全一致（smoke 验收契约）。

// 组合根装配体（apply 主流程 / 配置解析 / 运行期装配工厂 / 服务注入面 / 宣告文案与迁移接线）
// 在本文件内就地定义；导出面与拆分前逐字相同。

export const MCP_GUIDANCE =
  "dsh-mcp-manager is active: centrally manages MCP server connections without preset servers. MCP tools execute on real servers with inherited host permissions; results may contain sensitive data — explain and obtain user consent before write or sensitive operations. Terms like 'MCP / context server' refer to this plugin. Invocation rules:\n" +
  "- Project-level servers: search with `ws_mcp_search`, verify schema with `ws_mcp_detail` if uncertain, then invoke with `ws_mcp_call`. Do NOT call mcp__ prefixed tools directly.\n" +
  "- Global servers: call `mcp__<server>__<tool>` directly (or via `ws_mcp_call` in all mode).\n" +
  "- Do not retry a failing server tool more than twice.";

/** apply 顶层解析后的增强/开关配置集合。 */
interface ApplyOptions {
  enabled: boolean;
  announceToAgent: boolean;
  announceCatalog: boolean;
  catalogMaxEntries: number;
  middlewarePolicy: Record<string, unknown>;
  middlewareModeRaw: string | undefined;
  debug: DebugConfig;
}

/** 解析 storePath（显式配置优先，回落默认路径）。 */
function resolveStorePath(config: Record<string, unknown> | undefined): string {
  return typeof config?.storePath === "string" && config.storePath !== ""
    ? config.storePath
    : defaultStorePath();
}

/** 解析 debug 配置。 */
export function resolveDebugConfig(
  config: Record<string, unknown> | undefined,
  settingsSource?: unknown,
): DebugConfig {
  const settings =
    typeof settingsSource === "object" && settingsSource !== null
      ? (settingsSource as Record<string, unknown>).debug
      : undefined;
  const rawDebug = (
    typeof settings === "object" && settings !== null ? settings : config?.debug
  ) as Record<string, unknown> | undefined;
  return {
    callStats: rawDebug?.callStats === true,
    statsFile: typeof rawDebug?.statsFile === "string" ? rawDebug.statsFile : "",
  };
}

/** 解析全部布尔/数值/策略配置（兜底链引用具名常量，单一事实源）。 */
function resolveApplyOptions(
  config: Record<string, unknown> | undefined,
  settingsSource?: unknown,
): ApplyOptions {
  const announceCatalog =
    (config?.announceCatalog as boolean | undefined) ?? DEFAULT_ANNOUNCE_CATALOG;
  const catalogMaxEntries =
    Number.isFinite(config?.catalogMaxEntries) && (config?.catalogMaxEntries as number) > 0
      ? Math.floor(config?.catalogMaxEntries as number)
      : DEFAULT_CATALOG_MAX_ENTRIES;
  return {
    enabled: config?.enabled !== false,
    announceToAgent: config?.announceToAgent !== false,
    announceCatalog,
    catalogMaxEntries,
    middlewarePolicy: (config?.middlewarePolicy as Record<string, unknown> | undefined) ?? {},
    middlewareModeRaw: config?.middleware as string | undefined,
    debug: resolveDebugConfig(config, settingsSource),
  };
}

/** 解析中间层模式（settings 持久化值优先，回落 config 默认 project，#389 M2）。 */
export function resolveMiddlewareMode(
  manager: McpManager,
  fallbackRaw: string | undefined,
): ReturnType<typeof normalizeMiddlewareMode> {
  const settingsSource = manager.uiConfigSource();
  const persistedMiddleware =
    typeof settingsSource === "object" && settingsSource !== null
      ? (settingsSource as Record<string, unknown>).middleware
      : undefined;
  return normalizeMiddlewareMode(
    typeof persistedMiddleware === "string" ? persistedMiddleware : (fallbackRaw ?? "project"),
  );
}

/**
 * 插件自身 Config schema（标准 cordis 配置注入路径）：position/offset 不再藏于
 * 隐藏命名空间，设置页插件卡可编辑；配置变更经既有 SSE events 通道广播一帧，
 * 客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置（无需重启/轮询）。
 */
function installConfigSettings(
  ctx: Context,
  manager: McpManager,
  config: Record<string, unknown> | undefined,
  syncMiddlewareFromSettings: () => void,
): void {
  const broadcastUiConfigChanged = () => {
    // #515：广播收口到共享 hub（未创建 = 尚无 events 订阅，跳过）。
    manager.sseHub?.broadcast(uiConfigChangedFrame());
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
}

/**
 * 写入 sink：设置页卡片经 POST /api/dsh-mcp/config 写配置时，通过 settings 服务
 * 的 namespace update 落盘并触发 scope.watch → onChange → SSE 广播。settings 服务
 * 未挂载时 uiUpdate 保持 undefined → 写路由返回「不可写」（卡片/设置页本就不渲染）。
 */
function injectSettingsSink(ctx: Context, manager: McpManager): void {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["settings"], (sctx) => {
    // sctx 注入 settings 服务（cordis 类型面未声明该服务，经 unknown 中转取最小面）。
    const settings = (
      sctx as unknown as
        | {
            settings?: {
              update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown>;
            };
          }
        | undefined
    )?.settings;
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

/**
 * 向宿主容器提供核心化服务 `ctx.mcpManager`（供其他插件运行时注入/控制/查询
 * MCP 服务器）。提供时机由调用方保证（store.load 之后 manager 已就绪）；卸载
 * 由 mcp-manager 自身 dispose() 全量清理（含 runtime 条目与 supervisor）。
 * 兼容：fake ctx（单元测试 mock）可能无 provide，可选调用静默降级。
 */
function provideMcpManagerService(ctx: Context, manager: McpManager): void {
  if (typeof (ctx as unknown as { provide?: unknown }).provide !== "function") return;
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
      return found as unknown as McpServerSummary;
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
    list: () => (manager.summary().servers ?? []) as unknown as McpServerSummary[],
  });
}

/**
 * 中间层模式热切换（设置页「中间层模式」下拉；initMiddleware 幂等已有，
 * off↔project/all 需重新注册/卸载中间层工具——dispose 后重建）。
 * 注册在模式分支之外：启动即 off 时也能从设置页切到 project/all。
 */
export function makeMiddlewareHotSwitch(
  manager: McpManager,
  middlewarePolicy: Record<string, unknown> | undefined,
  resolveRoot: (agent: unknown) => Promise<string | undefined>,
  dispose: { current: () => void },
): (mode: MiddlewareMode) => Promise<void> {
  return async (mode: MiddlewareMode): Promise<void> => {
    if (normalizeMiddlewareMode(mode) === manager.middlewareMode) return;
    const next = normalizeMiddlewareMode(mode);
    manager.middlewareMode = next;
    dispose.current();
    if (next !== "off") {
      const mw = await manager.initMiddleware(next, middlewarePolicy ?? {});
      dispose.current = registerMiddlewareTools(manager.ctx, mw, resolveRoot, next, {
        disabledTools: manager.disabledTools,
        stats: manager.stats,
      });
    } else {
      // D8：off 模式无中间层实例，独立注册 mcp__ 直呼守卫（数据源直查禁用表）。
      const guardDispose = registerDirectMcpGuard(manager.ctx, manager.disabledTools, resolveRoot);
      if (guardDispose !== undefined) dispose.current = guardDispose;
    }
    // off ↔ project/all：重注册/卸载中间层工具后 reconcile——all 模式下全局
    // supervisor 由 reconcile 停掉、新全局条目经 start 内部接管触达 @global
    // 单元（#382 F3）；off 语义停掉全部中间层接管条目。防同一 server 双进程。
    manager.reconcileServers();
    manager.logger.info(`dsh-mcp-manager: middleware mode=${next} (hot-switched)`);
    // B20（C-EVT）：热切换后补 summary 帧——summary 帧源集合含热切换；现状
    // 缺失致热切换后客户端无帧可回拉 GET /servers（与客户端 C10 同根）。
    manager.emitStatus();
  };
}

/**
 * L1 能力目录注入（history-based 去重，仿 dsh-tool-skill catalog）：
 * 决策逻辑在 resolveCatalogInjection（纯函数，可单测）。
 */
function registerCatalogInjection(
  ctx: Context,
  manager: McpManager,
  catalogMaxEntries: number,
): () => void {
  // 官方强类型 payload：PreStepDecision waterfall（{kind:'reject'}|{kind:'enter';messages}）。
  // 目录决策逻辑在纯函数 resolveCatalogInjection（自建 CatalogDecision 宽面，
  // 可单测），此处仅做边界收窄/放宽。
  return ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    signal.throwIfAborted();
    // 目录数据源按会话 cwd 计算（工作区缓存），不跟随 host 的"当前工作区"
    // 实时状态——切换工作区不改变本会话目录集合，MCP 没变化就不重复注入。
    const supervisors = await manager.catalogServersFor(agent?.session?.header?.cwd);
    // #569：合成注入端目录缓存视图（B 起步 + 中间层 per-root 目录覆盖 +
    // 磁盘 last-good 兜底）。manager.catalogCache 是 supervisor（直呼）路径的
    // 摘要缓存；middleware 模式下其采集的工具目录注入端此前读不到——视图把
    // 两套数据源收口为一个 CatalogCache 形态，公共函数签名不变。
    const catalogView = await manager.catalogViewFor(agent?.session?.header?.cwd, supervisors);
    // 边界放宽：纯函数吃自建宽面 CatalogDecision，返回值即本轮 PreStepDecision
    return resolveCatalogInjection(
      decision as unknown as CatalogDecision,
      messages as CatalogMessage[],
      supervisors as Map<string, SupervisorLite>,
      catalogMaxEntries,
      catalogView,
      agent as unknown as CatalogAgent | undefined,
      // 热切换后目录文案按当前模式渲染（#362 设置页中间层模式下拉）。
      manager.middlewareMode,
    ) as unknown as PreStepDecision;
  });
}

/**
 * 注册 /api/dsh-mcp/* 路由 + SSE 状态广播接线。
 * 状态变化 → 广播 SSE 帧（hub 在 makeEventsRoute 中惰性创建，#515）。
 */
function setupRoutesAndBroadcast(ctx: Context, manager: McpManager): () => void {
  const routes = makeRoutes(manager);
  const eventsRoute = makeEventsRoute(manager);
  const healthRoute = makeHealthRoute(manager);
  const disposers = [...routes, eventsRoute, healthRoute].map((route) =>
    ctx.webServer.register(route),
  );
  const unsubscribeStatus = manager.onStatus(() => {
    manager.sseHub?.broadcast(sseData({ type: SSE_FRAMES.summary } satisfies SseFramePayload));
  });
  return () => {
    unsubscribeStatus();
    for (const dispose of disposers) dispose();
    // #515：hub.dispose() 统一停心跳 + destroy 全部连接（幂等，不依赖
    // close 事件异步时序）；取代旧 sseHeartbeatCleanups 逐连接清理。
    manager.sseHub?.dispose();
    manager.sseHub = undefined;
  };
}

/**
 * 变更点驱动（#111）：fs.watch 监听全局与当前项目 mcp.json 配置目录，
 * 外部编辑/落盘 → 防重入 reconcile（运行中排队补跑）。取代 mtime 轮询。
 */
async function setupConfigWatchersAsync(manager: McpManager): Promise<() => void> {
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
    return () => {
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
    return () => {};
  }
}

/**
 * 只读的「显式键」解析：upgrade 域判「用户是否接管了落点」要的是用户真的写进配置的原始值，
 * 不是解析后的生效路径。未配置时生效路径恰好是待迁移的旧默认落点（resolveStorePath 的回落），
 * 照生效值判会把每一次默认安装都当成「用户接管了路径」→ 迁移整段跳过、刻度照常推进，表现为
 * 静默丢用户配置。故这里只读键、不回落默认值（空串 = 未配置）。
 */
function explicitConfigPaths(config: Record<string, unknown> | undefined): {
  storePath: string;
  statsFile: string;
} {
  const debug =
    typeof config?.debug === "object" && config.debug !== null
      ? (config.debug as Record<string, unknown>)
      : undefined;
  return {
    storePath: typeof config?.storePath === "string" ? config.storePath : "",
    statsFile: typeof debug?.statsFile === "string" ? debug.statsFile : "",
  };
}

/**
 * MCP 能力宣告在系统提示中的排序位置：紧随部署 persona 之后、计划策略之前
 * （官方 SECTION_ORDERS 里 DEPLOYMENT_PERSONA_PREFIX=0 与 PLAN_POLICY=500 之间）。
 *
 * 不写成 getSectionOrder() 派生：0.1.5 把 HARNESS_SOURCE/WEB_SURFACE 从 -900/-800
 * 移到 10000/10100（官方对提示词整体重排），本段落与相邻段的相对位置不受影响，
 * 派生只多一层运行时依赖与失败面；改由 smoke 的分节顺序断言锁定区间。
 */
export const MCP_SECTION_ORDER = 160;

/** enabled 分支装配产物（disposer 集合，顶层 effect 统一收口）。 */
interface EnabledRuntimeDisposers {
  // ctx.effect 的 disposer 是异步签名（Disposable<Promise<void>>，见 cordis fiber 类型），
  // 路由清理正来自它。声明成 `() => void` 会让类型与事实不符，并把异步性藏到调用点看不见
  // （#764 的三条类型感知规则正是抓这类「签名撒谎」）。
  disposeRoutes: () => void | Promise<void>;
  disposeSection: () => void;
  disposeInjection: () => void;
  disposeMiddleware: () => void;
  watchCleanup: () => void;
}

/**
 * 挂载 MCP 管理器：加载存储、启动已启用服务器、注册路由与提示词。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 宿主插件上下文。
 * @param config 解析后的插件配置。
 */
export async function apply(
  ctx: Context,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const options = resolveApplyOptions(config);

  // 装配顺序（§十二 接线顺序约束）：存量存储迁移必须在任何读存储的域之前跑完——先建存储再
  // 迁移，各域会读到旧布局（旧文件那时已被归档，读到的是空盘）。链是异步的，不 await 就等于
  // 没有顺序保证。
  //
  // 装配前先复位单例标记：apply 在同一进程里会被多次调用（宿主重载插件；测试对多个假宿主各
  // apply 一次），而 upgrade 域的标记是进程级的；链本身幂等（归档名固定、目标存在即不覆盖），
  // 重跑不累积。真正的双重装配仍由 installUpgrade 自己的标记在直接调用面上兜住。
  const explicitPaths = explicitConfigPaths(config);
  releaseUpgrade();
  await installUpgrade({
    logger: ctx.logger,
    storePath: explicitPaths.storePath,
    statsFile: explicitPaths.statsFile,
  });

  const store = new McpStore(resolveStorePath(config));
  await store.load();
  const manager = new McpManager(ctx, store);
  // 感知增强配置（对抗性评审 v2）。默认值引用具名常量（单一事实源）。
  const enhanceEmptyDescriptions =
    (config?.enhanceEmptyDescriptions as boolean | undefined) ?? DEFAULT_ENHANCE_EMPTY;
  const resultTruncateBytes =
    Number.isFinite(config?.resultTruncateBytes) && (config?.resultTruncateBytes as number) > 0
      ? Math.floor(config?.resultTruncateBytes as number)
      : DEFAULT_TRUNCATE;
  manager.enhancement = { enhanceEmptyDescriptions, resultTruncateBytes };

  // 核心化服务（官方 storageDomain 模式）：对外暴露 ctx.mcpManager（见本文件的 provideMcpManagerService）。
  provideMcpManagerService(ctx, manager);

  // #389：settings 命名空间合并面（含用户层保存的 middleware）→ 运行时同步。
  // 此同步函数在 settings onChange（运行期变更）与启动兜底（enabled 分支内）
  // 两处调用：前者覆盖运行期变更，后者覆盖启动时 settings 已就绪的场景。
  const syncMiddlewareFromSettings = (): void => {
    const source = manager.uiConfigSource();
    const debugCfg = resolveDebugConfig(config, source);
    manager.stats.configure({
      enabled: debugCfg.callStats,
      filePath: debugCfg.statsFile || undefined,
      logger: manager.logger,
    });
    if (typeof manager.setMiddlewareMode !== "function") return;
    const persisted =
      typeof source === "object" && source !== null
        ? (source as Record<string, unknown>).middleware
        : undefined;
    if (typeof persisted !== "string") return;
    const next = normalizeMiddlewareMode(persisted);
    if (next === manager.middlewareMode) return;
    void manager
      .setMiddlewareMode(next)
      .catch((error: unknown) =>
        manager.logger.warn(
          `dsh-mcp-manager: sync middleware from settings failed: ${String(error)}`,
        ),
      );
  };
  installConfigSettings(ctx, manager, config, syncMiddlewareFromSettings);
  injectSettingsSink(ctx, manager);

  // 初始化 stats 配置
  manager.stats.configure({
    enabled: options.debug.callStats,
    filePath: options.debug.statsFile || undefined,
    logger: manager.logger,
  });

  let runtime: EnabledRuntimeDisposers = {
    disposeRoutes: () => {},
    disposeSection: () => {},
    disposeInjection: () => {},
    disposeMiddleware: () => {},
    watchCleanup: () => {},
  };

  if (options.enabled) {
    runtime = await assembleEnabledRuntime(ctx, manager, options, syncMiddlewareFromSettings);
  }

  ctx.effect(
    () => () => {
      runtime.disposeInjection();
      runtime.disposeSection();
      // 显式不等待：本清理面是同步语义（其余 disposer 同步），路由清理的异步性由类型写明，
      // 不在卸载路径上引入等待点。
      void runtime.disposeRoutes();
      runtime.disposeMiddleware();
      runtime.watchCleanup();
      void manager.dispose();
      // 逆序释放：upgrade 是第一个装配的域，故最后复位它的标记。
      releaseUpgrade();
    },
    "dsh-mcp-manager: dispose",
  );
}

/** enabled 分支装配（中间层 / 启动 / catalog / 路由 / watchers / 提示词）。 */
async function assembleEnabledRuntime(
  ctx: Context,
  manager: McpManager,
  options: {
    announceCatalog: boolean;
    announceToAgent: boolean;
    catalogMaxEntries: number;
    middlewarePolicy: Record<string, unknown>;
    middlewareModeRaw: string | undefined;
  },
  syncMiddlewareFromSettings: () => void,
): Promise<EnabledRuntimeDisposers> {
  // F3（#382）：中间层初始化提前到 startAll 之前（防「先建后停」竞态，详见
  // 本文件运行期装配段的注释）；#389 M2：settings 合并面就绪时直接取持久化模式，
  // 避免「先起 supervisor 再热切换 all」的启动抖动（连→断→连）。
  const middlewareMode = resolveMiddlewareMode(manager, options.middlewareModeRaw);

  const resolveRoot = makeResolveRoot(manager);
  // dispose.current 由热切换闭包持有重挂（off↔project/all 重建中间层工具）。
  let currentMiddlewareDispose = () => {};
  const middlewareDisposer = {
    get current(): () => void {
      return currentMiddlewareDispose;
    },
    set current(fn: () => void) {
      currentMiddlewareDispose = fn;
    },
  };
  // D8：guard 数据源直查禁用表（只读），加载独立于 initMiddleware——off 模式
  // 不 initMiddleware 也必须先载入禁用表，guard 才能三模式一致拦截 mcp__ 直呼。
  manager.disabledTools = await loadDisabledTools(manager.userStatePath);
  if (middlewareMode !== "off") {
    const mw = await manager.initMiddleware(middlewareMode, options.middlewarePolicy);
    currentMiddlewareDispose = registerMiddlewareTools(ctx, mw, resolveRoot, middlewareMode, {
      disabledTools: manager.disabledTools,
      stats: manager.stats,
    });
  } else {
    // D8：off 模式无中间层实例（无连接池副作用）——独立注册 mcp__ 直呼守卫。
    const guardDispose = registerDirectMcpGuard(ctx, manager.disabledTools, resolveRoot);
    if (guardDispose !== undefined) currentMiddlewareDispose = guardDispose;
  }
  manager.setMiddlewareMode = makeMiddlewareHotSwitch(
    manager,
    options.middlewarePolicy,
    resolveRoot,
    middlewareDisposer,
  );

  await manager.startAll();
  await manager.loadCatalogCache();
  manager.reconcileServers();
  manager.logger.info(`dsh-mcp-manager: middleware mode=${middlewareMode}`);

  // #389：启动阶段把 settings 持久化的 middleware 模式同步到运行时（兜底）。
  syncMiddlewareFromSettings();

  let disposeInjection = () => {};
  if (options.announceCatalog) {
    disposeInjection = registerCatalogInjection(ctx, manager, options.catalogMaxEntries);
  }

  const disposeRoutes = ctx.effect(
    () => setupRoutesAndBroadcast(ctx, manager),
    "dsh-mcp-manager: routes",
  );
  const watchCleanup = await setupConfigWatchersAsync(manager);

  let disposeSection = () => {};
  if (options.announceToAgent) {
    // 官方 SystemPrompt.section(opts) 签名（PromptSection）；此处传参满足其形状，
    // 经 unknown 中转以维持局部最小面写法。
    disposeSection = (
      ctx.systemPrompt as unknown as { section(opts: Record<string, unknown>): () => void }
    ).section({
      name: "plugin:dsh-mcp-manager",
      order: MCP_SECTION_ORDER,
      text: MCP_GUIDANCE,
    });
  }

  return {
    disposeRoutes,
    disposeSection,
    disposeInjection,
    disposeMiddleware: currentMiddlewareDispose,
    watchCleanup,
  };
}

// 具名常量（增强配置默认值）：DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS 从 config-schema
// re-export（拆分前由 apply.ts 直接 import；并入入口后仍是同一份定义）。
// 该默认值的**物理定义**在 server/shared（≥2 域消费，§3.6 规则 6；config/model 同法取值），
// 故直接取自共享门面，不经 connection 门面转发（W10 已删该门面的值面）。
const DEFAULT_ENHANCE_EMPTY = DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS;
const DEFAULT_TRUNCATE = DEFAULT_RESULT_TRUNCATE_BYTES;

// 插件 Config schema 与配置归一化（类型自 types.ts 取）
export {
  DEFAULT_UI_CONFIG,
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
  // ${ENV} 预展开的物理定义在 config 域（#767 S1-1 自 connection/runtime 迁出）；
  // 入口导出名集合不变，只换来源。
  expandEnv,
} from "./server/config/interface.ts";
export type { UiPlacementConfig } from "./server/config/interface.ts";
export type { ClientUiConfig } from "./shared/interface.ts";

// 管理器 / 连接域（orchestrator+runtime：#664 阶段 6 集中搬移完成）。runtime 的值面自 W10 起
// 直接取自子层门面——connection/interface.ts 只留类型出口，不再转发值符号。
export { McpManager } from "./server/connection/orchestrator/interface.ts";
export {
  ConnectionSupervisor,
  McpMiddleware,
  HttpTransport,
  parseSsePayload,
  StdioTransport,
  createTransport,
  MCPClient,
} from "./server/connection/runtime/interface.ts";
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  RECONNECT_DEFAULTS,
  resolveReconnect,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./server/connection/runtime/interface.ts";
export type { ReconnectPolicy } from "./server/connection/interface.ts";
// 工作空间路由域（项目根发现 / 全名解析 / scope / 模式归一化；阶段 4 成形）
export {
  findProjectRoot,
  normalizedProjectRoot,
  makeResolveRoot,
} from "./server/workspace/interface.ts";
export {
  fullServerName,
  parseFullServerName,
  normalizeToolName,
  normalizeMiddlewareMode,
} from "./server/workspace/interface.ts";
// 执行管道域（两路径同构纯函数族；#664 阶段 2）
export {
  normalizeArguments,
  msgOf,
  createRedactor,
  globMatch,
  policyAllows,
  policyDenialReason,
  isToolDenied,
  toolDisabledReason,
  withTimeout,
  defaultCallResultFallbackText,
  projectCallToolResult,
} from "./server/pipeline/interface.ts";
export type { CallResultTextHandlers, ProjectedCallResult } from "./server/pipeline/interface.ts";
// 核心化 service（官方 storageDomain 模式）：ctx.mcpManager 类型面 + 声明合并。
// 仅类型导出（无副作用导入）：消费方 import 类型时 tsc 会解析 shared 门面，
// 入口的 declare module 合并自动生效；副作用导入会让 stryker sandbox 解析
// src/service.js 失败（sandbox 只有 .ts），也避免 .d.ts 里残留 .ts 引用。
export type { McpManagerServerInput, McpManagerService } from "./shared/interface.ts";

/**
 * 服务名：本插件对兄弟插件开放的 ABI。声明合并的键引用它，而不是就地再写一遍字面量——两处字面量
 * 在改名时只会有一处被改到，而症状（消费方 `ctx.get` 拿到空）出现在别的插件里。名字的所有权在
 * 提供方（本文件的 provideMcpManagerService）；合并它与 provide 字面量要同笔改 service-contract.test.ts 的源文本 marker，归后续刀。
 *
 * 它不进包导出面：入口对外只有声明合并本身，常量不外放。
 */
const MCP_MANAGER_SERVICE = "mcpManager" as const;

/**
 * 对外名字的声明合并。**必须写在包入口**：declare module 是全局增强，入口声明面不可达时
 * `lib/index.d.ts` 里就没有它（`pack:check` 的「声明合并可达性」判据盯这条）。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** mcp-manager 核心服务：其他插件运行时注入/控制/查询 MCP 服务器（官方 storageDomain 模式）。 */
    [MCP_MANAGER_SERVICE]: McpManagerService;
  }
}

// 存储与状态持久化（config/store：#664 阶段 6 落位）
export { defaultStorePath, McpStore } from "./server/store/interface.ts";
export {
  userStateFile,
  loadUserState,
  saveUserState,
  loadDisabledTools,
  saveDisabledTools,
  parseDisabledTools,
  catalogCacheFileFor,
  readCatalogServerFromDisk,
} from "./server/store/interface.ts";
// 能力目录 / 目录缓存（#664 阶段 5：catalog 域成形）
export {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  catalogCacheFile,
  CATALOG_SUMMARY_MAX_CHARS,
  CATALOG_SUMMARY_PER_TOOL_CHARS,
  CATALOG_ENTRY_MAX_CHARS,
  summarizeToolDescriptions,
  composeCatalogEntries,
  digestCatalogEntries,
  renderMcpCatalogMessage,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  isCatalogSource,
  resolveCatalogEntries,
  CATALOG_SOURCE_PLUGIN,
  CATALOG_SECTION_NAME,
  catalogHistory,
  renderMcpCatalogUpdate,
  resolveCatalogInjection,
  scoreTool,
  searchCatalog,
  isCatalogFresh,
  boundCatalogTools,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
} from "./server/catalog/interface.ts";
// mcpServers JSON 导入 / 归一化（config/model）
export {
  fromClaudeEntry,
  parseClaudeJson,
  SERVER_NAME_PATTERN,
  normalizeServer,
} from "./server/config/interface.ts";
// 统计与 Debug
export { McpStatsCollector, defaultStatsPath } from "./server/stats/interface.ts";
export type {
  McpStatsSnapshot,
  ServerStats,
  ToolCallMetric,
  ProgressiveDisclosureStats,
  DebugConfig,
} from "./server/stats/interface.ts";
// 工具注册面（inject：#664 阶段 6 落位）
export { registerMiddlewareTools, registerDirectMcpGuard } from "./server/inject/interface.ts";
// 共享类型面（物理定义在各域 impl/<块>/type.ts，按落点域门面分组转出；#767 W11b2a）
export type { MiddlewareMode } from "./server/workspace/interface.ts";
export type { ProjectUnit } from "./server/connection/interface.ts";
export type {
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ListCatalogResult,
  ToolDetail,
} from "./server/catalog/interface.ts";
export type { MiddlewarePolicy } from "./server/pipeline/interface.ts";
export type { DisabledToolsMap } from "./server/store/interface.ts";
export type { ServerConfig } from "./server/config/interface.ts";
export type { ServerStatus } from "./server/api/interface.ts";

// 路由
export {
  ROUTES,
  makeRoutes,
  makeEventsRoute,
  makeHealthRoute,
  uiConfigChangedFrame,
  broadcastFrame,
  SSE_HEARTBEAT_MS,
  SSE_PING_FRAME,
} from "./server/api/interface.ts";
export { normalizeScope } from "./server/workspace/interface.ts";
// 跨端契约常量（物理定义在 shared/constants.ts）：入口经共享层门面取，与两端消费者同一份；
// workspace 域门面仍为域内消费者转出同一份。客户端目前仍以字面量重复实现 scope 与全局 root
// 前缀，改引属 #769。
export { MIDDLEWARE_GLOBAL_ROOT, SCOPE_GLOBAL, SCOPE_PROJECT } from "./shared/interface.ts";
// 仓库共享层（loopback 围栏 / writeJson / readJsonBody / sseData）
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readJsonBody, sseData } from "../../../shared/host-utils.js";
