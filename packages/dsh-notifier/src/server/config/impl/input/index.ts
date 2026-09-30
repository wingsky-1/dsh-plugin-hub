/**
 * config 域：外部输入 → 合法设置。三个来源（磁盘配置文件、组合层 entry、HTTP patch）都**不受信**，这里是它们进入
 * 设置模型的唯一闸门。三道工序不可互换：归一化**永不失败**、校验**只审显式提交**（缺键不是错误）、净化**只留认识的键**。
 */
import {
  BARK_KNOWN_KEYS,
  BARK_LEVELS,
  BARK_LEVELS_LIMIT,
  BARK_TIMEOUT_MS_LIMIT,
  BUILTIN_CHANNEL_TYPES,
  HISTORY_MAX_AGE_DAYS_LIMIT,
  REQUIRED_KEYS,
  WEBHOOK_AUTHS,
  WEBHOOK_KNOWN_KEYS,
  WEBHOOK_PRESETS,
  WEBHOOK_TEMPLATE_MAX_CHARS,
  isClockText,
  isSoundId,
} from "../../../../shared/interface.ts";
import { DEFAULT_CONFIG } from "../model/index.ts";
import { QUIET_WINDOWS_LIMIT } from "../model/type.ts";
import type {
  BarkChannelConfig,
  BarkLevel,
  BrowserChannelConfig,
  BuiltinChannelType,
  ChannelConfig,
  NotifyConfig,
  QuietHoursConfig,
  QuietWindow,
  RawSettingValue,
  SettingsPatch,
  SoundSetting,
  StoredSettings,
  SystemChannelConfig,
  WebhookChannelConfig,
} from "../model/type.ts";
import type { ValidationResult } from "./type.ts";

// ---------------------------------------------------------------- 合法域

// 内置音色白名单的事实源在 src/shared/sounds.ts（两端共享面），本域只消费：
// 写入口径与设置页的选项必须是同一份白名单，各写一份就会出现「页面选得到、宿主拒收」。
// 「白名单 ⊆ 音色表」这条不变量由 test/unit/shared/sounds.test.ts 守着。

// 内置频道类型的事实源在 src/shared/channels.ts（顺序即卡片顺序）：它们恒在场，是 `channels` 里
// 唯一不可删除的项——身份由 `type` 唯一确定。

/** bark 紧急度白名单、频道已知键、必填键、**尺寸上界**（`WEBHOOK_TEMPLATE_MAX_CHARS` /
 * `BARK_LEVELS_LIMIT`）的事实源都在 src/shared/config-schema.ts（两端共享面）：
 * 写入口径与设置页的选项必须是同一份，各写一份就会出现「页面选得到、宿主拒收」。本域只消费。
 *
 * 尺寸上界（#1016 S2）此前在本域就地写字面量，理由是「本轮不扩两端共享 schema」——那份「刻意」
 * 正是 S1 要消灭的第二事实源：客户端将来给这两个输入框加同源约束时只能来本域抄一份。
 * 两条尺寸判据的语义是**「拒新增、不动存量」**：本次提交的值超限即 400，沿用存量的旧值不重判
 * （判据的 `inherited` 面，见 validateChannel）；0.2.9 形态清理按同一口径不删它们。 */

// webhook 认证方式与预设白名单的事实源在 src/shared/webhooks.ts（两端共享面）：设置页的选项与
// 写入口径必须是同一份，各写一份就会出现「页面选得到、宿主拒收」。

/** `"HH:MM"` 二十四小时制：事实源在 src/shared/quiet.ts（`isClockText`），两端同源。 */

/**
 * 频道实例里**合法的凭据只能走已知字段**（bark 的 `deviceKey`、webhook 的 `token`/`password`/`headerValue`），
 * 这些凭据别名键在写入口径直接**拒绝**而不是静默剔除——静默剔除会让用户以为设置生效了。
 *
 * 导出是为了让判据按清单表驱动：README 的「保留键写拒」与这份清单必须是同一份事实源。
 */
export const BARK_RESERVED_KEYS: readonly string[] = ["device_key", "device_keys", "ciphertext"];

/** webhook 侧的凭据别名键；与 `BARK_RESERVED_KEYS` 同语义（见上）。 */
export const WEBHOOK_RESERVED_KEYS: readonly string[] = [
  "auth_token",
  "access_token",
  "bearer_token",
  "api_key",
  "apikey",
  "client_secret",
  "secret",
  "password_hash",
];

/**
 * 契约认识的键。从默认设置派生而不是另抄一份清单：模型新增键时白名单自动跟上，否则
 * 就是「加了键却忘了加白名单，该键永远写不进去」这种沉默故障。
 */
const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG);

/**
 * 只接受布尔值的键。
 *
 * 导出而非私有：门禁 `config-matrix` 要按真实取值断言「这份清单是默认设置的子集且值都是布尔」，
 * 让它读定义处才是唯一事实源——照抄一份给门禁，两边迟早各说各话。
 */
export const BOOLEAN_KEYS: readonly string[] = [
  "notifyAsk",
  "notifyQuestion",
  "notifyTaskDone",
  "notifySubagentDone",
  "notifyTaskError",
  "notifyTurnEnd",
];

/** 0.2.3 顶层渠道键的退役话术：0.2.4 起它们由 upgrade 域在装配期搬进 `channels` 的内置条目并删除。 */
const MOVED_INTO_CHANNELS_HINT =
  "该键在 0.2.4 升级时已移入渠道条目；页面停留在升级前时，刷新后重试";

/** `maxConnections` 的退役话术：0.2.5 移除了连接上限机制，本键没有后继键——说成「已移入渠道条目」会把用户引到另一种原因上。 */
const CONNECTION_CAP_REMOVED_HINT =
  "该键在 0.2.5 升级时已随 SSE 连接上限机制一并移除；页面停留在升级前时，刷新后重试";

