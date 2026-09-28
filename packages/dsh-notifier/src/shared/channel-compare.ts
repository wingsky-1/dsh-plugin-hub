/**
 * dsh-notifier —— 频道的**比较规范形**（两端共享叶子，零 import）。
 *
 * 它回答一个问题：「客户端与服务端在同一条频道上看到的是不是同一份内容？」
 * 之所以住在共享面而不是客户端，是因为**服务端也要用它算基线**：写面要分辨「用户本次改了
 * 这个字段」与「用户只是把界面上看到的原样带回来」，而界面上看到的那份是**归一化 + 比较规范形**
 * 之后的结果。基线若取磁盘原样，两侧形态就分叉了：客户端带回的每个默认值、空串剥除、钳制结果
 * 都会被读成「本次改动」——用户只改了个名字，机制却告诉他 8 个字段都动过。
 *
 * 落点在共享面的硬约束：零 import、只被 `src/shared/interface.ts` 转出（见该文件头的构建约束）。
 */

/** 空串即「未配置」的可选 string 字段清单（bark 与 webhook 实例的**并集**）。
 *  `url` 在这里是因为 bark 的 url 是可选的自定义端点覆写；对 webhook 而言 url 是必填，但那条路
 *  走不到剥除——UI 写回时 assignChannelFields 已把空串删键，接着服务端 validateWebhookChannel
 *  以「缺少 url」400 拦下（而不是静默写进一个打不通的地址）。
 *  真正不在清单内的是 id/type/baseUrl/deviceKey/auth：为空时原样提交、由服务端写面校验拦
 *  （必填不允许空，语义正确）；非 string 值（number/boolean/levels 对象）不触碰。 */
export const CHANNEL_OPTIONAL_STRING_KEYS: readonly string[] = [
  "name",
  "token",
  "username",
  "password",
  "headerName",
  "headerValue",
  "template",
  "sound",
  "group",
  "icon",
  "url",
];

/** 单个频道实例的空串可选字段剥除：浅拷贝后删除值为空串的可选字段。只处理 string 值，
 *  number/boolean/对象字段不触碰；非对象输入原样返回（防御数组/null）。
 *
 *  三个调用点，同一份：客户端提交前剥（diff.ts）、比较规范形的第一步（normalizeChannelForCompare）、
 *  服务端写面算基线时对**提交侧**再剥一遍（input/index.ts 的 writeScopeOf——凭据字段的空串是掩码
 *  还原之后才回到提交侧的，基线那一侧已经剥过了，两边各做一半才同形）。 */
export function stripChannelEmpties(ch: unknown): unknown {
  if (typeof ch !== "object" || ch === null || Array.isArray(ch)) return ch;
  const out = Object.assign({}, ch as Record<string, unknown>);
  for (const key of CHANNEL_OPTIONAL_STRING_KEYS) {
    if (typeof out[key] === "string" && (out[key] as string).length === 0) delete out[key];
  }
  return out;
}

/**
 * 频道实例的比较规范形：与服务端读面 normalize 同语义的收敛（纯读，返回浅拷贝）。
 *
 * - 可选 string 空串剥除：复用 stripChannelEmpties 的清单，不扩大——id/type/baseUrl 与
 *   deviceKey/auth 的空串仍原样保留，由服务端写面校验拦（必填不允许空）；非 string 不动；
 * - 缺键按类型补服务端默认值（只补缺席，已有的值原样保留——值域对错是写面的事，比较不替它断案）：
 *   bark 补 levels 空对象与 timeoutMs 0，webhook 补 headers 空对象、timeoutSec 0、preset custom、
 *   auth none，内置（browser/system）与未知类型不补。这只是比较用的补齐，payload 里仍是草稿原值
 *   （auth 缺席的提交照常被服务端 400——比较对称化没有把校验洗掉）；
 * - 掩码与其它非空值一律保留：掩码相等即未改，携带新值即脏（提交后由服务端按 id 还原）。
 *
 * 为什么按类型补而不是全量补：全量补会把 webhook 的 headers 空对象塞进 bark（或反向），
 * 提交时 validateExtras 以“只能是字符串或数字”400 拒收——比较对称不能污染提交形态。
 * 为什么是补齐而不是删空（例如删掉 levels 空对象或 timeout 0）：删空会把用户删掉最后一个
 * levels 映射洗成无变化（相对空基线恒等），那次删除就永远存不下去；补齐只统一缺席与
 * 默认值两种写法，真删除（非空变空）两侧仍不等。
 */
export function normalizeChannelForCompare(ch: unknown): unknown {
  const stripped = stripChannelEmpties(ch);
  if (typeof stripped !== "object" || stripped === null || Array.isArray(stripped)) return stripped;
  const out = stripped as Record<string, unknown>;
  const defaults = CHANNEL_COMPARE_DEFAULTS.find((entry) => entry.type === out.type)?.defaults;
  if (defaults === undefined) return out;
  for (const field of Object.keys(defaults)) {
    if (out[field] === undefined) out[field] = defaults[field];
  }
  return out;
}

/**
 * 按频道类型补的缺省默认值（只补缺席，已有的值原样保留）。
 *
 * 这张表是**二维**的：行 = 频道类型，列 = 该类型补哪几个字段、默认成什么。写成 if 链时
 * 「bark 少补一个 levels」与「webhook 多补一个 auth」要混在同一段里改，加字段时得回去数
 * 哪个分支。表序无关（每行字段互不重叠），命中即整行套用。
 *
 * 内置（browser/system）与未知类型**不补**：全量补会把 webhook 的 headers 空对象塞进 bark
 * （或反向），提交时 validateExtras 以「只能是字符串或数字」400 拒收——比较对称不能污染提交形态。
 */
const CHANNEL_COMPARE_DEFAULTS: readonly {
  readonly type: string;
  readonly defaults: Readonly<Record<string, unknown>>;
}[] = [
  { type: "bark", defaults: { levels: {}, timeoutMs: 0 } },
  { type: "webhook", defaults: { headers: {}, timeoutSec: 0, preset: "custom", auth: "none" } },
];

/** 频道数组的比较规范形：逐项过 normalizeChannelForCompare。
 *
 * 客户端的 diff 与服务端的写面基线**共用这一条**（这是本模块存在的全部理由）：两侧必须对
 * 「什么算同一份内容」给同一个答案，否则用户什么都没改也会被判成本次改动。返回新数组，
 * 输入不被改写。 */
export function canonicalChannelsForCompare(channels: readonly unknown[]): unknown[] {
  return channels.map(normalizeChannelForCompare);
}

/**
 * 设置整体的比较规范形：channels 逐项过 normalizeChannelForCompare，其余键原样（浅拷贝）。
 *
 * 只收敛 channels：UI 写回删键（assignChannelFields 与 chLevelsSet）与服务端读面兜底的形态
 * 分叉只发生在这里；quietHours 与 kindRoutes 等两侧恒同形，不需要第二份实现。
 */
export function canonicalSettingsForCompare(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const out = Object.assign({}, settings);
  if (Array.isArray(out.channels)) out.channels = canonicalChannelsForCompare(out.channels);
  return out;
}
