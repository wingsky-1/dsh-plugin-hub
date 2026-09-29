/**
 * upgrade 域 0.2.7 → 0.2.8：配置形态清理（#1016 S3）——把「本版本不可能是合法形态」的值从磁盘上删掉。
 *
 * 为什么这一步现在才存在：读面过去一边投递一边替磁盘兜底（缺键补默认、越界钳回合法域、半坏条目直接
 * 丢弃），于是「磁盘上这份配置能不能被解释」这件事没有任何一个地方说了算。#1016 S3 把读面拆成
 * 「投递投影 / 外发视图」两条通道后，视图**只做键子集原样 + 掩码**——兜底被搬到了本步：不可能是本
 * 版本合法形态的值在装配期就删掉，之后读面与写面看到的都是干净形态。
 *
 * **只清理「不可能合法」，不清理「合法但非默认」**：用户把 `levels` 配满 64 项、`template` 写 8000
 * 字符、凭据字段留空串——都是合法取值，本步一个字都不动（写面「拒新增、不动存量」的语义由 inherited
 * 面负责，见 service/impl/merge.ts）。判据因此全部是「条件 → 删/补」，**不猜值、不夹值**：越界值删键，
 * 而不是改成边界值——静默改写用户的输入比留下一个非法值更糟。
 *
 * **半坏条目（必填键空串或缺席）整条保留，不删**：#1016 S3 给它们修通了三条路——视图逐字外发（用户看得见、
 * 改得动、也删得掉）、写面按 preexisting 放行（此后每一次无关保存都不再被它锁死）、投递投影本来就整条丢弃
 * （`asBarkChannel` 对空串必填键返回 `ok: false`，它压根不会被发出去）。三条路都齐了之后，「删掉它」剩下的
 * 只有代价：连 `name` 带其它字段一起静默消失，而用户看到的现象是「升级后我那条频道不见了」。本步因此不判
 * 「这条还能不能打通」，只判「这个值在本版本有没有这种形态」。
 *
 * **必填键值形态不符则删整条**（唯一一处与上一条方向相反的处置）：上一条留的是**用户手改出来的**残缺，
 * 这一条处理的是**本步自己造出来的**残缺——`baseUrl` 写成数字时，删键就把一条本来只差一个字段的条目
 * 改造成半坏，与上一条自相矛盾。边界是「键在不在」：缺席或空串 → 留（本步不动它），形态不符 → 本步不能
 * 留下它制造的残缺，故删整条。见 `cleanEntryFields` 的注释。
 *
 * **取值域类的必填键（webhook 的 `auth`）走同一条处置**：它的判据是「值在不在 WEBHOOK_AUTHS 里」而不是
 * 「键在不在」，但**删整条的理由与上一格一字不差**——写面对 `auth` 的缺席与非法是同一句话（`auth` 非法），
 * 于是删键造出的那条「url 齐全、只是没有 auth」的条目，此后**每一次无关保存都被 400 拒收**，症状与
 * `baseUrl` 被删时一模一样，而它同样是本步自己造出来的。`auth` 刻意不并进 shared 的 `REQUIRED_KEYS`
 * （那张表的每个消费方都按「缺席即错」在用它，见 config-schema.ts 的注释），它登记在同一文件的
 * `VALUE_DOMAIN_REQUIRED_KEYS`，本步按那张表分派。边界仍按「键在不在 + 空串」：键缺席、值为空串都是
 * **用户手改**出来的「没填」，原样保留。
 *
 * **「什么算合法」只有一份**：必填键、取值域必填键、已知键、取值域、计数上界全部读 `src/shared/config-schema.ts`
 * （零 import 叶子，故本域读它不构成对 config 域运行时的反向依赖——装配次序约束只管 config 域的**服务**）。
 * 本域曾经自维护一份 `historyMaxAgeDays` 上界并注明「刻意不落在 shared」，那份「刻意」正是本步能造出
 * 残缺条目的根：一份落在「会删用户数据」的域里的「合法形态」定义，两边不同值就等于两个版本。
 *
 * **第三条路是本步唯一承重的一环，删它就换成另一种事故**：本步原先的判据是「缺必填键 → 删整条」，
 * 按那个设计走时读面那一句（`outboundChannels` 见 `ok: false` 即整条剔除）只是兜底——两边都堵着；
 * 改成选 (a) 不删之后，**投递侧就成了唯一的一道**。将来若有人把它读成冗余（必填键写面已经校验过、
 * 值域由 merge 判过、看着像重复劳动）顺手删掉，症状**不是**「半坏条目被真的投递出去」——
 * `admitDeliveryUrl` 会把空地址挡成一次硬失败——而是它从此留在投递池里（`resolvePool` 只按
 * `enabled` 收窄），此后每一条路由到它的通知都白记一次失败，在历史与统计里表现为一条永远修不好的
 * 记录。两侧要一起读：动本步「必填键空串或缺席不删整条」这一条判据，或动读面那一句，任一单独动都
 * 落进上面那句症状里。
 *
 * 直接读写配置文件而不走 config 域的写面，与前几步同因：链跑在各域装配之前，那时写面没有装配好的配置
 * 镜像，以它当基底合并会把整份配置写空（见 config-shape.ts 的注释）。
 *
 * 幂等：干净形态下每条判据都为假，`withCanonicalKeys` 返回 null，**一个字都不写**——每次启动重写
 * 文件会把用户手改的格式重新序列化，那是静默改写而不是清理。
 */