/**
 * 退役键：**曾经**是合法配置键、现已没有值语义的键，写面一律 400 拒收，且每键自带拒收话术。
 *
 * 为什么拒而不是当陌生键放行：陌生键是留给未来版本的空间，而这一批是**已经搬走 / 已经删除**的键——
 * 静默放行会让停留在升级前页面上的旧客户端以为保存成功了。话术逐键给出而不是共用一句：0.2.3 那批只是
 * 搬了家，`maxConnections` 是机制整体移除，共用一句会把后者引到错误的原因上。
 */
export const RETIRED_KEYS: Readonly<Record<string, string>> = {
  systemEnabled: MOVED_INTO_CHANNELS_HINT,
  browserEnabled: MOVED_INTO_CHANNELS_HINT,
  systemNotify: MOVED_INTO_CHANNELS_HINT,
  browserNotify: MOVED_INTO_CHANNELS_HINT,
  notifyWhenVisible: MOVED_INTO_CHANNELS_HINT,
  notifySound: MOVED_INTO_CHANNELS_HINT,
  browserSound: MOVED_INTO_CHANNELS_HINT,
  systemSound: MOVED_INTO_CHANNELS_HINT,
  maxConnections: CONNECTION_CAP_REMOVED_HINT,
};

/**
 * 非负整数键及其上界（越界视为非法而不是截断——静默改写用户的输入比拒绝更糟）。
 *
 * 导出理由同 `BOOLEAN_KEYS`：门禁要按真实取值断言「每个键都在默认设置里且上界是非负整数」。
 *
 * 上界的**值**来自 shared 的 `HISTORY_MAX_AGE_DAYS_LIMIT`，不是就地写的字面量：0.2.9 形态清理按
 * 「这个值在本版本有没有这种形态」删键，两处不同值就是两份「合法形态」的定义，而清理步那份一旦落后，
 * 用户一个合法的键会被静默删掉。
 */
export const COUNT_LIMITS: Record<string, number> = {
  historyMaxAgeDays: HISTORY_MAX_AGE_DAYS_LIMIT,
};

/**
 * 原型链上的危险键名：JSON 文本能造出自有键，展开进设置对象就会改写原型。
 *
 * 事实源放在输入闸门（判据要认得它才能把它从「陌生键」里摘出来），写面从这儿取同一份——
 * 两处各写一份清单，改了一处就会变成「一个判红一个放行」。
 */
export const UNSAFE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

// ---------------------------------------------------------------- 解析

/**
 * 文本 → 原始设置。坏 JSON 与非对象（数组、标量）一律得到空设置：配置文件被手改成不合法
 * 内容时读面该回落默认值，而不是让整个插件装配失败——设置坏掉不该拖垮通知。
 */
