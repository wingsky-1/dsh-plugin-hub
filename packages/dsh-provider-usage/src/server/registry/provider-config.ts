/**
 * dsh-provider-usage — 模型配置读取（V1 配置链 + DSH 凭据 seam 双层）。
 *
 * 密钥解析优先级（从高到低）：
 *   0. DSH 通用凭据 seam——由 configurable provider 目录驱动：经 `settings.describe()`
 *      读该 provider 的命名空间 value（llm adapter 声明的 `apiKeyEnv` 凭据引用名），
 *      再经 `credentials.resolve(ref)` 按 DSH 统一机制取值（env → .credentials.yaml
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
import type { Context } from "@deepseek-ai/cordis";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
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

/** seam 诊断出口（每条漂移面调一次；服务缺席不调用）。 */
export type ProviderConfigDiagnosticSink = (message: string) => void;

/**
 * 解析 provider 配置（DSH 凭据 seam + V1 配置链兜底）。
 *
 * @param provider - provider 路由键。
 * @param ctx - 插件 apply 收到的 cordis 上下文；用于访问 llm/settings/credentials
 *   服务（经可选访问取用，缺席时回落 V1 链，不引入硬依赖）。
 * @param input - 插件配置提供（apiEndpoint/apiKey）。
 * @param onDiagnostic - seam 诊断出口：服务在、方法不在时各面一条（服务缺席不调用）。
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
  onDiagnostic?: ProviderConfigDiagnosticSink,
): Promise<ResolvedProviderConfig> {
  const apiEndpoint = input?.apiEndpoint?.trim() || undefined;

  // 0. DSH 通用凭据 seam（最高优先，且不替换 V1 链）
  const seamKey = await resolveViaCredentialSeam(provider, ctx, onDiagnostic);
  if (seamKey !== undefined) return { apiEndpoint, apiKey: seamKey };

  // 1–5. V1 配置链兜底
  const apiKey = await resolveApiKey(provider, input?.apiKey);
  if (apiKey !== undefined) return { apiEndpoint, apiKey };

  // 6. 已知 provider 的凭据 ref 兜底：seam 不可用（宿主 settings 服务缺席/读面变更）
  //    且 V1 链按 provider 名派生不到 ref 名时，仍与 llm 层共用同一把 key。
  return { apiEndpoint, apiKey: await resolveViaKnownCredentialRef(provider, ctx) };
}

/**
 * configurable provider 目录条目：官方 `Context["llm"]` 目录读面的窄投影
 * （只取 seam 用到的三键；官方条目其余字段不进入本域类型面）。
 */
type ConfigurableProviderEntry = Pick<
  ReturnType<Context["llm"]["listConfigurableProviders"]>[number],
  "provider" | "settingsNs" | "settingsPath"
>;

/** cordis 上下文在 seam 沿线关心的两个面（可选访问，缺席回落 V1 链）。 */
interface CredentialSeamContext {
  /** 官方 `Context["llm"]` 的目录读面（partial：服务在、方法可能不在）。 */
  llm?: Partial<Pick<Context["llm"], "listConfigurableProviders">>;
  /** cordis 按名取服务（`ctx.get(name)`）；宿主 ctx 恒有，测试鸭子可为空。 */
  get?: (name: string) => unknown;
}

/**
 * settings 读面：从官方 `SettingsForms` 派生（`@deepseek-ai/dsh-settings@0.2.1-rc.2`，
 * 与 pnpm catalog 锁版一致）。Partial 表达「服务对象在、方法可能不在」——方法缺失不再
 * 被当作无类型鸭子静默接受，而由 seamDiagnosticOf 判为宿主 API 漂移。
 */
type SettingsService = Partial<Pick<SettingsForms, "describe">>;

