/**
 * dsh-mcp-manager — 中间层共享类型（单一事实源）。
 *
 * 供 middleware 各职责文件（连接池 / 纯函数 / 检索 / 状态 / 注册）取用；
 * 类型统一自本文件取，防循环引用（type-only，编译期擦除）。
 */

import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type { MCPClient } from "./protocol.ts";
import type { StdioTransport, HttpTransport } from "./transport.ts";
import type { ServerConfig } from "./types.ts";

/** 中间层模式：off = 直呼（默认兼容）；project = 项目级走中间层；all = 全部走中间层。 */
export type MiddlewareMode = "off" | "project" | "all";

/** 用户已禁用的工具集合（root → server → tool 列表）。root 为 @global 时跨工作空间共享。 */
export type DisabledToolsMap = Map<string, Map<string, Set<string>>>;

/** 策略过滤模式。 */
export interface MiddlewarePolicy {
  /** server 名（裸名，不含 @root 前缀）→ 允许的工具 glob（空 = 全部允许）。 */
  allowTools?: Record<string, string[]>;
  /** server 名（裸名）→ 拒绝的工具 glob（deny 优先）。 */
  denyTools?: Record<string, string[]>;
}

/** 连接池条目（每工作空间一套）。 */
export interface ProjectUnit {
  root: string;
  /** server 名（裸名）→ 连接条目。 */
  connections: Map<string, ConnectionEntry>;
  /** 目录缓存（last-good：连接断不丢）。 */
  catalog: Map<string, CatalogServer>;
  /** 用户禁用集合（持久化）。 */
  userDisabled: Set<string>;
  /** 最近触达时间（LRU 淘汰依据）。 */
  lastTouchedAt: number;
  /** 连接/发现 in-flight 去重（server 名 → Promise）。 */
  inFlight: Map<string, Promise<unknown>>;
}

/** 单服务器连接条目。 */
export interface ConnectionEntry {
  server: ServerConfig;
  client: MCPClient | undefined;
  transport: StdioTransport | HttpTransport | undefined;
  /** 连接状态：connecting / connected / failed / disabled。 */
  status: string;
  error: unknown;
  connectedAt: number | undefined;
  /** 后台重连定时器。 */
  reconnectTimer: NodeJS.Timeout | undefined;
  /** 代际断开清理。 */
  disposed: boolean;
  /** 连续失败次数（有界指数退避依据；连接成功后清零）。 */
  failedAttempts: number;
  /** 防双进程探测命中后的重试已排（#382 F5：只重试一次；连接成功后复位）。 */
  probeRetried?: boolean;
}

/** 目录中的单服务器条目。 */
export interface CatalogServer {
  /** 发现时间戳。 */
  discoveredAt: number;
  /** 工具列表（裸名 → 描述 + schema 摘要）。 */
  tools: Map<string, CatalogTool>;
  /** 发现失败原因（unavailable 段）。 */
  unavailable?: string;
}

/** 目录中的单工具。 */
export interface CatalogTool {
  description: string;
  inputSchema: Record<string, unknown>;
}

/** ws_mcp_search 单条命中。 */
export interface SearchHit {
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  score: number;
  matchedTerms: string[];
  fresh: boolean;
}

/** ws_mcp_list 的单个工具条目（完整清单只给摘要，防上下文膨胀）。 */
export interface ListToolEntry {
  tool: string;
  description: string;
  /** 工具级被用户禁用（独立于服务器级 enabled；仅在禁用时置位）。 */
  disabled?: boolean;
}

/** ws_mcp_list 的单个服务器条目。 */
export interface ListServerEntry {
  /** @<root>/<server> 全名。 */
  server: string;
  /** 用户已禁用（工具来自 last-good 目录缓存，明示）。 */
  disabled?: boolean;
  /** 发现失败原因（unavailable 段）。 */
  unavailable?: string;
  tools: ListToolEntry[];
  /** 工具数被 perServerLimit 截断。 */
  toolsTruncated: boolean;
}

/** ws_mcp_detail 的单工具详情（完整 inputSchema）。 */
export interface ToolDetail {
  /** @<root>/<server> 全名。 */
  server: string;
  /** 远端工具裸名（已归一化）。 */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 目录是否新鲜（TTL 内）。 */
  fresh: boolean;
  /** 用户已禁用。 */
  disabled?: boolean;
}

/** ws_mcp_list 输出（多单元合并的完整盘点）。 */
export interface ListCatalogResult {
  /** 当前工作空间 root；all 模式无项目 cwd 时为 "@global"。 */
  workspace: string;
  /** 中间层模式（模型据此理解可见范围）。 */
  mode: string;
  servers: ListServerEntry[];
  totalServers: number;
  totalTools: number;
  /** 任一服务器截断即为 true。 */
  toolsTruncated: boolean;
  /** 空返回时给模型的明确提示。 */
  message?: string;
}

/** 中间层最小面（manager 提供）。 */
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
  /** 该 server 是否全局级（双源：store.data.servers + runtimeRegistry；codegraph 为 runtime 注册）。 */
  isGlobalServer(name: string): boolean;
}