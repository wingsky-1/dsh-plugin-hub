/**
 * 存储布局与权限的单一事实源（I7）。
 *
 * 文件名与 mode 都是迁移契约：散在调用点就会各自漂移，漂移的那一次是「迁移读空」或
 * 「权限随 umask 静默变化」。旧路径与目标路径因此在同一处声明——`upgrade` 域只搬字节、
 * 不认字面量。根目录只认 `DSH_HOME` 一个变量（经仓库共享层 `shared/dsh-home.js`），
 * 隔离验证换掉它即换掉全部落盘位置。
 */
import { basename, dirname, join } from "node:path";
import { dshHome } from "../../../../../shared/dsh-home.js";
import { pluginHome } from "../../../../../shared/paths.js";

/** 本插件在 DSH home 下的私有目录：按 npm 包名分区，不与其它插件争用根目录。 */
const PACKAGE_DIR = "@wingsky-1/dsh-mcp-manager";

/** 私有目录权限：同机其它用户不得列举本插件的落盘面（与 mcp.json 的 0o600 同族）。 */
export const PACKAGE_DIR_MODE = 0o700;

/** 目标布局的文件名（迁移契约）。 */
export const CONFIG_FILE_NAME = "mcp.json";
export const USER_STATE_FILE_NAME = "user-state.json";
export const CATALOG_DIR_NAME = "catalog";
export const CATALOG_SUMMARY_FILE_NAME = "catalog-summary.json";
export const STATS_FILE_NAME = "stats.json";
export const VERSION_FILE_NAME = "version";

/**
 * 项目级配置的新形态：`<项目根>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json`（按包分区，
 * 与全局私有目录同构）。旧扁平形态 `<项目根>/.dsh/mcp.json` 见 `legacyProjectConfigFile`——
 * 只做迁移读面，不回写。
 */
const PROJECT_CONFIG_DIR_NAME = ".dsh";
const PROJECT_CONFIG_FILE_NAME = "mcp.json";

/**
 * 旧版布局清单（迁移的**读面**，新代码不得回写）：两类用户数据散在 DSH home 根。
 *
 * 收缩依据：目录摘要与调用统计可再生、不进迁移（见计划 §2.3）；目录型旧路径
 * `dsh-mcp-catalog/` 同理可再生，随本笔一并退出迁移面。
 */
export const LEGACY_LAYOUT = {
  config: "dsh-mcp.json",
  userState: "dsh-mcp-user-state.json",
} as const;

/** 本插件私有目录。 */
export function mcpManagerHome(): string {
  return pluginHome(dshHome(), PACKAGE_DIR);
}

/** 私有目录下的一个文件（只有本模块知道名字，故不对外暴露）。 */
function mcpManagerFile(fileName: string): string {
  return join(mcpManagerHome(), fileName);
}

/** 全局服务器配置：本包最敏感的一档（含 env 引用与凭据字段）。 */
export function configFile(): string {
  return mcpManagerFile(CONFIG_FILE_NAME);
}

/**
 * 用户状态（disabledTools 等）。
 *
 * 名字用 Path 而不是 File：入口今天仍导出旧实现 `userStateFile()`（返回旧路径），两个同名函数
 * 在迁移期同时存在会让「拿到的是新路径还是旧路径」无从判读，导出面门禁也会看到两个同名定义块。
 */
export function userStatePath(): string {
  return mcpManagerFile(USER_STATE_FILE_NAME);
}

/** 目录 last-good 缓存的**目录**（每工作空间一份 `<hash>.json`）。 */
export function catalogDir(): string {
  return mcpManagerFile(CATALOG_DIR_NAME);
}

/** 目录 last-good 缓存文件。 */
export function catalogFile(hash: string): string {
  return join(catalogDir(), `${hash}.json`);
}

/** 目录摘要缓存。 */
export function catalogSummaryFile(): string {
  return mcpManagerFile(CATALOG_SUMMARY_FILE_NAME);
}

/** 调用统计。 */
export function statsFile(): string {
  return mcpManagerFile(STATS_FILE_NAME);
}

/** 存储版本刻度（升级链走到哪一版，不是插件版本——后者读 package.json）。 */
export function versionFile(): string {
  return mcpManagerFile(VERSION_FILE_NAME);
}

