/**
 * dsh-mcp-manager — store/interface.ts：持久化域唯一对外引用面（D10，#767 W11b2a）。
 *
 * store 域 = 配置持久化（impl/store）+ 用户状态/工具禁用/目录缓存 IO
 * （impl/middleware-state）。目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 */
export { defaultStorePath, McpStore } from "./impl/store.ts";
export {
  userStateFile,
  loadUserState,
  saveUserState,
  catalogCacheFileFor,
  readCatalogServerFromDisk,
  loadDisabledTools,
  saveDisabledTools,
  parseDisabledTools,
} from "./impl/middleware-state.ts";
export type { PersistedCatalogServer, DisabledToolsMap } from "./impl/middleware-state.ts";
