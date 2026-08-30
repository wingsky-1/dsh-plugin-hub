/**
 * mcp-manager 核心服务类型面（单一事实源）。
 *
 * 供 mcp-manager 提供方（src/service.ts re-export + declare module 合并）
 * 与消费方插件（如 dsh-codegraph）引用——消费方**从 mcp-manager 包引类型**
 * （`import type { McpManagerService } from "@wingsky-1/dsh-mcp-manager"`），
 * 本文件是类型定义的唯一事实源，mcp-manager 包 re-export 之。纯类型，
 * esbuild 构建期内联、随包复制（d.ts X1）。
 *
 * 服务面（通用 MCP 能力 + 运行时注入专用面）：
 * - 注入面：registerServer / unregisterServer（内存态不落盘，同名幂等；
 *   registerServer 支持可选 toolDefinitions——调用方封装定义，见下）；
 * - 控制面：connect / disconnect / reconnect（通用 MCP 生命周期，注册即连、
 *   注销即断的补充控制）；
 * - 查询面：getStatus / getTools / list（连接状态、工具列表、全量摘要——
 *   「作为 MCP 应能感知连接状态与工具列表」，评审③ MVP 裁剪为纯注入面是
 *   过度裁剪，查询面是消费方感知服务状态所必需）。
 */

/** 封装工具定义（官方 dsh-tools 契约；类型面引用，编译期擦除）。 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** 服务器连接状态（与 manager summarize 投影一致）。 */
export type McpServerStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disabled"
  | "stopped"
  | "failed";

/** 作用域。 */
export type McpScope = "global" | "project";

/** 某服务器的实时摘要（配置 + 状态 + 工具 + 错误）。 */
export interface McpServerSummary {
  name: string;
  transport: "stdio" | "streamable-http";
  scope: McpScope;
  status: McpServerStatus;
  error?: string;
  tools: string[];
  enabled: boolean;
}

/** 某服务器的工具条目（查询面，返回名称 + 描述）。 */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/** 运行时注入服务器的入参（normalizeServer 接受的最小面）。 */
export interface McpManagerServerInput {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  toolCallTimeoutMs?: number;
  reconnect?: Record<string, unknown>;
  description?: string;
  /**
   * 可选：调用方封装工具定义（裸名；如 dsh-codegraph 的 codegraph_explore）。
   * 提供时该服务器工具全部用封装定义注册（execute 来自调用方，跳过远端
   * schema 与通用 callTool）；缺省维持现状（远端 schema + mcp__ 前缀 +
   * 通用 callTool）。模型可见名仍由 manager 命名机制决定（mcp__ 前缀）；
   * 工具级禁用/可见性/能力目录照常生效。仅内存态消费，不落盘。
   */
  toolDefinitions?: ToolDefinition[];
}

/** ctx.mcpManager service 面（完整：注入 + 控制 + 查询）。 */
export interface McpManagerService {
  // ---- 注入面（内存态不落盘） ----
  /** 运行时注册服务器。同名已存在（store 或 runtime）→ { existing: true } 不抛错。 */
  registerServer(server: McpManagerServerInput): Promise<{ name: string; existing: boolean }>;
  /** 运行时注销（不影响 store 持久化条目；同名 store 条目回落）。 */
  unregisterServer(name: string): Promise<void>;
  // ---- 控制面（通用 MCP 生命周期） ----
  /** 连接指定服务器（已连接 → no-op；未找到 → 抛错）。 */
  connect(name: string, scope?: McpScope): Promise<void>;
  /** 断开指定服务器（未连接 → no-op）。 */
  disconnect(name: string, scope?: McpScope): Promise<void>;
  /** 重连（先断后连）。 */
  reconnect(name: string, scope?: McpScope): Promise<void>;
  // ---- 查询面（服务状态感知） ----
  /** 某服务器实时摘要（状态/工具/错误）。未注册 → undefined。 */
  getStatus(name: string): McpServerSummary | undefined;
  /** 某服务器已注册工具列表（名称 + 描述）。 */
  getTools(name: string): McpToolInfo[];
  /** 全部服务器摘要（store 持久化 + runtime 双轨合并）。 */
  list(): McpServerSummary[];
}
