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
import { join } from "node:path";
import { dshHome as dshHomeShared, userHome } from "../../../../../shared/dsh-home.js";

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
 *  base 语义由 shared/dsh-home.js 承载）。 */
export function credentialsFile(dshHome?: string): string {
  return join(dshHome ?? dshHomeShared(), ".credentials.yaml");
}

/** auth.json 文件路径。 */
export function opencodeAuthFile(): string {
  // opencode 是 DSH_HOME 域外的第三方工具，凭据落点跟随用户 home（走共享接缝，
  // 使测试可用 process.env.HOME 隔离——见 shared/dsh-home.js 的 userHome 注释）。
  return join(userHome(), ".local", "share", "opencode", "auth.json");
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

/** configurable provider 目录条目（seam 沿线形状）。 */
interface ConfigurableProviderEntry {
  provider: string;
  settingsNs: string;
  settingsPath?: string[];
}

/** cordis 上下文在 seam 沿线关心的两个面（可选访问，缺席回落 V1 链）。 */
interface CredentialSeamContext {
  llm?: { listConfigurableProviders?: () => ConfigurableProviderEntry[] };
  get?: (name: string) => unknown;
}

interface SettingsService {
  get?: (ns: string) => unknown;
}

interface CredentialsService {
  resolve?: (ref: string) => Promise<{ value?: string } | undefined>;
}

/** seam 沿线已就位的两服务（取用顺序固定 settings → credentials，与历史实现一致）。 */
interface CredentialSeamServices {
  settingsGet: (ns: string) => unknown;
  credentialsResolve: (ref: string) => Promise<{ value?: string } | undefined>;
}

function isCredentialSeamContext(ctx: unknown): ctx is CredentialSeamContext {
  return typeof ctx === "object" && ctx !== null;
}

function isSettingsService(value: unknown): value is SettingsService {
  return typeof value === "object" && value !== null;
}

function isCredentialsService(value: unknown): value is CredentialsService {
  return typeof value === "object" && value !== null;
}

/** 可下标对象判定（类型谓词，承当下钻与字段读取的收窄，取代 as 逃逸）。 */
function isIndexable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 目录定位（纯函数）：configurable provider 目录里的本 provider 条目；
 * ctx 无 llm 面或目录服务缺席即视为不在目录。
 */
export function findProviderDirEntry(
  ctx: unknown,
  provider: string,
): ConfigurableProviderEntry | undefined {
  if (!isCredentialSeamContext(ctx)) return undefined;
  const listProviders = ctx.llm?.listConfigurableProviders;
  if (typeof listProviders !== "function") return undefined;
  return listProviders.call(ctx.llm).find((entry) => entry.provider === provider);
}

/** 沿 settingsPath 下钻到 provider profile 对象（覆盖 pi-ai 等嵌套命名空间）。 */
export function drillSettingsPath(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const seg of path) {
    if (!isIndexable(node)) return undefined;
    node = node[seg];
  }
  return node;
}

/** profile 对象上的凭据引用名（apiKeyEnv）；缺失或空串视同无引用。 */
export function apiKeyEnvOf(profile: unknown): string | undefined {
  if (!isIndexable(profile)) return undefined;
  const ref: unknown = profile.apiKeyEnv;
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

/** seam 所需两服务的就位判定（纯函数）：缺席任一即视同 seam 不可用。 */
export function seamServicesOf(ctx: unknown): CredentialSeamServices | undefined {
  if (!isCredentialSeamContext(ctx) || typeof ctx.get !== "function") return undefined;
  // 入参是 unknown 鸭子上下文（未必是 cordis 的 Ctx），沿历史同名的 anyCtx 别名取用：
  // 既标明「未类型化的 ctx 形态」，也与 upstream-contract-warn 的 S2 口径一致
  // （该判据只认字面量 ctx 接收者，anyCtx 形态不计宿主服务消费）。
  const anyCtx = ctx;
  const settings = anyCtx.get?.("settings");
  const credentials = anyCtx.get?.("credentials");
  if (!isSettingsService(settings) || typeof settings.get !== "function") return undefined;
  if (!isCredentialsService(credentials) || typeof credentials.resolve !== "function") {
    return undefined;
  }
  return { settingsGet: settings.get, credentialsResolve: credentials.resolve };
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
  const dir = findProviderDirEntry(ctx, provider);
  if (dir === undefined) return undefined;
  const services = seamServicesOf(ctx);
  if (services === undefined) return undefined;
  const ref = apiKeyEnvOf(
    drillSettingsPath(services.settingsGet(dir.settingsNs), dir.settingsPath ?? []),
  );
  if (ref === undefined) return undefined;
  const got = await services.credentialsResolve(ref);
  if (got !== undefined && typeof got.value === "string" && got.value.length > 0) {
    return got.value;
  }
  return undefined;
}

/** 去掉首尾空白；非字符串或空白串视同无值。 */
export function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 步骤 2 的环境变量名：{PROVIDER}_API_KEY（大写，连字符 → 下划线）。 */
export function providerApiKeyEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * 进程内来源（步骤 1–3，纯函数，无 I/O）：显式配置 → 标准环境变量 →
 * opencode-go 兼容旧环境变量名。
 */
export function resolveInlineKey(provider: string, explicitKey?: string): string | undefined {
  const explicit = trimmedOrUndefined(explicitKey);
  if (explicit !== undefined) return explicit;
  const fromEnv = trimmedOrUndefined(process.env[providerApiKeyEnvVar(provider)]);
  if (fromEnv !== undefined) return fromEnv;
  if (provider !== "opencode-go") return undefined;
  return trimmedOrUndefined(process.env.OPENCODE_GO_API_KEY);
}

/**
 * 步骤 4：.credentials.yaml（DSH 官方凭据文档）。opencode-go 在标准 key 未命中时
 * 再查旧名 OPENCODE_GO_API_KEY。读盘异常一律忽略（回落下一来源）。
 */
async function credentialsYamlKey(provider: string, envVar: string): Promise<string | undefined> {
  try {
    const credFile = credentialsFile();
    if (!existsSync(credFile)) return undefined;
    const text = await readFile(credFile, "utf8");
    const fromYaml = credentialsKeyFromYaml(text, envVar);
    if (fromYaml !== undefined) return fromYaml;
    if (provider !== "opencode-go") return undefined;
    return credentialsKeyFromYaml(text, "OPENCODE_GO_API_KEY");
  } catch {
    /* 忽略 */
    return undefined;
  }
}

/** 步骤 5：auth.json（仅 opencode-go）。读盘/解析异常一律忽略。 */
async function opencodeAuthKey(): Promise<string | undefined> {
  try {
    const authFile = opencodeAuthFile();
    if (!existsSync(authFile)) return undefined;
    return opencodeKeyFromAuth(await readFile(authFile, "utf8"));
  } catch {
    /* 忽略 */
    return undefined;
  }
}

/** 落盘来源（步骤 4–5）：.credentials.yaml → auth.json（仅 opencode-go）。 */
async function resolveFileKey(provider: string, envVar: string): Promise<string | undefined> {
  const fromYaml = await credentialsYamlKey(provider, envVar);
  if (fromYaml !== undefined) return fromYaml;
  return provider === "opencode-go" ? opencodeAuthKey() : undefined;
}

/** 解析密钥（V1 配置链）：进程内来源优先，落盘来源兜底。 */
async function resolveApiKey(provider: string, explicitKey?: string): Promise<string | undefined> {
  const inline = resolveInlineKey(provider, explicitKey);
  if (inline !== undefined) return inline;
  return resolveFileKey(provider, providerApiKeyEnvVar(provider));
}