import {
  readTextFileSync,
  writeTextAtomicSync,
  CONFIG_FILE_NAME,
  notifierFile,
} from "../../../shared/interface.ts";
import {
  BARK_KNOWN_KEYS,
  BARK_LEVELS,
  BARK_TIMEOUT_MS_LIMIT,
  BUILTIN_CHANNEL_TYPES,
  CHANNEL_SECRET_FIELDS,
  DEFAULTS,
  HISTORY_MAX_AGE_DAYS_LIMIT,
  REQUIRED_KEYS,
  VALUE_DOMAIN_REQUIRED_KEYS,
  WEBHOOK_AUTHS,
  WEBHOOK_KNOWN_KEYS,
  WEBHOOK_PRESETS,
  WEBHOOK_TIMEOUT,
  isSoundId,
} from "../../../../shared/interface.ts";
import type { RawSettingValue } from "../../deps.ts";

/**
 * 顶层已知键：共享表的默认值键集 `DEFAULTS` **加 `channels`**。
 *
 * `channels` 要单列是因为共享表刻意不带它（它是服务端面，两条内置条目只在服务端物化）——但本域必须
 * 认识它，否则每次清理都会把用户的频道整段删掉。第二事实源的风险（共享表加了键而这里没跟上）由
 * test/unit/upgrade/steps.test.ts 的「顶层键集与共享表同源」一条钉住。
 */
const TOP_LEVEL_KEYS: readonly string[] = [...Object.keys(DEFAULTS), "channels"];

/**
 * 全部频道类型：派生自 `CHANNEL_SECRET_FIELDS` 的键集而不是另抄一份。
 *
 * 那张表的类型是 `Record<ChannelType, …>`，编译器保证它的键集就是频道类型并集——新增一种类型而忘了
 * 在别处登记，本步会在编译期就红。另抄一份清单则不会，于是「新增类型没登记」的症状是升级把这类频道
 * 整条删掉（用户配置静默消失），那是本步能造成的最贵的一次错误。
 */
const CHANNEL_TYPES: readonly string[] = Object.keys(CHANNEL_SECRET_FIELDS);

/**
 * 该频道类型的**投递必填键**：读 shared 的 `REQUIRED_KEYS`（本域不另抄一份，见文件头「单一事实源」）。
 *
 * 内置两条不在那张表里（它们恒在场、身份由 type 唯一确定，没有投递必需键），故回落到空清单——
 * 没有必填键就意味着本域的「必填键形态不符 → 删整条」判据对它们恒为假，与它们此前的行为逐字一致。
 */
function requiredKeysOf(type: string): readonly string[] {
  return REQUIRED_KEYS[type] ?? [];
}

