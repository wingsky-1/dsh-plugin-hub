/**
 * dsh-notifier config 域 —— 写面的**按字段合并**（#1016 重构第 3 步）。
 *
 * 为什么不再整组替换：`channels` 过去是「提交的那份整个盖上去」，于是**客户端没在 patch 里带的
 * 字段，落盘后就没了**。它与「键缺席 = 不动」的语义正面冲突，也是 #1016 三条既有缺陷的共同根因。
 * 本模块把一个频道条目拆回**逐字段**的决策，每态都只回答一件事：这次提交对这个字段做了什么。
 *
 * 五态（键缺席之外的四态按判据顺序求值）：
 *   1. 键**缺席**（提交里没这个键）  -> 不动，沿用存量值（且该字段本次**不重新判合法性**）
 *   2. 值 == 掩码字面量 `"********"` -> **按该键是不是密钥字段分三段**（判据见 `fieldVerdict`）：
 *      本 type 密钥字段沿用存量值、无源 400；别的 type 的密钥字段名 400（跨 type 残留）；
 *      非密钥键是普通值，照写
 *   3. 值 == `null`                    -> 删键（显式删除：客户端把「清空」表达成这个手势）
 *   4. 值 == `""` 且该键非必填         -> 删键（与 null 同义，为旧客户端兜底）
 *   5. 其它值                          -> 写入
 *
 * 外加四条硬规则（都在**删键之前**判，因为「删掉一个必填键」要 400 而不是静默降级成一个空壳）：
 *   - 必填键传 `null` 或 `""` -> 400，话术指向「必填键，不能删除」；「必填键」含**取值域类**
 *     必填键（webhook 的 `auth`），两张表的合集见 `requiredKeysOf`——判据在输入闸门，处置在本模块；
 *   - 掩码落在密钥字段上而**无原值可还原**（状态 2 的前半）-> 400，话术是
 *     `NEW_CHANNEL_MASK_HINT`，与草稿测试（dry-run）同一句：两条链路对同一份草稿不许给出两个答案；
 *   - 掩码落在**别的 type 的密钥字段名**上（状态 2 的后半，跨 type 残留）-> 400，话术是
 *     `RESIDUAL_MASK_HINT`，同样与 dry-run 同一句；
 *   - 删键之后由调用方**重新校验合并结果**：必填键此刻为空 -> 400（validateChannel 的既有判据）。
 *
 * 本模块**不判值域**（枚举白名单、尺寸上限、陌生键）——那些是输入闸门的事，调用方拿合并结果去
 * 问它。合并只回答「这次写把什么变成了什么」。
 */
import {
  CHANNEL_SECRET_FIELDS,
  REQUIRED_KEYS,
  VALUE_DOMAIN_REQUIRED_KEYS,
} from "../../../../shared/interface.ts";
import { isDeliveredRequired, sameValue } from "../input/index.ts";
import type { RawSettingValue, SettingInvalid } from "../model/type.ts";

/** 掩码占位字面量：与 redact 域、设置页同一份跨端契约。
 *
 * 独立写出而不从 redact 域导入，与 service.test.ts 的同一纪律一致：它是**跨端契约**（客户端也
 * 按这个字面量原样带回），把它变成一条 import 会让「两端口径一致」这件事从「两边各写一份、互相
 * 校对」退化成「谁忘了同步就静默漂」。 */
const SECRET_MASK = "********";

/** 身份键：删掉它们条目就不再是同一条频道，与投递必需键同等对待。 */
const IDENTITY_KEYS: readonly string[] = ["id", "type"];

/**
 * 掩码无原值可还原时的拒绝理由（掩码只表达「未修改」，没有原值可还原时它什么也不是）。
 *
 * **写面与草稿测试（dry-run）共用这一句**：id 改名带掩码、无源新频道带掩码是同一种失败，两条链路
 * 各写一句迟早漂成两种说法——而「同一份草稿在保存与试发两条路上得到两个答案」正是「掩码搬进
 * merge」要消灭的那个缺陷。
 *
 * 事实源放在**写面**这一侧而不是 redact 域：dry-run 已经从这里 import（见 draft/index.ts），
 * 两句 hints 因此只有一份字面量，跨链路漂移在编译期就不可能发生。 */
