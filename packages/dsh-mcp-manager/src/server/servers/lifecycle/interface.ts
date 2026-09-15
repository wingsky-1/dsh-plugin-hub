/**
 * dsh-mcp-manager — servers/lifecycle/interface.ts：装载生命周期域唯一对外引用面（D10）。
 *
 * 本域承诺：装载编排（发起 mount、记账、回收）、自持六态投影、连接与发现超时封装
 * （767-v6-STAGED-PLAN §2.1 的 K9 / K10；超时封装归此已决）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）；域内实现不被域外直引。
 *
 * 本域**有对上依赖**（deps.ts 的两条 Port）：宿主装载口与 pipeline 的超时兜底。域内一律经
 * `impl/service` 的端口持有者取数，故域间只有类型边，没有值边。
 *
 * 本片（S1-2b）**不进 `src/index.ts` 的装配表**：骨架先落位，接线在 S1-3/S1-4。
 */
import type { LifecycleDeps } from "./deps.ts";
import { mountLedger } from "./impl/ledger/index.ts";
import { lifecyclePorts } from "./impl/service/index.ts";

/**
 * 装配装载生命周期域：把组合根持有的端口写入域内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——两条 Port 都是静态模块引用，不需要宿主 ctx。
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

export { mountLedger };
export type { LedgerEntry } from "./impl/ledger/index.ts";
export { projectServerState } from "./impl/state/index.ts";
export type { ServerStateInput } from "./impl/state/index.ts";
export { awaitMountWindow } from "./impl/timeout/index.ts";
export type { MountWindowInput, MountWindowOutcome } from "./impl/timeout/index.ts";
export type { LifecycleDeps, PipelinePort } from "./deps.ts";
