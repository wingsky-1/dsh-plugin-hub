/**
 * config 域门面：包内跨域引用的唯一入口（只转出，不放实现）。
 */
export type { ConfigDeps, FileIoPorts, LoggerPort } from "./deps.ts";
export type { ConfigPutPatch, PutFailure } from "./impl/model.ts";
export {
  buildDefaultConfig,
  normalizeLoadedConfig,
  normalizePutEnvelope,
  validatePutBody,
} from "./impl/model.ts";
export type { LoadedState } from "./impl/service.ts";
export {
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
  historyDir,
  jevHome,
  presetsFile,
  secretsFile,
  versionFile,
} from "./impl/paths.ts";
