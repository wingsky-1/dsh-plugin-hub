/**
 * server/shared 门面：目录外引用本模块的唯一入口（verify-dir-imports 的叶子模块判据）。
 *
 * 为什么要有它：目录含 interface.ts 才构成叶子模块——否则「共享层对外提供了什么」没有可校验
 * 的答案，各域会各自深入实现文件，收口点也就无从谈起。这里用**真实源名**转出（别名转出会
 * 解析到空，见 appendix G·G8）。
 */
export { ensureDir, readJsonFile, readTextFile, writeFileAtomic } from "./file-io.ts";
// 组合根机制（收窄宿主上下文 / 成对装配 / 逆序释放）：入口在 B2 调它接真实域，本刀由集成探针驱动。
export { assemble, bindHost, safeDisposeAll } from "./compose.ts";
export type { DomainSpec } from "./compose.ts";
// 宿主能力面的类型（I1 第二白名单点）：域 deps.ts 与组合根都只认这一份形状。
export type {
  EventsPort,
  ExposePort,
  HostContextPort,
  HostFaces,
  LoggerPort,
  PromptPort,
  RegisterPort,
  ToolsPort,
} from "./host-faces.ts";
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