export const NEW_CHANNEL_MASK_HINT = "新增频道不能提交掩码占位，请填写真实凭据";

/**
 * 掩码落在**别的 type 的密钥字段名**上时的拒绝理由（跨 type 残留：bark→webhook 后剩一个
 * `deviceKey: "********"`）。
 *
 * 与 `NEW_CHANNEL_MASK_HINT` 是**两句话、两种情形**，不许合并：前者是「本 type 的密钥位上没有原值
 * 可还原」（新频道 / id 改名），后者是「这个键根本不属于本 type，它属于另一种频道」（换型残留）。
 * 合并成一句的后果是把「你该填一个凭据」说成「你贴了一个对不上任何已存值的占位符」——用户在
 * 新建频道时看到后一句会以为是自己复制错了。
 *
 * **写面与草稿测试（dry-run）共用这一句**，判据口径也共用：两侧都扫**全部已知类型**的密钥字段名
 * （`hasResidualMask` 的扫描面），只扫本 type 的话残留恰恰扫不到——残留的定义就是「字段不属于
 * 当前 type」。
 */
export const RESIDUAL_MASK_HINT =
  "草稿里有未还原的掩码占位（跨类型残留或改名残留），请重新填写真实凭据";

/** 合并结论。 */
export type ChannelMerge =
  | {
      readonly ok: true;
      /** 合并后的频道数组（落盘用；非数组输入原样穿过，形状判据归输入闸门）。 */
      readonly channels: RawSettingValue;
      /**
       * 与 `channels` **同下标**：该条目里哪些字段的值**原样来自存量**。
       *
       * 这份清单是「写面拒新增、不动存量」的执行依据：只有不在清单里的字段才重新接受合法性
       * 判据。少了它，磁盘上一份**越界**的旧值会让此后每一次无关保存都被拒（用户改个名字存不
       * 下），而那不是用户造成的。
       */
      readonly inherited: readonly ReadonlySet<string>[];
      /**
       * 与 `channels` **同下标**：该条目里哪些**必填键是存量本就残缺、这次既没补上也没删掉**的。
       *
       * 它是「半坏条目不许锁死设置页」这条的执行依据（#1016 S3 的一处真实回归）：读面自 S3 起不再丢弃
       * 半坏条目（视图逐字外发，用户看得见它、也改得动它），而「必填键在场」曾是**绝对**判据，于是
       * 用户在升级之后手改出一条半坏条目，此后再改**别的**频道的名字也存不下去（每一次保存都 400）。
       * 0.2.8 的形态清理只在刻度推进时跑一次，救不了「升级后手改」这条路。
       *
       * 与 `inherited` 分开记而不并成一条：那条记的是「**值**原样来自存量」，而一个从未存在过的键
       * 没有值可沿用。合并成一条，两族判据都说不清自己为什么跳过。
       *
       * 刻意**只记必填键**：其余形状判据（缺 id、type 非法、内置在场）不归它管，故也不受它的放行。
       */
      readonly preexisting: readonly ReadonlySet<string>[];
    }
  | { readonly ok: false; readonly error: SettingInvalid };

/**
 * 掩码类拒收的**情形序号**：数字小的先说。
 *
 * 只有掩码判据需要排序，其余拒收（必填键显式删除）一律当场返回、不参与——它与掩码是互斥的两种
 * 手势，同一个键上不可能同时成立，排序它没有意义。序号镜像 dry-run 的两段次序（见 mergeChannels）。
 */
type MaskRejectRank = 0 | 1;

