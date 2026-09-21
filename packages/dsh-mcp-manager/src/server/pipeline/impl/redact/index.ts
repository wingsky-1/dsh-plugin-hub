/**
 * dsh-mcp-manager — pipeline/impl/redact/index.ts：凭据脱敏器（#664 阶段 2 迁入，B8 改口径同文件）。
 *
 * B8（D4 决策）：仅用户信息脱敏（username/password/searchParams），host/path
 * 无凭据保留可读（现状整 URL 脱敏，可诊断性差）；raw/decoded 双形态注册——
 * 错误消息中出现的是原始 URL 字节串（percent-encoding 形态），URL parse 拿到
 * decoded 形态，两者都须命中（否则 percent-encoding 绕过回归，评审 B8 修正）。
 */
import type { ServerConfig } from "../../../config/interface.ts";

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

/** 长 flag 精确名集合（去横线小写后全等匹配。子串匹配会把 --turkey 当成含 key 误收下个参数作秘密，过度脱敏；#903 B-M2）。覆盖旧子串口径的全部常见形态。 */
const SECRET_FLAG_NAMES: ReadonlySet<string> = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pass",
  "passphrase",
  "key",
  "keys",
  "apikey",
  "api-key",
  "secretkey",
  "secret-key",
  "auth",
  "authorization",
  "authtoken",
  "auth-token",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "access-token",
  "accesstoken",
  "client-secret",
  "clientsecret",
]);

/** 短 flag 精确集合（#903 B-M2：-p password 这类单字母形态旧口径漏收）。只认独占一拍的精确形态。 */
const SECRET_SHORT_FLAGS: ReadonlySet<string> = new Set(["-p", "-k", "-s"]);

/** flag 名是否为凭据形参（精确匹配；短 flag 另判）。 */
function isSecretFlagName(flag: string): boolean {
  return SECRET_FLAG_NAMES.has(flag.replace(/^-+/, "").toLowerCase());
}

/** 收集 stdio 形态服务器的 secret：回答「本地命令的秘密在哪？」——环境变量值
 * 全收 + 疑似凭据 flag 的参数值（`--token x` 与 `--token=x` 两种形态，另收 `-p/-k/-s` 短 flag 下一拍；长 flag 精确名匹配）；http 形态
 * （headers/URL 用户信息）的收集在 createRedactor 内（不同问题）。 */
function collectStdioSecrets(server: ServerConfig, secrets: Set<string>): void {
  for (const value of Object.values(server.env ?? {})) addSecretPair(secrets, value);
  const args = server.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (SECRET_SHORT_FLAGS.has(argument)) {
      const value = args[index + 1];
      if (value !== undefined && value.length > 0) addSecretPair(secrets, value);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!isSecretFlagName(flag)) continue;
    const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
    if (value !== undefined && value.length > 0) addSecretPair(secrets, value);
  }
}

/** 展示侧 args 脱敏（#925）：凭据形 flag 的参数值替换为 "[REDACTED]"，flag 名与非秘密元素原样保留可诊断。与 collectStdioSecrets 同一套 flag 口径（`--token x` / `--token=x` / `-p/-k/-s` 下一拍，长 flag 精确名匹配），空值不掩（无秘密可泄）；非字符串元素按 String() 原样带过。调用方（summarize 只读投影）展示用，写路径见 stripProjectionPatch 丢弃占位符。 */
export function maskSecretArgsForDisplay(args: readonly unknown[]): string[] {
  const out = args.map((entry) => String(entry));
  const masked = new Set<number>();
  const maskAt = (index: number): void => {
    if (index >= 0 && index < out.length && (out[index] as string).length > 0) {
      out[index] = "[REDACTED]";
      masked.add(index);
    }
  };
  const maskEqualsValue = (index: number, text: string): void => {
    const equals = text.indexOf("=");
    if (equals >= 0 && text.slice(equals + 1).length > 0) {
      out[index] = `${text.slice(0, equals + 1)}[REDACTED]`;
      masked.add(index);
    }
  };
  for (let index = 0; index < out.length; index += 1) {
    if (masked.has(index)) continue;
    const argument = out[index] as string;
    if (SECRET_SHORT_FLAGS.has(argument)) {
      maskAt(index + 1);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!isSecretFlagName(flag)) continue;
    if (equals < 0) maskAt(index + 1);
    else maskEqualsValue(index, argument);
  }
  return out;
}

/** 凭据脱敏器：从服务器配置收集 secret 值，替换错误消息中的出现。 */
export function createRedactor(servers: readonly ServerConfig[]): (error: unknown) => string {
  const secrets = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      collectStdioSecrets(server, secrets);
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
