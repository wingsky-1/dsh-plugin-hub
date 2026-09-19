/**
 * dsh-provider-usage — server/registry 域对外门面（#768 D7：registry 新域）。
 *
 * 域承诺 = 候选 + 唯一启用（registry.ts：同 provider 多候选、任一时刻一启用，
 * select 切换/清空，snapshot 快照）+ 错误登记（recordError 最近一次，
 * load/exec 两态，同 key 覆盖）+ 用户适配器持久化（user-adapters.ts）+
 * 加载校验（user-adapter-loader.ts）+ 热更新（hotreload.ts）+
 * 模型配置读取（provider-config.ts）+ 路径解析（path-resolve.ts）：
 * registry 为公开管理对象（layer-architecture §2 C2 裁定）：判断面
 * （getEntry/hasCandidates 等）不收口，本面导出其全部公开方法与类型；
 * 目录外（apply/路由/server/pipeline/server/adapters/domain2）一律经本文件消费，
 * 目录内互引直连。最小面 = 逐个命名导出，禁整文件 re-export。
 *
 * 复用边界（与 D6 pipeline 域同形）：
 * - 业务域（server/pipeline 经本门面复用提供商配置解析与适配器状态读写原语；
 *   server/adapters 经 BuiltinRegistryPort 收窄复用 register 内置一源；
 *   路由经本门面复用加载校验与路径准入）；
 * - 注入面见 deps.ts（RegistryDiag/RegistrySanitize 命名接缝与块内联双生子）。
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

export {
  readStamp,
  stampEqual,
  loadAndValidateAdapter,
  HotReloadableAdapter,
} from "./hotreload.ts";

// ------------------------------------------------------------------ 模型配置读取（provider-config.ts）

export { credentialsFile, opencodeAuthFile, resolveProviderConfig } from "./provider-config.ts";
export type { ProviderConfigInput, ResolvedProviderConfig } from "./provider-config.ts";

// ------------------------------------------------------------------ 路径解析（path-resolve.ts）

export { pluginHome, expandHomePath, resolvePath } from "./path-resolve.ts";