/** 单条合并结论（内部形态，与对外的 `ChannelMerge` 同构）。 */
type EntryMerge =
  | {
      readonly ok: true;
      readonly channel: RawSettingValue;
      readonly inherited: ReadonlySet<string>;
      readonly preexisting: ReadonlySet<string>;
    }
  | {
      readonly ok: false;
      readonly error: SettingInvalid;
      /** 掩码类拒收的情形序号；非掩码拒收（当场返回的那种）没有这个字段。 */
      readonly rank?: MaskRejectRank;
    };

const EMPTY: ReadonlySet<string> = new Set<string>();

/** 本 type 的密钥字段名（掩码在该键上才有「未修改」的语义）；不认识的类型给空清单。 */
function secretFieldsOfType(type: RawSettingValue): readonly string[] {
  if (type === "bark" || type === "webhook") return CHANNEL_SECRET_FIELDS[type];
  return NO_SECRET_FIELDS;
}

const NO_SECRET_FIELDS: readonly string[] = [];

/**
 * **全部**已知类型的密钥字段名（并集）：判「这个键上的掩码是不是跨 type 残留」的扫描面。
 *
 * 扫并集而不是本 type，与 redact 域 `hasResidualMask` 同一口径：残留的定义就是「字段不属于当前
 * type」，只扫本 type 永远扫不到它（bark 的 deviceKey 挂到 webhook 条目上时，本 type 的清单是空的）。
 * 事实源仍是 `CHANNEL_SECRET_FIELDS`（两端共享面）——本域不另抄一份清单，两份清单迟早漂。
 */
const ALL_SECRET_FIELDS: ReadonlySet<string> = new Set(Object.values(CHANNEL_SECRET_FIELDS).flat());

/**
 * 合并一个频道数组。
 *
 * @param incoming 提交上来的频道数组（掩码还原**之前**——掩码是本模块的五态之一，不在别处解）。
 * @param stored 存量频道数组（磁盘原样）。提交里没提到的键从它取值。
 */
export function mergeChannels(incoming: RawSettingValue, stored: RawSettingValue): ChannelMerge {
  // 非数组输入原样穿过，形状判据归输入闸门（`channels` 需要数组）；没有条目可逐条记账，两笔账都空。
  if (!Array.isArray(incoming)) {
    return { ok: true, channels: incoming, inherited: [], preexisting: [] };
  }
  const storedById = indexById(stored);
  const channels: RawSettingValue[] = [];
  const inherited: ReadonlySet<string>[] = [];
  const preexisting: ReadonlySet<string>[] = [];
  // 两种掩码拒收**不按条目顺序先到先得**，而是取更靠前的那一种（`NO_SOURCE` 先于 `RESIDUAL`）。
  // 判据是 dry-run 的执行次序：它先整批跑 unmask（本 type 密钥位无原值即整体失败），整批过了才扫
  // 残留。一份「换型后既缺自己的凭据、又剩着旧 type 的掩码」的提交里两条都成立，写面若按键序先到
  // 先得，两条链路就会对**同一份草稿**给出两个答案——那正是 F1/F2 要消灭的那个分叉。
  let masked: { readonly rank: MaskRejectRank; readonly error: SettingInvalid } | undefined;
  for (const item of incoming) {
    const read = mergeEntry(item, storedById);
    if (!read.ok) {
      if (read.rank === undefined) return { ok: false, error: read.error };
      if (masked === undefined || read.rank < masked.rank)
        masked = { rank: read.rank, error: read.error };
      continue;
    }
    channels.push(read.channel);
    inherited.push(read.inherited);
    preexisting.push(read.preexisting);
  }
  if (masked !== undefined) return { ok: false, error: masked.error };
  return { ok: true, channels, inherited, preexisting };
}

/**
 * 单条合并：五态 + 两条硬规则。
 *
 * 按 **id** 对齐存量，不按下标——数组顺序一变，按下标就会把 A 实例的凭据回填进 B。id 重复时取
 * 首条（与掩码还原的 `findById` 同一口径，两处不各取一条）。
 */