/**
 * 该频道类型的**取值域类必填键**：判据是「值在不在白名单里」的投递必需键（webhook 的 `auth`）。
 *
 * 与 `requiredKeysOf` 同款取法、同一个落点（判据 #5 第二格），读的是 shared 的同一族表——本域不另抄
 * 一份，那正是本域的病根：抄一份就意味着 config 域登记了一个取值域必填键而本步没跟上，症状是本步把那个键
 * 当普通键删掉，当场造出一条此后每次保存都被写面拒收的条目。
 */
function valueDomainRequiredKeysOf(type: string): readonly string[] {
  return VALUE_DOMAIN_REQUIRED_KEYS[type] ?? [];
}

/**
 * 出站条目的**字段值形态**：键 → 本版本该字段只可能是哪一种形态。
 *
 * 「什么算已知键」不归本表管——那是共享表 `BARK_KNOWN_KEYS` / `WEBHOOK_KNOWN_KEYS` 的事实源，两处各
 * 写一份「键集」就会在加字段时漂。本表只回答第二问：已知字段的**值**该是什么形态。表内必须**覆盖**
 * 两张已知键表的全部键（由 steps.test.ts 的覆盖断言钉住），否则新增字段会静默地不过形态清理。
 */
type FieldKind =
  | "boolean"
  | "string"
  | "sound"
  | "number"
  | "stringMap"
  | "level"
  | "auth"
  | "preset"
  | "barkTimeout"
  | "webhookTimeout";

const OUTBOUND_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  id: "string",
  type: "string",
  enabled: "boolean",
  name: "string",
  // bark
  baseUrl: "string",
  deviceKey: "string",
  level: "level",
  levels: "stringMap",
  group: "string",
  sound: "string",
  icon: "string",
  url: "string",
  badge: "number",
  timeoutMs: "barkTimeout",
  // webhook
  preset: "preset",
  auth: "auth",
  token: "string",
  username: "string",
  password: "string",
  headerName: "string",
  headerValue: "string",
  template: "string",
  headers: "stringMap",
  timeoutSec: "webhookTimeout",
};

/** 内置条目的字段值形态：键 → 本版本该字段只可能是哪一种形态（`sound` 独占布尔或音色名两种）。 */
const BUILTIN_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  type: "string",
  id: "string",
  enabled: "boolean",
  popup: "boolean",
  sound: "sound",
  whenVisible: "boolean",
};

/**
 * 补齐用的内置条目：写的是**完整**形态而不是 `{type, id}`。
 *
 * 与 0.2.4 的 config-shape 那一步不同（那边只搬有值的存量键，缺的留给读面补）：S3 之后读面**不再物化**
 * 内置条目（视图原样外发），只写 `{type, id}` 会让设置页把两条内置渲染成全关。值取自默认表，由
 * steps.test.ts 的「补齐的条目与默认表逐字相等」钉住，防它与 config 域的默认表漂。
 */
const BUILTIN_DEFAULTS: Readonly<Record<string, Readonly<Record<string, RawSettingValue>>>> = {
  browser: {
    type: "browser",
    id: "browser",
    enabled: true,
    popup: true,
    sound: true,
    whenVisible: false,
  },
  system: { type: "system", id: "system", enabled: true, popup: true, sound: true },
};

/** 清理过程的可变状态：判据一律「条件 → 删/补」，改动只经 `touch` 记一次，最后据此决定写不写盘。 */
type Cleaning = { touched: boolean };

/** 清理：把磁盘配置推到「本版本可解释」的形态。 */
export function migrateCanonicalKeys(): void {
  const file = notifierFile(CONFIG_FILE_NAME);
  const read = readTextFileSync(file);
  if (!read.ok) return;
  const shaped = withCanonicalKeys(parseObject(read.text));
  // 没有活要干时一个字都不写：每次启动重写文件会把用户手改的格式重新序列化，那是静默改写而不是清理。
  if (shaped === null) return;
  const written = writeTextAtomicSync(file, JSON.stringify(shaped, null, 2) + "\n");
  if (!written.ok) throw new Error("dsh-notifier: 配置形态清理落盘失败 — " + written.reason);
}

