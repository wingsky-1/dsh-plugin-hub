/**
 * dsh-notifier — 配置契约与校验。
 *
 * 配置模型（NotifyConfig）由官方 settings 命名空间承载（issue #76）：
 * 默认值、白名单净化与「首个非法键 + hint」校验在此收敛。读取来源为
 * 命名空间解析值（scope.get()），提交面（PUT /config / 存量迁移）经
 * validateSettings / sanitizeSettings 校验——非法值 400 拒绝 + hint，
 * 不再静默丢弃回默认（H6）。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUIET_ALLOW_KINDS, parseHHMM } from "./quiet-hours.ts";
import type { QuietHoursConfig } from "./quiet-hours.ts";

// ---------------------------------------------------------------- 频道实例（M2）

/**
 * Bark 推送频道实例（同类型可配多实例；地址与 device key 由用户在设置页自填）。
 * 可选参数未配置的字段发送时不携带；未知 string/number 键原样透传（Bark 参数
 * 集合会演进，透传即前向兼容），保留键（BARK_RESERVED_KEYS）一律剔除。
 */
export interface BarkChannelConfig {
  /** 实例 id（kindRoutes 对齐键与掩码回填对齐键；创建后锁定不可改）。 */
  id: string;
  /** 设置卡显示名（缺省回退 id）。 */
  name?: string;
  /** 频道类型（当前仅 bark；未来 ntfy/telegram… 扩此联合）。 */
  type: "bark";
  /** 服务地址（normalize 时规范化为 origin+path，拒绝带凭据 URL；scheme 限 http/https）。 */
  baseUrl: string;
  /** device key（secret：GET/PUT 响应一律掩码，明文仅服务端持有）。 */
  deviceKey: string;
  /** 是否启用（默认关——出站授权须用户显式授予）。 */
  enabled: boolean;
  /** 可选参数（Bark API V2；level 缺省由 severity 映射，显式配置则覆盖映射）。 */
  sound?: string;
  level?: "active" | "timeSensitive" | "passive" | "critical";
  group?: string;
  icon?: string;
  url?: string;
  badge?: number;
}

/** Bark 实例内不允许经透传写入的保留键（凭据/加密字段，防配置绕过 secret 规则）。 */
export const BARK_RESERVED_KEYS: readonly string[] = ["device_key", "device_keys", "ciphertext"];

/** device key 的响应掩码（PUT 提交整值等于它 = 该实例 key 未修改）。 */
export const SECRET_MASK = "********";

/** 实例 id 格式：2-32 位小写字母/数字/连字符，字母或数字开头（掩码回填的稳定对齐键）。 */
export const BARK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** 通知配置（内存单一事实源，与落盘 JSON 同构）。 */
export interface NotifyConfig {
  notifyAsk: boolean;
  notifyQuestion: boolean;
  notifyTaskDone: boolean;
  /** 子代理完成通知（独立于主任务完成，默认关）。 */
  notifySubagentDone: boolean;
  notifyTaskError: boolean;
  notifyTurnEnd: boolean;
  systemNotify: boolean;
  browserNotify: boolean;
  notifyWhenVisible: boolean;
  /** 系统通知是否带提示音（false = silent，静默弹出）。 */
  notifySound: boolean;
  quietHours: QuietHoursConfig;
  errorMergeWindowMs: number;
  /** 审批等待超时二次提醒（分钟；0 = 关闭）。 */
  askRemindMin: number;
  /** 完成风暴聚合窗口（毫秒；0 = 关闭聚合，每条完成即时通知）。 */
  doneMergeWindowMs: number;
  /** 通知历史按天自动清理（0 = 不按时间清理，仅行数上限滚动）。 */
  historyMaxAgeDays: number;
  /** SSE 连接表上限（同机同时在线的服务端未释放句柄数；超限淘汰最老连接，
   *  防半开幽灵连接只增不减耗尽资源）。 */
  maxConnections: number;
  /** 配置驱动的推送频道实例（M2：bark；启用后才参与投递，见 service.ts）。 */
  channels: BarkChannelConfig[];
  /** kind→channelId[] 稀疏路由覆盖（缺省=广播全部启用频道；见设计终稿 §4.6）。 */
  kindRoutes: Record<string, string[]>;
  /** 已确认的动态 kind 清单（用户确认后落盘，重启保持；M1 内存态缺陷修复）。 */
  allowKinds: string[];
}

