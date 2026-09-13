/**
 * config 域凭据的掩码往返（安全模块）：**读出去一律掩码，写回来按 id 还原**——没有这条对称，凭据只有两种结局：
 * 明文出到界面与日志，或被掩码覆盖成字面量。`CHANNEL_SECRET_FIELDS` 是唯一扩展点，两处各写一份清单一定会漂移。
 */
import type {
  ChannelConfig,
  NotifyConfig,
  RawSettingValue,
  StoredSettings,
} from "../model/type.ts";

/** 掩码占位：提交整值等于它 = 该字段「未修改」。 */
const SECRET_MASK = "********";

/** 掩码还原结果：成功带回还原后的频道数组；失败 = 有实例提交了掩码却无原值。 */
type UnmaskResult = { ok: true; channels: RawSettingValue } | { ok: false };

/** 单项还原结果；失败即「没有原值可还原」，整批随之中止。 */
type UnmaskedChannel = { ok: true; channel: RawSettingValue } | { ok: false };

/** 各频道类型的密钥字段清单。 */
const CHANNEL_SECRET_FIELDS: Record<ChannelConfig["type"], readonly string[]> = {
  bark: ["deviceKey"],
  webhook: ["token", "password", "headerValue"],
  // 内置频道没有任何凭据字段；它们在表里必须出现（Record 强制穷尽），值就是空清单。
  browser: [],
  system: [],
};

/** 读出口脱敏：深拷贝后把密钥字段掩码。拷贝而非原地改，是因为它作用于**即将外发的视图**，而同一份设置在域内还要以
 * 明文参与投递；频道项按**原始值**处理——存储层不受契约约束，里面可能躺着更高版本写的频道类型。 */
export function redactConfig(value: Partial<NotifyConfig>): Partial<NotifyConfig> {
  const copy = structuredClone(value);
  const channels = copy.channels;
  if (!Array.isArray(channels)) return copy;
  // 断言只声明"这是同一批频道，只是密钥被换成了掩码"——掩码不会改变项的形状。
  copy.channels = channels.map(maskChannel) as ChannelConfig[];
  return copy;
}

/**
 * 存储层的读出口脱敏：视图的 `user` 要**原样带陌生键**（只掩码凭据），所以不能先过净化——
 * 净化会把用户手写的未来键从视图里摘掉，而它们其实还在文件里，界面与文件就此各说各话。
 */
export function redactStored(stored: StoredSettings): StoredSettings {
  const masked: Record<string, RawSettingValue> = {};
  for (const [key, value] of Object.entries(stored)) {
    masked[key] =
      key === "channels" && Array.isArray(value)
        ? (value.map(maskChannel) as RawSettingValue)
        : structuredClone(value);
  }
  return masked;
}

/**
 * 写入口还原：patch 里等于掩码的字段，按 **id** 对齐取回原值——按下标对齐时数组顺序一变，
 * 就会把 A 实例的凭据回填进 B。
 *
 * @param patchChannels 提交上来的频道数组。
 * @param userChannels 已存储的频道数组（原值来源）；缺省视为没有原值。
 * @returns 还原后的频道数组；`ok: false` = 有实例提交了掩码却没有对应原值，调用方应当拒绝
 *   ——掩码只能表达「未修改」，不能凭空造出一个凭据。
 */
export function unmaskChannels(
  patchChannels: RawSettingValue,
  userChannels?: RawSettingValue,
): UnmaskResult {
  if (!Array.isArray(patchChannels)) return { ok: false };
  const existing: readonly RawSettingValue[] = Array.isArray(userChannels) ? userChannels : [];
  const restored: RawSettingValue[] = [];
  for (const item of patchChannels) {
    const read = unmaskChannel(item, existing);
    if (!read.ok) return { ok: false };
    restored.push(read.channel);
  }
  return { ok: true, channels: restored };
}

function maskChannel(channel: RawSettingValue): RawSettingValue {
  if (!isRecord(channel)) return channel;
  const masked: Record<string, RawSettingValue> = { ...channel };
  for (const field of secretFieldsOfType(channel.type)) {
    if (typeof masked[field] === "string") masked[field] = SECRET_MASK;
  }
  return masked;
}

function unmaskChannel(
  patch: RawSettingValue,
  existing: readonly RawSettingValue[],
): UnmaskedChannel {
  if (!isRecord(patch)) return { ok: true, channel: patch };
  const masked = secretFieldsOf(patch);
  if (masked.length === 0) return { ok: true, channel: patch };

  const original = findById(existing, idOf(patch));
  if (!original.ok) return { ok: false };

  const restored: Record<string, RawSettingValue> = { ...patch };
  for (const field of masked) {
    const value = original.channel[field];
    if (typeof value !== "string") return { ok: false };
    restored[field] = value;
  }
  return { ok: true, channel: restored };
}

/**
 * 某个频道类型的密钥字段；**不认识的类型给空清单**——配置文件里可能躺着更高版本或手写进去的
 * 频道，读出口的职责是原样送出而不是报错：在这里抛，用户看到的是设置页整页 500，而真正的原因
 * （某个陌生频道类型）没有任何线索指向它。
 */
function secretFieldsOfType(type: RawSettingValue): readonly string[] {
  if (type === "bark" || type === "webhook") return CHANNEL_SECRET_FIELDS[type];
  return [];
}

/** 提交项里**实际带了掩码**的密钥字段；不是频道对象时为空。 */
function secretFieldsOf(patch: Record<string, RawSettingValue>): readonly string[] {
  return secretFieldsOfType(patch.type).filter((field) => patch[field] === SECRET_MASK);
}

/** 按 id 查找的结果；找不到时不带回任何值。 */
type LookupResult = { ok: true; channel: Record<string, RawSettingValue> } | { ok: false };

/** 按 id 找已存储的同名频道；id 为空或找不到时给不出原值。 */
function findById(existing: readonly RawSettingValue[], id: string): LookupResult {
  if (id === "") return { ok: false };
  for (const item of existing) {
    if (isRecord(item) && item.id === id) return { ok: true, channel: item };
  }
  return { ok: false };
}

function idOf(patch: Record<string, RawSettingValue>): string {
  const id = patch.id;
  return typeof id === "string" ? id : "";
}

function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