export function parseJsonObject(text: string): StoredSettings {
  try {
    const parsed: RawSettingValue = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 归一化

/**
 * 归一化：把任意输入收敛成一份完整设置，缺键补默认、非法值回落合法域——**永不失败**，
 * 是读路径的必经工序。输出是**全量**的（可选字段也写出来，空串 / 空对象表达「没有」）：
 * 让形状随输入变化会迫使下游到处判键在不在，而这里正是唯一能把这件事做掉的地方。
 */
export function normalizeConfig(input: StoredSettings): NotifyConfig {
  const fallback = DEFAULT_CONFIG;
  // 渠道形态只有 `channels` 一处输出：内置两条先物化，取值链是「条目字段 → 默认表」——**没有中间那层
  // 旧顶层键**（#1016 S3 删除）：形态演进是 upgrade 域的职责，读面不认历史。存量里的 `browserEnabled` /
  // `notifySound` 那一批由 0.2.4 的配置形态割接在装配期搬进条目并删除，读面再兜一次等于同一件事有两处实现。
  const browser = asBrowserChannel(builtinRaw(input.channels, "browser"));
  const system = asSystemChannel(builtinRaw(input.channels, "system"));
  return {
    notifyAsk: asBoolean(input.notifyAsk, fallback.notifyAsk),
    notifyQuestion: asBoolean(input.notifyQuestion, fallback.notifyQuestion),
    notifyTaskDone: asBoolean(input.notifyTaskDone, fallback.notifyTaskDone),
    notifySubagentDone: asBoolean(input.notifySubagentDone, fallback.notifySubagentDone),
    notifyTaskError: asBoolean(input.notifyTaskError, fallback.notifyTaskError),
    notifyTurnEnd: asBoolean(input.notifyTurnEnd, fallback.notifyTurnEnd),

    quietHours: asQuietHours(input.quietHours, fallback.quietHours),
    channels: [browser, system, ...outboundChannels(input.channels)],
    kindRoutes: asKindRoutes(input.kindRoutes),
    allowKinds: asStrings(input.allowKinds),

    historyMaxAgeDays: asCount(
      input.historyMaxAgeDays,
      fallback.historyMaxAgeDays,
      COUNT_LIMITS.historyMaxAgeDays,
    ),
  };
}

// ---------------------------------------------------------------- 校验

/**
 * 校验：给出首个非法键与提示。只对**显式提交**的键负责——缺键不是错误，由归一化补默认；
 * 一次只报首个非法键，因为设置页的定位光标只能落在一个字段上。**陌生键一律 400**（退役键
 * 另有逐键话术，见 RETIRED_KEYS）：写面已经不再「透传保留」陌生键，理由见 validateKnownKeys。
 */
export function validateSettings(raw: SettingsPatch): ValidationResult {
  return verdictOf(raw);
}

/**
 * 校验**合并结果**（#1016 S2 写面专用入口，本身不收紧任何判据）。
 *
 * 与 `validateSettings` **共用同一个 `verdictOf`**：判定结论逐字相同，一个字都没多判。两者
 * 唯一的差别是审谁——本函数审「这次写真正要落盘的那条」，`validateSettings` 审「客户端交上来的
 * 草稿」。存量里有越界值时两者给出相反的结论，而后者不是用户要的。
 *
 * 单列一个函数而不是给 `validateSettings` 加可选参数：那是把一个纯函数改成「视参数而定
 * 行为」的形状，调用方分不清自己拿到的是哪一种；而两条入口结论一致这件事靠的是它们**共用同一个
 * `verdictOf`**，不是靠两处同步维护。
 * （`validateSettings` 在导出面基线上——改它的签名要动基线；本条分工取的是形态上的可辩护性，
 * 不是「动了不用改基线」。）
 *
 * @param raw 提交体。
 * @param merged 写面**按字段合并后**的结论（service 域 `mergeChannels` 的产物）。它与
 *   `raw.channels` 是两份东西：前者是这次写要落盘的形态（存量没被提到的键都在里面）加上每条
 *   里「哪些字段原样来自存量」的清单，后者是客户端交上来的草稿。
 *   缺省 = 按 `raw.channels` 判（草稿测试与直调路径的旧行为，条目里每个键都算本次提交）。
 */
export function validateSettingsWithMerge(
  raw: SettingsPatch,
  merged?: MergedChannelScope,
): ValidationResult {
  return verdictOf(raw, merged);
}

/**
 * 写面「按字段合并」结论在判据侧的形状：这次写要落盘的频道数组 + 与它同下标的**两条记账**。
 *
 * 两条记账问的是两个不同的事实，故分列而不是并成一条：
 *   - `inherited`：**值**原样来自存量的字段（#1016 S2）。它让值域判据只审本次真正动过的字段。
 *   - `preexisting`：**键的缺席**本来就来自存量的必填键（见 `firstMissing`）。存量里就缺、这次也没
 *     补上的那个键。
 * 「值沿用」与「缺席沿用」合成一条会让两种判据都说不清自己为什么跳过，故各自记各自的。
 *
 * 事实源是 service 域的 `ChannelMerge`（结构同构）；缺省 `preexisting` = 没有存量可谈，草稿与直调
 * 路径因此维持原样——那里每个键都算本次提交。
 */
export type MergedChannelScope = {
  readonly channels: RawSettingValue;
  readonly inherited: readonly ReadonlySet<string>[];
  readonly preexisting?: readonly ReadonlySet<string>[];
};

/**
 * 判据本体：两条入口（草稿 / 合并结果）都走它，「两条入口给出同一份判定结论」靠这一点保证。
 *
 * 两条通道分工（#1016 S2）：`channels` 判**合并后**的条目，`inherited` 里的字段不再重判值域
 * ——它们是存量原样带回来的，重判等于让一份越界的旧配置从此存不下任何东西。其余顶层键维持整值
 * 替换：不带 `inherited` 时每个键都算本次提交。
 */
function verdictOf(raw: SettingsPatch, mergedChannels?: MergedChannelScope): ValidationResult {
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // 原型链危险键不进判据：写面在落盘前整条剔除它们（writableEntries），在这里报「陌生键」只会
    // 把一次安全的写变成 400，而剔除本身已经挡住了原型改写。
    if (UNSAFE_KEYS.includes(key)) continue;
    // 走 hasOwn 而不是直接索引：constructor 这类键经 JSON 提交是可能的，直接索引会摸到
    // Object.prototype 上的同名成员，把一个陌生键误判成退役键。
    const retiredHint = Object.hasOwn(RETIRED_KEYS, key) ? RETIRED_KEYS[key] : undefined;
    if (retiredHint !== undefined) return reject(key, retiredHint);
    // 陌生键 400（#1016 S2）：写面不再透传保留，理由见 validateKnownKeys 的注释。存量里已有的
    // 陌生键不受影响——它们不在提交里，合并时原样沿用。
    if (!CONFIG_KEYS.includes(key)) return reject(key, key + " 不是已知配置键，删除它或核对拼写");
    const verdict = validateOne(key, value, key === "channels" ? mergedChannels : undefined);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * 逐值相同判定：标量用 `===`，数组逐项比，对象按键集合比（**键序无关**）。
 *
 * 键序无关有实测依据：客户端把视图原样交回，JSON 往返不保证键序，而「同一份内容、
 * 键序不同」在修订号那侧已经是不算改动（见 service 侧 `stableJson` 的注释）——
 * 两处对「什么算同一份内容」必须给同一个答案，否则用户什么都没改却被判成本次改动。
 *
 * 一侧缺键即视为不同：存量的键被提交抹掉，是一次真改动（客户端的 `stripChannelEmpties`
 * 会剥掉空串可选字段，那一类确实会在下次保存时被写掉）。
 *
 * 导出给写面合并（service/impl/merge.ts）判「这次提交有没有真的改这个字段」：同一个问题——
 * 「同一份内容」——两处必须给同一个答案，各写一份迟早把「原样带回」和「用户刚改的」读反。
 */
export function sameValue(
  left: RawSettingValue | undefined,
  right: RawSettingValue | undefined,
): boolean {
  if (left === right) return true;
  // 走到这里至多一侧缺键（两侧都缺已被上一行判成相同），缺键即不同。
  if (left === undefined || right === undefined) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

/** 单键校验；分支与归一化的取值助手一一对应，两处判断的是同一件事。 */
function validateOne(
  key: string,
  raw: RawSettingValue,
  mergedChannels?: MergedChannelScope,
): ValidationResult {
  if (BOOLEAN_KEYS.includes(key)) return requireBoolean(key, raw);
  const limit = COUNT_LIMITS[key];
  if (Number.isFinite(limit)) return requireCount(key, raw, limit);
  if (key === "quietHours") return validateQuietHours(raw);
  if (key === "channels") return validateMergedChannels(raw, mergedChannels);
  if (key === "kindRoutes") return validateKindRoutes(raw);
  if (key === "allowKinds") return requireStringArray(key, raw);
  return { ok: true };
}

/**
 * `channels` 一支：带合并结论时审**合并结果**（写面），不带时审提交面本身（草稿与直调路径）。
 *
 * 单列而不是把三笔账摊回 `validateOne`：那处是按 key 分派的开关链，摊开之后每加一笔账就多一个可选链
 * 访问，复杂度会顶到门禁上限——而「加一笔记账」本不该是件要改判据骨架的事。
 */
function validateMergedChannels(
  raw: RawSettingValue,
  merged: MergedChannelScope | undefined,
): ValidationResult {
  return validateChannels(merged?.channels ?? raw, merged?.inherited, merged?.preexisting);
}

/** 布尔闸门键：`"true"` 之类的同义写法不算数——设置页提交的就是字面 boolean。 */
function requireBoolean(key: string, raw: RawSettingValue): ValidationResult {
  return typeof raw === "boolean" ? { ok: true } : reject(key, "需要 true 或 false");
}

/** 声音键：false = 静音、true = 默认音、字符串 = 内置音色名，三者之外都非法。 */
function requireSoundSetting(key: string, raw: RawSettingValue): ValidationResult {
  return typeof raw === "boolean" || isSoundId(raw)
    ? { ok: true }
    : reject(key, "需要 false、true 或内置音色名");
}

/** 计数键：闭区间 `[0, 上界]`，小数与越界都拒绝（截断会静默改写用户的输入）。 */
function requireCount(key: string, raw: RawSettingValue, limit: number): ValidationResult {
  const inRange = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit;
  return inRange ? { ok: true } : reject(key, `需要 0 到 ${limit} 之间的整数`);
}

/** 白名单字符串数组键。 */
function requireStringArray(key: string, raw: RawSettingValue): ValidationResult {
  return isStringArray(raw) ? { ok: true } : reject(key, "需要字符串数组");
}

// 免打扰校验：一次只报首错（key 恒为 quietHours，设置页的定位光标只能落在一个字段上，
// 真正指到第几行靠 hint 里的 windows[i] 下标）。旧形（带 start/end 却没有 windows）在这里 400：
// 升级步会把它们搬进 windows[0]，放行旧形等于让停留在升级前页面上的旧客户端以为保存成功了，
// 故提示直接给出刷新的出路。
function validateQuietHours(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("quietHours", "需要对象");
  if (typeof raw.enabled !== "boolean") return reject("quietHours", "缺少 enabled");
  if (raw.windows === undefined)
    return reject("quietHours", "缺少 windows（页面停留在升级前时，刷新后重试）");
  if (!Array.isArray(raw.windows)) return reject("quietHours", "windows 需要数组");
  if (raw.windows.length > QUIET_WINDOWS_LIMIT)
    return reject("quietHours", "windows 最多 " + QUIET_WINDOWS_LIMIT + " 个");
  const windows = validateQuietWindows(raw.windows);
  if (!windows.ok) return windows;
  if ("allowKinds" in raw && !isStringArray(raw.allowKinds))
    return reject("quietHours", "allowKinds 需要字符串数组");
  return { ok: true };
}

/** 逐条窗口校验：一次只报首错（定位光标落不到具体行，行号靠 hint 里的 windows[i]）。 */
function validateQuietWindows(windows: readonly RawSettingValue[]): ValidationResult {
  for (let index = 0; index < windows.length; index += 1) {
    const verdict = validateQuietWindow(windows[index], index);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** 单条窗口的四处判据：对象形状 / start / end / 零长。与整组形态守卫是两类判据。 */
function validateQuietWindow(item: RawSettingValue, index: number): ValidationResult {
  if (!isRecord(item)) return reject("quietHours", "windows[" + index + "] 需要对象");
  if (typeof item.start !== "string" || !isClockText(item.start))
    return reject("quietHours", "windows[" + index + "].start 需要 HH:MM");
  if (typeof item.end !== "string" || !isClockText(item.end))
    return reject("quietHours", "windows[" + index + "].end 需要 HH:MM");
  // 零长窗口写面直接拒：读面把它当未命中丢掉，而写面放行等于让用户存下一条永远不生效的时段。
  if (item.start === item.end)
    return reject(
      "quietHours",
      "windows[" + index + "].start 与 windows[" + index + "].end 不能相同",
    );
  return { ok: true };
}

/**
 * 频道数组校验：逐条 + 内置在场。
 *
 * @param inherited 与数组同下标：该条目里**沿用存量**的字段名。清单里的字段不重判值域（#1016
 *   S2 的「写面拒新增、不动存量」）；缺省 = 每个键都算本次提交。
 * @param preexisting 与数组同下标：该条目里**存量本就残缺、这次也没补上**的必填键（见 MergedChannelScope）。
 */
function validateChannels(
  raw: RawSettingValue,
  inherited?: readonly ReadonlySet<string>[],
  preexisting?: readonly ReadonlySet<string>[],
): ValidationResult {
  if (!Array.isArray(raw)) return reject("channels", "需要数组");
  for (const [index, item] of raw.entries()) {
    const verdict = validateChannel(item, inherited?.[index], preexisting?.[index]);
    if (!verdict.ok) return verdict;
  }
  return requireBuiltinsPresent(raw);
}

/**
 * 内置频道不能删除：显式提交的 `channels` 必须仍然带着它们——这是内置频道**唯一**的特殊之处，
 * 其余一律按普通条目处理。
 *
 * 做成 400 而不是静默补回：静默补回会让「我删掉了它」与「它还在」在同一份界面上各说各话。代价是
 * 停留在升级前页面上的旧客户端（草稿里没有内置条目）会被拒一次，故提示直接给出刷新的出路。
 */
function requireBuiltinsPresent(list: readonly RawSettingValue[]): ValidationResult {
  const types = new Set<RawSettingValue>();
  for (const item of list) {
    if (isRecord(item)) types.add(item.type);
  }
  for (const type of BUILTIN_CHANNEL_TYPES) {
    if (types.has(type)) continue;
    return reject("channels", `内置渠道不能删除：缺少 ${type}（页面停留在升级前时，刷新后重试）`);
  }
  return { ok: true };
}

/** `level` 与 `preset` 是可选键：缺省各有明确语义（前者让「severity → level」映射生效，后者归一到 custom），
 * 客户端新建频道时本就不带它们——照必填拦下等于让用户的合法提交保存不了。
 *
 * 导出给草稿测试（dry-run）逐项复用：它只审单条、不审「内置必须在场」（见 requireBuiltinsPresent），
 * 草稿里可以只有目标频道一条。
 *
 * @param inherited 该条目里**沿用存量**的字段名（#1016 S2）。清单里的字段不重判值域：磁盘上
 *   一份越界的旧值不该让此后每一次无关保存都被拒——那不是用户造成的错误。缺省 = 每个键都算
 *   本次提交（草稿路径没有存量可言）。
 * @param preexisting 该条目里**存量本就残缺、这次也没补上**的必填键（#1016 S3 回归修复）。它只作用于
 *   「必填键在场」这一条形状判据，且只对清单里的键放行；缺省 = 没有存量可谈，每个键都算本次提交。 */
export function validateChannel(
  raw: RawSettingValue,
  inherited?: ReadonlySet<string>,
  preexisting?: ReadonlySet<string>,
): ValidationResult {
  if (!isRecord(raw)) return reject("channels", "频道项需要对象");
  if (raw.type === "browser" || raw.type === "system") return validateBuiltinChannel(raw, raw.type);
  if (typeof raw.id !== "string" || raw.id === "") return reject("channels", "频道缺少 id");
  if (raw.type === "bark") return validateBarkChannel(raw, raw.id, inherited, preexisting);
  if (raw.type === "webhook") return validateWebhookChannel(raw, raw.id, inherited, preexisting);
  return reject("channels", "频道 type 需要 bark、webhook、browser 或 system");
}

/** 内置频道：身份由 `type` 唯一确定（`id` 只是回显，写了就必须一致），开关与声音逐个按各自值域校验。
 *
 * 这几个键**不按 inherited 跳过**：内置条目的字段集是固定的五六个，0.2.9 形态清理会把缺席字段
 * 补齐，客户端也就每次都原样带回——存量里出现非布尔只可能是有人手改过文件（清理只在刻度推进时跑
 * 一次，救不了「升级后手改」），而那正是要拒的。 */
function validateBuiltinChannel(
  raw: Record<string, RawSettingValue>,
  type: BuiltinChannelType,
): ValidationResult {
  if (raw.id !== undefined && raw.id !== type)
    return reject("channels", `内置频道 ${type} 的 id 只能是 ${type}`);
  for (const key of ["enabled", "popup", "whenVisible"]) {
    if (raw[key] === undefined || typeof raw[key] === "boolean") continue;
    return reject("channels", `内置频道 ${type} 的 ${key} 需要 true 或 false`);
  }
  return raw.sound === undefined ? { ok: true } : requireSoundSetting("channels", raw.sound);
}

/** bark 频道：`baseUrl` 与 `deviceKey` 是投递必需（清单见 shared 的 REQUIRED_KEYS.bark）；
 * `level` 缺省时让 severity 映射生效，故可省。
 *
 * 必填键在**合并后**的条目上判：客户端可以只提交它改的那一个字段，其余从存量沿用。 */
function validateBarkChannel(
  raw: Record<string, RawSettingValue>,
  id: string,
  inherited?: ReadonlySet<string>,
  preexisting?: ReadonlySet<string>,
): ValidationResult {
  const missing = firstMissing(raw, REQUIRED_KEYS.bark, preexisting);
  if (missing !== undefined) return reject("channels", `bark 频道 ${id} 缺少 ${missing}`);
  if (isEdited(inherited, "level") && raw.level !== undefined && !isMember(raw.level, BARK_LEVELS))
    return reject("channels", `bark 频道 ${id} 的 level 非法`);
  if (
    isEdited(inherited, "levels") &&
    isRecord(raw.levels) &&
    Object.keys(raw.levels).length > BARK_LEVELS_LIMIT
  ) {
    return reject("channels", `bark 频道 ${id} 的 levels 最多 ${BARK_LEVELS_LIMIT} 项`);
  }
  return validateKnownKeys(raw, id, inherited, BARK_KNOWN_KEYS, BARK_RESERVED_KEYS, "bark");
}

/** webhook 频道：`url` 与 `auth` 是投递必需；`preset` 缺省归一到 custom，故可省。
 *
 * `auth` 的判据是**取值域**（缺席与非法同一句话），故不按 inherited 跳过：客户端的草稿来自读面
 * 归一化，永远带得出一个合法值，存量里出现非法 auth 只可能是手改过文件。 */
function validateWebhookChannel(
  raw: Record<string, RawSettingValue>,
  id: string,
  inherited?: ReadonlySet<string>,
  preexisting?: ReadonlySet<string>,
): ValidationResult {
  const missing = firstMissing(raw, REQUIRED_KEYS.webhook, preexisting);
  if (missing !== undefined) return reject("channels", `webhook 频道 ${id} 缺少 ${missing}`);
  if (!isMember(raw.auth, WEBHOOK_AUTHS))
    return reject("channels", `webhook 频道 ${id} 的 auth 非法`);
  if (
    isEdited(inherited, "preset") &&
    raw.preset !== undefined &&
    !isMember(raw.preset, WEBHOOK_PRESETS)
  )
    return reject("channels", `webhook 频道 ${id} 的 preset 非法`);
  if (
    isEdited(inherited, "template") &&
    typeof raw.template === "string" &&
    raw.template.length > WEBHOOK_TEMPLATE_MAX_CHARS
  ) {
    return reject(
      "channels",
      `webhook 频道 ${id} 的 template 最多 ${WEBHOOK_TEMPLATE_MAX_CHARS} 字符`,
    );
  }
  return validateKnownKeys(
    raw,
    id,
    inherited,
    WEBHOOK_KNOWN_KEYS,
    WEBHOOK_RESERVED_KEYS,
    "webhook",
  );
}

/**
 * 频道条目里的陌生键：一律 400（#1016 S2 删掉了 extras 概念）。
 *
 * 为什么不再「透传保留」：透传面要求读面把陌生键收进 `extras` 子对象再原样交回客户端，而写面
 * 只放行 string/number——于是 `extras` 这个**对象**自己撞上那条判据，该频道所在配置从此再也
 * 保存不了（#1016 缺陷 B）。收窄到「本版本认识的键」把那条自撞的口子关掉：写面拒新增，磁盘上
 * **已有**的陌生键由合并原样沿用（它不在提交里），既不丢也不锁人。
 *
 * 保留键（凭据别名）与其它陌生键**分两句**：前者是「你写的是别名，合法凭据只能走已知字段」，
 * 后者是「这个键从来不是本包的字段」——两者的排查方向不同，共用一句会把人引到错误的原因上。
 *
 * @param inherited 沿用存量的字段名；清单里的键不判（存量里的陌生键不该被一次无关保存追责）。
 */
function validateKnownKeys(
  raw: Record<string, RawSettingValue>,
  id: string,
  inherited: ReadonlySet<string> | undefined,
  known: readonly string[],
  reserved: readonly string[],
  kindLabel: string,
): ValidationResult {
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    if (!isEdited(inherited, key)) continue;
    if (reserved.includes(key))
      return reject("channels", `${kindLabel} 频道 ${id} 的 ${key} 是保留键：凭据只能走已知字段`);
    return reject("channels", `${kindLabel} 频道 ${id} 的 ${key} 不是已知键：删除它或核对拼写`);
  }
  return { ok: true };
}

function validateKindRoutes(raw: RawSettingValue): ValidationResult {
  if (!isRecord(raw)) return reject("kindRoutes", "需要对象");
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return reject("kindRoutes", `${key} 需要字符串数组`);
    }
  }
  return { ok: true };
}

function reject(key: string, hint: string): ValidationResult {
  return { ok: false, error: { key, hint } };
}

// ---------------------------------------------------------------- 净化

/**
 * 净化：只保留契约认识的键。陌生键一律剔除而不是拒绝——配置文件是共享的，别的东西写进来的
 * 键不该让设置读取失败，也不该被原样带进用户层再写回去。**不归一化**：净化只回答「这个键归
 * 不归我」，在这里顺手归一化会让写路径把用户的原始提交偷偷改写掉。
 *
 * @returns 净化后的部分设置；输入不是对象时得到空设置——「一个键都不认识」与「没有键」对
 *   调用方是同一件事，不必再给一个空值语义让它自己判。
 */
export function sanitizeSettings(raw: StoredSettings): Partial<NotifyConfig> {
  const kept: Record<string, RawSettingValue> = {};
  if (!isRecord(raw)) return kept;
  for (const key of CONFIG_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    kept[key] = value;
  }
  return kept as Partial<NotifyConfig>;
}

// ---------------------------------------------------------------- 取值助手

/** 原始值是不是一个 JSON 对象（数组与空值不算）。 */
function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * 该字段是否算「本次提交」：没有存量基线时一律算（草稿与直调路径），有则跳过沿用存量的字段。
 *
 * 这是 #1016 S2「写面拒新增、不动存量」的执行点：值域与尺寸判据只审本次真正动过的字段，磁盘上
 * 一份越界的旧值不该让此后每一次无关保存都被拒。形状判据（必填键、内置在场）**不看这个**——它问的
 * 不是「值是不是本次改的」而是「这个键在不在」，两者问的不是同一件事。
 *
 * 「存量本就残缺的必填键」也**不看这个**、而是看另一笔 `preexisting` 账：`inherited` 记的是「值原样
 * 来自存量」，而一个从未存在过的键没有值可沿用。两笔账分开记，各自只对自己的那族判据负责。
 */
function isEdited(inherited: ReadonlySet<string> | undefined, field: string): boolean {
  return inherited === undefined || !inherited.has(field);
}

/** 命中白名单则保留，其余（含缺键）回落。 */
function isMember<T extends string>(raw: RawSettingValue, allowed: readonly T[]): raw is T {
  return typeof raw === "string" && allowed.some((item) => item === raw);
}

/**
 * 「这个必填键交上来了没有」：**非空串**才算交上来。事实源是 `REQUIRED_KEYS`（S1 的共享 schema），
 * 「在场」是这一族判据共用的那一句，故单列并导出给写面合并用：两处各写一份「在场」，迟早在
 * 「空串算不算在场」上漂。
 *
 * 这一族的另两处：读面 `asChannel` 的空壳判定（`asBarkChannel` 对空串必填键返回 `ok: false`）与
 * upgrade 域 0.2.9 形态清理的**必填键判据**（canonical-keys 的 `requiredKeysOf`）。后者的必填键
 * **清单**同样只从 `REQUIRED_KEYS` 读，不再在本域另抄一份。
 */
export function isDeliveredRequired(value: RawSettingValue | undefined): boolean {
  return typeof value === "string" && value !== "";
}

/**
 * 必填键里第一个**这次写该负责**的缺项，全都在（或缺的都早已残缺）则 undefined。
 *
 * 按清单序返回**第一个**缺项而不是逐条拒：话术里带的是键名，缺哪个就报哪个，两项皆缺时报前一个
 * ——与逐条 if 链给出的结论完全一致（同一顺序、同一判据）。
 *
 * `preexisting` 里那些键**不计入缺项**，这是 #1016 S3 的一处回归修复：读面自 S3 起不丢弃半坏条目
 * （视图逐字外发），而这条判据原本是**绝对**的（只看合并后的条目），于是「用户在升级之后手改文件造出
 * 一条半坏条目」之后，此后每一次保存都 400——连改**别的**频道的名字都存不下去，比 S3 之前更差。
 *
 * 放行的条件是「两边都坏」：存量里这个键本来就是坏的（`preexisting` 由 merge 依存量事实算出），
 * 且这次写既没补上也没删它。**显式的删除手势不在此列**——它由 merge 的第三态在判据之前就 400 拒掉
 * （「必填键，不能删除」），所以「删掉一个必填键」的后果仍然一律被拒，只是拒在更早、更准的那一步。
 *
 * 反过来，存量里这个键是好的、这次被写成非法值（数字 / 对象 / 空串），`preexisting` 不含它，照样 400。
 * 换句话说：这条判据问的是「这次写有没有把事情做坏」，不是「磁盘上这份配置现在完不完整」——后者归
 * 读面（投递投影丢弃空壳）与 upgrade 域的形态清理，不归写面。
 */
function firstMissing(
  raw: Record<string, RawSettingValue>,
  keys: readonly string[],
  preexisting?: ReadonlySet<string>,
): string | undefined {
  for (const key of keys) {
    if (preexisting?.has(key) === true) continue;
    if (!isDeliveredRequired(raw[key])) return key;
  }
  return undefined;
}

/** 字符串数组：元素逐个看，非字符串即不算（与归一化侧「剔除非字符串项」是同一口径的两面）。 */
function isStringArray(raw: RawSettingValue): boolean {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string");
}

function asBoolean(raw: RawSettingValue, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function asString(raw: RawSettingValue, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

/** 非负整数且不越界；越界回落而不是截断（与校验的口径一致：拒绝胜过静默改写）。 */
function asCount(raw: RawSettingValue, fallback: number, limit: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= limit
    ? raw
    : fallback;
}

/** 声音设置：`false` / `true` / 内置音色名三种形态；音色名非法即回落。 */
function asSound(raw: RawSettingValue, fallback: SoundSetting): SoundSetting {
  if (typeof raw === "boolean") return raw;
  return isSoundId(raw) ? raw : fallback;
}

/** 字符串数组：非字符串项剔除而不是整组丢弃（一项脏值不该连累其余）。 */
function asStrings(raw: RawSettingValue): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

// 免打扰归一化：永不失败。单项非法（格式错、零长）只废该项，不废整组；全废则等于未命中
// （沿用「脏设置不吃掉所有通知」）。`windows` 缺席或非数组一律给 []（空数组 = 未命中）——#1016 S3
// 删掉了读面的旧 start/end 回落，那条链由 upgrade 域 0.2.6 的割接负责。显式 [] 同样保持 []。
function asQuietHours(raw: RawSettingValue, fallback: QuietHoursConfig): QuietHoursConfig {
  // 回落交出深副本：默认表是共享的，调用方就地改写它会污染此后每一个读者（windows 是数组，
  // 浅拷贝仍与默认表共享同一份列表）。
  if (!isRecord(raw)) return copyQuietHours(fallback);
  const enabled = asBoolean(raw.enabled, fallback.enabled);
  const allowKinds = asStrings(raw.allowKinds);
  // `windows` 缺席即「没有时段」，**不回落旧 start/end、不回落默认表**（#1016 S3 删除读面历史兼容）：
  // 旧形由 0.2.6 的免打扰多时间窗割接在装配期搬进 `windows[0]` 并删旧键，读面再兜一次就等于同一件事
  // 有两处实现，而两处迟早对「半截旧形」给出不同答案。回落方向是「丢键」而不是「落默认值」：
  // 用户显式写了 `quietHours` 却没有 `windows`，那表达的就是一条时段都不命中。
  if (!Array.isArray(raw.windows)) {
    return { enabled: enabled, windows: [], allowKinds: allowKinds };
  }
  const windows: QuietWindow[] = [];
  for (const item of raw.windows) {
    const window = asQuietWindow(item);
    if (window !== null) windows.push(window);
  }
  return { enabled: enabled, windows: windows, allowKinds: allowKinds };
}

// 默认表的免打扰深副本。
function copyQuietHours(fallback: QuietHoursConfig): QuietHoursConfig {
  const copied: QuietHoursConfig = {
    enabled: fallback.enabled,
    windows: fallback.windows.map((window) => ({ ...window })),
  };
  if (fallback.allowKinds !== undefined) copied.allowKinds = [...fallback.allowKinds];
  return copied;
}

// 单个窗口的读面收窄；非法与零长一律丢项（返回 null），不连累同组的其余项。
function asQuietWindow(raw: RawSettingValue): QuietWindow | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.start !== "string" || !isClockText(raw.start)) return null;
  if (typeof raw.end !== "string" || !isClockText(raw.end)) return null;
  if (raw.start === raw.end) return null;
  return { start: raw.start, end: raw.end };
}

/** kind → 频道 id 的稀疏路由；值不是数组的项剔除。 */
function asKindRoutes(raw: RawSettingValue): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  if (!isRecord(raw)) return routes;
  for (const key of Object.keys(raw)) {
    routes[key] = asStrings(raw[key]);
  }
  return routes;
}

/** 频道数组的逐项读取结果；认不出的项不带回值。 */
type ChannelRead = { ok: true; channel: ChannelConfig } | { ok: false };

/**
 * 出站实例数组：逐项归一化，**认不出的项直接丢弃**——一个没写 id、没写 url、没写凭据的「频道」
 * 没有任何可投递的目标，补成空壳只会在投递时制造一次必然失败的尝试。
 *
 * **这一次丢弃是 upgrade 域 0.2.9 形态清理的承重前提**（#1016 P1-2 选 (a)）：那一步不再删「必填键
 * 空串或缺席」的半坏条目，理由正是这里把它们整条剔出投递投影——留在磁盘上不等于会被打出去。
 * 两边要一起读；单独动任一侧的症状写在 canonical-keys.ts 文件头的「第三条路」那段。
 *
 * 内置条目在这里被跳过：它们由 `asBrowserChannel` / `asSystemChannel` 单独物化，且恒排在最前。
 */
function outboundChannels(raw: RawSettingValue): ChannelConfig[] {
  const channels: ChannelConfig[] = [];
  if (!Array.isArray(raw)) return channels;
  for (const item of raw) {
    const read = asChannel(item);
    if (read.ok) channels.push(read.channel);
  }
  return channels;
}

/** 输入数组里首个指定类型的内置条目（原始形态）；同类型的后来者被丢弃——内置身份由 `type` 唯一确定。 */
function builtinRaw(
  raw: RawSettingValue,
  type: BuiltinChannelType,
): Record<string, RawSettingValue> | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const item of raw) {
    if (isRecord(item) && item.type === type) return item;
  }
  return undefined;
}

