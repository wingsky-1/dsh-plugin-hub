/**
 * dsh-provider-usage — 模型配置读取（V1 配置链）。
 *
 * 评审结论：V2（settings 命名空间读取）不可行，因为 LlmConfigurableProvider
 * 无标准化 apiKey/baseURL 字段。永久方案为 V1 配置链。
 *
 * 配置链优先级（从高到低）：
 * 1. 插件配置中的显式 apiEndpoint / apiKey
 * 2. 环境变量 {PROVIDER}_API_KEY（大写，连字符替换为下划线）
 * 3. .credentials.yaml 文件中的 {PROVIDER}_API_KEY 字段
 * 4. opencode-go 兼容旧环境变量 OPENCODE_GO_API_KEY
 * 5. auth.json 文件（仅 opencode-go 兼容）
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 插件配置提供的 apiEndpoint/apiKey（可选）。 */
export interface ProviderConfigInput {
  apiEndpoint?: string;
  apiKey?: string;
}

/** 读取并解析后的 provider 配置。 */
export interface ResolvedProviderConfig {
  apiEndpoint?: string;
  apiKey?: string;
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 .credentials.yaml 按 keyName 读取密钥。 */
function credentialsKeyFromYaml(text: string | undefined, keyName: string): string | undefined {
  if (typeof text !== "string") return undefined;
  const match = text.match(new RegExp(`${escapeRegex(keyName)}\\s*:\\s*["']?([^"'\r\n#]+)`, "u"));
  if (match === null) return undefined;
  const key = match[1].trim();
  return key.length > 0 ? key : undefined;
}

/** 从 auth.json 读取 opencode-go 兼容密钥。 */
function opencodeKeyFromAuth(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const entry = (rec["opencode-go"] ?? rec["opencode"]) as Record<string, unknown> | undefined;
  if (entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) {
    return entry.key;
  }
  return undefined;
}

/** .credentials.yaml 文件路径。 */
export function credentialsFile(dshHome?: string): string {
  return join(dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
}

/** auth.json 文件路径。 */
export function opencodeAuthFile(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * 解析 provider 配置（V1 配置链）。
 *
 * 返回的 apiEndpoint 优先级：
 *   1. 显式配置 input.apiEndpoint
 *   2. 无（必须由适配器 staticPath + 插件配置组合）
 *
 * 返回的 apiKey 优先级：
 *   1. 显式配置 input.apiKey
 *   2. 环境变量 {PROVIDER}_API_KEY
 *   3. .credentials.yaml 中的 {PROVIDER}_API_KEY
 *   4. opencode-go 兼容旧环境变量
 *   5. auth.json（仅 opencode-go）
 */
export async function resolveProviderConfig(
  provider: string,
  input?: ProviderConfigInput,
): Promise<ResolvedProviderConfig> {
  const apiEndpoint = input?.apiEndpoint?.trim() || undefined;
  const apiKey = await resolveApiKey(provider, input?.apiKey);
  return { apiEndpoint, apiKey };
}

/** 解析密钥（V1 配置链）。 */
async function resolveApiKey(
  provider: string,
  explicitKey?: string,
): Promise<string | undefined> {
  // 1. 显式配置优先
  if (typeof explicitKey === "string" && explicitKey.trim() !== "") return explicitKey.trim();

  // 2. 环境变量 {PROVIDER}_API_KEY
  const envVar = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const env = process.env[envVar];
  if (typeof env === "string" && env.trim() !== "") return env.trim();

  // 3. opencode-go 兼容旧环境变量名
  if (provider === "opencode-go") {
    const legacy = process.env.OPENCODE_GO_API_KEY;
    if (typeof legacy === "string" && legacy.trim() !== "") return legacy.trim();
  }

  // 4. .credentials.yaml
  try {
    const credFile = credentialsFile();
    if (existsSync(credFile)) {
      const text = await readFile(credFile, "utf8");
      const fromYaml = credentialsKeyFromYaml(text, envVar);
      if (fromYaml !== undefined) return fromYaml;
      // opencode-go 兼容旧 key 名
      if (provider === "opencode-go") {
        const legacy = credentialsKeyFromYaml(text, "OPENCODE_GO_API_KEY");
        if (legacy !== undefined) return legacy;
      }
    }
  } catch { /* 忽略 */ }

  // 5. auth.json（仅 opencode-go）
  if (provider === "opencode-go") {
    try {
      const authFile = opencodeAuthFile();
      if (existsSync(authFile)) {
        const text = await readFile(authFile, "utf8");
        const fromAuth = opencodeKeyFromAuth(text);
        if (fromAuth !== undefined) return fromAuth;
      }
    } catch { /* 忽略 */ }
  }

  return undefined;
}