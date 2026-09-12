/**
 * dsh-notifier config 域 —— 外部输入 → 合法设置。
 *
 * 设置有三个来源：磁盘上的配置文件、组合层给的 entry、HTTP 提交的 patch。三者的
 * 共同点是**都不受信**——文件可能是手改的、entry 可能来自过期的 profile、patch
 * 可能是任意 JSON。本块是它们进入设置模型的唯一闸门：归一化让脏值有归宿，校验让
 * 非法值有明确的拒绝理由，净化让陌生键进不了用户层。
 *
 * 三道工序的分工不可互换：**归一化永不失败**（读路径必经，脏值回落默认），
 * **校验只审显式提交**（缺键不是错误），**净化只留认识的键**（陌生键既不认识、
 * 也不该被原样写回去）。
 *
 * 依赖方向：只引用本目录与 `../model/`，不引用 `interface.ts`。
 */
import { DEFAULT_CONFIG } from "../model/index.ts";
import type {
  BarkChannelConfig,
  BarkLevel,
  ChannelConfig,
  NotifyConfig,
  QuietHoursConfig,
  RawSettingValue,
  SettingsPatch,
  SoundId,
  SoundSetting,
  StoredSettings,
  WebhookAuth,
  WebhookChannelConfig,
  WebhookPreset,
} from "../model/type.ts";
import type { ValidationResult } from "./type.ts";

// ---------------------------------------------------------------- 合法域

/** 内置音色白名单；顺序即设置页的展示顺序。 */
const SOUND_IDS: readonly SoundId[] = ["ding", "bell", "chime", "pop"];

/** bark 紧急度白名单。 */
const BARK_LEVELS: readonly BarkLevel[] = ["active", "timeSensitive", "passive", "critical"];

/** webhook 认证方式白名单。 */
const WEBHOOK_AUTHS: readonly WebhookAuth[] = ["none", "bearer", "basic", "header"];

/** webhook 预设白名单。 */
const WEBHOOK_PRESETS: readonly WebhookPreset[] = ["ntfy", "gotify", "custom"];

/** `"HH:MM"` 二十四小时制。 */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 契约认识的键。
 *
 * 从默认设置派生而不是另抄一份清单：模型新增键时白名单自动跟上，不存在「加了键
 * 却忘了加进白名单，于是该键永远写不进去」这种沉默故障。
 */
const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG);

/** 只接受布尔值的键。 */
const BOOLEAN_KEYS: readonly string[] = [
  "notifyAsk",
  "notifyQuestion",
  "notifyTaskDone",
  "notifySubagentDone",
  "notifyTaskError",
  "notifyTurnEnd",
  "systemNotify",
  "browserNotify",
  "notifyWhenVisible",
  "notifySound",
  "sanitizeContent",
];

/** 非负整数键及其上界（越界视为非法而不是截断——静默改写用户的输入比拒绝更糟）。 */
const COUNT_LIMITS: Record<string, number> = {
  errorMergeWindowMs: 3_600_000,
  askRemindMin: 1_440,
  doneMergeWindowMs: 600_000,
  historyMaxAgeDays: 3_650,
  maxConnections: 1_024,
};

// ---------------------------------------------------------------- 解析

/**
 * 文本 → 原始设置。
 *
 * 坏 JSON 与非对象（数组、标量）一律得到空设置：配置文件被手改成不合法内容时，
 * 读面该回落到默认值，而不是让整个插件装配失败——设置坏掉不该拖垮通知。
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
 * 归一化：把任意输入收敛成一份完整的设置。
 *
 * 缺键补默认、非法值回落合法域——**永不失败**。它是读路径的必经工序：调用方拿到
 * 的一定是一份可以直接用的设置，不需要自己判空。
 *
 * 输出是**全量**的：每个键都有值，可选字段也写出来（空串 / 空对象表达「没有」）。
 * 让形状随输入变化会迫使下游到处判键在不在，而这里正是唯一能把这件事做掉的地方。
 */
