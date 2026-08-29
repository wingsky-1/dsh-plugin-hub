/**
 * mcp-manager 核心化 service 类型（官方 storageDomain 模式）。
 *
 * 提供方：apply.ts 中 ctx.provide("mcpManager", service)。
 * 消费方：其他插件 `declare module "@deepseek-ai/cordis"` 扩展 Context 后
 * 经 `ctx.mcpManager` 调用；inject 声明 `"mcpManager"`（或运行时 ctx.get 探测）。
 */

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
}

/** ctx.mcpManager service 面（MVP：register / unregister）。 */
export interface McpManagerService {
  /** 运行时注册服务器（内存态，不落盘）。同名已存在 → { existing: true } 不抛错。 */
  registerServer(server: McpManagerServerInput): Promise<{ name: string; existing: boolean }>;
  /** 运行时注销（不影响 store 持久化条目；同名 store 条目回落）。 */
  unregisterServer(name: string): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** mcp-manager 核心服务：其他插件运行时注入 MCP 服务器（官方 storageDomain 模式）。 */
    mcpManager: McpManagerService;
  }
}
