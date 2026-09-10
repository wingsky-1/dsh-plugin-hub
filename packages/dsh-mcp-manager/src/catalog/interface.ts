/**
 * dsh-mcp-manager — catalog/interface.ts：模型面+目录域唯一对外引用面（D10，#664 阶段 5）。
 *
 * 目录域 = 能力目录条目/渲染（entries）+ digest（digest）+ 会话内历史定位
 * （history）+ 注入决策（injection）+ 注入端缓存视图（cache-view）+ 检索函数族
 * （search）。目录外模块**只能**从这里引用（verify-dir-imports 静态强制）；
 * strategy 裁决族（policyAllows/isToolDenied 等）仍留在 middleware-utils.ts
 * （阶段 6 集中搬移时再归位）。
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
} from "./entries.ts";
export type { CatalogEntry, SupervisorLite, CatalogCache } from "./entries.ts";
export { digestCatalogEntries } from "./digest.ts";
export { catalogHistory } from "./history.ts";
export type { CatalogHistoryResult, CatalogAgent } from "./history.ts";
export { resolveCatalogInjection } from "./injection.ts";
export type { CatalogMessage, CatalogDecision } from "./injection.ts";
export { makeCatalogViewFor, catalogCacheFile } from "./cache-view.ts";
export type { CatalogViewHost, CatalogViewResolver } from "./cache-view.ts";
export {
  scoreTool,
  searchCatalog,
  searchCatalogMulti,
  listCatalog,
  findToolDetail,
  isCatalogFresh,
  boundCatalogTools,
} from "./search.ts";