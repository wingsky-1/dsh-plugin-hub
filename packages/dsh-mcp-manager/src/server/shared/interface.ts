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
  AgentFace,
  AttachmentsPort,
  EventsPort,
  ExposePort,
  HostContextPort,
  HostFaces,
  LoaderPort,
  LogRecord,
  LoggerPort,
  LogsPort,
  ModelAttachmentRef,
  ModelContentBlock,
  ModelInfoPort,
  MountedPlugin,
  OfficialPluginModule,
  PromptPort,
  RegisterPort,
  SaveImageInput,
  ToolsPort,
} from "./host-faces.ts";
// 跨域共享纯常量：单一物理定义在 constants.ts，目录外一律经本门面取——直接引
// constants.ts 会被 verify-dir-imports 判「直引实现文件」（合法出口只有 interface.ts/deps.ts）。
export {
  CONNECT_TIMEOUT_MS,
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  OFFICIAL_MCP_CLIENT_LOG_NAME,
  OFFICIAL_MCP_CLIENT_SPECIFIER,
  SERVER_NAME_PATTERN,
} from "./constants.ts";
export { publicToolName } from "./tool-names.ts";
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
  legacyFile,
  legacyProjectConfigFile,
  mcpManagerHome,
  projectConfigFile,
  statsFile,
  userStatePath,
  versionFile,
} from "./paths.ts";