/** 清理后的形态；`null` = 没有要删的也没有要补的（幂等出口，一个字不写）。 */
function withCanonicalKeys(
  stored: Record<string, RawSettingValue>,
): Record<string, RawSettingValue> | null {
  // 空配置 = 没有配置。凭空建一份文件会让设置页把默认值标成「用户改过」——与 0.2.4 割接同款纪律。
  if (Object.keys(stored).length === 0) return null;
  const next: Record<string, RawSettingValue> = { ...stored };
  const state: Cleaning = { touched: false };
  cleanTopLevel(next, state);
  cleanChannels(next, state);
  ensureBuiltins(next, state);
  return state.touched ? next : null;
}

/**
 * 顶层：不在已知键集内的键删除；类型与默认表不符的键删除；`historyMaxAgeDays` 越界删除。
 *
 * 值域一律比对**默认表**（`DEFAULTS`）而不是另抄一份类型表：模型加了键而这里忘了跟上，症状是那个键
 * 被当成陌生键删掉——那正是「另抄一份」最贵的失败方式，而从默认表派生时这个失败根本不会发生。
 */
function cleanTopLevel(stored: Record<string, RawSettingValue>, state: Cleaning): void {
  for (const key of Object.keys(stored)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      delete stored[key];
      state.touched = true;
      continue;
    }
    const value = stored[key];
    if (key === "channels") {
      if (!Array.isArray(value)) drop(stored, key, state);
      continue;
    }
    const expected = DEFAULTS[key as keyof typeof DEFAULTS];
    if (expected === undefined || typeof value !== typeof expected) {
      drop(stored, key, state);
      continue;
    }
    if (key === "historyMaxAgeDays" && !inCountRange(value, 0, HISTORY_MAX_AGE_DAYS_LIMIT)) {
      drop(stored, key, state);
    }
  }
}

/** `channels`：不是数组即删键（判据在 `cleanTopLevel`）；数组则逐条清理 + 删非法条目 + 去重。 */
function cleanChannels(stored: Record<string, RawSettingValue>, state: Cleaning): void {
  const list = stored.channels;
  if (!Array.isArray(list)) return;
  const kept: Record<string, RawSettingValue>[] = [];
  const seenIds = new Set<string>();
  let listChanged = false;
  for (const item of list) {
    const cleaned = cleanEntry(item, state);
    // null = 整条不可能合法（形状不对 / 类型不认识 / 身份不成立 / **必填键值形态不符**，取值域必填键同算）
    // 留一个空壳。必填键**空串或缺席不在**这一列（#1016 P1-2 选 (a)），理由见 cleanEntry 与文件头。
    // 两条的边界是「键在不在」：形态不符是本步自己造出来的残缺，缺席/空串是用户手改出来的。
    if (cleaned === null) {
      listChanged = true;
      continue;
    }
    // 重复 id 保留首条：与掩码还原的 `findById`、合并的 `indexById` 同一口径，三处不各取一条。
    if (seenIds.has(cleaned.identity)) {
      listChanged = true;
      continue;
    }
    seenIds.add(cleaned.identity);
    // `changed` 只在**真的删过键**时为真：逐条都逐字未动时不得换掉原数组，否则每次启动都会重写文件。
    if (cleaned.changed) listChanged = true;
    kept.push(cleaned.entry);
  }
  if (listChanged) {
    stored.channels = kept as RawSettingValue;
    state.touched = true;
  }
}

/** 单条频道的清理结果：`entry` = 清理后的条目（逐字未动时是新副本，内容相同）；`changed` = 删过键。 */
type CleanedEntry = {
  readonly entry: Record<string, RawSettingValue>;
  readonly changed: boolean;
  /**
   * 去重身份：出站条目取 `id`，内置条目取 `type`（它可以没有 `id` 键）。
   *
   * 与读面 `builtinRaw`（同类型的后来者被丢弃）、写面 `indexById`（只索引有非空 id 的条目）同口径——
   * 三处各取一条，早晚会在「两条同 id 的 bark」上给出三个不同的保留对象。
   */
  readonly identity: string;
};

