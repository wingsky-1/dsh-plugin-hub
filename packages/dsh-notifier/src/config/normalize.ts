/**
 * dsh-notifier — 配置域：读取面归一化（零 node 依赖）。
 *
 * normalizeConfig 是「磁盘/settings 输入 → 运行时镜像」的唯一读面权威：
 * 已知键归一化 + 默认值兜底 + 未知键透传保留 + 原型污染键剔除（#470 P0）。
 * isWebhookHeaderName 也放本文件：它是 normalize 与写校验共用的频道形状原语
 * （放 validators 会与 normalizeWebhookChannel 成同目录循环依赖）。
 */
import {
  BARK_ID_PATTERN,
  BARK_RESERVED_KEYS,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  PROTOTYPE_POLLUTION_KEYS,
  WEBHOOK_RESERVED_KEYS,
  isSoundSetting,
} from "./config.ts";
import type { BarkChannelConfig, BarkLevel, ChannelConfig, NotifyConfig, WebhookChannelConfig } from "./config.ts";
import { parseHHMM } from "./quiet-hours.ts";

// ---------------------------------------------------------------- 频道/路由/确认归一化（M2）

/**
 * Bark baseUrl 规范化：URL 可解析 + scheme 限 http/https（SSRF 姿态，评审 P0-3）
 * + 拒绝带凭据 URL（user:pass@host）+ 丢弃 query/hash → 返回 origin+path（去尾斜杠）。
 * 非法返回 null（读取归一化口径：丢弃该实例；写入口径由 isBarkChannels 整组 400）。
 */
export function normalizeBarkBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * Bark levels（kind→level 稀疏映射）归一化：对象形状、键 ≤64 字符、值枚举校验、
 * 项数 ≤64、剔除原型污染类键（__proto__/constructor/prototype）。非法键丢弃。
 * 空对象/非法返回 undefined（读取口径：等价未配置）。
 */
