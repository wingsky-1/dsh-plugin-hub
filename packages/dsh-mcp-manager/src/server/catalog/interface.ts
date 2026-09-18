/**
 * dsh-mcp-manager — catalog/interface.ts：模型面+目录域唯一对外引用面（D10，#664 阶段 5）。
 *
 * 目录域 = 能力目录条目/渲染（entries）+ digest（digest）+ 会话内历史定位
 * （history）+ 注入决策（injection）+ 注入端缓存视图（cache-view）+ 检索函数族
 * （search），其中 entries/digest/history/injection/cache-view 五块住 impl/<块>/index.ts。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）；工具级禁用裁决
 * （isToolDenied 等，#767 笔 2 后是唯一裁决）归执行管道域的 authorize 块。
 *
 * search 是本域唯一**暂留域根**的块——B2.4 就地重构的刻意偏差，不是漏做：它当时是
 * fileCycles 那条环签名（catalog/interface.ts|catalog/search.ts|connection/interface.ts|
 * connection/runtime/interface.ts|connection/runtime/middleware.ts）的成员，搬进
 * impl/search/ 会让签名变成 catalog/impl/search/index.ts|... → verify-dir-imports 判
 * 「新增未登记证据」且 --write-baseline 拒写（附录 G·G16 同族：证据 id 路径派生）。
 * W4 装上 ConnectionPort 后该环已断（本笔实测叶子模块级 / 文件级值环均归零，基线同笔清理），
 * 搬进 impl/search/ 不再制造证据位移；它改的是模块 id 与目录形态，与 B2b 的原子搬迁同笔。
 */
import type { CatalogDeps } from "./deps.ts";
import { catalogPorts } from "./impl/service/index.ts";

/**
 * 装配目录域：把组合根持有的三组端口写入域内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——三条 Port 全是静态模块引用，不需要宿主 ctx。
 * 宿主能力（工具注册表读口 / 日志出口 / 落盘路径）都不在端口内：它们是本域声明的**入参契约**，
 * 由 connection 在调用点构造递入（同 CatalogViewHost 的口径，见 deps.ts 头注释）。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的
 * analyzeInjectionFaces）按 `export function installXxx(` 采点，`async` 前缀会让这条对账
 * 静默失明（附录 G·G12）。本域装配是纯同步写标记，签名保持同步形态即可。
 */
export function installCatalog(deps: CatalogDeps): void {
  catalogPorts.install(deps);
}

/** 卸载目录域。只复位装配标记：本域读的是外部递进来的能力，没有活资源要释放。 */
export function releaseCatalog(): void {
  catalogPorts.release();
}

export {
  DEFAULT_ANNOUNCE_CATALOG,
  DEFAULT_CATALOG_MAX_ENTRIES,
  CATALOG_SUMMARY_MAX_CHARS,
  CATALOG_SUMMARY_PER_TOOL_CHARS,
  CATALOG_ENTRY_MAX_CHARS,
  summarizeToolDescriptions,
  composeCatalogEntries,
  renderMcpCatalogMessage,
  renderMcpCatalogUpdate,
  escapeCatalogText,
  findCatalogMessage,
  readCatalogEntries,
  isCatalogSource,
  resolveCatalogEntries,
  CATALOG_SOURCE_PLUGIN,
  CATALOG_SECTION_NAME,
} from "./impl/entries/index.ts";
export type {
  CatalogEntry,
  SupervisorLite,
  CatalogCache,
  CatalogSourceLike,
} from "./impl/entries/index.ts";
export { digestCatalogEntries } from "./impl/digest/index.ts";
export { catalogHistory } from "./impl/history/index.ts";
export type { CatalogHistoryResult, CatalogAgent } from "./impl/history/index.ts";
export { resolveCatalogInjection } from "./impl/injection/index.ts";
export type { CatalogMessage, CatalogDecision } from "./impl/injection/index.ts";
export { makeCatalogViewFor, catalogCacheFile } from "./impl/cache-view/index.ts";
export type { CatalogViewHost, CatalogViewResolver } from "./impl/cache-view/index.ts";
export {
  scoreTool,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  isCatalogFresh,
  boundCatalogTools,
} from "./search.ts";
// 目录内存态 + 投影 + last-good（#767 S1-3b 自连接层搬入）：写口/读口与投影入参类型。
export { catalogDirectory } from "./impl/directory/index.ts";
export type { SchemaView, RegisteredProjectionInput } from "./impl/directory/index.ts";
export type { CatalogServer, CatalogTool } from "./impl/entries/type.ts";
export type {
  SearchHit,
  ListToolEntry,
  ListServerEntry,
  ToolDetail,
  ListCatalogResult,
} from "./impl/search/type.ts";
