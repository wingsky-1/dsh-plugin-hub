/**
 * dsh-notifier — 配置域：写入校验（H6）。
 *
 * PUT /config 与存量迁移共用的「已知键 → 校验器」表；任一已知键非法即整体
 * 拒绝（400 + hint / 迁移仅标记不写入），不再静默丢弃回默认。与 lan-proxy
 * 的 FILE_CONFIG_VALIDATORS 同形态（零依赖，未引入 schemastery）。
 * SETTING_VALIDATORS 与 SETTING_HINTS 平行维护，遍历顺序即「首个非法键」口径。
 */
import { ASSEMBLY_SETTING_KEYS, BARK_ID_PATTERN, BARK_RESERVED_KEYS, PROTOTYPE_POLLUTION_KEYS, WEBHOOK_RESERVED_KEYS, isSoundSetting } from "./config.ts";
import type { NotifyConfig } from "./config.ts";
import { parseHHMM } from "./quiet-hours.ts";
import { isWebhookHeaderName, normalizeBarkBaseUrl } from "./normalize.ts";

function isBoolean(v: unknown): boolean {
  return typeof v === "boolean";
}

/** HH:MM 时段串（00:00-23:59）是否合法。 */
function isHHMM(v: unknown): boolean {
  return typeof v === "string" && /^\d{2}:\d{2}$/u.test(v) && parseHHMM(v) >= 0;
}

function isNonNegNumber(max: number): (v: unknown) => boolean {
  return (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
}

/** SSE 连接上限校验（1-1024 的整数，与 normalizeConfig 范围一致；#334）。 */
function isConnLimit(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 1024;
}

/** 免打扰豁免整组写入校验（issue #421：放开白名单为「非空字符串 ≤64 字符、≤128 项」，
 *  与顶层 allowKinds 的 isConfirmedKinds 同口径——避免「手改配置能生效、UI 保存却 400」
 *  的读写分裂；未知 kind 项合法保留（豁免判定仅 includes 匹配，不做语义约束）。 */
function isAllowKinds(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > 128) return false;
  return v.every((k) => typeof k === "string" && k.length > 0 && k.length <= 64);
}

/** quietHours 整组校验（enabled/start/end/allowKinds 任一层非法即整组拒绝）。 */
function isQuietHours(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const qh = v as Record<string, unknown>;
  return (
    (qh.enabled === undefined || isBoolean(qh.enabled)) &&
    (qh.start === undefined || isHHMM(qh.start)) &&
    (qh.end === undefined || isHHMM(qh.end)) &&
    (qh.allowKinds === undefined || isAllowKinds(qh.allowKinds))
  );
}

/** levels（kind→level）写入严格校验：对象形状、键 ≤64、值枚举、项数 ≤64、剔原型键。任一项非法即 400。 */
function isBarkLevelsStrict(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const src = v as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length > 64) return false;
  for (const kind of keys) {
    if (kind.length === 0 || kind.length > 64) return false;
    if (kind === "__proto__" || kind === "constructor" || kind === "prototype") return false;
    const level = src[kind];
    if (level !== "active" && level !== "timeSensitive" && level !== "passive" && level !== "critical") return false;
  }
  return true;
}

/** 已知 Bark 实例可选参数的类型校验表（与 normalizeBarkChannel 的过滤键平行维护）。 */
function isBarkChannelParam(key: string, value: unknown): boolean {
  if (key === "name") return typeof value === "string" && value.length > 0 && value.length <= 64;
  if (key === "sound" || key === "group" || key === "icon" || key === "url") return typeof value === "string";
  if (key === "level") return value === "active" || value === "timeSensitive" || value === "passive" || value === "critical";
  if (key === "levels") return isBarkLevelsStrict(value);
  if (key === "badge") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 999999;
  return typeof value === "string" || typeof value === "number"; // 未知键透传
}

const BARK_KNOWN_PARAM_KEYS: readonly string[] = ["name", "sound", "level", "levels", "group", "icon", "url", "badge"];

