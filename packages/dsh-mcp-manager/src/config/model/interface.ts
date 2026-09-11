/**
 * dsh-mcp-manager — config/model/interface.ts：配置域 model 子层门面（D10，#664 阶段 6）。
 *
 * 配置域 = model（归一化/导入/schema）+ store（持久化/状态/目录缓存 IO）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）；类型 DTO
 * 统一从 types/interface.ts 取（v3 C-DIR）。
 */
export { SERVER_NAME_PATTERN, normalizeServer } from "./normalize.ts";
export { fromClaudeEntry, parseClaudeJson } from "./import.ts";
export {
  DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS,
  DEFAULT_CATALOG_INJECTION,
  normalizeCatalogInjectionMode,
  DEFAULT_UI_CONFIG,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  Config,
} from "./config-schema.ts";
export type { CatalogInjectionMode } from "./config-schema.ts";
