/**
 * dsh-mcp-manager — mcpServers JSON 导入（独立模块）。
 *
 * 把 mcpServers JSON 条目（{ serverName: config }，业界通用格式）映射为
 * 插件服务器配置：解析粘贴的 JSON 文本，供 /api/dsh-mcp/import/json
 * 使用。仅支持 JSON 文本导入（不扫描任何应用的配置文件）。
 * 由 lib/index.js 组合根 re-export。
 */

import type { ServerConfig } from "./types.ts";

// ------------------------------------------- mcpServers JSON 条目映射

/** 把一条 mcpServers JSON 条目映射为服务器配置。 */
export function fromClaudeEntry(name: string, entry: Record<string, unknown>): ServerConfig {
  const type = entry.type;
  if (type === "http" || type === "sse" || entry.url !== undefined) {
    if (typeof entry.url !== "string" || entry.url === "") throw new Error(`server "${name}": missing url`);
    const server: ServerConfig = {
      name,
      transport: "streamable-http",
      url: entry.url,
    };
    if (typeof entry.headers === "object" && entry.headers !== null) server.headers = entry.headers as Record<string, string>;
    if (typeof entry.env === "object" && entry.env !== null && Object.keys(entry.env).length > 0) {
      // http 传输不支持 env，合并进 headers 之外忽略——记录来源即可
      server.sourceEnv = Object.keys(entry.env);
    }
    return server;
  }
  if (typeof entry.command !== "string" || entry.command === "") {
    throw new Error(`server "${name}": unsupported entry (need command or url)`);
  }
  const server: ServerConfig = {
    name,
    transport: "stdio",
    command: entry.command,
  };
  if (Array.isArray(entry.args)) server.args = entry.args.map(String);
  if (typeof entry.cwd === "string" && entry.cwd !== "") server.cwd = entry.cwd;
  if (typeof entry.env === "object" && entry.env !== null) {
    server.env = Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)]));
  }
  return server;
}

/** 解析一段 mcpServers JSON 文本为配置列表。 */
export function parseClaudeJson(text: string): ServerConfig[] {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON must be an object of { serverName: config }");
  }
  return Object.entries(parsed as Record<string, unknown>).map(([name, entry]) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`server "${name}": entry must be an object`);
    return fromClaudeEntry(name, entry as Record<string, unknown>);
  });
}
