/**
 * dsh-notifier —— 两端共享面（门禁要求：跨模块引用只能落到本文件）。
 *
 * 本目录的位置是临时形态（维护者裁定后续可能改成单独的 shard 目录），所以这里只做转出、
 * 不放任何实现：届时迁移成本 = 本文件与同级实现文件。
 *
 * **同级模块的构建硬约束**：本目录参与两端打包，宿主端经 tsc emit 后被 esbuild 内联，
 * 客户端则由 esbuild **直接**解析本目录的 .ts 内联进 lib/client.js。故每个同级模块必须
 * **零 import**，或只做同目录相对 import（带 .ts 后缀）：
 *   - 值引 node:* → 客户端构建硬失败；
 *   - 值引 bare 第三方包 → **静默内联**进浏览器产物（无报错，最危险的一种）；
 *   - 跨目录相对引用会把别的代码拖进客户端产物。
 * 这条约束由 scripts/test/shared-leaf-imports.test.ts 机械守着（本包客户端走本门面，
 * 故在扫描面内）。反例见 packages/dsh-provider-usage/src/shared/interface.ts：那个包的
 * 客户端**不走**门面，正因为它的转出目标里有 node:fs 这类宿主专属模块。
 */
export { FOLLOW_SYSTEM_TONE, TONES } from "./tones.ts";
export type { ToneNote } from "./tones.ts";
export { SOUND_IDS, isSoundId } from "./sounds.ts";
export type { SoundId } from "./sounds.ts";
export {
  BUILTIN_KINDS,
  KIND_SEVERITY,
  KIND_SWITCHES,
  NOTIFY_SEVERITIES,
  isBuiltinKind,
  isNotifySeverity,
} from "./kinds.ts";
export type {
  BuiltinKind,
  ExternalKind,
  KindSwitchKey,
  NotifyKind,
  NotifySeverity,
} from "./kinds.ts";
export {
  BUILTIN_CHANNELS,
  BUILTIN_CHANNEL_TYPES,
  channelIdFor,
  channelIdOf,
  isBuiltinChannelType,
} from "./channels.ts";
export type { BuiltinChannelType } from "./channels.ts";
export {
  WEBHOOK_AUTHS,
  WEBHOOK_DEFAULT_TEMPLATES,
  WEBHOOK_DELIVERY_PRESETS,
  WEBHOOK_PRESETS,
  WEBHOOK_PRIORITY,
  deliveryPresetOf,
  webhookTemplateOf,
} from "./webhooks.ts";
export type { WebhookAuth, WebhookDeliveryPreset, WebhookPreset } from "./webhooks.ts";
export { REASON_CODES, REASON_LEGACY } from "./reason-codes.ts";
export type { ReasonCode, ReasonParams } from "./reason-codes.ts";
export type {
  CapabilityDimension,
  CheckedDimension,
  HostCapabilities,
  PackageManager,
  PopupCapability,
  Remediation,
  RemediationCode,
  RemediationParams,
  SoundCapability,
  Verdict,
} from "./capabilities.ts";
export { REFUSAL_CODES } from "./refusal.ts";
export type { RefusalCode } from "./refusal.ts";
export { createDisposerStack } from "./disposers.ts";
export type { DisposerStack } from "./disposers.ts";
