/**
 * server/shared 门面：目录外引用本模块的唯一入口（verify-dir-imports 的叶子模块判据）。
 *
 * 为什么要有它：目录含 interface.ts 才构成叶子模块——否则「共享层对外提供了什么」没有可校验
 * 的答案，各域会各自深入实现文件，收口点也就无从谈起。这里用**真实源名**转出（别名转出会
 * 解析到空，见 appendix G·G8）。
 */
export { ensureDir, readJsonFile, readTextFile, writeFileAtomic } from "./file-io.ts";
export {
  CATALOG_DIR_NAME,
  CATALOG_SUMMARY_FILE_NAME,
  CONFIG_FILE_NAME,
  LEGACY_LAYOUT,
  PACKAGE_DIR_MODE,
  STATS_FILE_NAME,
  USER_STATE_FILE_NAME,
  VERSION_FILE_NAME,
  catalogDir,
  catalogFile,
  catalogSummaryFile,
  configFile,
  directoryMode,
  fileMode,
  legacyCatalogFile,
  legacyFile,
  mcpManagerHome,
  projectConfigFile,
  statsFile,
  userStatePath,
  versionFile,
} from "./paths.ts";
