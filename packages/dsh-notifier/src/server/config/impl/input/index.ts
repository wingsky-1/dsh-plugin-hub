/**
 * config 域：外部输入 → 合法设置。三个来源（磁盘配置文件、组合层 entry、HTTP patch）都**不受信**，这里是它们进入
 * 设置模型的唯一闸门。三道工序不可互换：归一化**永不失败**、校验**只审显式提交**（缺键不是错误）、净化**只留认识的键**。
 */
import { DEFAULT_CONFIG } from "../model/index.ts";
import type {
  BarkChannelConfig,
  BarkLevel,
  BrowserChannelConfig,
  BuiltinChannelType,
  ChannelConfig,
  NotifyConfig,
  QuietHoursConfig,
  RawSettingValue,
  SettingsPatch,
  SoundId,
  SoundSetting,
  StoredSettings,
  SystemChannelConfig,
  WebhookAuth,
  WebhookChannelConfig,
  WebhookPreset,
} from "../model/type.ts";
import type { ValidationResult } from "./type.ts";

// ---------------------------------------------------------------- 合法域

/**
 * 内置音色白名单；顺序即设置页的展示顺序。
 * 导出是为了让「白名单 ⊆ 音色表」这条断言有第二个集合可比（音色表在同包的 `shared/interface.ts`；
 * 两边都改才算真的加了一个音色）。
 */
export const SOUND_IDS: readonly SoundId[] = ["ding", "bell", "chime", "pop"];

/** 内置频道类型；顺序即卡片顺序。它们恒在场，是 `channels` 里唯一不可删除的项——身份由 `type` 唯一确定。 */
const BUILTIN_TYPES: readonly BuiltinChannelType[] = ["browser", "system"];

/** bark 紧急度白名单。 */
const BARK_LEVELS: readonly BarkLevel[] = ["active", "timeSensitive", "passive", "critical"];

/** webhook 认证方式白名单。 */
const WEBHOOK_AUTHS: readonly WebhookAuth[] = ["none", "bearer", "basic", "header"];

/** webhook 预设白名单。 */
const WEBHOOK_PRESETS: readonly WebhookPreset[] = ["ntfy", "gotify", "custom"];

/** `"HH:MM"` 二十四小时制。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 频道实例里**合法的凭据只能走已知字段**（bark 的 `deviceKey`、webhook 的 `token`/`password`/`headerValue`），
 * 这些凭据别名键在写入口径直接**拒绝**而不是静默剔除——静默剔除会让用户以为设置生效了。
 *
 * 导出是为了让判据按清单表驱动：README 的「保留键写拒」与这份清单必须是同一份事实源。
 */
export const BARK_RESERVED_KEYS: readonly string[] = ["device_key", "device_keys", "ciphertext"];

/** webhook 侧的凭据别名键；与 `BARK_RESERVED_KEYS` 同语义（见上）。 */
export const WEBHOOK_RESERVED_KEYS: readonly string[] = [
  "auth_token",
  "access_token",
  "bearer_token",
  "api_key",
  "apikey",
  "client_secret",
  "secret",
  "password_hash",
];

/**
 * 频道实例的已知键。校验与归一化**共用这一份**——未知键的判定正是拿它做的减法，两处各写一份清单，
 * 「什么算未知」就会在两个工序里给出两种答案。
 */
const BARK_KNOWN_KEYS: readonly string[] = [
  "id",
  "type",
  "enabled",
  "name",
  "baseUrl",
  "deviceKey",
  "level",
  "levels",
  "group",
  "sound",
  "icon",
  "url",
  "badge",
  "timeoutMs",
];

const WEBHOOK_KNOWN_KEYS: readonly string[] = [
  "id",
  "type",
  "enabled",
  "name",
  "url",
  "preset",
  "auth",
  "token",
  "username",
  "password",
  "headerName",
  "headerValue",
  "template",
  "headers",
  "timeoutSec",
];

/**
 * 契约认识的键。从默认设置派生而不是另抄一份清单：模型新增键时白名单自动跟上，否则
 * 就是「加了键却忘了加白名单，该键永远写不进去」这种沉默故障。
 */
const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG);

