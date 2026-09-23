/**
 * config 域门面：只转出组合根与 upgrade 域实际用的符号（无逻辑）。
 *
 * upgrade 复用本域路径与版本语义（单一事实源）；其余内部符号经 impl 直引，不走门面。
 */
export type { ConfigDeps } from "./deps.ts";
export { buildDefaultConfig, validateCustomPresets, validatePutBody } from "./impl/model.ts";
export type { ConfigPutPatch } from "./impl/model.ts";
export { normalizePutEnvelope } from "./impl/envelope.ts";
export type { LoadedState } from "./impl/service.ts";
export {
  BASELINE_VERSION,
  compareVersions,
  loadState,
  pluginVersion,
  readStoredVersion,
  resolveApiKey,
  savePatch,
  toMaskedConfig,
  writeStoredVersion,
} from "./impl/service.ts";
export {
  configFile,
  customPresetsFile,
  presetsFile,
  secretsFile,
  versionFile,
} from "./impl/paths.ts";