function mergeEntry(
  item: RawSettingValue,
  storedById: ReadonlyMap<string, Record<string, RawSettingValue>>,
): EntryMerge {
  // 形状不对的条目原样穿过：形状的判据在输入闸门（`频道项需要对象`），不在合并里再抄一份。
  if (!isRecord(item)) return { ok: true, channel: item, inherited: EMPTY, preexisting: EMPTY };
  const id = typeof item.id === "string" ? item.id : "";
  const base = sameKindBase(item, id, storedById);
  const merged: Record<string, RawSettingValue> = base === undefined ? {} : { ...base };
  const inherited = inheritedKeys(base, item);
  const required = requiredKeysOf(item.type);
  // 掩码类拒收不在第一个命中处返回，而是**扫完本条全部键后取情形序号最小的那一个**
  // （理由见 mergeChannels 的注释）。非掩码类拒收（必填键显式删除）仍当场返回：它与掩码是互斥手势，
  // 且 dry-run 根本不产生那句话，两者的先后没有跨链路契约。
  const state: EntryState = { merged, inherited, masked: undefined, rejected: undefined };
  for (const [key, value] of Object.entries(item)) {
    // 只有非掩码拒收会走到 false（掩码拒收记进 state.masked，扫完本条再一起返回）。
    if (!applyField(key, value, base, required, item.type, id, state)) {
      if (state.rejected === undefined) throw new Error("applyField 返回 false 却没记下拒收话术");
      return { ok: false, error: state.rejected };
    }
  }
  if (state.masked !== undefined) {
    return { ok: false, error: state.masked.error, rank: state.masked.rank };
  }
  return {
    ok: true,
    channel: merged,
    inherited,
    preexisting: preexistingGaps(base, merged, item.type),
  };
}

/** 一条正在合并的频道条目：合并结果本体 + 逐字段记账 + 待决的拒收。 */
type EntryState = {
  readonly merged: Record<string, RawSettingValue>;
  readonly inherited: Set<string>;
  /** 本条扫到目前为止**情形序号最小**的掩码拒收（undefined = 还没有）。 */
  masked: { readonly rank: MaskRejectRank; readonly error: SettingInvalid } | undefined;
  /** 非掩码拒收的话术（必填键显式删除）；只在 applyField 返回 false 的那一轮被写进，随即被读走。 */
  rejected: SettingInvalid | undefined;
};

/**
 * 逐字段把一个 verdict 落到 state 上。
 *
 * @returns `false` = 这一条**当场拒收**（仅非掩码拒收：必填键显式删除），调用方立刻返回；掩码拒收
 *   记进 `state.masked` 并返回 `true`，让本条其余键继续扫完——理由见 mergeEntry 的注释。
 */
function applyField(
  key: string,
  value: RawSettingValue,
  base: Record<string, RawSettingValue> | undefined,
  required: readonly string[],
  type: RawSettingValue,
  id: string,
  state: EntryState,
): boolean {
  const verdict = fieldVerdict(key, value, base, required, type, id);
  if (verdict.kind === "reject") {
    if (verdict.rank === undefined) {
      state.rejected = verdict.error;
      return false;
    }
    if (state.masked === undefined || verdict.rank < state.masked.rank) {
      state.masked = { rank: verdict.rank, error: verdict.error };
    }
    return true;
  }
  if (verdict.kind === "drop") {
    delete state.merged[key];
    return true;
  }
  if (verdict.kind === "keep") {
    state.inherited.add(key);
    return true;
  }
  state.merged[key] = value;
  // 原样带回（客户端把磁盘上的值原封不动交回来）不算本次改动，故不重新判它的合法性。
  if (base !== undefined && sameValue(value, base[key])) state.inherited.add(key);
  return true;
}