export function normalizeConfig(input: StoredSettings): NotifyConfig {
  const fallback = DEFAULT_CONFIG;
  return {
    notifyAsk: asBoolean(input.notifyAsk, fallback.notifyAsk),
    notifyQuestion: asBoolean(input.notifyQuestion, fallback.notifyQuestion),
    notifyTaskDone: asBoolean(input.notifyTaskDone, fallback.notifyTaskDone),
    notifySubagentDone: asBoolean(input.notifySubagentDone, fallback.notifySubagentDone),
    notifyTaskError: asBoolean(input.notifyTaskError, fallback.notifyTaskError),
    notifyTurnEnd: asBoolean(input.notifyTurnEnd, fallback.notifyTurnEnd),

    systemNotify: asBoolean(input.systemNotify, fallback.systemNotify),
    browserNotify: asBoolean(input.browserNotify, fallback.browserNotify),
    notifyWhenVisible: asBoolean(input.notifyWhenVisible, fallback.notifyWhenVisible),
    notifySound: asBoolean(input.notifySound, fallback.notifySound),
    browserSound: asSound(input.browserSound, fallback.browserSound),
    systemSound: asSound(input.systemSound, fallback.systemSound),
    quietHours: asQuietHours(input.quietHours, fallback.quietHours),
    channels: asChannels(input.channels),
    kindRoutes: asKindRoutes(input.kindRoutes),
    allowKinds: asStrings(input.allowKinds),
    sanitizeContent: asBoolean(input.sanitizeContent, fallback.sanitizeContent),

    errorMergeWindowMs: asCount(input.errorMergeWindowMs, fallback.errorMergeWindowMs, COUNT_LIMITS.errorMergeWindowMs),
    askRemindMin: asCount(input.askRemindMin, fallback.askRemindMin, COUNT_LIMITS.askRemindMin),
    doneMergeWindowMs: asCount(input.doneMergeWindowMs, fallback.doneMergeWindowMs, COUNT_LIMITS.doneMergeWindowMs),
    historyMaxAgeDays: asCount(input.historyMaxAgeDays, fallback.historyMaxAgeDays, COUNT_LIMITS.historyMaxAgeDays),
    maxConnections: asCount(input.maxConnections, fallback.maxConnections, COUNT_LIMITS.maxConnections),
  };
}

// ---------------------------------------------------------------- 校验

/**
 * 校验：给出首个非法键与提示，通过时返回 `ok`。
 *
 * 只对**显式提交**的键负责——缺键不是错误，它由归一化补默认。一次只报首个非法键，
 * 是因为设置页的定位光标只能落在一个字段上。
 *
 * 陌生键不参与校验：它们既不是本域的事实，也会被原样透传保留，拦下它们等于替未来
 * 的版本拒绝今天的用户。
 */
