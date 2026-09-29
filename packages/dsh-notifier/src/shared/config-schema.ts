/**
 * dsh-notifier —— 配置 schema（纯数据，零 import 叶子）。
 *
 * 为什么两端共用一份：这些是「设置长什么样」的事实源，客户端渲染选项、宿主端校验提交都读它。
 * 两处各写一份时的漂移症状分两种：页面选得到而宿主拒收（枚举漂移），以及凭据字段在读面被掩码
 * 而在写面不被还原（密钥字段漂移）——后者更糟，它让用户存下的配置静默丢失。
 *
 * 本目录零 import 约束见 interface.ts 文件头：值引 node:* 会让客户端构建硬失败，值引 bare 第三方
 * 包会静默内联进浏览器产物。故本文件不引模型类型（NotifyConfig / BarkLevel 那些），枚举按字面量
 * 就地声明——**字面量本身就是这里的事实源**，不靠类型回引来保持同源。
 */

/**
 * 频道类型并集（配置模型里 `channels` 数组元素的判别键取值）。
 *
 * 就地声明而非从 model/type.ts 引：那个类型是服务端面，跨目录引用会把服务端代码拖进客户端
 * 产物（见 interface.ts 文件头的零 import 约束）。两侧靠 test/unit/config/input.test.ts 的
 * 双向断言钉住——新增一种频道类型而忘了改这里，测试打红。
 */
export type ChannelType = "bark" | "webhook" | "browser" | "system";
/**
 * bark 紧急度白名单。顺序即设置页下拉的呈现顺序。
 *
 * `as const` 是必需的：写面靠 `isMember(value, BARK_LEVELS)` 的类型谓词把值**收窄**回
 * `BarkLevel` 再落进 `levels` 映射；声明成 `readonly string[]` 会让收窄退化成 `string`，
 * 那一步就编不过了（`BarkLevel` 由 model/type.ts 从本表派生，两者是同一份字面量）。
 */
export const BARK_LEVELS = ["active", "timeSensitive", "passive", "critical"] as const;

/**
 * 频道实例的已知键（bark）。校验与归一化**共用这一份**——未知键的判定正是拿它做减法，
 * 两处各写一份清单，「什么算未知」就会在两个工序里给出两种答案。
 */
export const BARK_KNOWN_KEYS: readonly string[] = [
  "id",
  "type",
  "enabled",
  "name",
  "baseUrl",
  "deviceKey",
  "level",
  "levels",
  "group",
  "sound",
  "icon",
  "url",
  "badge",
  "timeoutMs",
];

/** 频道实例的已知键（webhook）。 */
export const WEBHOOK_KNOWN_KEYS: readonly string[] = [
  "id",
  "type",
  "enabled",
  "name",
  "url",
  "preset",
  "auth",
  "token",
  "username",
  "password",
  "headerName",
  "headerValue",
  "template",
  "headers",
  "timeoutSec",
];

/**
 * 投递必需的键（按频道类型分组），**只收「必须是非空串」的那几个**。缺项即 400 拒收——不是
 * 默认值兜底：凭据与地址兜不出可投递的实例，静默补一个空串会让用户以为配好了。
 *
 * 另两个必填键**刻意不在本表**，它们的判据不是「在场」而是另一种，混进来会把话术改掉：
 *   - `id` 是实例身份，对所有实例频道统一判一次（validateChannel），话术也不带类型前缀；
 *   - `auth` 是**取值域**检查（必须落在 WEBHOOK_AUTHS 里），缺席与非法同一句话——它登记在同文件的
 *     `VALUE_DOMAIN_REQUIRED_KEYS`，两张表判据不同，合成一张就得给每项带上「判据是哪一种」。
 *
 * 内置频道（browser/system）恒在场、身份由 type 唯一确定，没有投递必需键，故不出现在本表。
 * `level` / `preset` 是可选键：缺省各有明确语义（前者让「severity → level」映射生效，后者归一到
 * custom），客户端新建频道时本就不带它们——照必填拦下等于让用户的合法提交保存不了。
 */
export const REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  bark: ["baseUrl", "deviceKey"],
  webhook: ["url"],
};

