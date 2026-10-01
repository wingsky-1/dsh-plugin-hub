/**
 * dsh-notifier config 域 —— 草稿测试（dry-run）的输入闸门：只认 draft.channels。
 *
 * 与写面（write）的三处不同，每一处都是提案 B1/B2 的逐条落实：
 * - 只审 channels：draft 顶层的其它键一律忽略（不 400），revision 直接忽略——
 *   dry-run 不做乐观并发，测的是眼前条目，不是版本链；
 * - 逐项只调 validateChannel（单条），跳过 requireBuiltinsPresent——草稿里可以只有
 *   目标频道一条，要求内置在场会把「单测一个新建 bark 频道」这个主场景直接拒掉；
 * - 掩码按 id 还原（复用 unmaskChannels）：新频道无源、id 改名带掩码都落到
 *   NEW_CHANNEL_MASK_HINT 的 400；还原后仍残留掩码字面量（跨 type 残留）整体拒绝，话术是
 *   RESIDUAL_MASK_HINT——**与写面对同一情形逐字同句**（两句都从 service/merge.ts import）。
 *   占位符不是凭据，发出去会进对端日志，剥离会替用户改配置（B2 选 400 那一支，并由判据钉住）。
 *
 * 本模块只做「输入 → 可投递的频道数组」，不读文件、不写盘、不记日志：调用方（api 域）
 * 拿到的已是还原后的原始条目，再经 normalizeConfig 在内存里归一化，全程零落盘。
 */
import { validateChannel } from "../input/index.ts";
import type { RawSettingValue } from "../model/type.ts";
import { hasResidualMask, unmaskChannels } from "../redact/index.ts";
import { NEW_CHANNEL_MASK_HINT, RESIDUAL_MASK_HINT } from "../service/merge.ts";

/** 草稿解析结论：成功带回还原后的频道数组（原始形态，调用方再归一化）；失败只带一句话。 */
export type ResolvedDraft =
  | { readonly ok: true; readonly channels: readonly RawSettingValue[] }
  | { readonly ok: false; readonly hint: string };

// 跨 type 残留掩码的拒绝理由**不在本模块另写一份**：占位符出现在密钥位上，说明草稿里的凭据
// 已经对不上任何已存值，而这句话写面也要一字不差地说。两句拒绝话术（NEW_CHANNEL_MASK_HINT /
// RESIDUAL_MASK_HINT）都从写面那一侧 import——它们是「写面与 dry-run 对同一情形必须逐字同句」这条
// 跨链路契约的字面量，两处各写一份时漂移是时间问题而不是会不会的问题，而漂了的后果正是本模块
// 存在的理由被推翻（同一份草稿在保存与试发两条路上得到两个答案）。
//
// 情形本身仍在本模块判：unmaskChannels 失败 = 本 type 密钥位无原值（第一句）；还原后
// hasResidualMask 命中 = 掩码落在别的 type 的密钥位上（第二句）。写面按同一情形分三段，
// 见 service/merge.ts 的 fieldVerdict。判据见 config-merge-roundtrip.test.ts 的「两条链路同句」一组。

/**
 * 解析 dry-run 草稿：draft 必须是对象，其 channels 必须是数组；按 id 还原掩码、扫残留、
 * 再逐项校验。三步任一失败即整体拒绝——半条还原的草稿没有「测一半」的语义。
 *
 * **掩码两步排在逐项校验之前**（#1016 S2）：写面不再透传陌生键，于是「webhook 条目上带一个
 * bark 的 deviceKey 占位」会先被陌生键判据接住，而那句话（`deviceKey 不是已知键`）对用户是
 * 误导——他真正要知道的是「你贴进来的凭据对不上任何已存值」。安全信号优先于形状信号。
 *
 * @param draft 请求体里的 draft（顶层其它键与 revision 由调用方忽略，不进这里）。
 * @param secrets 掩码还原的原值来源（调用方传已生效设置的 channels，含明文凭据、不外发）。
 */
export function resolveDraftChannels(
  draft: unknown,
  secrets: readonly RawSettingValue[] | undefined,
): ResolvedDraft {
  if (!isRecord(draft)) return fail("draft 需要对象");
  const raw = draft.channels;
  if (!Array.isArray(raw)) return fail("draft.channels 需要数组");
  const restored = unmaskChannels(raw, secrets);
  if (!restored.ok) return fail(NEW_CHANNEL_MASK_HINT);
  const channels = restored.channels;
  if (!Array.isArray(channels)) return fail("draft.channels 需要数组");
  for (const channel of channels) {
    if (hasResidualMask(channel)) return fail(RESIDUAL_MASK_HINT);
  }
  for (const item of channels) {
    const verdict = validateChannel(item);
    if (!verdict.ok) return fail(verdict.error.hint);
  }
  return { ok: true, channels };
}

function fail(hint: string): ResolvedDraft {
  return { ok: false, hint };
}

function isRecord(raw: unknown): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