/**
 * 单条频道：先按类型删陌生键，再逐字段判形态。`null` = 整条不可能合法（形状不对 / 类型不认识 / 身份不成立）。
 *
 * 凭据字段（`deviceKey` / `token` / `password` / `headerValue`）的**非字符串**值由同一张形态表删掉
 * ——它们在表里就是 `string`，不为凭据单开一条判据：两份清单迟早漂，而漂的那次症状是「凭据形态无人判」。
 *
 * **投递必需键空串或缺席不删整条**（#1016 P1-2 选 (a)）：投递投影本来就整条丢弃这种条目，视图与写面自 S3
 * 起也各有出路（见文件头）。留下它的代价是「设置页里有一条打不通的频道」——那是**看得见**的；删掉它的
 * 代价是「升级后我那条频道连名字一起没了」——那是**看不见**的。
 *
 * **投递必需键的值形态不符则删整条**（判据 #5 第二格，与上一条方向相反）：那是本步**自己**造出来的
 * 残缺，不能留也不能靠「删键」处理——理由与两者的边界见 `cleanEntryFields` 的注释。
 *
 * 判据在 test/unit/upgrade/steps.test.ts 的「判据 #6」：**该编号相对 S3 任务书原文是反转的**（原文是
 * 「缺必填键 → 删整条」），反转的理由与「号为何不重排」都写在那一条的注释里，改这一处前先读那段。
 */
function cleanEntry(item: RawSettingValue, state: Cleaning): CleanedEntry | null {
  if (!isRecord(item)) return null;
  const type = item.type;
  if (typeof type !== "string") return null;
  if (!CHANNEL_TYPES.some((known) => known === type)) return null;
  if (!hasIdentity(item, type)) return null;
  const entry: Record<string, RawSettingValue> = { ...item };
  const local = cleanEntryFields(entry, type);
  // null = 必填键值形态不符（判据 #5 第二格，在场必填与取值域必填都算）：整条删。**不记账**——删整条由
  // listChanged 一并记账，在这儿再记一次会让「删了几条」与「动了文件」两笔账对不上。
  if (local === null) return null;
  if (local.touched) state.touched = true;
  return { entry, changed: local.touched, identity: identityOf(entry, type) };
}

/**
 * 条目身份是否成立：内置的 id 恒等于 type（写面 `validateBuiltinChannel` 就是这么判的），出站的必须非空串。
 */
function hasIdentity(entry: Record<string, RawSettingValue>, type: string): boolean {
  if (isBuiltin(type)) return entry.id === undefined || entry.id === type;
  return typeof entry.id === "string" && entry.id !== "";
}

/** 去重身份：出站取 id，内置取 type（它可以没有 id 键）。 */
function identityOf(entry: Record<string, RawSettingValue>, type: string): string {
  return typeof entry.id === "string" && entry.id !== "" ? entry.id : type;
}

/**
 * 逐字段清理。`null` = 命中判据 #5 的第二格（**必填键值形态不符 → 整条不可留**），调用方据此删整条。
 *
 * 四格判据，逐格对应一个动作：
 *   1. 不在本类型已知键集内 → **删键**（陌生字段在本版本没有值语义，带 name 留着只会让人在设置页里
 *      看到一条自己从没配过的字段）。
 *   2. **在场必填键**（`REQUIRED_KEYS`）的值形态不符 → **删整条**（见下）。
 *   3. **取值域必填键**（`VALUE_DOMAIN_REQUIRED_KEYS`，webhook 的 `auth`）的值不在白名单里 → **删整条**：
 *      与第 2 格同形，判据不同而处置一样。
 *   4. 其余键的值形态不符 → **删键**（含凭据字段：它们在形态表里就是 `string`，不为凭据单开一条判据）。
 *
 * **为什么必填键必须升级成「删整条」而不是「删键」**（本步唯一一条「删键 → 删整条」的规则，第 2、3 格共用）：
 * 删掉一个必填键就是**当场制造一条残缺条目**——磁盘上原本只有这一个字段不对，清理之后整条都投递不了，
 * 而这恰恰是判据 #6 承诺「整条保留」的那一类。两条判据在同一个循环里给出相反的处置，症状是升级把一条
 * 本来还能改回来的频道弄成半坏，再由 S3 自己修通的三条路（视图可见 / 写面 preexisting 放行 / 投递投影
 * 丢弃）去兜——用户看到的却是「升级后我那条频道打不通了」，而罪魁是升级本身。
 *
 * **与判据 #6 的边界就在「键在不在」这一句**：
 *   - 值形态不符（`baseUrl` 是数字）→ 本步**造出来**的残缺，删整条；
 *   - 键缺席或空串（`baseUrl` 没了 / `""`）→ 用户手改出来的残缺，原样保留（判据 #6 不变）。
 * 空串走的是第 4 格：`typeof "" === "string"` 形态合法，删键逻辑压根不看它，条目逐字不动。
 *
 * **取值域必填键（`auth`）为什么也归到「删整条」那一格**：它不在 `REQUIRED_KEYS` 里是因为判据不同，
 * 不因为处置可以更轻。删掉 `auth` 键造出的条目与删掉 `baseUrl` 键造出的条目在写面是**同一种**东西——
 * `validateWebhookChannel` 对「`auth` 缺席」与「`auth` 非法」共用一句拒收（`auth` 非法），于是这条
 * 频道此后**每一次无关保存都被 400 拒收**，用户看到的现象与「本步造出残缺条目」一模一样。本步造出来的
 * 残缺不能留，与它是哪一类必填键无关。
 *
 * **空串这一侧与在场必填键同款**（判据 #6）：`auth` 键缺席或值为空串都是**用户手改**出来的「没填」，
 * 原样保留——`auth` 不在 `REQUIRED_KEYS` 里不改变判据 #6 对它的承诺。`null` 不在这一侧：在场必填键
 * 的 `deviceKey: null` 同样是「形态不符 → 删整条」，取值域类照此办理（`typeof null !== "string"`，
 * 它不是「没填」而是形态坏了）。
 */