/**
 * 0.2.8 形态清理读的是**本表**而不是另抄一份必填键清单：清理步过去没有「哪些键是必填」的概念，
 * 于是它的值形态判据对必填键与对普通键一视同仁地「删键」——把 baseUrl 写成数字时它把这个键删掉，
 * **当场造出一条自己刚说过要整条保留的残缺条目**（判据 #6 与它相隔不到十行、方向相反）。
 * 两处各写一份「什么算必填」迟早漂，而漂的那次症状是清理步一边制造残缺、一边判它合法。
 *
 * 读法是**删整条而不是删键**：必填键的值形态不符时整条都不可投递，删键等于把一条本来带着 id、
 * name、enabled 的条目改造成残缺；而值形态**合法**的必填键（空串）仍然原样保留——两者的边界写在
 * canonical-keys.ts 的判据 #5 注释里。
 */

/**
 * **取值域类**的投递必需键（按频道类型分组）：键在场即必填，判据不是「键在不在」而是「值在不在
 * 白名单里」——`auth` 落在 WEBHOOK_AUTHS 之外与缺席是同一句话（写面 validateWebhookChannel 就是
 * 这么拒的，缺席与非法共用一句「auth 非法」）。
 *
 * **与 `REQUIRED_KEYS` 分成两张表而不是合成一张**：本表各项的「不合法」不是「少了一项」而是「这项
 * 的值不对」，而 `REQUIRED_KEYS` 的每个消费方（写面的「缺 X」话术、合并的「必填键不能删除」、
 * 清理步判据 #5 的第二格）都是按「缺席即错」在用它。合成一张就得给每项补一个「判据是哪一种」，
 * 那些话术与处置随之改口——「`auth` 的判据是取值域」这条约定（S1 定下的共享 schema 语义）就消失
 * 在一个布尔标记里，而它正是本表存在的理由。
 *
 * **消费方只有 0.2.8 形态清理步**（server/upgrade 的 canonical-keys.ts，判据 #5 第二格多出来的那一格）：
 * 值在白名单外时它**删整条**而不是删键。删键的后果不是「少一个可选字段」——写面对 `auth` 的缺席与
 * 非法同一句话拒收，于是删键当场造出一条**此后每一次保存都 400** 的频道，而那正是本步自己造出来的
 * 残缺，与判据 #6「用户手改出来的残缺原样保留」自相矛盾。
 *
 * 边界仍按「键在不在 + 空串」（判据 #6）：键缺席、或值为空串，都是**用户手改**出来的「没填」，
 * 原样保留；非空且不在白名单里才是「本步不能留下的残缺」。这一格与在场必填键的那一格同形，区别只在
 * 判据用的谓词：`WEBHOOK_AUTHS` 的成员判定取代 `typeof === "string"`。
 */
export const VALUE_DOMAIN_REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  webhook: ["auth"],
};

/**
 * `historyMaxAgeDays` 的上界：写面 `COUNT_LIMITS` 与 0.2.8 形态清理读**这一个数**。
 *
 * 清理步过去在本域另抄了一份 3650，并在注释里声明那是「刻意不落在 shared」。那份「刻意」的理由
 * （本轮不扩两端共享 schema）已经反过来成为病根本身：抄一份就意味着 config 域改了上界而清理步
 * 没跟上，而清理步的后果是**删掉用户的键**——第二事实源里最贵的一种。同一族里的另一个同款
 * （`WEBHOOK_TIMEOUT`）早已收在这里，两处都从它读。
 */
export const HISTORY_MAX_AGE_DAYS_LIMIT = 3_650;

/**
 * bark `timeoutMs` 的上界（毫秒）：读面归一化与 0.2.8 形态清理读**这一个数**。
 *
 * 与 `HISTORY_MAX_AGE_DAYS_LIMIT` 同因同解：读面的 `asCount(raw.timeoutMs, 0, 600_000)` 与清理步
 * 的越界判据必须同值，否则「读面认得的形态」与「清理步认得的形态」给出两个答案，而清理步会照
 * 自己那份把用户的键删掉。
 */
export const BARK_TIMEOUT_MS_LIMIT = 600_000;