/**
 * 存量基底：按 id 对齐，且**只认同一种 type**。
 *
 * 按 id 不按下标——数组顺序一变，按下标就会把 A 实例的凭据回填进 B；id 重复时取首条（与掩码
 * 还原的 `findById` 同一口径，两处不各取一条）。
 *
 * **换型 = 换了一条**：字段集随 type 变，存量那批键对新类型是陌生键，按字段继承会把 bark 的
 * baseUrl 带进 webhook。与「整组替换」的旧行为同向——换型之后提交面就是全部。
 */
function sameKindBase(
  item: Record<string, RawSettingValue>,
  id: string,
  storedById: ReadonlyMap<string, Record<string, RawSettingValue>>,
): Record<string, RawSettingValue> | undefined {
  if (id === "") return undefined;
  const previous = storedById.get(id);
  if (previous === undefined || previous.type !== item.type) return undefined;
  return previous;
}

/** 提交里没提到的键：整条沿用存量，它们既不是本次改动，也不该被重新判一遍合法性。 */
function inheritedKeys(
  base: Record<string, RawSettingValue> | undefined,
  item: Record<string, RawSettingValue>,
): Set<string> {
  const inherited = new Set<string>();
  if (base === undefined) return inherited;
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(item, key)) inherited.add(key);
  }
  return inherited;
}

/** 单键的合并动作（`merged[key]` 之后该怎么变）。 */
type FieldVerdict =
  | { readonly kind: "keep" }
  | { readonly kind: "drop" }
  | { readonly kind: "write" }
  | {
      readonly kind: "reject";
      readonly error: SettingInvalid;
      /** 掩码类拒收的情形序号（见 `MaskRejectRank`）；非掩码拒收不带这个字段。 */
      readonly rank?: MaskRejectRank;
    };

const KEEP: FieldVerdict = { kind: "keep" };
const DROP: FieldVerdict = { kind: "drop" };
const WRITE: FieldVerdict = { kind: "write" };

/**
 * 五态里的前四态落到一个键上。**第五态（其它值 → 写入）是剩下的唯一出口**，故这里只返回「不写」。
 *
 * @param base 同 id 同 type 的存量条目（换型或新频道时为 undefined = 没有可沿用的原值）。
 */
function fieldVerdict(
  key: string,
  value: RawSettingValue,
  base: Record<string, RawSettingValue> | undefined,
  required: readonly string[],
  type: RawSettingValue,
  id: string,
): FieldVerdict {
  if (value === undefined) return KEEP;
  // 状态 2：掩码 = 用户没改它。**这一态只对密钥字段成立**——判据是「这个键上，掩码有没有
  // 『未修改』的语义」，而语义来自 `CHANNEL_SECRET_FIELDS`（掩码往返的唯一扩展点）：
  //   (a) 本 type 的密钥字段：必须有原值可沿用。存量同 id 同 type 的条目里没有这个键
  //       （新频道、id 改名）时 400 `NEW_CHANNEL_MASK_HINT`——放行就等于把 `********`
  //       当凭据写进磁盘，那条凭据从此报废，而用户以为自己填过；
  //   (b) **别的** type 的密钥字段名（跨 type 残留，如 bark→webhook 后剩的 deviceKey）：
  //       400 `RESIDUAL_MASK_HINT`。这一格绝不能放行成普通值——那正是掩码工作要消灭的
  //       「占位符落进磁盘」；也绝不能并进 (a) 的话术：那是另一种情形、另一种排查方向；
  //   (c) 非密钥键：`********` 只是一个**普通字符串**（用户把频道名写成八个星号是他的自由），
  //       走第五态正常写入。把它当哨兵的症状是「一条关于凭据的话出现在频道名字上」，或者
  //       更隐蔽的「界面显示新值、磁盘是旧值」——那次改名被静默吞掉。
  // 为什么不干脆只留 (a)+(b)：那正是把跨 type 残留当成普通值写进磁盘的写法，两条都不对。
  if (value === SECRET_MASK) {
    if (secretFieldsOfType(type).includes(key)) {
      if (base !== undefined && Object.hasOwn(base, key)) return KEEP;
      return { kind: "reject", rank: 0, error: { key: "channels", hint: NEW_CHANNEL_MASK_HINT } };
    }
    if (ALL_SECRET_FIELDS.has(key)) {
      return { kind: "reject", rank: 1, error: { key: "channels", hint: RESIDUAL_MASK_HINT } };
    }
    return WRITE;
  }
  // 状态 3 / 4：显式删除。必填键不在这里被删——那要 400，不是静默降级成一个打不通的空壳。
  // `required` 是两张必填键表的并集（含取值域类的 `auth`，见 requiredKeysOf）：删它造出的残缺条目
  // 会在输入闸门被拒，而那里的理由是「值非法」——与 `url` 同一条手势、另一句话，用户无从分辨。
  if (value === null || value === "") {
    if (required.includes(key)) return { kind: "reject", error: rejectDeletable(type, id, key) };
    return DROP;
  }
  return WRITE;
}