/**
 * 只接受布尔值的键。
 *
 * 导出而非私有：门禁 `config-matrix` 要按真实取值断言「这份清单是默认设置的子集且值都是布尔」，
 * 让它读定义处才是唯一事实源——照抄一份给门禁，两边迟早各说各话。
 */
export const BOOLEAN_KEYS: readonly string[] = [
  "notifyAsk",
  "notifyQuestion",
  "notifyTaskDone",
  "notifySubagentDone",
  "notifyTaskError",
  "notifyTurnEnd",
];

/**
 * 0.2.3 及更早的顶层渠道键：0.2.4 起由 upgrade 域在装配期搬进 `channels` 的内置条目并**删除**。
 *
 * 写面**拒绝**它们而不是当陌生键放行：陌生键是留给未来版本的空间，而这一批是**已经搬走**的键——
 * 静默放行会让停留在升级前页面上的旧客户端以为保存成功了。提示里直接给出出路（刷新）。
 */
export const RETIRED_KEYS: readonly string[] = [
  "systemEnabled",
  "browserEnabled",
  "systemNotify",
  "browserNotify",
  "notifyWhenVisible",
  "notifySound",
  "browserSound",
  "systemSound",
];

/**
 * 非负整数键及其上界（越界视为非法而不是截断——静默改写用户的输入比拒绝更糟）。
 *
 * 导出理由同 `BOOLEAN_KEYS`：门禁要按真实取值断言「每个键都在默认设置里且上界是非负整数」。
 */
export const COUNT_LIMITS: Record<string, number> = {
  historyMaxAgeDays: 3_650,
  maxConnections: 1_024,
};

// ---------------------------------------------------------------- 解析

/**
 * 文本 → 原始设置。坏 JSON 与非对象（数组、标量）一律得到空设置：配置文件被手改成不合法
 * 内容时读面该回落默认值，而不是让整个插件装配失败——设置坏掉不该拖垮通知。
 */
