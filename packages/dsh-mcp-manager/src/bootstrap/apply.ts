/**
 * dsh-mcp-manager — 插件挂载主流程（apply）与工具注册（单一事实源）。
 *
 * 加载存储、启动已启用服务器、注册路由/中间层工具/能力目录/提示词；
 * index.ts 仅 re-export（插件契约转发），apply.ts 不 import index.ts（防循环）。
 *
 * #592 阶段二 Batch A 消峰：原 apply() 单函数圈复杂度 78（全仓第二），全部
 * 来自内联装配闭包；拆分后本文件只保留顺序装配骨架——
 * - 配置解析与 settings 接线 → apply-config.ts
 * - 服务注入面 → apply-services.ts
 * - 运行期装配阶段 → apply-runtime.ts（watchers / 热切换 / catalog / 路由）
 * - Agent 宣告文案 → apply-guidance.ts
 * 行为与拆分前逐字节等价；service-contract.test.ts 的 provide 源文本静态
 * 扫描 marker 迁移至 apply-services.ts（契约测试同步更新）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { McpManager } from "../connection/orchestrator/interface.ts";
import { McpStore } from "../config/store/interface.ts";
import { registerMiddlewareTools, registerDirectMcpGuard } from "../inject/interface.ts";
import { loadDisabledTools } from "../config/store/interface.ts";
import { makeMiddlewareHotSwitch } from "./apply-runtime.ts";
import { normalizeMiddlewareMode, makeResolveRoot } from "../workspace/interface.ts";
import { registerCatalogInjection, setupConfigWatchersAsync, setupRoutesAndBroadcast } from "./apply-runtime.ts";
import type { CatalogInjectionMode } from "../config/model/interface.ts";
import { provideMcpManagerService } from "./apply-services.ts";
import {
  injectSettingsSink,
  installConfigSettings,
  resolveApplyOptions,
  resolveDebugConfig,
  resolveMiddlewareMode,
  resolveStorePath,
} from "./apply-config.ts";
import { MCP_GUIDANCE } from "./apply-guidance.ts";
// 导出面兼容：index.ts 仍从 apply.ts re-export MCP_GUIDANCE（组合根单一来源不变）。
export { MCP_GUIDANCE };

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
  disposeRoutes: () => void;
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
export async function apply(ctx: Context, config: Record<string, unknown> | undefined): Promise<void> {
  const options = resolveApplyOptions(config);

  const store = new McpStore(resolveStorePath(config));
  await store.load();
  const manager = new McpManager(ctx, store);
  // 感知增强配置（对抗性评审 v2）。默认值引用具名常量（单一事实源）。
  const enhanceEmptyDescriptions = (config?.enhanceEmptyDescriptions as boolean | undefined) ?? DEFAULT_ENHANCE_EMPTY;
  const resultTruncateBytes = Number.isFinite(config?.resultTruncateBytes) && (config?.resultTruncateBytes as number) > 0
    ? Math.floor(config?.resultTruncateBytes as number)
    : DEFAULT_TRUNCATE;
  manager.enhancement = { enhanceEmptyDescriptions, resultTruncateBytes };
  // 目录注入时机：目录注入时机回落值（settings 命名空间未设时用它；pre-step 每次现读）。
  manager.catalogInjectionFallback = options.catalogInjection;

  // 核心化服务（官方 storageDomain 模式）：对外暴露 ctx.mcpManager（apply-services）。
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
    const persisted = typeof source === "object" && source !== null ? (source as Record<string, unknown>).middleware : undefined;
    if (typeof persisted !== "string") return;
    const next = normalizeMiddlewareMode(persisted);
    if (next === manager.middlewareMode) return;
    void manager.setMiddlewareMode(next).catch((error: unknown) => manager.logger.warn(`dsh-mcp-manager: sync middleware from settings failed: ${String(error)}`));
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

  ctx.effect(() => () => {
    runtime.disposeInjection();
    runtime.disposeSection();
    runtime.disposeRoutes();
    runtime.disposeMiddleware();
    runtime.watchCleanup();
    void manager.dispose();
  }, "dsh-mcp-manager: dispose");
}

/** enabled 分支装配（中间层 / 启动 / catalog / 路由 / watchers / 提示词）。 */
async function assembleEnabledRuntime(
  ctx: Context,
  manager: McpManager,
  options: { announceCatalog: boolean; catalogInjection: CatalogInjectionMode; announceToAgent: boolean; catalogMaxEntries: number; middlewarePolicy: Record<string, unknown>; middlewareModeRaw: string | undefined },
  syncMiddlewareFromSettings: () => void,
): Promise<EnabledRuntimeDisposers> {
  // F3（#382）：中间层初始化提前到 startAll 之前（防「先建后停」竞态，详见
  // apply-runtime 注释）；#389 M2：settings 合并面就绪时直接取持久化模式，
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
  manager.setMiddlewareMode = makeMiddlewareHotSwitch(manager, options.middlewarePolicy, resolveRoot, middlewareDisposer);

  await manager.startAll();
  await manager.loadCatalogCache();
  manager.reconcileServers();
  manager.logger.info(`dsh-mcp-manager: middleware mode=${middlewareMode}`);

  // #389：启动阶段把 settings 持久化的 middleware 模式同步到运行时（兜底）。
  syncMiddlewareFromSettings();

  let disposeInjection = () => {};
  if (options.announceCatalog) {
    disposeInjection = registerCatalogInjection(ctx, manager, options.catalogMaxEntries, options.catalogInjection);
  }

  const disposeRoutes = ctx.effect(() => setupRoutesAndBroadcast(ctx, manager), "dsh-mcp-manager: routes");
  const watchCleanup = await setupConfigWatchersAsync(manager);

  let disposeSection = () => {};
  if (options.announceToAgent) {
    // 官方 SystemPrompt.section(opts) 签名（PromptSection）；此处传参满足其形状，
    // 经 unknown 中转以维持局部最小面写法。
    disposeSection = (ctx.systemPrompt as unknown as { section(opts: Record<string, unknown>): () => void }).section({
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
// re-export（拆分前 apply.ts 直接 import；此处保持同值语义）。
import { DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS } from "../config/model/interface.ts";
import { DEFAULT_RESULT_TRUNCATE_BYTES } from "../connection/interface.ts";
const DEFAULT_ENHANCE_EMPTY = DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS;
const DEFAULT_TRUNCATE = DEFAULT_RESULT_TRUNCATE_BYTES;
