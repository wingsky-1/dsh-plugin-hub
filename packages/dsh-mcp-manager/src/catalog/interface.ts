/**
 * dsh-mcp-manager — catalog/interface.ts：模型面+目录域唯一对外引用面（D10，#664 阶段 5）。
 *
 * 目录域 = 能力目录条目/渲染（entries）+ digest（digest）+ 会话内历史定位
 * （history）+ 注入决策（injection）+ 注入端缓存视图（cache-view）+ 检索函数族
 * （search），其中 entries/digest/history/injection/cache-view 五块住 impl/<块>/index.ts。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）；strategy 裁决族
 * （policyAllows/isToolDenied 等）仍留在 middleware-utils.ts（阶段 6 集中搬移时再归位）。
 *
 * search 是本域唯一**暂留域根**的块——B2.4 就地重构的刻意偏差，不是漏做：它是 fileCycles
 * 那条环签名（catalog/interface.ts|catalog/search.ts|connection/interface.ts|
 * connection/runtime/interface.ts|connection/runtime/middleware.ts）的成员，搬进
 * impl/search/ 会让签名变成 catalog/impl/search/index.ts|... → verify-dir-imports 判
 * 「新增未登记证据」且 --write-baseline 拒写（附录 G·G16 同族：证据 id 路径派生）。
 * 破环必须动域外消费者（装 deps 端口 + 组合根注入），故 search 进 impl/search/ 与破环
 * 同笔，留 B2b。
 */
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