export function parseJsonObject(text: string): StoredSettings {
  try {
    const parsed: RawSettingValue = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 归一化

/**
 * 归一化：把任意输入收敛成一份完整设置，缺键补默认、非法值回落合法域——**永不失败**，
 * 是读路径的必经工序。输出是**全量**的（可选字段也写出来，空串 / 空对象表达「没有」）：
 * 让形状随输入变化会迫使下游到处判键在不在，而这里正是唯一能把这件事做掉的地方。
 */
export function normalizeConfig(input: StoredSettings): NotifyConfig {
  const fallback = DEFAULT_CONFIG;
  // 渠道形态只有 `channels` 一处输出：内置两条先物化，取值链是「条目字段 → 存量的旧顶层键 → 默认表」。
  const browser = asBrowserChannel(builtinRaw(input.channels, "browser"), input);
  const system = asSystemChannel(builtinRaw(input.channels, "system"), input);
  return {
    notifyAsk: asBoolean(input.notifyAsk, fallback.notifyAsk),
    notifyQuestion: asBoolean(input.notifyQuestion, fallback.notifyQuestion),
    notifyTaskDone: asBoolean(input.notifyTaskDone, fallback.notifyTaskDone),
    notifySubagentDone: asBoolean(input.notifySubagentDone, fallback.notifySubagentDone),
    notifyTaskError: asBoolean(input.notifyTaskError, fallback.notifyTaskError),
    notifyTurnEnd: asBoolean(input.notifyTurnEnd, fallback.notifyTurnEnd),

    quietHours: asQuietHours(input.quietHours, fallback.quietHours),
    channels: [browser, system, ...outboundChannels(input.channels)],
    kindRoutes: asKindRoutes(input.kindRoutes),
    allowKinds: asStrings(input.allowKinds),

    historyMaxAgeDays: asCount(
      input.historyMaxAgeDays,
      fallback.historyMaxAgeDays,
      COUNT_LIMITS.historyMaxAgeDays,
    ),
    maxConnections: asCount(
      input.maxConnections,
      fallback.maxConnections,
      COUNT_LIMITS.maxConnections,
    ),
  };
}

// ---------------------------------------------------------------- 校验

/**
 * 校验：给出首个非法键与提示。只对**显式提交**的键负责——缺键不是错误，由归一化补默认；
 * 一次只报首个非法键，因为设置页的定位光标只能落在一个字段上。陌生键不参与校验：拦下它们
 * 等于替未来的版本拒绝今天的用户。
 */
export function validateSettings(raw: SettingsPatch): ValidationResult {
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (RETIRED_KEYS.includes(key))
      return reject(key, "该键在 0.2.4 升级时已移入渠道条目；页面停留在升级前时，刷新后重试");
    if (!CONFIG_KEYS.includes(key)) continue;
    const verdict = validateOne(key, value);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** 单键校验；分支与归一化的取值助手一一对应，两处判断的是同一件事。 */
function validateOne(key: string, raw: RawSettingValue): ValidationResult {
  if (BOOLEAN_KEYS.includes(key)) return requireBoolean(key, raw);
  const limit = COUNT_LIMITS[key];
  if (Number.isFinite(limit)) return requireCount(key, raw, limit);
  if (key === "quietHours") return validateQuietHours(raw);
  if (key === "channels") return validateChannels(raw);
  if (key === "kindRoutes") return validateKindRoutes(raw);
  if (key === "allowKinds") return requireStringArray(key, raw);
  return { ok: true };
}

/** 布尔闸门键：`"true"` 之类的同义写法不算数——设置页提交的就是字面 boolean。 */
function requireBoolean(key: string, raw: RawSettingValue): ValidationResult {
  return typeof raw === "boolean" ? { ok: true } : reject(key, "需要 true 或 false");
}

/** 声音键：false = 静音、true = 默认音、字符串 = 内置音色名，三者之外都非法。 */
function requireSoundSetting(key: string, raw: RawSettingValue): ValidationResult {
  return typeof raw === "boolean" || isSoundId(raw)
    ? { ok: true }
    : reject(key, "需要 false、true 或内置音色名");
}

/** 计数键：闭区间 `[0, 上界]`，小数与越界都拒绝（截断会静默改写用户的输入）。 */
function requireCount(key: string, raw: RawSettingValue, limit: number): ValidationResult {
  const inRange = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit;
  return inRange ? { ok: true } : reject(key, `需要 0 到 ${limit} 之间的整数`);
}

/** 白名单字符串数组键。 */
function requireStringArray(key: string, raw: RawSettingValue): ValidationResult {
  return isStringArray(raw) ? { ok: true } : reject(key, "需要字符串数组");
}

function validateQuietHours(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("quietHours", "需要对象");
  if (typeof raw.enabled !== "boolean") return reject("quietHours", "缺少 enabled");
  if (typeof raw.start !== "string" || !CLOCK_PATTERN.test(raw.start))
    return reject("quietHours", "start 需要 HH:MM");
  if (typeof raw.end !== "string" || !CLOCK_PATTERN.test(raw.end))
    return reject("quietHours", "end 需要 HH:MM");
  if ("allowKinds" in raw && !isStringArray(raw.allowKinds))
    return reject("quietHours", "allowKinds 需要字符串数组");
  return { ok: true };
}

function validateChannels(raw: RawSettingValue): ValidationResult {
  if (!Array.isArray(raw)) return reject("channels", "需要数组");
  for (const item of raw) {
    const verdict = validateChannel(item);
    if (!verdict.ok) return verdict;
  }
  return requireBuiltinsPresent(raw);
}

/**
 * 内置频道不能删除：显式提交的 `channels` 必须仍然带着它们——这是内置频道**唯一**的特殊之处，
 * 其余一律按普通条目处理。
 *
 * 做成 400 而不是静默补回：静默补回会让「我删掉了它」与「它还在」在同一份界面上各说各话。代价是
 * 停留在升级前页面上的旧客户端（草稿里没有内置条目）会被拒一次，故提示直接给出刷新的出路。
 */
function requireBuiltinsPresent(list: readonly RawSettingValue[]): ValidationResult {
  const types = new Set<RawSettingValue>();
  for (const item of list) {
    if (isRecord(item)) types.add(item.type);
  }
  for (const type of BUILTIN_TYPES) {
    if (types.has(type)) continue;
    return reject("channels", `内置渠道不能删除：缺少 ${type}（页面停留在升级前时，刷新后重试）`);
  }
  return { ok: true };
}

/** `level` 与 `preset` 是可选键：缺省各有明确语义（前者让「severity → level」映射生效，后者归一到 custom），
 * 客户端新建频道时本就不带它们——照必填拦下等于让用户的合法提交保存不了。 */
function validateChannel(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("channels", "频道项需要对象");
  if (raw.type === "browser" || raw.type === "system") return validateBuiltinChannel(raw, raw.type);
  if (typeof raw.id !== "string" || raw.id === "") return reject("channels", "频道缺少 id");
  if (raw.type === "bark") return validateBarkChannel(raw, raw.id);
  if (raw.type === "webhook") return validateWebhookChannel(raw, raw.id);
  return reject("channels", "频道 type 需要 bark、webhook、browser 或 system");
}

/** 内置频道：身份由 `type` 唯一确定（`id` 只是回显，写了就必须一致），开关与声音逐个按各自值域校验。 */
function validateBuiltinChannel(
  raw: Record<string, RawSettingValue>,
  type: BuiltinChannelType,
): ValidationResult {
  if (raw.id !== undefined && raw.id !== type)
    return reject("channels", `内置频道 ${type} 的 id 只能是 ${type}`);
  for (const key of ["enabled", "popup", "whenVisible"]) {
    if (raw[key] === undefined || typeof raw[key] === "boolean") continue;
    return reject("channels", `内置频道 ${type} 的 ${key} 需要 true 或 false`);
  }
  return raw.sound === undefined ? { ok: true } : requireSoundSetting("channels", raw.sound);
}

/** bark 频道：`baseUrl` 与 `deviceKey` 是投递必需；`level` 缺省时让 severity 映射生效，故可省。 */
function validateBarkChannel(raw: Record<string, RawSettingValue>, id: string): ValidationResult {
  if (typeof raw.baseUrl !== "string" || raw.baseUrl === "")
    return reject("channels", `bark 频道 ${id} 缺少 baseUrl`);
  if (typeof raw.deviceKey !== "string" || raw.deviceKey === "")
    return reject("channels", `bark 频道 ${id} 缺少 deviceKey`);
  if (raw.level !== undefined && !isMember(raw.level, BARK_LEVELS))
    return reject("channels", `bark 频道 ${id} 的 level 非法`);
  return validateExtras(raw, id, BARK_KNOWN_KEYS, BARK_RESERVED_KEYS, "bark");
}

/** webhook 频道：`url` 与 `auth` 是投递必需；`preset` 缺省归一到 custom，故可省。 */
function validateWebhookChannel(
  raw: Record<string, RawSettingValue>,
  id: string,
): ValidationResult {
  if (typeof raw.url !== "string" || raw.url === "")
    return reject("channels", `webhook 频道 ${id} 缺少 url`);
  if (!isMember(raw.auth, WEBHOOK_AUTHS))
    return reject("channels", `webhook 频道 ${id} 的 auth 非法`);
  if (raw.preset !== undefined && !isMember(raw.preset, WEBHOOK_PRESETS))
    return reject("channels", `webhook 频道 ${id} 的 preset 非法`);
  return validateExtras(raw, id, WEBHOOK_KNOWN_KEYS, WEBHOOK_RESERVED_KEYS, "webhook");
}

/**
 * 未知键的写入口径：保留键**写拒**（400），其余只放行 string/number。
 *
 * 为什么不做成「未知键一律拒绝」：README 承诺了前向兼容——bark 将来新增的参数，用户现在写进配置
 * 就该被保留并原样带出去；而为什么不做成「一律接受」：`{}`、数组、布尔的透传值会污染生效设置，
 * 让「有值」与「没值」在下游分不清。
 */
function validateExtras(
  raw: Record<string, RawSettingValue>,
  id: string,
  known: readonly string[],
  reserved: readonly string[],
  kindLabel: string,
): ValidationResult {
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    if (reserved.includes(key))
      return reject("channels", `${kindLabel} 频道 ${id} 的 ${key} 是保留键：凭据只能走已知字段`);
    const value = raw[key];
    if (typeof value !== "string" && typeof value !== "number")
      return reject("channels", `${kindLabel} 频道 ${id} 的 ${key} 只能是字符串或数字`);
  }
  return { ok: true };
}

function validateKindRoutes(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("kindRoutes", "需要对象");
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return reject("kindRoutes", `${key} 需要字符串数组`);
    }
  }
  return { ok: true };
}