/**
 * 浏览器频道物化：条目字段 → 默认表。
 *
 * **只认条目**（#1016 S3 删除读面历史兼容）：取值链上不再有「存量投影键（0.2.3 的顶层键）」那一层。
 * 0.2.3 的 `browserEnabled` / `browserNotify` / `browserSound` / `notifyWhenVisible` 与更早的全局
 * `notifySound` 都由 upgrade 域的 0.2.4 配置形态割接在装配期搬进本条目并删除旧键；读面再兜一次，
 * 两处实现对「只搬了一半的文件」迟早给出不同答案，而那时已经没有任何用户能看出来是哪一处错了。
 */
function asBrowserChannel(raw: Record<string, RawSettingValue> | undefined): BrowserChannelConfig {
  const fallback = builtinDefault("browser");
  const source: Record<string, RawSettingValue> = raw ?? {};
  return {
    type: "browser",
    id: "browser",
    enabled: asBoolean(source.enabled, fallback.enabled),
    popup: asBoolean(source.popup, fallback.popup),
    sound: asSound(source.sound, fallback.sound),
    whenVisible: asBoolean(source.whenVisible, fallback.whenVisible),
  };
}

/** 系统频道物化：链与浏览器频道同构，只是没有 `whenVisible`——那是浏览器出口独有的展示条件。 */
function asSystemChannel(raw: Record<string, RawSettingValue> | undefined): SystemChannelConfig {
  const fallback = builtinDefault("system");
  const source: Record<string, RawSettingValue> = raw ?? {};
  return {
    type: "system",
    id: "system",
    enabled: asBoolean(source.enabled, fallback.enabled),
    popup: asBoolean(source.popup, fallback.popup),
    sound: asSound(source.sound, fallback.sound),
  };
}