/**
 * 不可删除的键：身份键（`id` / `type`）+ 该类型的**两张**必填键表。
 *
 * 事实源是 shared 的两张表（src/shared/config-schema.ts，两端共享面）：在场必填键 `REQUIRED_KEYS`
 * 与取值域类必填键 `VALUE_DOMAIN_REQUIRED_KEYS`（webhook 的 `auth`）。身份键不在任何一张表里，
 * 因为它们的判据不是「在场」而是「条目还是不是同一条」——但**删掉它们的动作是同一类**，故合到
 * 一起判。
 *
 * **取值域类的必填键为什么也在这张清单里（#1016）**：本模块只回答「这次写把这个键变成了什么」，
 * 不回答「这个值合不合法」——所以 `auth` 的**取值判据**（必须落在 WEBHOOK_AUTHS 里）仍然只在输入
 * 闸门。但「能不能删」是另一个问题，而它的答案与 `url` 一样是「不能」：客户端把 `auth` 清空成
 * `null` / `""` 时，本模块过去按「非必填键显式删除」把键 DROP 掉，删键造出的那条频道随即被输入闸门以
 * 「auth 非法」400 拒收——写面对 `auth` 的缺席与非法共用一句话，于是**同一个手势的两种落点给出两
 * 句话，而用户看到的现象是「保存不进去」**：他清空一个必填键，得到的回执却在说值非法。与 `url` 被
 * 清空时撞「url 是必填键，不能删除」相比，`auth` 这一格是纯粹的话术错位（两条路都是 400，故不是
 * 放行了坏数据）。清空一个必填键之后仍然只有 400 一条路，故按必填键处理就是与 `url` 对称的那条路。
 *
 * **刻意不并进 `REQUIRED_KEYS`**：那张表的每个消费方（输入闸门的「缺 X」话术、`preexisting` 记账、
 * 清理步判据 #5）都是按「缺席即错」在用它，`auth` 混进去会让「它的判据是取值域」这条约定消失在一
 * 个布尔标记里。本模块要的只是「两张表的并集」，故读两张、不合并。
 *
 * **也不按 type 白名单硬编码**：按表查（无该项即空清单），新增一种频道类型时不必记得回来改这里——
 * 抄一份 type 清单的代价与抄一份必填键清单同一种，而这份清单的错处会当场造出「此后每次保存都 400」
 * 的频道。
 */
function requiredKeysOf(type: RawSettingValue): readonly string[] {
  if (typeof type !== "string") return IDENTITY_KEYS;
  return [
    ...IDENTITY_KEYS,
    ...(REQUIRED_KEYS[type] ?? NO_REQUIRED_KEYS),
    ...(VALUE_DOMAIN_REQUIRED_KEYS[type] ?? NO_REQUIRED_KEYS),
  ];
}

/** 表里没有该 type 时的空清单（与 `deliveredRequiredKeys` 的同名常量同一个意思，故同名）。 */
const NO_REQUIRED_KEYS: readonly string[] = [];

