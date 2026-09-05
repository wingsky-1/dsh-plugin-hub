/**
 * dsh-provider-usage — 模型配置读取（V1 配置链 + DSH 凭据 seam 双层）。
 *
 * 密钥解析优先级（从高到低）：
 *   0. DSH 通用凭据 seam——由 configurable provider 目录驱动：读该 provider 的
 *      settings 命名空间（llm adapter 声明的 `apiKeyEnv` 凭据引用名），再经
 *      `credentials.resolve(ref)` 按 DSH 统一机制取值（env → .credentials.yaml
 *      refs → .env）。不猜环境变量名，与 llm 层同源同 key。
 *   1. 插件配置中的显式 apiKey
 *   2. 环境变量 {PROVIDER}_API_KEY（大写，连字符替换为下划线）
 *   3. opencode-go 兼容旧环境变量 OPENCODE_GO_API_KEY
 *   4. .credentials.yaml 文件：先查 {PROVIDER}_API_KEY 字段，opencode-go
 *      在标准 key 未命中时再查旧名 OPENCODE_GO_API_KEY
 *   5. auth.json 文件（仅 opencode-go 兼容）
 *
 * V1 链保留为兜底：opencode-go 默认 provider 不在 DSH configurable 目录，
 * seam 对 null 时须回落 V1 链，勿用 seam 替换。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dshHome as dshHomeShared } from "../../../shared/dsh-home.js";

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

/** .credentials.yaml 文件路径（DSH 官方凭据文档，dsh-credentials-local 同源：
 *  base 语义由 shared/dsh-home.js 承载，#517 收敛）。 */
export function credentialsFile(dshHome?: string): string {
  return join(dshHome ?? dshHomeShared(), ".credentials.yaml");
}

/** auth.json 文件路径。 */
export function opencodeAuthFile(): string {
  // dsh-gate:allow-homedir #525 opencode 外部凭据：DSH_HOME 域之外的第三方工具自身写面
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * 解析 provider 配置（DSH 凭据 seam + V1 配置链兜底）。
 *
 * @param provider - provider 路由键。
 * @param ctx - 插件 apply 收到的 cordis 上下文；用于访问 llm/settings/credentials
 *   服务（经可选访问取用，缺席时回落 V1 链，不引入硬依赖）。
 * @param input - 插件配置提供（apiEndpoint/apiKey）。
 *
 * apiKey 解析优先级：
 *   0. DSH 凭据 seam（见 resolveViaCredentialSeam）
 *   1. 显式 input.apiKey
 *   2. 环境变量 {PROVIDER}_API_KEY
 *   3. opencode-go 兼容旧环境变量 OPENCODE_GO_API_KEY
 *   4. .credentials.yaml 的 {PROVIDER}_API_KEY（opencode-go 再查旧名）
 *   5. auth.json（仅 opencode-go）
 */
export async function resolveProviderConfig(
  provider: string,
  ctx?: unknown,
  input?: ProviderConfigInput,
): Promise<ResolvedProviderConfig> {
  const apiEndpoint = input?.apiEndpoint?.trim() || undefined;

  // 0. DSH 通用凭据 seam（最高优先，且不替换 V1 链）
  const seamKey = await resolveViaCredentialSeam(provider, ctx);
  if (seamKey !== undefined) return { apiEndpoint, apiKey: seamKey };

  // 1–5. V1 配置链兜底
  const apiKey = await resolveApiKey(provider, input?.apiKey);
  return { apiEndpoint, apiKey };
}

/**
 * DSH 通用凭据 seam：由 configurable provider 目录驱动，读 provider 的 settings
 * 命名空间（llm adapter 声明的 `apiKeyEnv` 凭据引用名），再经 `credentials.resolve`
 * 按 DSH 统一机制取值。沿线 `settingsPath` 下钻（覆盖 pi-ai 等嵌套命名空间）。
 * 任何环节缺席/无值一律返回 undefined（回落 V1 链），不抛错。
 */
async function resolveViaCredentialSeam(
  provider: string,
  ctx?: unknown,
): Promise<string | undefined> {
  const anyCtx = (ctx ?? {}) as {
    llm?: { listConfigurableProviders?: () => Array<{ provider: string; settingsNs: string; settingsPath?: string[] }> };
    get?: (name: string) => unknown;
  };
  if (typeof anyCtx.llm?.listConfigurableProviders !== "function") return undefined;

  const dir = anyCtx.llm.listConfigurableProviders().find((c) => c.provider === provider);
  if (dir === undefined) return undefined;

  const settings = anyCtx.get?.("settings") as { get?: (ns: string) => unknown } | undefined;
  const credentials = anyCtx.get?.("credentials") as { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } | undefined;
  if (settings === undefined || typeof settings.get !== "function") return undefined;
  if (credentials === undefined || typeof credentials.resolve !== "function") return undefined;

  // 沿 settingsPath 下钻到 provider profile 对象
  let node: unknown = settings.get(dir.settingsNs);
  for (const seg of dir.settingsPath ?? []) {
    node = (node as Record<string, unknown> | undefined)?.[seg];
  }
  const ref = (node as { apiKeyEnv?: string } | undefined)?.apiKeyEnv;
  if (typeof ref !== "string" || ref.length === 0) return undefined;

  const got = await credentials.resolve(ref);
  if (got !== undefined && typeof got.value === "string" && got.value.length > 0) {
    return got.value;
  }
  return undefined;
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