/** 布尔配置键联合（normalizeConfig 白名单与客户端渲染依赖它）。 */
type BooleanKeys = { [K in keyof NotifyConfig]: NotifyConfig[K] extends boolean ? K : never }[keyof NotifyConfig];

/** apply 接收的配置（enabled / 路径覆盖）。 */
export interface NotifierApplyConfig {
  enabled?: boolean;
  configFile?: string;
  toastScript?: string;
  historyFile?: string;
  /** 频道投递状态文件覆盖（默认 ~/.dsh/dsh-notifier-status.json；测试隔离用）。 */
  statusFile?: string;
}

/** 默认配置。 */
export const DEFAULT_CONFIG: NotifyConfig = {
  notifyAsk: true,
  /** 用户提问（ask_user_question / GUI 提问弹窗）时通知。 */
  notifyQuestion: true,
  notifyTaskDone: true,
  /** 子代理完成通知（独立开关，默认关：派生任务完成不打扰主流程）。 */
  notifySubagentDone: false,
  notifyTaskError: true,
  notifyTurnEnd: false,
  systemNotify: true,
  browserNotify: true,
  /** 页面可见（聚焦）时也弹浏览器通知；默认 false = 仅页面隐藏时弹（避免打扰）。 */
  notifyWhenVisible: false,
  /** 系统通知默认带提示音。 */
  notifySound: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  /** 同类错误合并窗口（毫秒）：窗口内后续错误不再单独通知，累计到下次一并提示。 */
  errorMergeWindowMs: 60000,
  /** 审批等待超时二次提醒（分钟，0=关闭；审批被卡是最高成本事件，值得重提醒）。 */
  askRemindMin: 5,
  /** 完成风暴聚合窗口（毫秒；0=关闭——并行子代理收尾防刷屏，代价是窗口内
   *  后续完成会延迟到窗口到点以聚合条补发）。 */
  doneMergeWindowMs: 3000,
  /** 通知历史按天自动清理（0=不按时间清理，仅靠行数上限滚动）。 */
  historyMaxAgeDays: 0,
  /** SSE 连接表上限默认 16：覆盖多设备×多页签 + 幽灵余量；超出淘汰最老连接，
   *  客户端断开后自动重连 + since 补拉，无感知。 */
  maxConnections: 16,
  /** 推送频道实例默认空（Bark 等出站频道默认不存在，用户显式添加）。 */
  channels: [],
  /** 路由稀疏覆盖默认空 = 全部 kind 广播全部启用频道（新插件零配置可用）。 */
  kindRoutes: {},
  /** 动态 kind 确认清单默认空。 */
  allowKinds: [],
};

/** 布尔配置键（单一事实源：normalizeConfig 白名单与客户端渲染依赖它）。 */
export const CONFIG_KEYS: readonly BooleanKeys[] = ["notifyAsk", "notifyQuestion", "notifyTaskDone", "notifySubagentDone", "notifyTaskError", "notifyTurnEnd", "systemNotify", "browserNotify", "notifyWhenVisible", "notifySound"];

/** 配置存储路径（旧版自建 json；issue #76 后仅作存量迁移源，不再读写）。 */
export function configFile() {
  return join(homedir(), ".dsh", "dsh-notifier.json");
}

/** 通知历史文件路径（jsonl 追加；与配置同目录）。 */
export function historyFile() {
  return join(homedir(), ".dsh", "dsh-notifier-history.jsonl");
}

/** 频道投递状态文件路径（M2：per-channel 最近投递终态；与配置同目录）。 */
export function statusFile() {
  return join(homedir(), ".dsh", "dsh-notifier-status.json");
}

