/**
 * dsh-notifier config 域 —— 凭据的掩码往返（安全模块）。
 *
 * 设置的读出口与写入口在这一块上对称：**读出去一律掩码，写回来按 id 还原**。没有
 * 这条对称，凭据就只有两种结局——明文出到界面与日志，或者被掩码覆盖成字面量。
 *
 * 表是扩展点：新增频道类型只改 `CHANNEL_SECRET_FIELDS` 一处，读出口与写入口同时
 * 生效；两处各写一份清单就一定会漂移，漂移的那一次就是明文泄漏。表的键类型取自
 * 频道联合的判别键，所以「加了频道类型却忘了登记密钥字段」是编译错误，不是漏洞。
 *
 * 依赖方向：只引用本目录与 `../model/`，不引用 `interface.ts`。
 */
import type { ChannelConfig, NotifyConfig, RawSettingValue } from "../model/type.ts";

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
};

/**
 * 读出口脱敏：深拷贝后把密钥字段掩码。
 *
 * 拷贝而非原地改，是因为它作用于**即将外发的视图**，而同一份设置在域内还要以明文
 * 参与投递——原地掩码会把凭据真的抹掉。
 */
export function redactConfig(value: Partial<NotifyConfig>): Partial<NotifyConfig> {
  const copy = structuredClone(value);
  const channels = copy.channels;
  if (!Array.isArray(channels)) return copy;
  copy.channels = channels.map(maskChannel);
  return copy;
}

/**
 * 写入口还原：patch 里等于掩码的字段，按 **id** 对齐取回原值。
 *
 * 按 id 而非下标：数组顺序一变，下标对齐就会把 A 实例的凭据回填进 B。
 *
 * @param patchChannels 提交上来的频道数组。
 * @param userChannels 已存储的频道数组（原值来源）；缺省视为没有原值。
 * @returns 还原后的频道数组；`ok: false` = 有实例提交了掩码却没有对应原值，
 *   调用方应当拒绝——掩码只能表达「未修改」，不能凭空造出一个凭据。
 */
export function unmaskChannels(patchChannels: RawSettingValue, userChannels?: RawSettingValue): UnmaskResult {
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

function maskChannel(channel: ChannelConfig): ChannelConfig {
  const masked: Record<string, RawSettingValue> = { ...channel };
  for (const field of CHANNEL_SECRET_FIELDS[channel.type]) {
    if (typeof masked[field] === "string") masked[field] = SECRET_MASK;
  }
  return masked as ChannelConfig;
}

function unmaskChannel(patch: RawSettingValue, existing: readonly RawSettingValue[]): UnmaskedChannel {
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

/** 提交项里**实际带了掩码**的密钥字段；不是频道对象时为空。 */
function secretFieldsOf(patch: Record<string, RawSettingValue>): readonly string[] {
  const type = patch.type;
  if (type !== "bark" && type !== "webhook") return [];
  return CHANNEL_SECRET_FIELDS[type].filter((field) => patch[field] === SECRET_MASK);
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
