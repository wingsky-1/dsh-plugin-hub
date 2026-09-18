/**
 * dsh-mcp-manager — pipeline/interface.ts：执行管道域唯一对外引用面（D10，#664 阶段 2 首个应用）。
 *
 * 本目录（执行管道域）对外承诺：两执行路径（supervisor 直呼 / ws_mcp_call）共用的
 * 纯函数族——参数归一（args 块）、错误取消息（msg 块）、凭据脱敏（redact 块）、超时
 * 兜底（timeout 块）、授权匹配与工具级禁用裁决（authorize 块）、结果投影（project 块）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 *
 * 本域**有对上依赖**（§3.1 规则 2；决策⑥ 以运行时能力消费为准）：authorize 块取 workspace
 * 域的全名解析（`deps.ts` 的 WorkspacePort），宿主能力（ctx/Context/logger）实测
 * 0 命中。域内实现一律经 `impl/service` 的端口持有者取数——W5 接线后 I2① 的
 * `pipeline|workspace` 值边消失，域间只剩类型边。
 */
import type { PipelineDeps } from "./deps.ts";
import { pipelinePorts } from "./impl/service/index.ts";

/**
 * 装配执行管道域：把组合根持有的端口写入域内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——Port 是静态模块引用，不需要宿主 ctx。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的
 * analyzeInjectionFaces）按 `export function installXxx(` 采点，`async` 前缀会让这条对账
 * 静默失明（附录 G·G12）。本域装配是纯同步写标记，签名保持同步形态即可。
 */
export function installPipeline(deps: PipelineDeps): void {
  pipelinePorts.install(deps);
}

/** 卸载执行管道域。只复位装配标记：本域读的是外部递进来的能力，没有活资源要释放。 */
export function releasePipeline(): void {
  pipelinePorts.release();
}

export { normalizeArguments } from "./impl/args/index.ts";
export { msgOf } from "./impl/msg/index.ts";
export { createRedactor } from "./impl/redact/index.ts";
export { withTimeout } from "./impl/timeout/index.ts";
export { globMatch, isToolDenied, toolDisabledReason } from "./impl/authorize/index.ts";
export { defaultCallResultFallbackText, projectCallToolResult } from "./impl/project/index.ts";
export type { CallResultTextHandlers, ProjectedCallResult } from "./impl/project/index.ts";
