/**
 * dsh-mcp-manager — types/host-faces.ts：宿主最小面接口收敛（#664 阶段 6，v3 §二）。
 *
 * 四个最小面接口（ManagerLite / RoutesManager / MiddlewareHost / SupervisorLite）
 * 原散落于 supervisor.ts / routes.ts / middleware-types.ts / catalog/entries.ts，
 * 阶段 6 集中收敛到 types 域（DTO 集中规划）：宿主类（McpManager / McpMiddleware /
 * ConnectionSupervisor）实现这些面，消费侧按面引用防循环 import。
 */

import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { McpStatsCollector } from "../stats/interface.ts";
import type { ClientUiConfig } from "./ui.ts";
import type { ServerConfig } from "./server.ts";
import type { McpStore } from "../config/store/interface.ts";
import type { ProjectUnit } from "./middleware-types.ts";
import type { SseHub } from "../../../../shared/sse-hub.js";

/** McpManager 最小面（supervisor 使用；避免 index↔supervisor 循环 import）。
 * tools 面取官方 Context，register 入参为官方 ToolDefinition。 */
export interface ManagerLite {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  enhancement: { enhanceEmptyDescriptions?: boolean; resultTruncateBytes?: number };
  emitStatus(): void;
  recordCatalogTools(serverName: string, toolMeta: Map<string, { description?: unknown }>): Promise<void>;
  /** 行为扩展（#664 阶段 2）：调用统计最小面，supervisor 直呼路径埋点。 */
  stats?: Pick<McpStatsCollector, "isEnabled" | "recordCall">;
}

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

/** 中间层宿主最小面（McpManager 实现；McpMiddleware 构造注入）。 */
export interface MiddlewareHost {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  /** 按 root 读取项目级服务器配置（惰性；root 无标记 → undefined）。 */
  projectServersFor(root: string): Promise<ServerConfig[] | undefined>;
  /** 全局服务器配置（走中间层 all 模式时使用）。 */
  globalServers(): ServerConfig[];
  /** 路由解析：cwd → 归一化项目根。 */
  normalizedProjectRoot(cwd: string | undefined): Promise<string | undefined>;
  /** 持久化 userDisabled。 */
  saveUserState(units: Map<string, ProjectUnit>): Promise<void>;
  /** 状态变化通知（SSE 标脏）。 */
  emitStatus(): void;
  /** 目录缓存文件路径（last-good 持久化）。 */
  catalogCachePath(root: string): string;
  /** 该 server 是否全局级（双源：store.data.servers + runtimeRegistry；runtime 注册的服务器不落 store）。 */
  isGlobalServer(name: string): boolean;
  /** 该 server 是否 runtime 注入（registerServer 内存态；目录不写盘判定，#413）。 */
  isRuntimeServer(name: string): boolean;
}

/** supervisor 最小面（manager.supervisors 的条目）。 */
export interface SupervisorLite {
  server: ServerConfig;
  /** 服务器归属（global/project）；目录条目携带用于调用引导（#228）。 */
  scope?: string;
}