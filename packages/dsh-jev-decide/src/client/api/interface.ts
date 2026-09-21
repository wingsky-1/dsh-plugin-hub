/**
 * dsh-jev-decide — api 域门面（域内跨文件唯一入口；本文件只转出、不放实现）。
 *
 * 传输（routes.ts）+ 契约消费（contract.ts）经此门面被 panes / index 消费；
 * 禁止绕过门面直引域内实现。
 */
export { APP_ROUTES, CLIENT_FETCH_TIMEOUT_MS, fetchTimeout } from "./routes.ts";
export {
  capLabel,
  clamp01,
  failureCategory,
  normalizeCap,
  parseConfigPayload,
  parseHistoryPayload,
  parsePresetsPayload,
  validApiKeyRef,
} from "./contract.ts";
export type {
  AutomationCap,
  AutomationLevel,
  JevConfigV1,
  JevHistoryEntry,
  JevLang,
  JevPresetConfigEntry,
  JevPresetInfo,
  JevTier,
} from "./contract.ts";
