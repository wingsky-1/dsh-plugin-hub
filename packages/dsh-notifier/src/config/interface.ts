/**
 * dsh-notifier — config/interface.ts：配置域唯一对外引用面。
 *
 * 目录外代码（其他域 / index.ts / service.d.ts）只能从这里引用本域符号：
 * 配置类型族、默认值/装配键、归一化、写校验、凭据脱敏、路径、免打扰纯函数、
 * settings 接线、settings 桥（ConfigPort 的现状实现面）、存量迁移。
 * 域内实现文件互引不经过本文件；跨域消费者所需符号全部在本文件收口
 * （verify-dir-imports 静态强制）。
 */
export {
  ASSEMBLY_SETTING_KEYS,
  BARK_ID_PATTERN,
  BARK_RESERVED_KEYS,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  SOUND_IDS,
  WEBHOOK_RESERVED_KEYS,
  isSoundSetting,
  resolveSoundSetting,
} from "./config.ts";
export type {
  BarkChannelConfig,
  BarkLevel,
  ChannelConfig,
  NotifierApplyConfig,
  NotifyConfig,
  SoundChannel,
  SoundId,
  SoundSetting,
  WebhookAuth,
  WebhookChannelConfig,
  WebhookPreset,
} from "./config.ts";
export { isWebhookHeaderName, normalizeBarkBaseUrl, normalizeBarkLevels, normalizeConfig } from "./normalize.ts";
export { sanitizePatchSettings, sanitizeSettings, validateSettings } from "./validators.ts";
export type { SettingInvalid } from "./validators.ts";
export { CHANNEL_SECRET_FIELDS, SECRET_MASK, redactConfigView, unmaskChannels } from "./redact.ts";
export { configFile, historyFile, seqFile, statusFile, toastScriptPath } from "./paths.ts";
export { QUIET_ALLOW_KINDS, isInQuietHours, parseHHMM } from "./quiet-hours.ts";
export type { QuietHoursConfig } from "./quiet-hours.ts";
export { SETTINGS_NS, installNotifierSettings, warnLog } from "./settings.ts";
export { createSettingsBridge } from "./settings-bridge.ts";
export type { SettingsBridge } from "./settings-bridge.ts";
export { CORRUPTED_BAK_SUFFIX, MIGRATED_BAK_SUFFIX, migrateLegacyConfig } from "./migrate.ts";
export type { MigrateDeps, MigrationOutcome } from "./migrate.ts";