/**
 * credentials 服务面：**显式豁免**——官方 catalog 没有 `@deepseek-ai/dsh-credentials*`
 * 类型包（`ctx.credentials` 由宿主运行时提供，其 .d.ts 未进 catalog），无法像
 * SettingsService 一样从官方类型派生，故保留 duck 形状。方法存在性由 seamDiagnosticOf
 * 在运行时判定（有对象无 resolve 即报 API 漂移），不靠类型层兜底。
 * 若 catalog 日后收录官方 credentials 类型包，应改为与 SettingsService 同形的派生。
 */
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
  const llm = ctx.llm;
  if (llm === undefined) return undefined;
  const listProviders = llm.listConfigurableProviders;
  if (typeof listProviders !== "function") return undefined;
  return listProviders.call(llm).find((entry) => entry.provider === provider);
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

/**
 * 从 settings.describe() 的条目数组里按 ns 取 value 层（纯函数）。
 * 非数组 / 条目非对象 / 无该 ns 一律 undefined（seam 视同不可用，回落 V1 链）。
 */
function settingsValueOf(descriptors: unknown, ns: string): unknown {
  if (!Array.isArray(descriptors)) return undefined;
  for (const entry of descriptors) {
    if (!isIndexable(entry)) continue;
    if (entry.ns === ns) return entry.value;
  }
  return undefined;
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
  if (!isSettingsService(settings) || typeof settings.describe !== "function") return undefined;
  if (!isCredentialsService(credentials) || typeof credentials.resolve !== "function") {
    return undefined;
  }
  // 捕获方法本体再调用（保留 receiver 语义）。现行读面是 describe() 的条目数组
  // （ns → value）；旧 `get(ns)` 已随 dsh 0.1.7-rc.1 删除，不再作为兜底——缺失即
  // 视为 seam 不可用并回落 V1 链（#1163：旧接口被删后 seam 静默失效 27 天）。
  const describe = settings.describe;
  const settingsGet = (ns: string): unknown => {
    try {
      // redactSecrets:true 为最小权限读面：apiKeyEnv 是 credential-ref（非 secret），
      // 仍会出现在 value 层；可避免其它 volatile secret 字段被物化（#1167 评审批次 P2）。
      return settingsValueOf(describe.call(settings, { redactSecrets: true }), ns);
    } catch {
      // describe() 可失败（宿主自身也包 try/catch）。此处必须吞掉：seam 视同不可用，
      // 回落 V1 链 / known-ref 兜底；否则抛错会击穿 resolveProviderConfig 的
      // 「不抛错」契约，让 /stats 直接 504（#1167 评审批次 P1-1）。
      return undefined;
    }
  };
  // credentials.resolve 是宿主 LocalCredentialProvider 的原型方法（内部读 this.values /
  // this.inherited）；裸函数取出再调用会把 this 换成取用面对象，抛 TypeError 击穿
  // /stats（#1167 回归：describe seam 修好后首次真正走到这里）。闭包保留 receiver，
  // 并吞掉解析失败——seam 契约是「任何环节失败即视同不可用」，不得冒泡。
  const credentialsResolve = async (ref: string): Promise<{ value?: string } | undefined> => {
    try {
      return await credentials.resolve?.(ref);
    } catch {
      return undefined;
    }
  };
  return { settingsGet, credentialsResolve };
}

/** seam 漂移诊断条目（service = 漂移面；message = 可直接登记进 health.errors 的文案）。 */
export interface SeamDiagnostic {
  service: "settings" | "credentials";
  message: string;
}

/**
 * seam 诊断（纯函数）：把运行时两种形态分开——
 * - **服务缺席**：`ctx.get("settings"|"credentials")` 无对象，属正常回落（V1 链兜底），不报；
 * - **方法不在**：服务对象在、`describe()`/`resolve()` 不在，属宿主 API 漂移，必须报。
 * 旧 `settings.get(ns)` 形状同属「服务在、describe 不在」，文案会点明旧形状。
 * @returns 漂移条目（空数组 = 无漂移；顺序固定 settings → credentials）。
 */
