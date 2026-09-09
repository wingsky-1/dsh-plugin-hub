/**
 * dsh-provider-usage — domain1/registry/ 适配器注册域对外门面（C2）。
 *
 * registry 为公开管理对象（layer-architecture §2 C2 裁定）：判断面
 * （getEntry/hasCandidates 等）不收口，本面导出其全部公开方法与类型；
 * 目录外（pipeline/routes/apply/domain2）一律经本文件消费，目录内互引直连。
 * 最小面 = 逐个命名导出，禁整文件 re-export。
 */

// ------------------------------------------------------------------ 注册表（registry.ts）

export { makeAdapterRegistry } from "./registry.ts";
export type {
  AdapterSource,
  AdapterErrorInfo,
  AdapterInfo,
  ReplaceFileResult,
  AdapterRegistry,
} from "./registry.ts";

// ------------------------------------------------------------------ 用户适配器持久化（user-adapters.ts）

export {
  userAdaptersFile,
  adapterStateFile,
  parseUserAdapters,
  readUserAdapters,
  readAdapterStateResult,
  readAdapterState,
  writeAdapterState,
  resolveAddAdapterFile,
} from "./user-adapters.ts";
export type { UserAdapterRecord } from "./user-adapters.ts";

// ------------------------------------------------------------------ 用户适配器加载校验（user-adapter-loader.ts）

export { loadUserHostAdapterFile, loadUserAdapterChecked } from "./user-adapter-loader.ts";

// ------------------------------------------------------------------ 热更新（hotreload.ts）

export { readStamp, stampEqual, loadAndValidateAdapter, HotReloadableAdapter } from "./hotreload.ts";

// ------------------------------------------------------------------ 模型配置读取（provider-config.ts）

export { credentialsFile, opencodeAuthFile, resolveProviderConfig } from "./provider-config.ts";
export type { ProviderConfigInput, ResolvedProviderConfig } from "./provider-config.ts";

// ------------------------------------------------------------------ 路径解析（path-resolve.ts）

export { pluginHome, expandHomePath, resolvePath } from "./path-resolve.ts";