/** 单个 Bark 实例写入校验（严格口径：任一项非法即整组 400）。 */
function isBarkChannel(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const ch = v as Record<string, unknown>;
  if (typeof ch.id !== "string" || !BARK_ID_PATTERN.test(ch.id)) return false;
  if (ch.type !== "bark") return false;
  if (normalizeBarkBaseUrl(ch.baseUrl) === null) return false;
  if (typeof ch.deviceKey !== "string" || ch.deviceKey.length === 0 || ch.deviceKey.length > 512) return false;
  if (typeof ch.enabled !== "boolean") return false;
  for (const key of Object.keys(ch)) {
    if (key === "id" || key === "type" || key === "baseUrl" || key === "deviceKey" || key === "enabled") continue;
    if ((BARK_RESERVED_KEYS as readonly string[]).includes(key)) return false; // 保留键写入口径直接拒绝
    const value = ch[key];
    if (!(BARK_KNOWN_PARAM_KEYS as readonly string[]).includes(key) && typeof value !== "string" && typeof value !== "number") return false;
    if (!isBarkChannelParam(key, value)) return false;
  }
  return true;
}

/** channels 整组写入校验（≤16 实例 + id 不得重复——重复会让掩码回填/路由对齐歧义）。
 *  #508 M2：按实例 type 分派 bark/webhook 严格校验，id 跨类型去重。 */
function isBarkChannels(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > 16) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (!isBarkChannel(item)) return false;
    const id = (item as Record<string, unknown>).id as string;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** webhook 已知参数的类型校验表（与 normalizeWebhookChannel 的过滤键平行维护）。 */
const WEBHOOK_KNOWN_PARAM_KEYS: readonly string[] = ["name", "token", "username", "password", "headerName", "headerValue", "preset", "template", "timeoutSec"];

function isWebhookChannelParam(key: string, value: unknown): boolean {
  if (key === "name") return typeof value === "string" && value.length > 0 && value.length <= 64;
  if (key === "token" || key === "password" || key === "headerValue") return typeof value === "string" && value.length > 0 && value.length <= 512;
  if (key === "username") return typeof value === "string" && value.length > 0 && value.length <= 128;
  if (key === "headerName") return isWebhookHeaderName(value);
  if (key === "preset") return value === "ntfy" || value === "gotify" || value === "custom";
  if (key === "template") return typeof value === "string" && value.length <= 8192;
  if (key === "timeoutSec") return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 60;
  return typeof value === "string" || typeof value === "number"; // 未知键透传
}

/** 单个 webhook 实例写入校验（严格口径：任一项非法即整组 400）。 */
function isWebhookChannel(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const ch = v as Record<string, unknown>;
  if (typeof ch.id !== "string" || !BARK_ID_PATTERN.test(ch.id)) return false;
  if (ch.type !== "webhook") return false;
  if (normalizeBarkBaseUrl(ch.url) === null) return false;
  if (typeof ch.enabled !== "boolean") return false;
  const auth = ch.auth === undefined ? "none" : ch.auth;
  if (auth !== "none" && auth !== "bearer" && auth !== "basic" && auth !== "header") return false;
  for (const key of Object.keys(ch)) {
    if (key === "id" || key === "type" || key === "url" || key === "enabled" || key === "auth") continue;
    if ((WEBHOOK_RESERVED_KEYS as readonly string[]).includes(key)) return false; // 保留键写入口径直接拒绝
    if (!(WEBHOOK_KNOWN_PARAM_KEYS as readonly string[]).includes(key) && typeof ch[key] !== "string" && typeof ch[key] !== "number") return false;
    if (!isWebhookChannelParam(key, ch[key])) return false;
  }
  return true;
}