function reject(key: string, hint: string): ValidationResult {
  return { ok: false, error: { key, hint } };
}

// ---------------------------------------------------------------- 净化

/**
 * 净化：只保留契约认识的键。陌生键一律剔除而不是拒绝——配置文件是共享的，别的东西写进来的
 * 键不该让设置读取失败，也不该被原样带进用户层再写回去。**不归一化**：净化只回答「这个键归
 * 不归我」，在这里顺手归一化会让写路径把用户的原始提交偷偷改写掉。
 *
 * @returns 净化后的部分设置；输入不是对象时得到空设置——「一个键都不认识」与「没有键」对
 *   调用方是同一件事，不必再给一个空值语义让它自己判。
 */
export function sanitizeSettings(raw: StoredSettings): Partial<NotifyConfig> {
  const kept: Record<string, RawSettingValue> = {};
  if (!isRecord(raw)) return kept;
  for (const key of CONFIG_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    kept[key] = value;
  }
  return kept as Partial<NotifyConfig>;
}

// ---------------------------------------------------------------- 取值助手

/** 原始值是不是一个 JSON 对象（数组与空值不算）。 */
function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 命中白名单则保留，其余（含缺键）回落。 */
function isMember<T extends string>(raw: RawSettingValue, allowed: readonly T[]): raw is T {
  return typeof raw === "string" && allowed.some((item) => item === raw);
}