/** 删必填键的拒收话术：与输入闸门「缺少 X」分开——一个说的是「没交」，一个说的是「要删」。 */
function rejectDeletable(type: RawSettingValue, id: string, key: string): SettingInvalid {
  const label = typeof type === "string" && type !== "" ? type : "实例";
  const subject = id === "" ? "" : ` ${id}`;
  return { key: "channels", hint: `${label} 频道${subject} 的 ${key} 是必填键，不能删除` };
}

/**
 * 「存量本就残缺、这次既没补上也没删掉」的必填键（`ChannelMerge.preexisting` 的算法）。
 *
 * 判据是**两边都坏**：合并结果里这个键没交上来（空串 / 数字 / 缺席），且存量那一份**同样**没交上来。
 * 少任何一边都不记账——
 *   - 存量里是好的、这次坏了 → 是这次写做坏的，判据必须拒（否则「把合法配置写坏」会一路通行）；
 *   - 存量里没有这条（新建频道、换型、id 改名）→ 没有「本就残缺」可言，新建的缺键照常 400。
 *
 * 按键逐个判而不是按整条判：客户端在提交前会合法地扰动条目（剥空串的可选字段、按类型补比较默认值），
 * 于是「这条提交里的内容与磁盘逐字相同」是个**假**前提——拿它当放行条件，一批真实形态照样被锁死。
 * 键粒度的增量才与「用户到底动了什么」对齐。
 *
 * 显式的删除手势（`null`）不会走到这里：它在上面的 `fieldVerdict` 里就 400 拒掉了。「删掉一个必填
 * 键」的后果因此仍是一律被拒，只是拒在更早、更准的那一步，而不是混进这条放行里。
 */
function preexistingGaps(
  base: Record<string, RawSettingValue> | undefined,
  merged: Record<string, RawSettingValue>,
  type: RawSettingValue,
): ReadonlySet<string> {
  // 换型（base 为 undefined）= 换了一条，新类型的必填键在存量里没有对应物，不记账。
  if (base === undefined) return EMPTY;
  const gaps = new Set<string>();
  for (const key of deliveredRequiredKeys(type)) {
    if (isDeliveredRequired(merged[key])) continue;
    if (isDeliveredRequired(base[key])) continue;
    gaps.add(key);
  }
  return gaps;
}

/** 判「必填键在场」的那份清单（判据 firstMissing 用的同一份）。
 *
 *  与 `requiredKeysOf` 的**可删除**清单不是同一张，有两处不同，缺一不可：
 *   - 那张还含身份键（删 id / type 同样是 400）与取值域类必填键（删 `auth` 同样是 400）；
 *   - 这里只问「这个键在不在」——身份键在场与否由 `validateChannel` 判，与本账无关。
 *
 *  **取值域类必填键（`auth`）刻意不在这张账上**：`preexisting` 放行的前提是输入闸门**认这份清单**，
 *  而 `validateWebhookChannel` 对 `auth` 走的是取值域判据且**不查 preexisting**——把 `auth` 加进
 *  这张表只会让合并结论报出一个没有消费方的字段名，看起来放行了、实际上照样 400。加它要连判据层
 *  一起改（那是「存量本就残缺」的另一件事，不在本模块的处置范围内）。 */
function deliveredRequiredKeys(type: RawSettingValue): readonly string[] {
  if (type !== "bark" && type !== "webhook") return NO_REQUIRED;
  return REQUIRED_KEYS[type];
}

const NO_REQUIRED: readonly string[] = [];

/** 频道数组 → id → 首条该 id 的条目；不是对象或没有非空 id 字符串的项不进索引。 */
function indexById(list: RawSettingValue): Map<string, Record<string, RawSettingValue>> {
  const index = new Map<string, Record<string, RawSettingValue>>();
  if (!Array.isArray(list)) return index;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || id === "") continue;
    if (!index.has(id)) index.set(id, item);
  }
  return index;
}

function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