export function normalizeBarkLevels(v: unknown): Record<string, BarkLevel> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, BarkLevel> = {};
  for (const kind of Object.keys(src)) {
    if (Object.keys(out).length >= 64) break;
    if (kind.length === 0 || kind.length > 64) continue;
    if (kind === "__proto__" || kind === "constructor" || kind === "prototype") continue;
    const level = src[kind];
    if (level === "active" || level === "timeSensitive" || level === "passive" || level === "critical") {
      out[kind] = level;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 单个 Bark 实例归一化：形状/类型不对返回 null（读取时丢弃）。
 * 已知可选参数按类型过滤；未知 string/number 键透传（保留键剔除，评审 P1）；
 * 同实例内 id 必须匹配 BARK_ID_PATTERN（掩码回填与 kindRoutes 的稳定对齐键）。
 */
function normalizeBarkChannel(v: unknown): BarkChannelConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const src = v as Record<string, unknown>;
  if (typeof src.id !== "string" || !BARK_ID_PATTERN.test(src.id)) return null;
  if (src.type !== "bark") return null;
  const baseUrl = normalizeBarkBaseUrl(src.baseUrl);
  if (baseUrl === null) return null;
  if (typeof src.deviceKey !== "string" || src.deviceKey.length === 0 || src.deviceKey.length > 512) return null;
  if (typeof src.enabled !== "boolean") return null;
  const out: BarkChannelConfig & Record<string, unknown> = {
    id: src.id,
    type: "bark",
    baseUrl,
    deviceKey: src.deviceKey,
    enabled: src.enabled,
  };
  if (typeof src.name === "string" && src.name.length > 0 && src.name.length <= 64) out.name = src.name;
  if (src.sound === undefined || typeof src.sound === "string") { if (typeof src.sound === "string") out.sound = src.sound; }
  if (src.level === "active" || src.level === "timeSensitive" || src.level === "passive" || src.level === "critical") out.level = src.level;
  const levels = normalizeBarkLevels(src.levels);
  if (levels !== undefined) out.levels = levels;
  if (typeof src.group === "string") out.group = src.group;
  if (typeof src.icon === "string") out.icon = src.icon;
  if (typeof src.url === "string") out.url = src.url;
  if (typeof src.badge === "number" && Number.isFinite(src.badge) && src.badge >= 0 && src.badge <= 999999) out.badge = Math.round(src.badge);
  // 未知键透传：string/number 值原样保留（Bark 未来参数前向兼容）；保留键一律剔除
  for (const key of Object.keys(src)) {
    if (key === "id" || key === "type" || key === "baseUrl" || key === "deviceKey" || key === "enabled") continue;
    if (key === "name" || key === "sound" || key === "level" || key === "levels" || key === "group" || key === "icon" || key === "url" || key === "badge") continue;
    if ((BARK_RESERVED_KEYS as readonly string[]).includes(key)) continue;
    const value = src[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** 自定义请求头名合法性（保守 token 集；禁冒端到端关键头防走私/破坏 JSON body）。 */
const WEBHOOK_HEADER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const WEBHOOK_HEADER_DENYLIST: readonly string[] = ["content-type", "content-length", "host", "cookie", "authorization"];

/** 头名校验（#508 M2；normalize 与写校验共用，channels/webhook 复用拒非法头名）。 */
export function isWebhookHeaderName(v: unknown): boolean {
  if (typeof v !== "string" || !WEBHOOK_HEADER_NAME_PATTERN.test(v)) return false;
  return !(WEBHOOK_HEADER_DENYLIST as readonly string[]).includes(v.toLowerCase());
}

/**
 * 单个 webhook 实例归一化（#508 M2）：形状/类型不对返回 null（读取时丢弃）。
 * URL 复用 normalizeBarkBaseUrl（http/https、拒绝凭据、去 query/hash——凭据走
 * 请求头不落 URL）；timeoutSec 权威 clamp 1-60；凭据字段长度限 512；
 * 未知 string/number 键透传（保留键剔除，同 bark 口径）。
 */
function normalizeWebhookChannel(v: unknown): WebhookChannelConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const src = v as Record<string, unknown>;
  if (typeof src.id !== "string" || !BARK_ID_PATTERN.test(src.id)) return null;
  if (src.type !== "webhook") return null;
  const url = normalizeBarkBaseUrl(src.url);
  if (url === null) return null;
  if (typeof src.enabled !== "boolean") return null;
  const auth = src.auth === undefined ? "none" : src.auth;
  if (auth !== "none" && auth !== "bearer" && auth !== "basic" && auth !== "header") return null;
  const out: WebhookChannelConfig & Record<string, unknown> = {
    id: src.id,
    type: "webhook",
    url,
    enabled: src.enabled,
    auth,
  };
  if (typeof src.name === "string" && src.name.length > 0 && src.name.length <= 64) out.name = src.name;
  if (typeof src.token === "string" && src.token.length > 0 && src.token.length <= 512) out.token = src.token;
  if (typeof src.username === "string" && src.username.length > 0 && src.username.length <= 128) out.username = src.username;
  if (typeof src.password === "string" && src.password.length > 0 && src.password.length <= 512) out.password = src.password;
  if (typeof src.headerName === "string" && isWebhookHeaderName(src.headerName)) out.headerName = src.headerName;
  if (typeof src.headerValue === "string" && src.headerValue.length > 0 && src.headerValue.length <= 512) out.headerValue = src.headerValue;
  if (src.preset === "ntfy" || src.preset === "gotify" || src.preset === "custom") out.preset = src.preset;
  if (typeof src.template === "string" && src.template.length <= 8192) out.template = src.template;
  if (typeof src.timeoutSec === "number" && Number.isFinite(src.timeoutSec)) out.timeoutSec = Math.min(60, Math.max(1, Math.round(src.timeoutSec)));
  // 未知键透传：string/number 值原样保留（与 bark 同口径）；保留键一律剔除
  for (const key of Object.keys(src)) {
    if (key === "id" || key === "type" || key === "url" || key === "enabled" || key === "auth") continue;
    if (key === "name" || key === "token" || key === "username" || key === "password" || key === "headerName" || key === "headerValue" || key === "preset" || key === "template" || key === "timeoutSec") continue;
    if ((WEBHOOK_RESERVED_KEYS as readonly string[]).includes(key)) continue;
    const value = src[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/**
 * 频道实例数组归一化（#508 M2 分派版）：按实例 type 分派 bark/webhook 专属
 * normalizer，跨类型按 id 去重（首个胜出）；上限 16 实例。未知 type 走 bark
 * 口径（normalizeBarkChannel 对 type!=="bark" 返回 null → 丢弃，前向兼容旧行为）。
 */
function normalizeChannels(v: unknown): ChannelConfig[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: ChannelConfig[] = [];
  for (const item of v) {
    if (out.length >= 16) break;
    const isWebhook = typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "webhook";
    const ch = isWebhook ? normalizeWebhookChannel(item) : normalizeBarkChannel(item);
    if (ch === null || seen.has(ch.id)) continue;
    seen.add(ch.id);
    out.push(ch);
  }
  return out;
}

/** kindRoutes 归一化：对象、键/值字符串、值数组去重；键 ≤64、每数组 ≤16、id ≤64 字符。 */
function normalizeKindRoutes(v: unknown): Record<string, string[]> {
  if (typeof v !== "object" || v === null) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const kind of Object.keys(src)) {
    if (Object.keys(out).length >= 64) break;
    if (kind.length === 0 || kind.length > 64) continue;
    const routes = src[kind];
    if (!Array.isArray(routes)) continue;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of routes) {
      if (ids.length >= 16) break;
      if (typeof id !== "string" || id.length === 0 || id.length > 64 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > 0) out[kind] = ids;
  }
  return out;
}

/** allowKinds 归一化：非空字符串去重，≤128 项。 */
function normalizeAllowKinds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const k of v) {
    if (seen.size >= 128) break;
    if (typeof k === "string" && k.length > 0 && k.length <= 64) seen.add(k);
  }
  return [...seen];
}

/** 合并配置（未知键透传保留，默认值兜底；深拷贝防默认值被污染）。 */
export function normalizeConfig(input: unknown): NotifyConfig {
  const base: NotifyConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  if (typeof input !== "object" || input === null) return base;
  const src = input as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (typeof src[key] === "boolean") base[key] = src[key];
  }
  // #640/#641：声音设置专用分支——SoundSetting 非纯布尔，走不进 CONFIG_KEYS
  // 布尔循环；这里与下方「已归一化键排除表」成对出现（P1-1 修订），否则字符串
  // 音色会走未知键透传绕过校验（读面丢弃非法值回默认 true，不抛不炸）。
  if (isSoundSetting(src.browserSound)) base.browserSound = src.browserSound;
  if (isSoundSetting(src.systemSound)) base.systemSound = src.systemSound;
  // 存量表态等价映射（P0-3 收敛的读面回落前提）：旧版只有 notifySound 显式时，
  // 若新键未显式给出（JSON 显式 undefined 不可能，undefined = 未给），把旧键值
  // 等价映射为新键——normalize 后 cfg 新键恒存在，resolveSoundSetting 直读即可；
  // 否则用户曾关声音（user.notifySound=false）会在升级后因新键默认 true 复活成
  // 「突然有声」（README 行为变化声明同源）。优先级：显式新键 > 旧键映射 > 默认
  // true；显式新键（含非法值丢回默认）后旧键不再映射。
  if (typeof src.notifySound === "boolean") {
    if (src.browserSound === undefined) base.browserSound = src.notifySound;
    if (src.systemSound === undefined) base.systemSound = src.notifySound;
  }
  if (Number.isFinite(src.errorMergeWindowMs) && (src.errorMergeWindowMs as number) >= 0 && (src.errorMergeWindowMs as number) <= 3600000) {
    base.errorMergeWindowMs = Math.round(src.errorMergeWindowMs as number);
  }
  if (Number.isFinite(src.askRemindMin) && (src.askRemindMin as number) >= 0 && (src.askRemindMin as number) <= 600) {
    base.askRemindMin = Math.round(src.askRemindMin as number);
  }
  if (Number.isFinite(src.doneMergeWindowMs) && (src.doneMergeWindowMs as number) >= 0 && (src.doneMergeWindowMs as number) <= 60000) {
    base.doneMergeWindowMs = Math.round(src.doneMergeWindowMs as number);
  }
  if (Number.isFinite(src.historyMaxAgeDays) && (src.historyMaxAgeDays as number) >= 0 && (src.historyMaxAgeDays as number) <= 3650) {
    base.historyMaxAgeDays = Math.round(src.historyMaxAgeDays as number);
  }
  if (Number.isFinite(src.maxConnections) && (src.maxConnections as number) >= 1 && (src.maxConnections as number) <= 1024) {
    base.maxConnections = Math.round(src.maxConnections as number);
  }
  if (typeof src.quietHours === "object" && src.quietHours !== null) {
    const qh = src.quietHours as Record<string, unknown>;
    if (typeof qh.enabled === "boolean") base.quietHours.enabled = qh.enabled;
    // 时/分范围校验（0-23/0-59）：复用 parseHHMM，非法值（如 25:00）丢弃回默认，
    // 避免「配置保存成功但免打扰永不生效」的静默失败
    if (typeof qh.start === "string" && /^\d{2}:\d{2}$/u.test(qh.start) && parseHHMM(qh.start) >= 0) base.quietHours.start = qh.start;
    if (typeof qh.end === "string" && /^\d{2}:\d{2}$/u.test(qh.end) && parseHHMM(qh.end) >= 0) base.quietHours.end = qh.end;
    // 免打扰豁免 kind（issue #421：放开白名单——不再按 QUIET_ALLOW_KINDS 过滤未知
    // 项，与顶层 allowKinds 同款 normalizeAllowKinds 边界：非空、≤64 字符、去重、≤128 项。
    // 豁免判定仅 includes 匹配，语义由 UI 引导，服务端不约束 kind 集合）
    if (Array.isArray(qh.allowKinds)) {
      base.quietHours.allowKinds = normalizeAllowKinds(qh.allowKinds);
    }
  }
  // M2 三键：推送频道实例 / kind 稀疏路由 / 动态 kind 确认清单（#508 M2：channels 按类型分派）
  if (Array.isArray(src.channels)) base.channels = normalizeChannels(src.channels);
  if (typeof src.kindRoutes === "object" && src.kindRoutes !== null) base.kindRoutes = normalizeKindRoutes(src.kindRoutes);
  if (Array.isArray(src.allowKinds)) base.allowKinds = normalizeAllowKinds(src.allowKinds);
  // 未知键透传：白名单之外的键原样保留（此插件在旧版本运行或手改配置时会
  // 出现未来版本/第三方键），避免「降级丢键」——只归一化你认识的键。
  // #470 复核 P0：原型链污染/特殊成员键（__proto__/constructor/toString 等）
  // 一律剔除——JSON.parse 能让它们成为自有键，透传会脏写运行时镜像或改原型。
  const out = base as NotifyConfig & Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if ((PROTOTYPE_POLLUTION_KEYS as readonly string[]).includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    // 已归一化过的键不再透传（否则非法值会以原样覆盖归一化结果）
    if (key === "quietHours" || key === "errorMergeWindowMs" || key === "askRemindMin" || key === "doneMergeWindowMs" || key === "historyMaxAgeDays" || key === "maxConnections") continue;
    if (key === "channels" || key === "kindRoutes" || key === "allowKinds") continue;
    // #640/#641：browserSound/systemSound 属已归一化键（SoundSetting 白名单），
    // 非法字符串（如 "<script>"）不得经未知键透传覆盖归一化结果（P1-1/四同步）
    if (key === "browserSound" || key === "systemSound") continue;
    out[key] = src[key];
  }
  return out;
}