/**
 * webhook `template` 的上界（字符）：写面尺寸判据读**这一个数**。
 *
 * 与上两条同因同解。这两个数过去写在 `config/impl/input/index.ts`，理由是「本轮不扩两端共享
 * schema」——而那份「刻意」正是 S1 要消灭的第二事实源本身：客户端将来给这个输入框加同源约束时
 * 只能去 `input/index.ts` 抄一份，两处迟早漂成两种说法，而症状是「页面不让填的值宿主端照收」
 * 或反过来。本表是「配置长什么样」的事实源，尺寸上界属于同一族。
 */
export const WEBHOOK_TEMPLATE_MAX_CHARS = 8192;

/**
 * bark `levels` 映射的项数上界：写面尺寸判据读**这一个数**。与 `WEBHOOK_TEMPLATE_MAX_CHARS` 同因。
 */
export const BARK_LEVELS_LIMIT = 64;

/**
 * 投递超时边界与缺省（秒）。**投递出口的 clamp**（channels/impl/webhook 的 clampTimeoutSec）与
 * **0.2.8 形态清理的边界判据**（upgrade canonical-keys 的 webhookTimeout）读这一个数。
 *
 * **写面/投递投影不读它**：那条链按 `asCount(raw.timeoutSec, 0, 600)` 收口（见 config/impl/input），
 * 范围比本表宽得多——它判的是「这个值在本版本有没有这种形态」，不是「投递时用几秒」。两边口径不同
 * 是刻意的：出口的 clamp 是**兜跨边界值**的那一道，不声称与配置层同口径（见 webhook/index.ts 的注释）。
 */
export const WEBHOOK_TIMEOUT: { min: number; max: number; default: number } = {
  min: 1,
  max: 60,
  default: 10,
};

/**
 * 各频道类型的密钥字段清单。掩码往返（读出掩码 / 写回按 id 还原）的唯一扩展点——两处各写一份
 * 清单一定会漂移，症状是凭据明文出到界面与日志，或被掩码覆盖成字面量。
 *
 * 键的类型取自 `ChannelType`（本目录就地声明的频道类型并集）而不是 `Record<string, …>`：
 * 写成后者就丢了穷尽性——新增一种频道类型而忘了在本表加一行，编译期一声不吭，读面就会
 * 把它当「无凭据频道」原样送出明文。
 */
export const CHANNEL_SECRET_FIELDS: Readonly<Record<ChannelType, readonly string[]>> = {
  bark: ["deviceKey"],
  webhook: ["token", "password", "headerValue"],
  // 内置频道没有任何凭据字段；它们在表里必须出现（Record 强制穷尽），值就是空清单。
  browser: [],
  system: [],
};

/**
 * 默认设置的**顶层部分**：缺键的兜底值，也是设置页展示的初始形态。
 *
 * `channels` 的两条内置条目**不在这里**：它们只在服务端物化（读面保证恒在场），
 * 客户端既拿不到也不需要。顶层默认值与内置频道由 model/index.ts 组装成 DEFAULT_CONFIG。
 *
 * 调用方只读不写：组装出的 DEFAULT_CONFIG 的嵌套值与本表同引用，谁就地改写谁就污染了
 * 另一个——「默认值被改过之后，此后每个读者拿到的都不是默认」。
 */
export const DEFAULTS: {
  readonly notifyAsk: boolean;
  readonly notifyQuestion: boolean;
  readonly notifyTaskDone: boolean;
  readonly notifySubagentDone: boolean;
  readonly notifyTaskError: boolean;
  readonly notifyTurnEnd: boolean;
  // 嵌套容器刻意不冻结：model/index.ts 组装 DEFAULT_CONFIG 时要把它们**重新物化**一份
  // （直接铺开 = 与本表同引用，谁就地改写谁就污染了另一个，且本表还随客户端内联）。
  readonly quietHours: { enabled: boolean; windows: { start: string; end: string }[] };
  readonly kindRoutes: Record<string, string[]>;
  readonly allowKinds: string[];
  readonly historyMaxAgeDays: number;
} = {
  notifyAsk: true,
  notifyQuestion: true,
  notifyTaskDone: true,
  notifySubagentDone: false,
  notifyTaskError: true,
  notifyTurnEnd: false,

  quietHours: { enabled: false, windows: [{ start: "22:00", end: "08:00" }] },
  kindRoutes: {},
  allowKinds: [],

  historyMaxAgeDays: 0,
};