/** channels 整组写入校验（#508 M2 混合版）：按实例 type 分派严格校验，id 跨类型去重。 */
function isChannels(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > 16) return false;
  const seen = new Set<string>();
  for (const item of v) {
    const type = typeof item === "object" && item !== null ? (item as Record<string, unknown>).type : undefined;
    const ok = type === "webhook" ? isWebhookChannel(item) : isBarkChannel(item);
    if (!ok) return false;
    const id = (item as Record<string, unknown>).id as string;
    if (typeof id !== "string" || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** kindRoutes 整组写入校验（键 ≤64、每值数组 ≤16、元素非空 ≤64 字符）。 */
function isKindRoutes(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const src = v as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length > 64) return false;
  for (const kind of keys) {
    if (kind.length === 0 || kind.length > 64) return false;
    const routes = src[kind];
    if (!Array.isArray(routes) || routes.length === 0 || routes.length > 16) return false;
    for (const id of routes) {
      if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
    }
  }
  return true;
}

/** allowKinds 整组写入校验（非空字符串 ≤64 字符、≤128 项）。 */
function isConfirmedKinds(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > 128) return false;
  return v.every((k) => typeof k === "string" && k.length > 0 && k.length <= 64);
}

/** 已知配置键 → 校验器（遍历顺序即「首个非法键」口径）。 */
const SETTING_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  notifyAsk: isBoolean,
  notifyQuestion: isBoolean,
  notifyTaskDone: isBoolean,
  notifySubagentDone: isBoolean,
  notifyTaskError: isBoolean,
  notifyTurnEnd: isBoolean,
  systemNotify: isBoolean,
  browserNotify: isBoolean,
  notifyWhenVisible: isBoolean,
  notifySound: isBoolean,
  browserSound: isSoundSetting,
  systemSound: isSoundSetting,
  quietHours: isQuietHours,
  errorMergeWindowMs: isNonNegNumber(3600000),
  askRemindMin: isNonNegNumber(600),
  doneMergeWindowMs: isNonNegNumber(60000),
  historyMaxAgeDays: isNonNegNumber(3650),
  maxConnections: isConnLimit,
  channels: isChannels,
  kindRoutes: isKindRoutes,
  allowKinds: isConfirmedKinds,
};

/** 各配置键的合法范围描述（validateSettings 400 hint 用；与 SETTING_VALIDATORS 平行维护）。 */
const SETTING_HINTS: Record<string, string> = {
  notifyAsk: "需为布尔值",
  notifyQuestion: "需为布尔值",
  notifyTaskDone: "需为布尔值",
  notifySubagentDone: "需为布尔值",
  notifyTaskError: "需为布尔值",
  notifyTurnEnd: "需为布尔值",
  systemNotify: "需为布尔值",
  browserNotify: "需为布尔值",
  notifyWhenVisible: "需为布尔值",
  notifySound: "需为布尔值",
  browserSound: "需为布尔值或音色 id 之一（ding/bell/chime/pop）",
  systemSound: "需为布尔值或音色 id 之一（ding/bell/chime/pop）",
  quietHours: "需为 { enabled?: boolean, start?: \"HH:MM\", end?: \"HH:MM\", allowKinds?: string[] }（allowKinds 每项为非空字符串 ≤64 字符、至多 128 项）",
  errorMergeWindowMs: "需为 0-3600000 的整数（毫秒）",
  askRemindMin: "需为 0-600 的整数（分钟）",
  doneMergeWindowMs: "需为 0-60000 的整数（毫秒）",
  historyMaxAgeDays: "需为 0-3650 的整数（天）",
  maxConnections: "需为 1-1024 的整数",
  channels: "需为频道实例数组（至多 16 实例、id 不重复，id 为 2-32 位小写字母/数字/连字符）：bark 实例 { id, type:'bark', baseUrl, deviceKey, enabled }（baseUrl 为无凭据的 http(s) 地址；可选 levels 为 { kind: 级别 } 映射，键至多 64 字符、至多 64 项，级别限 active/timeSensitive/passive/critical）；webhook 实例 { id, type:'webhook', url, enabled, auth?:'none'|'bearer'|'basic'|'header', token?/username?/password?/headerName?/headerValue?, preset?:'ntfy'|'gotify'|'custom', template?(JSON ≤8192), timeoutSec?(1-60) }（url 为无凭据无 query 的 http(s) 地址，凭据只走请求头）",
  kindRoutes: "需为 { kind: channelId[] } 对象（至多 64 个 kind，每项至多 16 个 channelId）",
  allowKinds: "需为非空字符串数组（至多 128 项，每项至多 64 字符）",
};