function isSoundId(raw: RawSettingValue): raw is SoundId {
  return isMember(raw, SOUND_IDS);
}

/** 字符串数组：元素逐个看，非字符串即不算（与归一化侧「剔除非字符串项」是同一口径的两面）。 */
function isStringArray(raw: RawSettingValue): boolean {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string");
}

function asBoolean(raw: RawSettingValue, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function asString(raw: RawSettingValue, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

/** 非负整数且不越界；越界回落而不是截断（与校验的口径一致：拒绝胜过静默改写）。 */
function asCount(raw: RawSettingValue, fallback: number, limit: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit
    ? raw
    : fallback;
}

/** 声音设置：`false` / `true` / 内置音色名三种形态；音色名非法即回落。 */
function asSound(raw: RawSettingValue, fallback: SoundSetting): SoundSetting {
  if (typeof raw === "boolean") return raw;
  return isSoundId(raw) ? raw : fallback;
}

/**
 * 旧全局声音键的**读面**回落：两个按出口的新键缺失（或非法）时先看 `notifySound`，再看默认值。
 *
 * 为什么保留这条链：存量 user 层不迁移（只在官方 settings 里写过旧键的用户），没有它，「当时关过提示音」
 * 这件事在升级后会被读成默认的 `true` —— 静音设置无声复活成有声。
 */
function legacySound(legacy: RawSettingValue, fallback: SoundSetting): SoundSetting {
  return typeof legacy === "boolean" ? legacy : fallback;
}

/** 字符串数组：非字符串项剔除而不是整组丢弃（一项脏值不该连累其余）。 */
function asStrings(raw: RawSettingValue): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function asQuietHours(raw: RawSettingValue, fallback: QuietHoursConfig): QuietHoursConfig {
  // 回落交出副本：默认表是共享的，调用方就地改写它会污染此后每一个读者。
  if (!isRecord(raw)) return { ...fallback };
  return {
    enabled: asBoolean(raw.enabled, fallback.enabled),
    start: asClock(raw.start, fallback.start),
    end: asClock(raw.end, fallback.end),
    allowKinds: asStrings(raw.allowKinds),
  };
}

function asClock(raw: RawSettingValue, fallback: string): string {
  return typeof raw === "string" && CLOCK_PATTERN.test(raw) ? raw : fallback;
}

/** kind → 频道 id 的稀疏路由；值不是数组的项剔除。 */
function asKindRoutes(raw: RawSettingValue): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  if (!isRecord(raw)) return routes;
  for (const key of Object.keys(raw)) {
    routes[key] = asStrings(raw[key]);
  }
  return routes;
}

/** 频道数组的逐项读取结果；认不出的项不带回值。 */
type ChannelRead = { ok: true; channel: ChannelConfig } | { ok: false };

/**
 * 出站实例数组：逐项归一化，**认不出的项直接丢弃**——一个没写 id、没写 url、没写凭据的「频道」
 * 没有任何可投递的目标，补成空壳只会在投递时制造一次必然失败的尝试。
 *
 * 内置条目在这里被跳过：它们由 `asBrowserChannel` / `asSystemChannel` 单独物化，且恒排在最前。
 */
function outboundChannels(raw: RawSettingValue): ChannelConfig[] {
  const channels: ChannelConfig[] = [];
  if (!Array.isArray(raw)) return channels;
  for (const item of raw) {
    const read = asChannel(item);
    if (read.ok) channels.push(read.channel);
  }
  return channels;
}

/** 输入数组里首个指定类型的内置条目（原始形态）；同类型的后来者被丢弃——内置身份由 `type` 唯一确定。 */
function builtinRaw(
  raw: RawSettingValue,
  type: BuiltinChannelType,
): Record<string, RawSettingValue> | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const item of raw) {
    if (isRecord(item) && item.type === type) return item;
  }
  return undefined;
}

