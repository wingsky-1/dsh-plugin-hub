/**
 * dsh-notifier —— 频道的**比较规范形**（两端共享叶子，零 import）。
 *
 * 它回答一个问题：「客户端在同一条频道上看到的是不是同一份内容？」——加载基线与当前草稿两侧
 * 走同一份规范形，首屏才不会恒脏（#912）。
 *
 * **本模块现在只有客户端一处消费者**（diff.ts：基线 diff 与基线快照），两端的旧消费者都已退场：
 *   - 写面一度用它算「本次改动」基线，那条路随 #1016 S2 的 scope 面删除（改由合并域的 inherited
 *     按 id 认改动）；
 *   - 读面自 #1016 S3 拆成「投递投影 / 外发视图」之后也不再经过它——视图只做键子集 + 原样 + 掩码，
 *     归一化留在投递投影内部，两条通道都不调用本模块。
 * 仍住在共享面而不是搬进 `client/`：它是对「什么算同一份内容」这一问题的**口径文本**，服务端
 * merge 判「原样带回」用的是同一个问题的另一个答案（`sameValue`），两边要能对着读；且本目录的
 * 零 import 约束保证它进客户端产物时不会把宿主代码拖进去。真要下沉到客户端目录，那是与「注释跟上
 * 现状」无关的一次搬迁，不在这里做。
 *
 * 落点在共享面的硬约束：零 import、只被 `src/shared/interface.ts` 转出（见该文件头的构建约束）。
 */

/** 空串即「未配置」的可选 string 字段清单（bark 与 webhook 实例的**并集**）。
 *
 *  `url` / `baseUrl` / `deviceKey` 在这里是因为它们在另一种频道类型里可选（bark 的 url 是
 *  自定义端点覆写；webhook 才有 url / baseUrl / deviceKey 这些投递必需键）。清单一律跨类型取并集——
 *  按类型各留一份的代价是「哪种类型被加进来」与「哪种类型剥空串」两处要同步，而漏掉的那次症状是：
 *  客户端提交前不剥，**半坏条目**（磁盘上必填键是空串的那种）每次保存都撞 400「必填键，不能删除」，
 *  用户改个别的频道的名字都存不下去（#1016 P2-1；剥完是键缺席，落在写面 preexisting 的放行路径上）。
 *
 *  **剥除只吃读面补出来的空串，不吃用户显式清空**：UI 写回走 assignChannelFields，空值被写成 `null`
 *  （显式删除手势，null 原样穿过剥除），服务端照样 400 拒收必填键的显式删除——语义不变。
 *
 *  真正不在清单内的是 id/type/auth：为空时原样提交、由服务端写面校验拦（auth 的判据是取值域，
 *  缺席与非法同一句话）；非 string 值（number/boolean/levels 对象）不触碰。 */
export const CHANNEL_OPTIONAL_STRING_KEYS: readonly string[] = [
  "name",
  "baseUrl",
  "deviceKey",
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
 *  两个调用点，同一份：客户端提交前剥（diff.ts）、比较规范形的第一步（normalizeChannelForCompare）。
 * 第三个调用点（服务端写面算基线时对提交侧再剥一遍）随 #1016 S2 的 scope 面删除一并没了——写面
 * 改由合并域按 id 认改动，不再比对两侧。 */
export function stripChannelEmpties(ch: unknown): unknown {
  if (typeof ch !== "object" || ch === null || Array.isArray(ch)) return ch;
  const out = Object.assign({}, ch as Record<string, unknown>);
  for (const key of CHANNEL_OPTIONAL_STRING_KEYS) {
    if (typeof out[key] === "string" && (out[key] as string).length === 0) delete out[key];
  }
  return out;
}

/**
 * 频道实例的比较规范形：与服务端**投递投影**（normalizeConfig）同语义的收敛（纯读，返回浅拷贝）。
 *
 * 「同语义」的对象是投递投影而不是外发视图：视图自 #1016 S3 起逐字外发（不补默认值），而本模块补的
 * 正是投递投影会物化出来的那批缺省值——客户端要比较的是「界面上显示的」与「基线里的」，两者都得先
 * 收敛到投递投影的形态才可比。
 *
 * - 可选 string 空串剥除：复用 stripChannelEmpties 的清单，不扩大——id/type/auth 的空串仍原样保留，
 *   由服务端写面校验拦（auth 的判据是取值域）；baseUrl/deviceKey 的空串**在**清单内（#1016 P2-1），
 *   剥成键缺席正是为了让半坏条目落到写面 preexisting 的放行路径上；非 string 不动；
 * - 缺键按类型补服务端默认值（只补缺席，已有的值原样保留——值域对错是写面的事，比较不替它断案）：
 *   bark 补 levels 空对象与 timeoutMs 0，webhook 补 headers 空对象、timeoutSec 0、preset custom、
 *   auth none，内置（browser/system）与未知类型不补。这只是比较用的补齐，payload 里仍是草稿原值
 *   （auth 缺席的提交照常被服务端 400——比较对称化没有把校验洗掉）；
 * - 掩码与其它非空值一律保留：掩码相等即未改，携带新值即脏（提交后由服务端按 id 还原；还原失败
 *   即掩码无源，由写面 400，与 dry-run 同一情形同一句）。
 *
 * 为什么按类型补而不是全量补：全量补会把 webhook 的 headers 空对象塞进 bark（或反向），
 * 提交时该键就成了「不是已知键」被写面 400 拒收（validateKnownKeys）——比较对称不能污染提交形态。
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
 * （或反向），提交时该键就成了「不是已知键」被写面 400 拒收（validateKnownKeys）——比较对称不能
 * 污染提交形态。
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
 * 消费者是客户端的 diff——加载基线与当前草稿**两侧**都过这一条，否则用户什么都没改也会被判成本次
 * 改动（服务端已不再消费，见文件头）。返回新数组，输入不被改写。 */
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
