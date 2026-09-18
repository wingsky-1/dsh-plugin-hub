/**
 * dsh-notifier 客户端 —— 设置页视图类型（服务端快照经 HTTP 到客户端后的读形态）。
 *
 * 为什么在这里镜像而不 `import type` 宿主侧形状（ChannelConfig / RegisteredKind /
 * HistoryEntry）：跨端面只按字符串拼键（见 src/shared/channels.ts channelIdOf 的注释——
 * 把宿主类型拖进跨端面会让客户端与宿主配置模型锁死，脏数据（旧版本/手改存储）本就可能
 * 缺键，读侧一律按可选字段 + 调用点收窄使用）。各字段类型锚在服务端契约的对应字段上，
 * 改动即两端同改；`unknown` 只出现在「调用点已做收窄」的脏值位（sound / error 段等）。
 *
 * 本模块只放类型（零运行时）：不新增覆盖率负担，不参与导出面值块比对（门禁只看值声明块）。
 */

/** 设置草稿里的单条频道（服务端 ChannelConfig 经 /config 到客户端的视图）。 */
export type SettingsChannelView = {
  [key: string]: unknown;
  /** 频道类型：内置（browser/system）与实例（bark/webhook）的分派键，服务端恒有。 */
  type: string;
  /** 实例 id（路由对齐键）；内置恒等于 type。 */
  id: string;
  /** 设置卡显示名（缺省回退 id）。 */
  name?: string;
  /** 发不发：本频道唯一的投递闸门。 */
  enabled?: boolean;
  /** 弹不弹；关掉而声音开着 = 只响不弹。 */
  popup?: boolean;
  /** 声音设置：false = 静音；true = 跟随系统默认；SoundId = 显式音色（脏值由调用点收窄）。 */
  sound?: unknown;
  /** 页面可见时是否也弹。 */
  whenVisible?: boolean;
  /** bark 自定义端点覆写（可选）。 */
  baseUrl?: string;
  /** bark 设备密钥（服务端掩码回填，未编辑不回显）。 */
  deviceKey?: string;
  /** bark 分组。 */
  group?: string;
  /** bark 自定义图标。 */
  icon?: string;
  /** bark 跳转 URL / webhook 目标 URL。 */
  url?: string;
  /** bark 角标数。 */
  badge?: number;
  /** bark 默认紧急度。 */
  level?: string;
  /** bark 按 kind 的紧急度稀疏映射（调用点只写 string 值，见 chLevelsSet）。 */
  levels?: Record<string, string>;
  /** webhook 认证方式。 */
  auth?: string;
  /** webhook bearer 令牌（密钥）。 */
  token?: string;
  /** webhook basic 用户名（非密钥）。 */
  username?: string;
  /** webhook basic 密码（密钥）。 */
  password?: string;
  /** webhook 自定义头名（非密钥）。 */
  headerName?: string;
  /** webhook 自定义头值（密钥）。 */
  headerValue?: string;
  /** webhook JSON body 模板。 */
  template?: string;
  /** webhook 预设（{{priority}} 频道感知映射的依据）。 */
  preset?: string;
  /** webhook 投递超时秒数（UI 先 clamp 1-60，服务端 normalize 权威 clamp）。 */
  timeoutSec?: number;
};

/** 动态 kind 清单项（GET /kinds 元素；形状对齐服务端 RegisteredKind）。 */
export type RegisteredKindView = {
  id: string;
  label: string;
  /** 用户已经放行；未放行的种类在裁决层被压制。 */
  confirmed: boolean;
};

/** 历史记录行（GET /history records 元素当中的渲染子集；全量形状见服务端 HistoryEntry）。 */
export type HistoryRecordView = {
  ts: number;
  kind: string;
  title: string;
  message: string;
  /** 被压制的原因；真正投递出去时缺省。 */
  suppressed?: string;
  /** 逐出口投递明细（结构由 rows.tsx deliveryLines 经 reason-text 解释）。 */
  channels?: unknown;
};

/** 免打扰时段（服务端 QuietHoursConfig 到客户端的视图；缺键回落默认值由调用点处理）。 */
export type QuietHoursView = {
  enabled?: boolean;
  /** "HH:MM"，允许跨零点。 */
  start?: string;
  end?: string;
  /** 时段内仍放行的 kind。 */
  allowKinds?: string[];
};

/** 设置草稿（服务端 settings 对象到客户端的视图；真正的形状声明在宿主侧，见 index.tsx 注释）。 */
export type SettingsView = {
  [key: string]: unknown;
  /** 全部频道：内置恒在最前，实例随后。 */
  channels?: SettingsChannelView[];
  quietHours?: QuietHoursView;
  /** kind → channelId[] 稀疏路由；缺省 = 广播全部启用频道。 */
  kindRoutes?: Record<string, string[]>;
  /** 历史保留天数。 */
  historyMaxAgeDays?: number;
};

/** settings 唯一写入口 patch 的输入：浅合并对象，或以最新草稿计算的 updater。 */
export type SettingsPatch = Record<string, unknown> | ((prev: SettingsView) => SettingsView);

/** GET /config 包装体（{ok,user,revision,effective,writable} 当中的读子集 + 失败体的 error 段）。 */
export type ConfigSnapshot = {
  user?: unknown;
  revision?: unknown;
  effective?: Record<string, unknown>;
  writable?: unknown;
  error?: ErrorDetail;
};

/** 失败响应体的 error 段：端点体为对象、围栏体为裸字符串（两形状说明见 api-error.ts）。 */
export type ErrorDetail = string | { details?: string; error?: string; code?: string };

/** 设置卡 meta（revision 链）：revision 只被读作 number（putAndCommit 的 expectedRevision）。 */
export type MetaView = {
  user: unknown;
  revision: unknown;
  effective: unknown;
  writable: boolean;
};

/** 409 冲突横幅的 latest（冲突时拉取的服务端最新；动作为空时不弹横幅）。 */
export type ConflictLatest = {
  effective: Record<string, unknown>;
  revision?: unknown;
  user?: unknown;
};

/** POST /kinds 成功体（调用点只读 revision；失败体走 ErrorDetail）。 */
export type PostKindResult = {
  revision?: unknown;
  error?: ErrorDetail;
};

/** PUT /config 成功体（调用点只读 user/revision；失败体走 ErrorDetail）。 */
export type PutResult = {
  user?: unknown;
  revision?: unknown;
  error?: ErrorDetail;
};

/** POST /test 成功体（调用点只读 sseConnections；失败体走 ErrorDetail）。 */
export type SendTestResult = {
  sseConnections?: unknown;
  error?: ErrorDetail;
};

/** DELETE /history 成功体（调用点只读 removed 计数）。 */
export type ClearHistoryResult = {
  removed?: unknown;
};