/**
 * 浏览器频道物化：条目字段 → 存量投影键（0.2.3 的顶层键）→ 默认表。
 *
 * 别名只在这条链的末端参与，所以「用户已在新页面改过条目」与「文件里还躺着旧顶层键」不会互相覆盖
 * ——前者恒赢。这也是同一件事在文件里有两处表达却不打架的原因。
 */
function asBrowserChannel(
  raw: Record<string, RawSettingValue> | undefined,
  input: StoredSettings,
): BrowserChannelConfig {
  const fallback = builtinDefault("browser");
  const source: Record<string, RawSettingValue> = raw ?? {};
  return {
    type: "browser",
    id: "browser",
    enabled: asBoolean(source.enabled, asBoolean(input.browserEnabled, fallback.enabled)),
    popup: asBoolean(source.popup, asBoolean(input.browserNotify, fallback.popup)),
    sound: asSound(source.sound, outletSoundOf(input, input.browserSound, fallback.sound)),
    whenVisible: asBoolean(
      source.whenVisible,
      asBoolean(input.notifyWhenVisible, fallback.whenVisible),
    ),
  };
}

/** 系统频道物化：链与浏览器频道同构，只是没有 `whenVisible`——那是浏览器出口独有的展示条件。 */
function asSystemChannel(
  raw: Record<string, RawSettingValue> | undefined,
  input: StoredSettings,
): SystemChannelConfig {
  const fallback = builtinDefault("system");
  const source: Record<string, RawSettingValue> = raw ?? {};
  return {
    type: "system",
    id: "system",
    enabled: asBoolean(source.enabled, asBoolean(input.systemEnabled, fallback.enabled)),
    popup: asBoolean(source.popup, asBoolean(input.systemNotify, fallback.popup)),
    sound: asSound(source.sound, outletSoundOf(input, input.systemSound, fallback.sound)),
  };
}

/**
 * 默认表里的内置条目：物化的最后一级回落。
 *
 * 断言只为把「按 type 找到的那条」收窄成对应型号——查找条件就是 type 相等。默认表是本模块的常量，
 * 两条内置条目必然在场；真缺了当场抛错比静默降级好（那是编码错误，不是用户输入的问题）。
 */
function builtinDefault<T extends BuiltinChannelType>(
  type: T,
): Extract<ChannelConfig, { type: T }> {
  for (const channel of DEFAULT_CONFIG.channels) {
    if (channel.type === type) return channel as Extract<ChannelConfig, { type: T }>;
  }
  throw new Error(`dsh-notifier: 默认设置里缺少内置频道 ${type}`);
}

/**
 * 存量音效的物化：按出口的键（`browserSound` / `systemSound`）优先，其次旧的全局键 `notifySound`。
 *
 * 两者的值域不同，不能合在一层收窄：出口键当年就存音色名（完整声音域），全局键只有开关语义（只认布尔）
 * ——用同一个助手处理会把存量音色名吞成默认值。
 */
