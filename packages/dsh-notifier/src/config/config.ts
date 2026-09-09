/**
 * dsh-notifier — 配置域：类型 + 默认值 + 装配键锁（零 node 依赖）。
 *
 * 配置模型（NotifyConfig）由官方 settings 命名空间承载（issue #76）：
 * 默认值、白名单净化与「首个非法键 + hint」校验收敛在 validators/normalize；
 * 本文件只持有类型、默认值、声音回落、频道保留键与组合层装配键的编译期契约。
 * 读取来源为命名空间解析值（scope.get()），提交面（PUT /config / 存量迁移）
 * 经 validateSettings / sanitizeSettings 校验——非法值 400 拒绝 + hint，
 * 不再静默丢弃回默认（H6）。
 */
import type { QuietHoursConfig } from "./quiet-hours.ts";

// ---------------------------------------------------------------- 频道实例（M2）

/** Bark 紧急度级别（Bark API V2 level 枚举；config 契约单点，channels/bark 复用）。 */
export type BarkLevel = "active" | "timeSensitive" | "passive" | "critical";

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
  level?: BarkLevel;
  /** 按事件（kind）紧急度稀疏映射：命中优先于 level 与 severity 映射（见 channels/bark）。 */
  levels?: Record<string, BarkLevel>;
  group?: string;
  icon?: string;
  url?: string;
  badge?: number;
}

/** Bark 实例内不允许经透传写入的保留键（凭据/加密字段，防配置绕过 secret 规则）。 */
export const BARK_RESERVED_KEYS: readonly string[] = ["device_key", "device_keys", "ciphertext"];

/**
 * webhook 实例内不允许经透传写入的保留键（#508 M2）：凭据类 snake_case 别名
 * 一律剔除——合法凭据只能走已知 secret 字段（token/password/headerValue，经掩码
 * 收口），防配置绕过 secret 规则（与 BARK_RESERVED_KEYS 同语义）。
 */
export const WEBHOOK_RESERVED_KEYS: readonly string[] = ["auth_token", "access_token", "bearer_token", "api_key", "apikey", "client_secret", "secret", "password_hash"];

/** 实例 id 格式：2-32 位小写字母/数字/连字符，字母或数字开头（掩码回填的稳定对齐键）。 */
export const BARK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Webhook 推送频道实例（#508 M2：安卓经 ntfy / Gotify / 自建推送网关；默认停用，
 * 出站授权须用户显式授予）。凭据一律走请求头（bearer/basic/header），不拼 URL。
 */
export type WebhookAuth = "none" | "bearer" | "basic" | "header";

/** webhook 预设（#508 拍板 r3：{{priority}} 频道感知映射的依据）。 */
export type WebhookPreset = "ntfy" | "gotify" | "custom";

export interface WebhookChannelConfig {
  /** 实例 id（kindRoutes 对齐键与掩码回填对齐键；创建后锁定不可改）。 */
  id: string;
  /** 设置卡显示名（缺省回退 id）。 */
  name?: string;
  type: "webhook";
  /** 目标 URL（normalize 规范化为 origin+path：拒绝凭据 URL、去 query/hash——
   *  凭据走请求头不落 URL；scheme 限 http/https）。 */
  url: string;
  enabled: boolean;
  /** 认证方式（默认 none；bearer→token、basic→username+password、header→headerName+headerValue）。 */
  auth: WebhookAuth;
  /** 访问令牌（secret：bearer 认证用；响应一律掩码）。 */
  token?: string;
  /** Basic 认证用户名（非 secret）。 */
  username?: string;
  /** Basic 认证密码（secret：响应一律掩码）。 */
  password?: string;
  /** 自定义请求头名（token 字符限 http(s) 头名合法集；header 认证用，非 secret）。 */
  headerName?: string;
  /** 自定义请求头值（secret：响应一律掩码）。 */
  headerValue?: string;
  /** 预设（{{priority}} 映射与默认模板依据；默认 ntfy）。 */
  preset?: WebhookPreset;
  /** JSON body 模板（渲染契约见 channels/webhook renderWebhookBody；空 = 预设默认模板）。 */
  template?: string;
  /** 投递超时秒（1-60，服务端 normalize 权威 clamp；默认 10）。 */
  timeoutSec?: number;
}