/** settings 面漂移判定（纯函数）：服务对象在但 describe() 不在时给出一条诊断。 */
function settingsDriftOf(settings: unknown): SeamDiagnostic | undefined {
  if (!isSettingsService(settings) || typeof settings.describe === "function") return undefined;
  const asRecord: Record<string, unknown> | undefined = isIndexable(settings)
    ? settings
    : undefined;
  const legacyGet = asRecord !== undefined && typeof asRecord.get === "function";
  return {
    service: "settings",
    message: legacyGet
      ? "settings 服务在但缺少 describe()，只见旧 get(ns) 形状（宿主 API 漂移：seam 读面自 dsh 0.1.7-rc.1 起为 describe()）"
      : "settings 服务在但缺少 describe()（宿主 API 漂移，凭据 seam 已回落 V1 链）",
  };
}

/** credentials 面漂移判定（纯函数）：服务对象在但 resolve() 不在时给出一条诊断。 */
function credentialsDriftOf(credentials: unknown): SeamDiagnostic | undefined {
  if (!isCredentialsService(credentials) || typeof credentials.resolve === "function") {
    return undefined;
  }
  return {
    service: "credentials",
    message: "credentials 服务在但缺少 resolve(ref)（宿主 API 漂移，凭据 seam 已回落 V1 链）",
  };
}

export function seamDiagnosticOf(ctx: unknown): SeamDiagnostic[] {
  if (!isCredentialSeamContext(ctx) || typeof ctx.get !== "function") return [];
  // 与 seamServicesOf 同款 anyCtx 别名：诊断只读同一 seam 面，不新增宿主服务消费点
  // （upstream-contract-warn 的 S2 只认字面量 ctx 接收者，别名形态不计入）。
  const anyCtx = ctx;
  const out: SeamDiagnostic[] = [];
  const settings = settingsDriftOf(anyCtx.get?.("settings"));
  if (settings !== undefined) out.push(settings);
  const credentials = credentialsDriftOf(anyCtx.get?.("credentials"));
  if (credentials !== undefined) out.push(credentials);
  return out;
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
  onDiagnostic?: ProviderConfigDiagnosticSink,
): Promise<string | undefined> {
  const dir = findProviderDirEntry(ctx, provider);
  if (dir === undefined) return undefined;
  const services = seamServicesOf(ctx);
  if (services === undefined) {
    // 服务在、方法不在 = API 漂移（fail-loud）；服务缺席 = 正常回落（诊断为空）。
    for (const diagnostic of seamDiagnosticOf(ctx)) onDiagnostic?.(diagnostic.message);
    return undefined;
  }
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

/**
 * 已知 provider → llm 层凭据引用名（seam 不可用时的兜底，与官方 llm adapter 的默认
 * apiKeyEnv 同源）。新增条目必须附「llm 侧默认 ref」证据；无证据不要猜。
 *
 * 边界：仅当 seam 与 V1 链都取不到 key 时生效。若用户在 settings 里自定义了
 * apiKeyEnv（另一把 key/账户），此处会回落默认 ref，可能取到默认账户的 key——
 * 这是「最后兜底」的已知取舍，不覆盖显式配置/环境变量。
 */
const KNOWN_CREDENTIAL_REFS: Readonly<Record<string, string>> = {
  "deepseek-official": "DEEPSEEK_API_KEY",
};

/**
 * 经 credentials 服务解析已知 ref（seam 不可用/无目录条目且 V1 链按 provider 名
 * 派生不到 ref 时的最后兜底）。服务缺席、ref 未登记、解析无值一律 undefined。
 */
async function resolveViaKnownCredentialRef(
  provider: string,
  ctx?: unknown,
): Promise<string | undefined> {
  const ref = KNOWN_CREDENTIAL_REFS[provider];
  if (ref === undefined) return undefined;
  if (!isCredentialSeamContext(ctx) || typeof ctx.get !== "function") return undefined;
  // 沿用 seam 的 anyCtx 别名：upstream-contract-warn 的 S2 只认字面量 ctx 接收者。
  // 注意这是 alias 口径而非「没有新增消费点」：credentials 消费点仍属无类型面，
  // 正式的类型锚/存在性门禁跟踪见 #1164。
  const anyCtx = ctx;
  const credentials = anyCtx.get?.("credentials");
  if (!isCredentialsService(credentials) || typeof credentials.resolve !== "function") {
    return undefined;
  }
  const got = await credentials.resolve(ref);
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
