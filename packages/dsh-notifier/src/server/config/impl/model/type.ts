/**
 * dsh-notifier config 域 —— 设置模型（本域形状）。
 *
 * 模型即跨端契约：设置页与宿主端读的是同一份形状，字段名两侧同源，改动即两端同改。
 * 因此这里只放「设置长什么样」，不放「设置怎么被处理」——归一化、校验、掩码往返
 * 都是 `input/` 与 `redact/` 的事。
 *
 * 全篇用类型别名而非接口：设置模型要能落进「原始值」这层宽类型（宿主存储里的内容
 * 不受契约约束），而只有类型别名带隐式索引签名，接口没有。
 */
import type { BarkTarget, WebhookTarget } from "../../deps.ts";

// ---------------------------------------------------------------- 原始输入

/**
 * 原始设置值：来自宿主存储或 HTTP 提交。
 *
 * 只承诺「是 JSON 结构」，不承诺落在任何合法域：形状是清楚的（设置值就那么几种），
 * 只是内容不受信。收窄它的责任在输入闸门。
 */
export type RawSettingValue = string | number | boolean | readonly RawSettingValue[] | { readonly [key: string]: RawSettingValue };

/** 宿主存储里的原始设置：键名也不受契约约束——存储里可能是陌生键。 */
export type StoredSettings = { readonly [key: string]: RawSettingValue };

// ---------------------------------------------------------------- 声音

/** 内置音色 id：全平台语义一致的白名单；「跟随系统」由 true 承担，不占 id。 */
export type SoundId = "ding" | "bell" | "chime" | "pop";

/** 声音设置：false = 静音；true = 跟随系统默认；SoundId = 显式内置音色。 */
export type SoundSetting = boolean | SoundId;

// ---------------------------------------------------------------- 免打扰

/**
 * 免打扰时段。
 *
 * 只描述「哪段时间、放行谁」；**是否命中时段、要不要静音**由裁决层解释——配置域
 * 不认识通知业务，只负责把这段设置原样存下来。
 */
export type QuietHoursConfig = {
  enabled: boolean;
  /** "HH:MM"，允许跨零点（start > end）。 */
  start: string;
  end: string;
  /** 时段内仍放行的 kind；缺省语义由裁决层定义。 */
  allowKinds?: string[];
};

// ---------------------------------------------------------------- 频道

/** bark 紧急度。 */
export type BarkLevel = "active" | "timeSensitive" | "passive" | "critical";

/**
 * bark 频道实例 = 投递参数 + 配置元数据。
 *
 * `type` 与 `level` 重声明：前者是频道联合的判别键，后者在配置层受枚举约束而投递层
 * 不受（跨进程传来的 target 不被编译期类型约束）。
 */
export type BarkChannelConfig = Omit<BarkTarget, "type" | "level"> & {
  type: "bark";
  /** 实例 id：路由对齐键与掩码回填对齐键，创建后不可改。 */
  id: string;
  /** 是否启用；缺省关——出站授权须用户显式授予。 */
  enabled: boolean;
  /** 设置卡显示名（缺省回退 id）。 */
  name?: string;
  level?: BarkLevel;
  /** 按 kind 的紧急度稀疏映射，命中优先于 level。 */
  levels?: Record<string, BarkLevel>;
};

/** webhook 认证方式：凭据一律走请求头，不拼 URL。 */
export type WebhookAuth = "none" | "bearer" | "basic" | "header";

/** webhook 预设：决定默认 body 模板与优先级映射。 */
export type WebhookPreset = "ntfy" | "gotify" | "custom";

/**
 * webhook 频道实例。
 *
 * `auth` 重声明：投递层要的是**已解析的凭据对象**（调用方解析后传入），配置层存的是
 * 用户选的**认证方式**加分散的凭据字段——两者不是同一个形状。
 */
export type WebhookChannelConfig = Omit<WebhookTarget, "type" | "auth" | "preset"> & {
  type: "webhook";
  id: string;
  enabled: boolean;
  name?: string;
  auth: WebhookAuth;
  /** bearer 令牌（密钥）。 */
  token?: string;
  /** basic 用户名（非密钥）。 */
  username?: string;
  /** basic 密码（密钥）。 */
  password?: string;
  /** 自定义头名（非密钥）。 */
  headerName?: string;
  /** 自定义头值（密钥）。 */
  headerValue?: string;
  preset?: WebhookPreset;
  /** JSON body 模板；空 = 预设默认模板。 */
  template?: string;
};

/** 出站频道实例联合；新增频道类型扩此联合。 */
export type ChannelConfig = BarkChannelConfig | WebhookChannelConfig;

// ---------------------------------------------------------------- 设置

/**
 * 通知设置（宿主端与设置页共用的形状）。
 *
 * 分三类：**事件开关**（哪种宿主事件要通知）、**投递形态**（走哪些频道、什么声音、
 * 什么时段）、**资源上限**（历史、连接、聚合窗口）。
 */
export type NotifyConfig = {
  // 事件开关
  notifyAsk: boolean;
  notifyQuestion: boolean;
  notifyTaskDone: boolean;
  notifySubagentDone: boolean;
  notifyTaskError: boolean;
  notifyTurnEnd: boolean;

  // 投递形态
  systemNotify: boolean;
  browserNotify: boolean;
  /** 页面可见时是否也弹浏览器通知。 */
  notifyWhenVisible: boolean;
  /** @deprecated 只读兼容别名；读取由回落链消费，新写入一律用下面两个键。 */
  notifySound: boolean;
  browserSound: SoundSetting;
  systemSound: SoundSetting;
  quietHours: QuietHoursConfig;
  channels: ChannelConfig[];
  /** kind → channelId[] 稀疏路由；缺省 = 广播全部启用频道。 */
  kindRoutes: Record<string, string[]>;
  /** 已确认的动态 kind。 */
  allowKinds: string[];
  /** 通知与历史的统一脱敏开关。 */
  sanitizeContent: boolean;

  // 资源上限
  /** 同类错误合并窗口（毫秒；0 = 不合并）。 */
  errorMergeWindowMs: number;
  /** 审批等待超时二次提醒（分钟；0 = 关闭）。 */
  askRemindMin: number;
  /** 完成风暴聚合窗口（毫秒；0 = 每条即时通知）。 */
  doneMergeWindowMs: number;
  /** 历史按天自动清理（0 = 只按行数滚动）。 */
  historyMaxAgeDays: number;
  /** SSE 连接表上限（超限淘汰最老连接）。 */
  maxConnections: number;
};

/**
 * 设置提交体：键名受契约约束（写错键名是编译错误），值待校验——提交上来的东西在
 * 运行时不受类型约束，所以值的类型是原始的、需要过闸门的。
 */
export type SettingsPatch = { [K in keyof NotifyConfig]?: RawSettingValue };

/** 校验失败载荷：首个非法键 + 给用户看的提示。 */
export type SettingInvalid = {
  key: string;
  hint: string;
};