/** toast 脚本路径（本插件 lib 下）。 */
export function toastScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "toast.ps1");
}

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
  if (typeof src.group === "string") out.group = src.group;
  if (typeof src.icon === "string") out.icon = src.icon;
  if (typeof src.url === "string") out.url = src.url;
  if (typeof src.badge === "number" && Number.isFinite(src.badge) && src.badge >= 0 && src.badge <= 999999) out.badge = Math.round(src.badge);
  // 未知键透传：string/number 值原样保留（Bark 未来参数前向兼容）；保留键一律剔除
  for (const key of Object.keys(src)) {
    if (key === "id" || key === "type" || key === "baseUrl" || key === "deviceKey" || key === "enabled") continue;
    if (key === "name" || key === "sound" || key === "level" || key === "group" || key === "icon" || key === "url" || key === "badge") continue;
    if ((BARK_RESERVED_KEYS as readonly string[]).includes(key)) continue;
    const value = src[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/**
 * Bark 实例数组归一化：逐实例归一化后按 id 去重（首个胜出，重复 id 会让掩码
 * 回填与路由对齐产生歧义）；上限 16 实例（单人自用足够，防配置膨胀）。
 */
function normalizeBarkChannels(v: unknown): BarkChannelConfig[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: BarkChannelConfig[] = [];
  for (const item of v) {
    if (out.length >= 16) break;
    const ch = normalizeBarkChannel(item);
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

/** 合并配置（未知键丢弃，默认值兜底；深拷贝防默认值被污染）。 */
export function normalizeConfig(input: unknown): NotifyConfig {
  const base: NotifyConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  if (typeof input !== "object" || input === null) return base;
  const src = input as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (typeof src[key] === "boolean") base[key] = src[key];
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
    // 紧急例外 kind 白名单过滤
    if (Array.isArray(qh.allowKinds)) {
      base.quietHours.allowKinds = qh.allowKinds.filter((k): k is string => typeof k === "string" && (QUIET_ALLOW_KINDS as readonly string[]).includes(k));
    }
  }
  // M2 三键：推送频道实例 / kind 稀疏路由 / 动态 kind 确认清单
  if (Array.isArray(src.channels)) base.channels = normalizeBarkChannels(src.channels);
  if (typeof src.kindRoutes === "object" && src.kindRoutes !== null) base.kindRoutes = normalizeKindRoutes(src.kindRoutes);
  if (Array.isArray(src.allowKinds)) base.allowKinds = normalizeAllowKinds(src.allowKinds);
  // 未知键透传：白名单之外的键原样保留（此插件在旧版本运行或手改配置时会
  // 出现未来版本/第三方键），避免「降级丢键」——只归一化你认识的键。
  const out = base as NotifyConfig & Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    // 已归一化过的键不再透传（否则非法值会以原样覆盖归一化结果）
    if (key === "quietHours" || key === "errorMergeWindowMs" || key === "askRemindMin" || key === "doneMergeWindowMs" || key === "historyMaxAgeDays" || key === "maxConnections") continue;
    if (key === "channels" || key === "kindRoutes" || key === "allowKinds") continue;
    out[key] = src[key];
  }
  return out;
}

// ---------------------------------------------------------------- 写入校验（H6）
// PUT /config 与存量迁移共用的「已知键 → 校验器」表；任一已知键非法即整体
// 拒绝（400 + hint / 迁移仅标记不写入），不再静默丢弃回默认。与 lan-proxy
// 的 FILE_CONFIG_VALIDATORS 同形态（零依赖，未引入 schemastery）。

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

function isAllowKinds(v: unknown): boolean {
  return Array.isArray(v) && v.every((k) => typeof k === "string" && (QUIET_ALLOW_KINDS as readonly string[]).includes(k));
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

/** 已知 Bark 实例可选参数的类型校验表（与 normalizeBarkChannel 的过滤键平行维护）。 */
function isBarkChannelParam(key: string, value: unknown): boolean {
  if (key === "name") return typeof value === "string" && value.length > 0 && value.length <= 64;
  if (key === "sound" || key === "group" || key === "icon" || key === "url") return typeof value === "string";
  if (key === "level") return value === "active" || value === "timeSensitive" || value === "passive" || value === "critical";
  if (key === "badge") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 999999;
  return typeof value === "string" || typeof value === "number"; // 未知键透传
}

const BARK_KNOWN_PARAM_KEYS: readonly string[] = ["name", "sound", "level", "group", "icon", "url", "badge"];

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

/** channels 整组写入校验（≤16 实例 + id 不得重复——重复会让掩码回填/路由对齐歧义）。 */
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
  quietHours: isQuietHours,
  errorMergeWindowMs: isNonNegNumber(3600000),
  askRemindMin: isNonNegNumber(600),
  doneMergeWindowMs: isNonNegNumber(60000),
  historyMaxAgeDays: isNonNegNumber(3650),
  maxConnections: isConnLimit,
  channels: isBarkChannels,
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
  quietHours: "需为 { enabled?: boolean, start?: \"HH:MM\", end?: \"HH:MM\", allowKinds?: kind[] }",
  errorMergeWindowMs: "需为 0-3600000 的整数（毫秒）",
  askRemindMin: "需为 0-600 的整数（分钟）",
  doneMergeWindowMs: "需为 0-60000 的整数（毫秒）",
  historyMaxAgeDays: "需为 0-3650 的整数（天）",
  maxConnections: "需为 1-1024 的整数",
  channels: "需为 { id, type:'bark', baseUrl, deviceKey, enabled } 实例数组（id 为 2-32 位小写字母/数字/连字符且不重复；baseUrl 为无凭据的 http(s) 地址；至多 16 实例）",
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
 */
export function validateSettings(raw: unknown): SettingInvalid | null {
  if (typeof raw !== "object" || raw === null) return { key: "(payload)", hint: "需为配置对象" };
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
 * 净化提交的配置（PUT 保存通道与存量迁移共用）：只接受已知键；任一已知键
 * 类型非法 → 整体拒绝（返回 null，避免静默丢键造成「保存了但没生效」的
 * 困惑；迁移场景则等价于「无有效键 → 只标记不写入」）。未知键丢弃（写入
 * 通道白名单语义——不把组合层装配键如 configFile 等混入 user 层；与
 * lan-proxy sanitizeSettings 同口径，normalizeConfig 的透传仅服务读取渲染）。
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

// ---------------------------------------------------------------- 凭据脱敏与掩码回填（M2 评审 P0-1/P0-2）

/**
 * 配置读取面统一脱敏出口（单一收口，评审 P0-1）：深拷贝后把 channels[].deviceKey
 * 掩码为 SECRET_MASK。GET /config 的 user 与 effective、PUT 成功响应的 user 一律
 * 经此函数输出——调用方不得绕过（契约测试深度扫描锁死）。
 *
 * 模板类型仅约束输入输出同构；实现按结构化克隆 + 单键覆写，对任意 JSON 值安全。
 */
export function redactConfigView<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value ?? null)) as T & { channels?: Array<Record<string, unknown>> };
  if (Array.isArray(clone?.channels)) {
    for (const ch of clone.channels) {
      if (ch && typeof ch === "object" && typeof ch.deviceKey === "string") ch.deviceKey = SECRET_MASK;
    }
  }
  return clone;
}

/**
 * 掩码回填（PUT /config 保存通道，评审 P0-2）：patch 实例的 deviceKey 整值等于
 * SECRET_MASK 时按 **id 对齐**回填 user 层原值（严禁按下标——数组序变会把 A 的
 * key 回填进 B，造成凭据串实例）。必须先于 validateSettings/sanitizeSettings 执行
 * （掩码不是合法 deviceKey 语义，未回填会被 400 拦死）。
 *
 * @returns 回填后的 channels 数组；`missing` = 新增实例却提交掩码（无原值可回填），
 *   调用方应 400 拒绝——掩码只允许表达「未修改」。
 */
export function unmaskChannels(
  patchChannels: unknown,
  userChannels: unknown,
): { ok: true; channels: unknown[] } | { ok: false } {
  if (!Array.isArray(patchChannels)) return { ok: true, channels: [] };
  const originals = new Map<string, string>();
  if (Array.isArray(userChannels)) {
    for (const ch of userChannels) {
      if (typeof ch === "object" && ch !== null) {
        const rec = ch as Record<string, unknown>;
        if (typeof rec.id === "string" && typeof rec.deviceKey === "string") originals.set(rec.id, rec.deviceKey);
      }
    }
  }
  const out: unknown[] = [];
  for (const item of patchChannels) {
    if (typeof item !== "object" || item === null) return { ok: false };
    const ch = { ...(item as Record<string, unknown>) };
    if (ch.deviceKey === SECRET_MASK) {
      const original = typeof ch.id === "string" ? originals.get(ch.id) : undefined;
      if (original === undefined) return { ok: false }; // 新实例不允许掩码占位
      ch.deviceKey = original;
    }
    out.push(ch);
  }
  return { ok: true, channels: out };
}