/** validateSettings 的结果：null = 全部合法。 */
export interface SettingInvalid {
  /** 首个非法的配置键名。 */
  key: string;
  /** 该键的合法范围描述（面向用户的文案）。 */
  hint: string;
}

/**
 * 校验提交的配置（写入前，不净化）：返回首个非法键与其合法范围，全部合法
 * 返回 null（H6：非法值 400 拒绝 + hint，不再静默丢弃回默认）。遍历顺序
 * 与 sanitizeSettings 一致（SETTING_VALIDATORS 键序）。导出供 smoke 单测。
 * 非对象/数组 payload 命中 key="(payload)" 分支（400 + 「patch 必须是对象」，
 * #470 复核 P1-4：文案与 README 边界声明逐句一致）。
 */
export function validateSettings(raw: unknown): SettingInvalid | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { key: "(payload)", hint: "patch 必须是对象（数组/非对象形态不支持）" };
  }
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(SETTING_VALIDATORS)) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (!SETTING_VALIDATORS[key](value)) {
      return { key, hint: SETTING_HINTS[key] ?? "类型非法" };
    }
  }
  return null;
}

/**
 * 净化组合层 entry 配置（apply 装配通道专用）：白名单语义不变——只取已知
 * 配置键，装配键/未知键一律丢弃（现状 index.ts:140 行为保留，#470 P1-3
 * 双通道拆分后本函数不再服务 PUT / 迁移）。
 */
export function sanitizeSettings(raw: unknown): Partial<NotifyConfig> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(SETTING_VALIDATORS)) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (!SETTING_VALIDATORS[key](value)) return null;
    out[key] = value;
  }
  return out;
}

/**
 * 净化 PUT /config 与存量迁移的增量 patch（透传通道，#470）：已知键按
 * validateSettings 同口径校验（任一非法 → 整体拒绝返回 null）；**未知键原样
 * 透传保留**（前向兼容——GET 读得到的未来/第三方键 PUT 回得去，迁移不丢
 * legacy 未来键；任意 JSON 值含 null——与读面 normalizeConfig 透传口径一致，
 * #470 qa 复核发现 2），但组合层装配键名（ASSEMBLY_SETTING_KEYS）一律剔除
 * （静默，与 Bark 保留键同口径）。返回对象非空即代表有可写键；纯未知键 patch
 * 透传后同样非空（区别于空 patch {} → 空对象由调用方按 400 处理）。
 *
 * 安全边界（#470 复核 P0）：patch 必须为**普通对象**（数组直接返回 null——
 * 数组会被 Object.keys 当对象把数字索引透传成 "0":"1" 式脏键）；原型链成员
 * 键（constructor/prototype/toString/hasOwnProperty/valueOf/__proto__）一律
 * 剔除不写入——查表前用 hasOwn 判自有键防误触原型链校验器（抛 TypeError 致
 * 500），写入经 hasOwn 校验防把 Object.prototype 方法当未知键透传脏写 user 层。
 * null 值语义：已知键值为 null 沿用既有跳过语义（validateSettings 同口径，
 * 视同未提交）；**未知键值为 null 透传保留**（读面 normalizeConfig 本就透传
 * null，写面不留空档——否则 GET 读到的 null 键 PUT 回去会静默消失）。
 */
export function sanitizePatchSettings(raw: unknown): Partial<NotifyConfig> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if ((ASSEMBLY_SETTING_KEYS as readonly string[]).includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if ((PROTOTYPE_POLLUTION_KEYS as readonly string[]).includes(key)) continue;
    if (Object.hasOwn(SETTING_VALIDATORS, key)) {
      // 已知键：null 沿用既有跳过语义（与 validateSettings/sanitizeSettings 一致）
      if (value === undefined || value === null) continue;
      const validator = SETTING_VALIDATORS[key];
      if (!validator(value)) return null;
      out[key] = value;
      continue;
    }
    // 未知键透传保留：任意 JSON 值（含 null/undefined 不存在于 JSON 文本；
    // null 显式透传）原样并入——顶层未来键形状不可预知
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}