/**
 * 默认表里的内置条目：物化的最后一级回落。
 *
 * 断言只为把「按 type 找到的那条」收窄成对应型号——查找条件就是 type 相等。默认表是本模块的常量，
 * 两条内置条目必然在场；真缺了当场抛错比静默降级好（那是编码错误，不是用户输入的问题）。
 */
function builtinDefault<T extends BuiltinChannelType>(
  type: T,
): Extract<ChannelConfig, { type: T }> {
  for (const channel of DEFAULT_CONFIG.channels) {
    if (channel.type === type) return channel as Extract<ChannelConfig, { type: T }>;
  }
  throw new Error(`dsh-notifier: 默认设置里缺少内置频道 ${type}`);
}

function asChannel(raw: RawSettingValue): ChannelRead {
  if (!isRecord(raw)) return { ok: false };
  const id = asString(raw.id, "");
  if (id === "") return { ok: false };
  if (raw.type === "bark") return asBarkChannel(raw, id);
  if (raw.type === "webhook") return asWebhookChannel(raw, id);
  return { ok: false };
}

function asBarkChannel(raw: Record<string, RawSettingValue>, id: string): ChannelRead {
  const baseUrl = asString(raw.baseUrl, "");
  const deviceKey = asString(raw.deviceKey, "");
  if (baseUrl === "" || deviceKey === "") return { ok: false };
  const channel: BarkChannelConfig = {
    type: "bark",
    id,
    enabled: asBoolean(raw.enabled, false),
    name: asString(raw.name, ""),
    baseUrl,
    deviceKey,
    group: asString(raw.group, ""),
    sound: asString(raw.sound, ""),
    icon: asString(raw.icon, ""),
    url: asString(raw.url, ""),
    timeoutMs: asCount(raw.timeoutMs, 0, BARK_TIMEOUT_MS_LIMIT),
    levels: asLevels(raw.levels),
  };
  // 紧急度不兜底：缺了它才轮到「severity → level」那层映射，兜成 active 会让 error 通知
  // 永远发不出 timeSensitive；徽标同理，0 是有意义的取值。
  if (isMember(raw.level, BARK_LEVELS)) channel.level = raw.level;
  if (typeof raw.badge === "number") channel.badge = raw.badge;
  return { ok: true, channel };
}