function cleanEntryFields(entry: Record<string, RawSettingValue>, type: string): Cleaning | null {
  const local: Cleaning = { touched: false };
  const known = knownKeysOf(type);
  const kinds = isBuiltin(type) ? BUILTIN_FIELD_KINDS : OUTBOUND_FIELD_KINDS;
  const required = requiredKeysOf(type);
  const valueDomainRequired = valueDomainRequiredKeysOf(type);
  for (const key of Object.keys(entry)) {
    if (!known.includes(key)) {
      drop(entry, key, local);
      continue;
    }
    if (isFieldValueOfKind(entry[key], kinds[key])) continue;
    // 判据 #5 第二格：必填键的值形态不符 → 整条不可投递。不删键——删键等于本步自己造出一条残缺条目。
    if (required.includes(key)) return null;
    // 同一格的取值域那一半：webhook 的 `auth` 白名单外 → 同样删整条（写面对缺席与非法是同一句拒收）。
    // 空串整条跳过：不删键也不删条目——键在但没填是**用户手改**出来的残缺，判据 #6 那一侧本步一个字都不动。
    // 删掉这个键恰恰就是本步自己把它变成「此后每次保存都 400」的那条频道，与删掉 baseUrl 同一种事故。
    if (valueDomainRequired.includes(key)) {
      if (entry[key] === "") continue;
      return null;
    }
    drop(entry, key, local);
  }
  return local;
}

/**
 * 补齐内置两条：**整条缺席则补一条，在场则补缺席的字段**。
 *
 * 内置恒在场（写面 `requireBuiltinsPresent` 会 400 拒掉缺它们的提交），且恒排在最前。
 *
 * **补字段是 P1-1 的正解**：0.2.4 的割接在用户没设过任何 system 旧键时写出的就是 `{type, id}`
 * （见 config-shape.ts 的 `builtinEntry`：只搬有值的存量键，缺的留给读面补默认）。而 S3 之后
 * 读面**不再物化**默认值，客户端按 `ch.popup === true` 判开关——字段缺席即渲染成「全关」，
 * 投递投影却按默认表照发，于是**界面显示全关、实际照发**，用户看到与实际投递正好相反。补缺席字段让两侧
 * 重新一致；补的值取自内置默认表，与默认表的同源由 steps.test.ts 钉住。
 *
 * **只补缺席，不覆盖显式值**（含显式 `false`）：用户把某条内置显式关掉就是在表态，抹回默认
 * `true` 是静默改写用户的输入。判据一律「键在不在」不看值——判值就把上面那条纪律又破一次。
 */
