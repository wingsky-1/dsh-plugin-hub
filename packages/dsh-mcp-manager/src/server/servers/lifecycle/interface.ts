/**
 * dsh-mcp-manager — servers/lifecycle/interface.ts：装载生命周期域唯一对外引用面（D10）。
 *
 * 本域承诺：装载编排（发起 mount、记账、回收）、自持六态投影、连接与发现超时封装
 * （767-v6-STAGED-PLAN §2.1 的 K9 / K10；超时封装归此已决）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）；域内实现不被域外直引。
 *
 * 本域**有对上依赖**（deps.ts 的六条 Port）：宿主装载口、工具注册表查询与宿主日志导出器、
 * pipeline 的超时兜底、workspace 的 serverName 分配、config 的模板预展开。域内一律经
 * `impl/service` 的端口持有者取数，故域间只有类型边，没有值边。
 *
 * 本片（S1-4b）落**真装载**（`mountServer`：取 id → 官方 Config → 装载 → 等待窗口），但仍
 * **不进 `src/index.ts` 的装配表**：由单元测试用假 LoaderPort / 假 ToolsPort 驱动，接线在 S1-4c。
 */
import type { LifecycleDeps } from "./deps.ts";
import { mountLedger } from "./impl/ledger/index.ts";
import { lifecyclePorts } from "./impl/service/index.ts";

/**
 * 装配装载生命周期域：把组合根持有的端口写入域内注册表（见 impl/service）。调用点在
 * `src/index.ts` 的 `apply` 内而不是模块求值期——六条 Port 里的 loader 是**宿主服务**
 * （官方 loader 包不在 catalog、类型面取不到，只能经 `ctx.get` 现取），静态模块引用给不出来。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的 analyzeInjectionFaces）
 * 按 `export function installXxx(` 采点，`async` 前缀会让这条对账静默失明（附录 G·G12）。
 */
export function installLifecycle(deps: LifecycleDeps): void {
  lifecyclePorts.install(deps);
}

/**
 * 卸载装载生命周期域：先按账本逐条发起 dispose（主回收链），再复位装配标记。
 * 只发起、不等结算——官方 dispose 会等在途首连，挂死的服务器能把它拖到 SDK 的 60s 超时；
 * 需要等的时候用 `mountLedger.flushDisposals()`。
 */
export function releaseLifecycle(): void {
  mountLedger.release();
  lifecyclePorts.release();
}

/**
 * 释放一个已装载实例，只发起 dispose、不等结算。
 *
 * 为什么不等：官方 dispose 会等在途首连，挂死的服务器能把它拖到 SDK 的 60s 超时——拆除
 * （disconnect / remove / update / evict / 插件卸载）是同步语义，等它等于让 UI 与 reconcile 卡住。
 */
export function releaseServer(key: string): void {
  mountLedger.releaseOne(key);
}

/**
 * 释放一个已装载实例并等结算。
 *
 * 为什么必须等：官方 serverName 是整个应用根的活体预留，旧实例未结算就挂同名新实例会当场抛
 * 「serverName is already in use」（实测 §2.9-16），故重建路径必须先走这里再 mount。
 */
export function disposeServer(key: string): Promise<void> {
  return mountLedger.dispose(key);
}

export { mountLedger };
export type { LedgerEntry } from "./impl/ledger/index.ts";
export { projectServerState } from "./impl/state/index.ts";
export type { ServerStateInput } from "./impl/state/index.ts";
export { awaitMountWindow } from "./impl/timeout/index.ts";
export type { MountWindowInput, MountWindowOutcome } from "./impl/timeout/index.ts";
export { mountServer } from "./impl/mount/index.ts";
export type { MountServerInput, MountServerResult } from "./impl/mount/index.ts";
export {
  attributeOfficialLog,
  collectOfficialLogs,
  diagnosticText,
  officialLogText,
} from "./impl/logs/index.ts";
export type { OfficialLogCollector } from "./impl/logs/index.ts";
export type {
  ConfigPort,
  LifecycleDeps,
  PipelinePort,
  ToolsRegistryPort,
  WorkspacePort,
} from "./deps.ts";
