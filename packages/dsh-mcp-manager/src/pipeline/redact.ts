/**
 * dsh-mcp-manager — pipeline/redact：凭据脱敏器（#664 阶段 2 迁入，B8 改口径同文件）。
 *
 * 原自 middleware-utils.ts createRedactor（现状整 URL 脱敏口径）。
 * B8（D4 决策）：改「仅用户信息 + raw/decoded 双形态」在阶段 2 修复 commit 实施；
 * 本文件先保持现状语义迁移（零行为变更），基线测试同步锁定。
 */
import type { ServerConfig } from "../types.ts";

/** 凭据脱敏器：从服务器配置收集 secret 值，替换错误消息中的出现。 */
export function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      for (const value of Object.values(server.env ?? {})) if (value.length > 0) secrets.add(value);
      const args = server.args ?? [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? "";
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (!/(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)) continue;
        const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
        if (value !== undefined && value.length > 0) secrets.add(value);
      }
      continue;
    }
    for (const value of Object.values(server.headers ?? {})) if (value.length > 0) secrets.add(value);
    const url = server.url;
    if (typeof url === "string" && url !== "") {
      secrets.add(url);
      try {
        const parsed = new URL(url);
        if (parsed.username.length > 0) secrets.add(parsed.username);
        if (parsed.password.length > 0) secrets.add(parsed.password);
        for (const value of parsed.searchParams.values()) if (value.length > 0) secrets.add(value);
      } catch {
        // 非法 URL 忽略
      }
    }
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  return (error: unknown): string => {
    let text: string;
    try {
      text = error instanceof Error ? error.message : String(error);
    } catch {
      text = "<unprintable error>";
    }
    for (const secret of ordered) text = text.split(secret).join("[REDACTED]");
    return text;
  };
}