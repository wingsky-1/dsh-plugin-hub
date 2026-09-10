/**
 * dsh-mcp-manager — config/store/interface.ts：配置域 store 子层门面（D10，#664 阶段 6）。
 *
 * 配置域 = model（归一化/导入/schema）+ store（持久化/状态/目录缓存 IO）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 */
export { defaultStorePath, McpStore } from "./store.ts";
export {
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  readCatalogServerFromDisk,
  loadDisabledTools,
  saveDisabledTools,
  parseDisabledTools,
} from "./middleware-state.ts";
export type { PersistedCatalogServer } from "./middleware-state.ts";