function ensureBuiltins(stored: Record<string, RawSettingValue>, state: Cleaning): void {
  const list = Array.isArray(stored.channels) ? [...(stored.channels as RawSettingValue[])] : [];
  const local: Cleaning = { touched: false };
  const present = new Set<RawSettingValue>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    present.add(item.type);
    completeBuiltinFields(item, item.type, local);
  }
  const missing: RawSettingValue[] = [];
  for (const type of BUILTIN_CHANNEL_TYPES) {
    if (present.has(type)) continue;
    missing.push({ ...BUILTIN_DEFAULTS[type] });
    local.touched = true;
  }
  // 没有要补的也没有要加的：一个字都不动（否则每次启动都重写文件，见文件头的幂等纪律）。
  if (!local.touched) return;
  stored.channels = [...missing, ...list];
  state.touched = true;
}

/** 内置条目补缺席字段：值取内置默认表，键在场就不动（显式 `false` 与显式 `true` 一样是表态）。 */
function completeBuiltinFields(
  entry: Record<string, RawSettingValue>,
  type: RawSettingValue,
  local: Cleaning,
): void {
  const defaults = BUILTIN_DEFAULTS[type as string];
  if (defaults === undefined) return;
  for (const [key, value] of Object.entries(defaults)) {
    if (Object.hasOwn(entry, key)) continue;
    entry[key] = value;
    local.touched = true;
  }
}

/** 该频道类型的已知键：内置两条与出站实例的清单不同，混用会把 bark 的 baseUrl 带进 webhook。 */
function knownKeysOf(type: string): readonly string[] {
  if (type === "bark") return BARK_KNOWN_KEYS;
  if (type === "webhook") return WEBHOOK_KNOWN_KEYS;
  // 内置条目的已知键就是 `BUILTIN_FIELD_KINDS` 的键集（那张表只描述内置，不与出站重叠）。
  return Object.keys(BUILTIN_FIELD_KINDS);
}

/** 字段值是否落在本版本的形态里：类型不符、枚举越界、计数越界都算不可能合法。 */
function isFieldValueOfKind(value: RawSettingValue, kind: FieldKind | undefined): boolean {
  if (kind === undefined) return true;
  return FIELD_PREDICATES[kind](value);
}

/**
 * 形态判据表：kind → 判据。**表驱动而非 if 链**：if 链每加一种形态就多一个分支，而形态表恰是会长的
 * 那一面（新增字段就可能要新增 kind）——两者叠在一起，判据函数会随功能增长一起越过复杂度上限。
 */
const FIELD_PREDICATES: Readonly<Record<FieldKind, (value: RawSettingValue) => boolean>> = {
  boolean: (value) => typeof value === "boolean",
  string: (value) => typeof value === "string",
  sound: (value) => typeof value === "boolean" || isSoundId(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  stringMap: (value) => isRecord(value),
  level: (value) => isMember(value, BARK_LEVELS),
  auth: (value) => isMember(value, WEBHOOK_AUTHS),
  preset: (value) => isMember(value, WEBHOOK_PRESETS),
  barkTimeout: (value) => inCountRange(value, 0, BARK_TIMEOUT_MS_LIMIT),
  webhookTimeout: (value) => inCountRange(value, WEBHOOK_TIMEOUT.min, WEBHOOK_TIMEOUT.max),
};

/** 闭区间 `[min, max]` 内的整数（与 config 域 `requireCount` 同一口径：小数与越界都非法）。 */
function inCountRange(value: RawSettingValue, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** 删键并记账。 */
function drop(stored: Record<string, RawSettingValue>, key: string, state: Cleaning): void {
  delete stored[key];
  state.touched = true;
}

function isBuiltin(type: string): boolean {
  return type === "browser" || type === "system";
}

function isMember<T extends string>(raw: RawSettingValue, allowed: readonly T[]): raw is T {
  return typeof raw === "string" && allowed.some((item) => item === raw);
}

/** 文件内容 → 对象；坏 JSON 与非对象都当「没有配置」——一份读不动的文件不该让启动失败。 */
function parseObject(text: string): Record<string, RawSettingValue> {
  try {
    const parsed: RawSettingValue = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
