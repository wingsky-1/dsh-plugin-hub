/**
 * dsh-mcp-manager — apply 装配拆分：配置解析与设置接线（#592 阶段二 Batch A）。
 *
 * 原 apply() 的配置解析（10+ 个可选字段兜底链）与 settings 命名空间接线
 * 内联在主函数中，是 apply 圈复杂度的主要来源之一；本模块抽为独立工厂。
 * 行为与拆分前逐字节等价（含 #125 this 绑定与 #389 同步语义）。
 */

import type { Context } from "@deepseek-ai/cordis";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { DEFAULT_ANNOUNCE_CATALOG, DEFAULT_CATALOG_MAX_ENTRIES } from "./catalog/interface.ts";
import { Config, DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS } from "./config-schema.ts";
import { DEFAULT_RESULT_TRUNCATE_BYTES } from "./supervisor.ts";
import { normalizeMiddlewareMode } from "./workspace/interface.ts";
import type { McpManager } from "./manager.ts";
import { uiConfigChangedFrame } from "./routes.ts";
import { defaultStorePath } from "./store.ts";
import type { DebugConfig } from "./call-stats-types.ts";

/** apply 顶层解析后的增强/开关配置集合。 */
export interface ApplyOptions {
  enabled: boolean;
  announceToAgent: boolean;
  announceCatalog: boolean;
  catalogMaxEntries: number;
  middlewarePolicy: Record<string, unknown>;
  middlewareModeRaw: string | undefined;
  debug: DebugConfig;
}

/** 解析 storePath（显式配置优先，回落默认路径）。 */
export function resolveStorePath(config: Record<string, unknown> | undefined): string {
  return typeof config?.storePath === "string" && config.storePath !== "" ? config.storePath : defaultStorePath();
}

/** 解析 debug 配置。 */
export function resolveDebugConfig(config: Record<string, unknown> | undefined, settingsSource?: unknown): DebugConfig {
  const settings = typeof settingsSource === "object" && settingsSource !== null ? (settingsSource as Record<string, unknown>).debug : undefined;
  const rawDebug = (typeof settings === "object" && settings !== null ? settings : config?.debug) as Record<string, unknown> | undefined;
  return {
    callStats: rawDebug?.callStats === true,
    statsFile: typeof rawDebug?.statsFile === "string" ? rawDebug.statsFile : "",
  };
}

/** 解析全部布尔/数值/策略配置（兜底链引用具名常量，单一事实源）。 */
export function resolveApplyOptions(config: Record<string, unknown> | undefined, settingsSource?: unknown): ApplyOptions {
  const announceCatalog = (config?.announceCatalog as boolean | undefined) ?? DEFAULT_ANNOUNCE_CATALOG;
  const catalogMaxEntries = Number.isFinite(config?.catalogMaxEntries) && (config?.catalogMaxEntries as number) > 0
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
export function resolveMiddlewareMode(manager: McpManager, fallbackRaw: string | undefined): ReturnType<typeof normalizeMiddlewareMode> {
  const settingsSource = manager.uiConfigSource();
  const persistedMiddleware =
    typeof settingsSource === "object" && settingsSource !== null
      ? (settingsSource as Record<string, unknown>).middleware
      : undefined;
  return normalizeMiddlewareMode(
    typeof persistedMiddleware === "string" ? persistedMiddleware : fallbackRaw ?? "project",
  );
}

/**
 * 插件自身 Config schema（标准 cordis 配置注入路径）：position/offset 不再藏于
 * 隐藏命名空间，设置页插件卡可编辑；配置变更经既有 SSE events 通道广播一帧，
 * 客户端收到后重新 GET /api/dsh-mcp/config 就地更新浮窗位置（无需重启/轮询）。
 */
export function installConfigSettings(
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
export function injectSettingsSink(ctx: Context, manager: McpManager): void {
  if (typeof ctx.inject !== "function") return;
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
