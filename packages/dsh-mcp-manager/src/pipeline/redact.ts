/**
 * dsh-mcp-manager — pipeline/redact：凭据脱敏器（#664 阶段 2 迁入，B8 改口径同文件）。
 *
 * B8（D4 决策）：仅用户信息脱敏（username/password/searchParams），host/path
 * 无凭据保留可读（现状整 URL 脱敏，可诊断性差）；raw/decoded 双形态注册——
 * 错误消息中出现的是原始 URL 字节串（percent-encoding 形态），URL parse 拿到
 * decoded 形态，两者都须命中（否则 percent-encoding 绕过回归，评审 B8 修正）。
 */
import type { ServerConfig } from "../types/interface.ts";

/** 注册单个敏感值：decoded 形态 + percent-encoded raw 形态双注册。 */
function addSecretPair(secrets: Set<string>, value: string): void {
  if (value.length === 0) return;
  secrets.add(value);
  try {
    secrets.add(encodeURIComponent(value));
  } catch {
    // 编码失败（如孤立代理字符）忽略 raw 形态，decoded 已注册
  }
}

/** 凭据脱敏器：从服务器配置收集 secret 值，替换错误消息中的出现。 */
export function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      for (const value of Object.values(server.env ?? {})) addSecretPair(secrets, value);
      const args = server.args ?? [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] ?? "";
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (!/(?:token|secret|pass|key|auth|cookie|credential)/i.test(flag)) continue;
        const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
        if (value !== undefined && value.length > 0) addSecretPair(secrets, value);
      }
      continue;
    }
    for (const value of Object.values(server.headers ?? {})) addSecretPair(secrets, value);
    const url = server.url;
    if (typeof url === "string" && url !== "") {
      // B8：不加入整 URL——host/path 无凭据部分保留（错误消息可诊断）；
      // 仅用户信息（username/password/searchParams）脱敏。
      try {
        const parsed = new URL(url);
        addSecretPair(secrets, parsed.username);
        addSecretPair(secrets, parsed.password);
        for (const value of parsed.searchParams.values()) addSecretPair(secrets, value);
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