/** 频道实例联合（#508 M2：bark | webhook；未来类型扩此联合 + 分派三处）。 */
export type ChannelConfig = BarkChannelConfig | WebhookChannelConfig;

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
  /**
   * 系统通知是否带提示音（false = silent，静默弹出）。
   * @deprecated 只读兼容别名（#640/#641）：新 UI 不再写本键；读取由
   * resolveSoundSetting 回落消费（缺 browserSound/systemSound 时沿用旧值）。
   * 存量 user 层可能残留本键（settings 层不迁移、首次 UI 保存后由新键取代）。
   */
  notifySound: boolean;
  /** 浏览器通道声音（false=静音；true=跟随系统默认；SoundId=页内自播音色）。 */
  browserSound: SoundSetting;
  /** 系统通道声音（false=静音；true=跟随系统默认；Linux true=默认事件音自播）。 */
  systemSound: SoundSetting;
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
  /** 配置驱动的推送频道实例（#508 M2：bark | webhook；启用后才参与投递，见 sdk/service）。 */
  channels: ChannelConfig[];
  /** kind→channelId[] 稀疏路由覆盖（缺省=广播全部启用频道；见设计终稿 §4.6）。 */
  kindRoutes: Record<string, string[]>;
  /** 已确认的动态 kind 清单（用户确认后落盘，重启保持；M1 内存态缺陷修复）。 */
  allowKinds: string[];
}

/**
 * 布尔配置键联合（normalizeConfig 白名单与客户端渲染依赖它）。
 * browserSound/systemSound 类型为 SoundSetting（boolean|SoundId），其 boolean
 * 形态仍需走 CONFIG_KEYS 循环（#640/#641；门禁 N2 以默认字面量布尔推导），
 * SoundId 字符串形态由声音专用分支归一化——联合推导把 SoundSetting 纳入。
 */
type BooleanKeys = { [K in keyof NotifyConfig]: NotifyConfig[K] extends boolean | SoundSetting ? K : never }[keyof NotifyConfig];

// ---------------------------------------------------------------- 声音设置（#640/#641）

/**
 * 内置音色 id（全平台语义一致的 SoundId 白名单；定稿口径 ding/bell/chime/pop，
 * 不含 default——「跟随系统」由 true 承担；不含 complete——与 done 语义重叠且
 * 多数 DE 默认包缺对应事件文件）。各平台映射：
 * - 浏览器：Web Audio 合成短旋律（客户端 playTone）；
 * - macOS：NSSound 系统内置名（Glass/Ping/Sosumi/Pop/Frog/Tink…，sound name）；
 * - Linux：freedesktop 声音事件文件（sound-theme-freedesktop 基线包内存在）；
 * - Windows：宿主 SoundPlayer 白名单 wav（C:\Windows\Media\…，缺失静默）。
 */
export const SOUND_IDS = ["ding", "bell", "chime", "pop"] as const;

/** 声音设置取值：false=静音；true=跟随系统默认；SoundId=显式内置音色。 */
export type SoundId = (typeof SOUND_IDS)[number];

/** 声音设置（boolean | 内置音色 id；校验器 isSoundSetting 与其白名单同源）。 */
export type SoundSetting = boolean | SoundId;

/** 声音通道键（browserSound/systemSound；resolveSoundSetting 与客户端渲染共用）。 */
export type SoundChannel = "browser" | "system";

/** v 是否为合法声音设置（false/true 或 SOUND_IDS 之一）。 */
export function isSoundSetting(v: unknown): v is SoundSetting {
  if (v === true || v === false) return true;
  return typeof v === "string" && (SOUND_IDS as readonly string[]).includes(v);
}

/**
 * 单一回落纯函数（评审 P0-3 收敛）：通道声音设置的读面权威。
 * 缺该通道键（undefined）→ 回落全局旧别名 notifySound → 再缺省 true（跟随系统）；
 * 显式写入（含 false）后两通道互不影响。normalize 后配置恒含两键（DEFAULT_CONFIG
 * 兜底），但存量 user 层可能只有 notifySound（settings 层存量不迁，#640/#641 读面
 * 回落）——本函数是唯一回落点，消费方不得自行叠加回落逻辑。
 */
