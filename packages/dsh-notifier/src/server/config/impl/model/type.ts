/** 设置模型（本域形状）。模型即跨端契约：设置页与宿主端读同一份形状，字段名两侧同源，改动即两端同改；这里只放
 * 「设置长什么样」。全篇用类型别名而非接口——只有类型别名带隐式索引签名，能落进「原始值」这层宽类型。 */
import type { BarkTarget, WebhookTarget } from "../../deps.ts";
import type {
  BuiltinChannelType,
  SoundId,
  WebhookAuth,
  WebhookPreset,
} from "../../../../shared/interface.ts";

// ---------------------------------------------------------------- 原始输入

/** 原始设置值：来自宿主存储或 HTTP 提交。只承诺「是 JSON 结构」，不承诺落在任何合法域——形状是清楚的，内容不受信，
 * 收窄它的责任在输入闸门。 */
export type RawSettingValue =
  | string
  | number
  | boolean
  | readonly RawSettingValue[]
  | { readonly [key: string]: RawSettingValue };

/** 宿主存储里的原始设置：键名也不受契约约束——存储里可能是陌生键。 */
export type StoredSettings = { readonly [key: string]: RawSettingValue };

// ---------------------------------------------------------------- 声音

/** 内置音色 id：事实源在 src/shared/sounds.ts（两端共享面）——白名单与设置页的选项同源。
 *  「跟随系统」由 true 承担，不占 id。 */
export type { SoundId };

/** 声音设置：false = 静音；true = 跟随系统默认；SoundId = 显式内置音色。 */
export type SoundSetting = boolean | SoundId;

// ---------------------------------------------------------------- 免打扰

/** 单个免打扰时间窗。"HH:MM"，允许跨零点（start > end，由裁决层解释）。 */
export type QuietWindow = {
  start: string;
  end: string;
};

/**
 * 免打扰时间窗上限：写面超限 400 拒收（静默截断会让用户以为配好的时段生效了）。
 *
 * 事实源在 src/shared/quiet.ts（两端共享面）：设置页的「添加时段」按钮与写面读同一个数，
 * 各写一个 5 迟早各说各话。这里只做转出，兼容既有 `../model/type.ts` 引用面。
 */
export { QUIET_WINDOWS_LIMIT } from "../../../../shared/interface.ts";

/** 免打扰时段。只描述「哪些时间、放行谁」；**是否命中时段、要不要静音**由裁决层解释——配置域不认识通知业务，
 * 只负责把这段设置原样存下来。 */
export type QuietHoursConfig = {
  enabled: boolean;
  /** 时间窗列表：命中任一窗口即压制（并集语义，重叠允许）；空数组 = 一个都不命中。 */
  windows: QuietWindow[];
  /** 时段内仍放行的 kind；缺省语义由裁决层定义。 */
  allowKinds?: string[];
};

// ---------------------------------------------------------------- 频道

/** bark 紧急度。 */
export type BarkLevel = "active" | "timeSensitive" | "passive" | "critical";

/** bark 频道实例 = 投递参数 + 配置元数据。`type` 与 `level` 重声明：前者是频道联合的判别键，后者在配置层受枚举
 * 约束而投递层不受（跨进程传来的 target 不被编译期类型约束）。 */
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

/** webhook 认证方式：凭据一律走请求头，不拼 URL。事实源在 src/shared/webhooks.ts（两端共享面）。 */
export type { WebhookAuth };

/** webhook 预设：决定默认 body 模板与优先级映射。事实源在 src/shared/webhooks.ts（两端共享面）。 */
export type { WebhookPreset };

/** webhook 频道实例。`auth` 重声明：投递层要的是**已解析的凭据对象**，配置层存的是用户选的**认证方式**加分散的
 * 凭据字段——两者不是同一个形状。 */
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

/** 内置频道类型：只有这两个，且身份由 `type` 唯一确定——实例才需要 id 消歧。
 *  事实源在 src/shared/channels.ts（两端共享面，值清单与类型同源）。 */
export type { BuiltinChannelType };

/** 浏览器频道（内置）：浏览器通知的展示形态。这些字段就是「发什么」的判据，由频道自己解释——裁决管线只认 `enabled`。 */
export type BrowserChannelConfig = {
  type: "browser";
  /** 内置频道的 id 恒等于 `type`：与实例的 `type:id` 规则同源，`browser` 与 `browser:<id>` 不会撞。 */
  id: "browser";
  /** 发不发：本频道唯一的投递闸门。 */
  enabled: boolean;
  /** 弹不弹；关掉而声音开着 = 只响不弹。 */
  popup: boolean;
  sound: SoundSetting;
  /** 页面可见时是否也弹（随帧下发给浏览器出口）。 */
  whenVisible: boolean;
};

/** 系统频道（内置）：原生 toast 与提示音。 */
export type SystemChannelConfig = {
  type: "system";
  id: "system";
  enabled: boolean;
  popup: boolean;
  sound: SoundSetting;
};

/** 频道联合：出站实例 + 内置频道。新增类型扩此联合，`channels` 数组与设置页都按 `type` 分派。 */
export type ChannelConfig =
  BarkChannelConfig | WebhookChannelConfig | BrowserChannelConfig | SystemChannelConfig;

// ---------------------------------------------------------------- 设置

/** 通知设置（宿主端与设置页共用的形状）。分三类：**事件开关**（哪种宿主事件要通知）、**投递形态**（走哪些频道、
 * 什么声音、什么时段）、**资源上限**（历史、连接、聚合窗口）。 */
export type NotifyConfig = {
  // 事件开关
  notifyAsk: boolean;
  notifyQuestion: boolean;
  notifyTaskDone: boolean;
  notifySubagentDone: boolean;
  notifyTaskError: boolean;
  notifyTurnEnd: boolean;

  // 投递形态
  // 渠道的开关、弹窗与声音都住在 `channels` 的条目里（两条内置 + 实例），这里没有第二处表达。
  // 0.2.3 的顶层渠道键（`browserEnabled` / `notifySound` 那一批）由 upgrade 域在装配期搬进条目并
  // **删除**——本契约不认识它们；读面只为「还没割接的文件」保留消费它们的物化输入。
  quietHours: QuietHoursConfig;
  /** 全部频道：内置恒在最前（browser、system），实例随后；读面保证两条内置条目恒在场。 */
  channels: ChannelConfig[];
  /** kind → channelId[] 稀疏路由；缺省 = 广播全部启用频道。 */
  kindRoutes: Record<string, string[]>;
  /** 已确认的动态 kind。 */
  allowKinds: string[];

  // 资源上限
  /** 历史按天自动清理（0 = 只按行数滚动）。 */
  historyMaxAgeDays: number;
};

/** 设置提交体：键名受契约约束（写错键名是编译错误），值待校验——提交上来的东西在运行时不受类型约束。 */
export type SettingsPatch = { [K in keyof NotifyConfig]?: RawSettingValue };

/** 校验失败载荷：首个非法键 + 给用户看的提示。 */
export type SettingInvalid = {
  key: string;
  hint: string;
};
