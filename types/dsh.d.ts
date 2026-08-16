/**
 * DSH 插件宿主端类型层（非官方）。
 *
 * 来源：基于 dsh 0.1.0-rc.6 + 本仓库各插件实际调用点反推，
 * 非官方 API 文档；dsh 升级后须按同一验证链路（smoke + health）核验并同步。
 *
 * 使用约定：
 * - 优先使用本文件的最小接口；未知服务/字段用 `unknown` 兜底。
 * - `unknown` 优先于 `any`；确需 any 时注明原因。
 * - 每迁移一个插件，按该插件实际用到的服务面收紧一处类型。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** webServer.register 的路由对象（kind: exact / prefix）。 */
export interface DshRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;
}

/** 模型工具定义（ctx.tools.register 入参）。 */
export interface DshTool {
  /** 工具名（dsh-mcp-manager 用 name 注册；id 与 name 二选一）。 */
  id?: string;
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
  execute(args: Record<string, unknown> | undefined, ctx?: unknown): unknown;
  /** ⚠️ 必须返回块数组（`[{ type: "text", text }]`），字符串 content 会触发宿主崩溃。 */
  output?: {
    schema?: Record<string, unknown>;
    render(args: unknown, value?: unknown): Array<{ type: string; text?: unknown; [key: string]: unknown }>;
  };
  [key: string]: unknown;
}

export interface DshLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface DshWebServer {
  /** 注册路由；返回 disposer（⚠️ 非 fiber 自动管理，卸载必须显式调用）。 */
  register(route: DshRoute): () => void;
  /** 已注册的 prefix 路由表（dsh-gzip 双挂点依赖，非官方字段）。 */
  prefixes?: Map<string, { kind: string; path: string; handler: DshRoute["handler"] }>;
  /** web 服务器实际绑定端口（--port 0 时启动后才有值；lan-proxy 依赖）。 */
  port?: number;
  /** 注入 index.html 的钩子（返回 disposer；lan-proxy polyfill 依赖）。 */
  tapIndex?(transform: (html: string) => string): () => void;
  [key: string]: unknown;
}

/** 插件宿主端 apply 接收的 ctx（cordis 上下文，服务面按需收紧）。 */
export interface PluginContext {
  logger: DshLogger;
  webServer: DshWebServer;
  tools: {
    register(tool: DshTool): () => void;
    [key: string]: unknown;
  };
  /** ⚠️ fn 在 apply 期间立即同步执行；只有 fn **返回**的函数才在 fiber 卸载时被调用。 */
  effect<T>(fn: () => T, label?: string): () => void;
  /**
   * 事件订阅；返回 disposer。
   * 事件参数无法静态枚举，回调参数由监听器自行声明（事件系统合理折衷）。
   */
  on(event: string, handler: (...args: any[]) => void): () => void;
  /** 按名取服务实例（notifier 的 userQuestions 动态包装依赖）。 */
  get?<T = unknown>(service: string, required?: boolean): T | undefined;
  // —— 以下服务面在相关插件迁移时按实测收紧 ——
  llm?: Record<string, unknown>;
  sessionQuery?: Record<string, unknown>;
  workspaces?: Record<string, unknown>;
  systemPrompt?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  sessionPersistence?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  [key: string]: unknown;
}
