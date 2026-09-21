/**
 * dsh-jev-decide 双端共享面门面（跨模块引用唯一入口；本文件只转出、不放实现）。
 *
 * 同级模块构建硬约束：本目录仅 contract.ts 一个纯模块（零 import）。
 */
export {
  API_KEY_REF_RE,
  CJK_RE,
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  JEV_BASE_URL,
  MAX_QUESTIONS,
  MAX_QUESTION_TEXT,
  PACKAGE_DIR,
  PRESETS_FILE_NAME,
  PRESET_ID_RE,
  QUESTION_ID_RE,
  RETIRED_KEYS,
  ROUTES,
  SECRETS_FILE_NAME,
  SESSION_ID_RE,
  SNIPPET_MAX,
  TEMPLATE_VERSION,
  VERSION_FILE_NAME,
  FROZEN_PRESETS,
  containsCjk,
  frozenPresetOf,
  keyShapeCategory,
  truncateCodePoints,
} from "./contract.ts";
export type {
  AutomationCap,
  AutomationLevel,
  ConfigV1,
  DecideOutput,
  ErrorEnvelope,
  HistoryEntry,
  JevLang,
  JevTier,
  KeyShapeCategory,
  PresetQuestion,
  PresetTemplate,
} from "./contract.ts";