export function resolveSoundSetting(cfg: Pick<NotifyConfig, "browserSound" | "systemSound" | "notifySound">, channel: SoundChannel): SoundSetting {
  const value = cfg[channel === "browser" ? "browserSound" : "systemSound"];
  if (value !== undefined) return value;
  const legacy = cfg.notifySound;
  if (legacy !== undefined) return legacy;
  return true;
}

/** apply 接收的配置（enabled / 路径覆盖；路径不覆盖时默认落 DSH_HOME，未设时 ~/.dsh，#510）。 */
export interface NotifierApplyConfig {
  enabled?: boolean;
  configFile?: string;
  toastScript?: string;
  historyFile?: string;
  /** 频道投递状态文件覆盖（测试隔离用）。 */
  statusFile?: string;
}

/**
 * 组合层装配键名（sanitizePatchSettings 透传通道的保留键排除表，单一事实源）：
 * 这些键是 cordis 组合层 / apply 入口的装配键（开关与路径覆盖），不属于
 * settings user 层的配置契约——PUT /config 与存量迁移提交同名键时一律剔除，
 * 防 user 层被无意义装配键污染，也杜绝未来某版本误把 user 层 configFile 等当
 * 配置来源（#470 P1-3：PUT 透传不能成为绕过 entry 白名单的路径；新增装配键
 * 只加 NotifierApplyConfig 不加本表 → 下方编译期断言直接报错）。
 */
export const ASSEMBLY_SETTING_KEYS = ["configFile", "toastScript", "historyFile", "statusFile", "enabled"] as const;

// 编译期契约锁（#470 复核 P1-3）：ASSEMBLY_SETTING_KEYS 必须与
// NotifierApplyConfig 键集**双向完全一致**——任一方向漏/多都让赋值类型错误。
type AssemblyKey = (typeof ASSEMBLY_SETTING_KEYS)[number];
type ApplyConfigKey = keyof NotifierApplyConfig;
type AssertAssemblyComplete = Exclude<ApplyConfigKey, AssemblyKey> extends never ? true : false;
type AssertAssemblyNoExtra = Exclude<AssemblyKey, ApplyConfigKey> extends never ? true : false;
const assemblyKeysComplete: AssertAssemblyComplete = true;
const assemblyKeysNoExtra: AssertAssemblyNoExtra = true;

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
  /** 浏览器通道声音默认 true = 跟随系统默认（浏览器通知不 silent，不自播）。 */
  browserSound: true,
  /** 系统通道声音默认 true = 跟随系统默认（Linux 特例：默认事件音自播，#640）。 */
  systemSound: true,
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

/**
 * 布尔配置键（单一事实源：normalizeConfig 白名单与客户端渲染依赖它）。
 * browserSound/systemSound 属 SoundSetting（boolean|SoundId），其 boolean 形态
 * 走 CONFIG_KEYS 循环；SoundId 字符串形态由 normalizeConfig 声音专用分支处理
 * （两处都要排除表同步排除——见 normalizeConfig）。
 */
export const CONFIG_KEYS: readonly BooleanKeys[] = ["notifyAsk", "notifyQuestion", "notifyTaskDone", "notifySubagentDone", "notifyTaskError", "notifyTurnEnd", "systemNotify", "browserNotify", "notifyWhenVisible", "notifySound", "browserSound", "systemSound"];

/**
 * 原型链污染/特殊成员键名（读透传与写通道共用保留键，#470 复核 P0）：这些键
 * 经 JSON.parse 可成为**自有键**，但作为未知键透传会误触 Object.prototype
 * 成员——constructor/prototype/toString/hasOwnProperty/valueOf 被原样写进
 * user 层/运行时镜像属脏写，__proto__ 赋值还会改对象原型（原型污染）。config
 * 契约不识别这些键，读取透传与写入通道一律剔除（与 Bark 保留键、
 * isBarkLevelsStrict/isKindRoutes 既有剔除口径一致）。
 */
export const PROTOTYPE_POLLUTION_KEYS: readonly string[] = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];