export function validateSettings(raw: SettingsPatch): ValidationResult {
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (!CONFIG_KEYS.includes(key)) continue;
    const verdict = validateOne(key, value);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** 单键校验；分支与归一化的取值助手一一对应，两处判断的是同一件事。 */
function validateOne(key: string, raw: RawSettingValue): ValidationResult {
  if (BOOLEAN_KEYS.includes(key)) {
    return typeof raw === "boolean" ? { ok: true } : reject(key, "需要 true 或 false");
  }
  if (key === "browserSound" || key === "systemSound") {
    return typeof raw === "boolean" || isSoundId(raw) ? { ok: true } : reject(key, "需要 false、true 或内置音色名");
  }
  const limit = COUNT_LIMITS[key];
  if (Number.isFinite(limit)) {
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit
      ? { ok: true }
      : reject(key, `需要 0 到 ${limit} 之间的整数`);
  }
  if (key === "quietHours") return validateQuietHours(raw);
  if (key === "channels") return validateChannels(raw);
  if (key === "kindRoutes") return validateKindRoutes(raw);
  if (key === "allowKinds") {
    return Array.isArray(raw) && raw.every((item) => typeof item === "string")
      ? { ok: true }
      : reject(key, "需要字符串数组");
  }
  return { ok: true };
}

function validateQuietHours(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("quietHours", "需要对象");
  if (typeof raw.enabled !== "boolean") return reject("quietHours", "缺少 enabled");
  if (typeof raw.start !== "string" || !CLOCK_PATTERN.test(raw.start)) return reject("quietHours", "start 需要 HH:MM");
  if (typeof raw.end !== "string" || !CLOCK_PATTERN.test(raw.end)) return reject("quietHours", "end 需要 HH:MM");
  if ("allowKinds" in raw && !Array.isArray(raw.allowKinds)) return reject("quietHours", "allowKinds 需要字符串数组");
  return { ok: true };
}

function validateChannels(raw: RawSettingValue): ValidationResult {
  if (!Array.isArray(raw)) return reject("channels", "需要数组");
  for (const item of raw) {
    const verdict = validateChannel(item);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function validateChannel(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("channels", "频道项需要对象");
  if (typeof raw.id !== "string" || raw.id === "") return reject("channels", "频道缺少 id");
  if (raw.type === "bark") {
    if (typeof raw.baseUrl !== "string" || raw.baseUrl === "") return reject("channels", `bark 频道 ${raw.id} 缺少 baseUrl`);
    if (typeof raw.deviceKey !== "string" || raw.deviceKey === "") return reject("channels", `bark 频道 ${raw.id} 缺少 deviceKey`);
    if (!isMember(raw.level, BARK_LEVELS)) return reject("channels", `bark 频道 ${raw.id} 的 level 非法`);
    return { ok: true };
  }
  if (raw.type === "webhook") {
    if (typeof raw.url !== "string" || raw.url === "") return reject("channels", `webhook 频道 ${raw.id} 缺少 url`);
    if (!isMember(raw.auth, WEBHOOK_AUTHS)) return reject("channels", `webhook 频道 ${raw.id} 的 auth 非法`);
    if (!isMember(raw.preset, WEBHOOK_PRESETS)) return reject("channels", `webhook 频道 ${raw.id} 的 preset 非法`);
    return { ok: true };
  }
  return reject("channels", "频道 type 需要 bark 或 webhook");
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
 * 净化：只保留契约认识的键。
 *
 * 陌生键一律剔除而不是拒绝——配置文件是共享的，别的东西写进来的键不该让设置读取
 * 失败；但也不该被原样带进用户层再写回去。
 *
 * **不归一化**：净化只回答「这个键归不归我」，值的合法性由归一化与校验分别负责。
 * 在这里顺手归一化会让写路径把用户的原始提交偷偷改写掉。
 *
 * @returns 净化后的部分设置；输入不是对象时得到空设置——「一个键都不认识」与
 *   「没有键」对调用方是同一件事，不必再给一个空值语义让它自己判。
 */
export function sanitizeSettings(raw: StoredSettings): Partial<NotifyConfig> {
  const kept: Record<string, RawSettingValue> = {};
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

function asBoolean(raw: RawSettingValue, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function asString(raw: RawSettingValue, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

/** 非负整数且不越界；越界回落而不是截断（与校验的口径一致：拒绝胜过静默改写）。 */
function asCount(raw: RawSettingValue, fallback: number, limit: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit ? raw : fallback;
}

/** 声音设置：`false` / `true` / 内置音色名三种形态；音色名非法即回落。 */
function asSound(raw: RawSettingValue, fallback: SoundSetting): SoundSetting {
  if (typeof raw === "boolean") return raw;
  return isSoundId(raw) ? raw : fallback;
}

/** 字符串数组：非字符串项剔除而不是整组丢弃（一项脏值不该连累其余）。 */
function asStrings(raw: RawSettingValue): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function asQuietHours(raw: RawSettingValue, fallback: QuietHoursConfig): QuietHoursConfig {
  if (!isRecord(raw)) return fallback;
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
 * 频道数组：逐项归一化，**认不出的项直接丢弃**。
 *
 * 丢弃而不是补默认：一个没写 id、没写 url、没写凭据的「频道」没有任何可投递的
 * 目标，把它补成一个空壳频道只会在投递时制造一次必然失败的尝试。
 */
function asChannels(raw: RawSettingValue): ChannelConfig[] {
  const channels: ChannelConfig[] = [];
  if (!Array.isArray(raw)) return channels;
  for (const item of raw) {
    const read = asChannel(item);
    if (read.ok) channels.push(read.channel);
  }
  return channels;
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
    level: isMember(raw.level, BARK_LEVELS) ? raw.level : "active",
    group: asString(raw.group, ""),
    sound: asString(raw.sound, ""),
    timeoutMs: asCount(raw.timeoutMs, 0, 600_000),
    levels: asLevels(raw.levels),
  };
  return { ok: true, channel };
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