function asLevels(raw: RawSettingValue): Record<string, BarkLevel> {
  const levels: Record<string, BarkLevel> = {};
  if (!isRecord(raw)) return levels;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (isMember(value, BARK_LEVELS)) levels[key] = value;
  }
  return levels;
}

function asWebhookChannel(raw: Record<string, RawSettingValue>, id: string): ChannelRead {
  const url = asString(raw.url, "");
  if (url === "") return { ok: false };
  const channel: WebhookChannelConfig = {
    type: "webhook",
    id,
    enabled: asBoolean(raw.enabled, false),
    name: asString(raw.name, ""),
    url,
    preset: isMember(raw.preset, WEBHOOK_PRESETS) ? raw.preset : "custom",
    auth: isMember(raw.auth, WEBHOOK_AUTHS) ? raw.auth : "none",
    token: asString(raw.token, ""),
    username: asString(raw.username, ""),
    password: asString(raw.password, ""),
    headerName: asString(raw.headerName, ""),
    headerValue: asString(raw.headerValue, ""),
    template: asString(raw.template, ""),
    headers: asHeaders(raw.headers),
    timeoutSec: asCount(raw.timeoutSec, 0, 600),
  };
  return { ok: true, channel };
}

function asHeaders(raw: RawSettingValue): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!isRecord(raw)) return headers;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}