function outletSoundOf(
  input: StoredSettings,
  outlet: RawSettingValue,
  fallback: SoundSetting,
): SoundSetting {
  if (outlet !== undefined) return asSound(outlet, fallback);
  return legacySound(input.notifySound, fallback);
}

function asChannel(raw: RawSettingValue): ChannelRead {
  if (!isRecord(raw)) return { ok: false };
  const id = asString(raw.id, "");
  if (id === "") return { ok: false };
  if (raw.type === "bark") return asBarkChannel(raw, id);
  if (raw.type === "webhook") return asWebhookChannel(raw, id);
  return { ok: false };
}

function asBarkChannel(raw: Record<string, RawSettingValue>, id: string): ChannelRead {
  const baseUrl = asString(raw.baseUrl, "");
  const deviceKey = asString(raw.deviceKey, "");
  if (baseUrl === "" || deviceKey === "") return { ok: false };
  const channel: BarkChannelConfig = {
    type: "bark",
    id,
    enabled: asBoolean(raw.enabled, false),
    name: asString(raw.name, ""),
    baseUrl,
    deviceKey,
    group: asString(raw.group, ""),
    sound: asString(raw.sound, ""),
    icon: asString(raw.icon, ""),
    url: asString(raw.url, ""),
    timeoutMs: asCount(raw.timeoutMs, 0, 600_000),
    levels: asLevels(raw.levels),
  };
  // 紧急度不兜底：缺了它才轮到「severity → level」那层映射，兜成 active 会让 error 通知
  // 永远发不出 timeSensitive；徽标同理，0 是有意义的取值。
  if (isMember(raw.level, BARK_LEVELS)) channel.level = raw.level;
  if (typeof raw.badge === "number") channel.badge = raw.badge;
  const extras = extrasOf(raw, BARK_KNOWN_KEYS, BARK_RESERVED_KEYS);
  if (Object.keys(extras).length > 0) channel.extras = extras;
  return { ok: true, channel };
}

/**
 * 实例里的未知键：只留 string/number 值。
 *
 * 校验面已经拒掉保留键与非 string/number 值，这里再过滤一遍不是重复——归一化读的是**磁盘上的内容**，
 * 手改过的文件不经过写入口径；而保留键在这里必须剔除，否则一条手写的 `device_key` 就能绕开
 * 「凭据只能走已知字段」的收口。
 */
function extrasOf(
  raw: Record<string, RawSettingValue>,
  known: readonly string[],
  reserved: readonly string[],
): Record<string, string | number> {
  const extras: Record<string, string | number> = {};
  for (const key of Object.keys(raw)) {
    if (known.includes(key) || reserved.includes(key)) continue;
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") extras[key] = value;
  }
  return extras;
}

function asLevels(raw: RawSettingValue): Record<string, BarkLevel> {
  const levels: Record<string, BarkLevel> = {};
  if (!isRecord(raw)) return levels;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (isMember(value, BARK_LEVELS)) levels[key] = value;
  }
  return levels;
}

function asWebhookChannel(raw: Record<string, RawSettingValue>, id: string): ChannelRead {
  const url = asString(raw.url, "");
  if (url === "") return { ok: false };
  const channel: WebhookChannelConfig = {
    type: "webhook",
    id,
    enabled: asBoolean(raw.enabled, false),
    name: asString(raw.name, ""),
    url,
    preset: isMember(raw.preset, WEBHOOK_PRESETS) ? raw.preset : "custom",
    auth: isMember(raw.auth, WEBHOOK_AUTHS) ? raw.auth : "none",
    token: asString(raw.token, ""),
    username: asString(raw.username, ""),
    password: asString(raw.password, ""),
    headerName: asString(raw.headerName, ""),
    headerValue: asString(raw.headerValue, ""),
    template: asString(raw.template, ""),
    headers: asHeaders(raw.headers),
    timeoutSec: asCount(raw.timeoutSec, 0, 600),
  };
  const extras = extrasOf(raw, WEBHOOK_KNOWN_KEYS, WEBHOOK_RESERVED_KEYS);
  if (Object.keys(extras).length > 0) channel.extras = extras;
  return { ok: true, channel };
}

function asHeaders(raw: RawSettingValue): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!isRecord(raw)) return headers;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}