/** 项目级服务器配置：包分区新形态（迁移目标，写面只认它）。 */
export function projectConfigFile(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR_NAME, PACKAGE_DIR, PROJECT_CONFIG_FILE_NAME);
}

/**
 * 项目级旧扁平形态（迁移**读面**，新代码不得回写）：`isProjectConfigFile` 只认新形态，
 * 故写函数天然拒绝它——与全局 LEGACY_LAYOUT 的「旧路径只读」同族。
 */
export function legacyProjectConfigFile(projectRoot: string): string {
  return join(projectRoot, PROJECT_CONFIG_DIR_NAME, PROJECT_CONFIG_FILE_NAME);
}

/** 旧版布局下的一个文件（DSH home 根）。 */
export function legacyFile(fileName: string): string {
  return join(dshHome(), fileName);
}

/** mode 登记表的一行。`null` = 登记了「不设 mode」（该项目随项目自身的权限模型）。 */
type ModeEntry = { readonly matches: (path: string) => boolean; readonly mode: number | null };

/**
 * 项目级配置的路径形态：项目根是用户数据、不能枚举，故按三级目录名识别——文件名
 * `mcp.json` + 父目录包分区目录 + 祖父的父目录 `.dsh`。旧扁平形态不在此列（只读）。
 *
 * 注：`PACKAGE_DIR` 含 `/`（`@wingsky-1/dsh-mcp-manager`），`basename` 只取末段比较，
 * 祖父层用两次 `dirname` 跳过中间的 `@wingsky-1` 一级——字面量比较 `basename(dir) ===
 * PACKAGE_DIR` 恒为假，故此处按段比较。
 */
function isProjectConfigFile(path: string): boolean {
  if (basename(path) !== PROJECT_CONFIG_FILE_NAME) return false;
  const leafDir = dirname(path);
  return (
    basename(leafDir) === basename(PACKAGE_DIR) &&
    basename(dirname(dirname(leafDir))) === PROJECT_CONFIG_DIR_NAME
  );
}

/**
 * 逐文件 mode 表（§7.1）。catalog 一族按**父目录**登记，`catalog/<hash>.json` 只占一行。
 *
 * 为什么不给写函数兜底默认值：兜底 = 权限随 umask 漂移而调用点毫无感觉，这条静默行为正是
 * mode 表要消除的；未登记一律抛错（I6）。
 */
const FILE_MODES: readonly ModeEntry[] = [
  { matches: (path) => path === configFile(), mode: 0o600 },
  { matches: (path) => path === userStatePath(), mode: 0o644 },
  { matches: (path) => dirname(path) === catalogDir(), mode: 0o644 },
  { matches: (path) => path === catalogSummaryFile(), mode: 0o644 },
  { matches: (path) => path === statsFile(), mode: 0o644 },
  { matches: (path) => path === versionFile(), mode: 0o644 },
  { matches: (path) => isProjectConfigFile(path), mode: null },
];

/** 目标文件的登记 mode；未登记即抛错，写函数不替调用点做权限决定。 */
export function fileMode(file: string): number | null {
  const entry = FILE_MODES.find((candidate) => candidate.matches(file));
  if (entry === undefined) {
    throw new Error(`落盘路径未登记 mode（先加入 server/shared/paths.ts 的登记表）：${file}`);
  }
  return entry.mode;
}

/**
 * 目标目录的登记 mode：插件自有目录 0o700；项目 `.dsh/` 及其下的包分区叶子目录随项目
 * （null）；未登记即抛错。
 *
 * 注：`PACKAGE_DIR` 含 `/`，`basename(dir) === PACKAGE_DIR` 恒为假，故按末段 +
 * 祖父层 `.dsh` 双条件识别（与 `isProjectConfigFile` 同形）。`ensureDir` 只校验传入的
 * 那一级目录，叶子登记 null 即够（`mkdir recursive` 建中间级不另校验）。
 */
export function directoryMode(dir: string): number | null {
  if (dir === mcpManagerHome() || dir === catalogDir()) return PACKAGE_DIR_MODE;
  if (basename(dir) === PROJECT_CONFIG_DIR_NAME) return null;
  if (
    basename(dir) === basename(PACKAGE_DIR) &&
    basename(dirname(dirname(dir))) === PROJECT_CONFIG_DIR_NAME
  ) {
    return null;
  }
  throw new Error(`落盘目录未登记 mode（先加入 server/shared/paths.ts 的登记表）：${dir}`);
}
