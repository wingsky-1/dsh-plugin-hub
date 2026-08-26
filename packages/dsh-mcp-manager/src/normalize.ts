/**
 * dsh-mcp-manager — 服务器配置归一化（纯函数，单一事实源）。
 *
 * normalizeServer 校验并规范化一条 MCP 服务器配置（stdio / streamable-http），
 * 供 Manager 增改与 mcpServers JSON 导入路径共用；SERVER_NAME_PATTERN 为
 * 服务器名命名空间约束（与官方 dsh-mcp-client 一致）。
 */

import type { ServerConfig } from "./types.ts";
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from "./supervisor.ts";

/** MCP 服务器名命名空间约束（与官方 dsh-mcp-client 一致）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 校验并规范化一条服务器配置。 */
export function normalizeServer(input: unknown): ServerConfig {
  if (typeof input !== "object" || input === null) throw new Error("server config must be an object");
  const src = input as Record<string, unknown>;
  const name = String(src.name ?? "").trim();
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`server name must match ${SERVER_NAME_PATTERN.source}`);
  }
  const transport = src.transport === "streamable-http" ? "streamable-http" : src.transport === "stdio" ? "stdio" : undefined;
  if (transport === undefined) throw new Error('transport must be "stdio" or "streamable-http"');
  if (transport === "stdio") {
    if (typeof src.command !== "string" || (src.command as string).trim() === "") {
      throw new Error("stdio server requires a command");
    }
  } else {
    if (typeof src.url !== "string" || (src.url as string).trim() === "") {
      throw new Error("streamable-http server requires a url");
    }
    try {
      new URL(src.url as string);
    } catch {
      throw new Error(`invalid url: ${src.url}`);
    }
  }
  const server: ServerConfig = {
    name,
    transport,
    enabled: src.enabled !== false,
    toolCallTimeoutMs: typeof src.toolCallTimeoutMs === "number" && (src.toolCallTimeoutMs as number) > 0
      ? Math.floor(src.toolCallTimeoutMs as number)
      : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    reconnect: (src.reconnect as Record<string, unknown> | undefined) ?? {},
    // 能力目录的自定义描述（用户手写；MCP 协议无服务器级自描述，完整保留不截断）。
    description: typeof src.description === "string" && (src.description as string).trim() !== ""
      ? (src.description as string).trim()
      : undefined,
  };
  if (transport === "stdio") {
    server.command = src.command as string;
    if (Array.isArray(src.args)) server.args = (src.args as unknown[]).map(String);
    if (typeof src.cwd === "string" && (src.cwd as string) !== "") server.cwd = src.cwd as string;
    if (typeof src.env === "object" && src.env !== null) {
      server.env = Object.fromEntries(Object.entries(src.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
    }
  } else {
    server.url = src.url as string;
    if (typeof src.headers === "object" && src.headers !== null) {
      server.headers = Object.fromEntries(Object.entries(src.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
    }
  }
  return server;
}
