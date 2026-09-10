/**
 * dsh-mcp-manager — types/server.ts：服务器配置/运行状态类型（#664 阶段 6 收敛）。
 *
 * 自 src/types.ts 拆出（server 域）：ServerConfig 形状以 src/index.ts 的
 * normalizeServer 产出为准（唯一构造点），import.ts（mcpServers 映射）与
 * store 持久化共用本类型；运行时零成本（type-only，编译期擦除）。
 */

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** MCP 服务器配置（归一化后）。 */
export interface ServerConfig {
  name: string;
  transport: "stdio" | "streamable-http";
  /** 由 normalizeServer 补齐；导入/持久化数据可能缺省。 */
  enabled?: boolean;
  toolCallTimeoutMs?: number;
  /** 重连策略（透传，形状由 transport/supervisor 消费）。 */
  reconnect?: Record<string, unknown>;
  /** 能力目录的自定义描述（用户手写）。 */
  description?: string;
  /**
   * 调用方封装工具定义（registerServer 运行时注入面专用）：
   * 提供时该服务器工具**全部用封装定义注册**（execute 来自调用方，跳过远端
   * schema 投影与通用 callTool）；缺省走现状（远端 schema + 通用 callTool）。
   * 工具名为裸名；模型可见名仍由 publicToolName（mcp__ 前缀）决定。
   * 仅内存态（runtimeRegistry）消费，不随 store 落盘、不随 import 透传。
   */
  toolDefinitions?: ToolDefinition[];
  // stdio 传输字段
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // streamable-http 传输字段
  url?: string;
  headers?: Record<string, string>;
  /** 运行状态（supervisor 维护，非持久化字段）。 */
  status?: unknown;
  [key: string]: unknown;
}