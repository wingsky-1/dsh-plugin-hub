/**
 * dsh-mcp-manager — connection/orchestrator/interface.ts：连接域 orchestrator 子层门面（D10）。
 *
 * orchestrator = 仲裁/双轨/summary/事件出口（manager 类，阶段 6 集中搬移落位
 * 本目录）+ 展示投影（tool-names）。连接域外部一律经 ../interface.ts 引用。
 *
 * 本子层**有对上依赖**（§3.1 规则 2；决策⑥ 以运行时能力消费为准）：catalog / config/model /
 * config/store / connection/runtime / pipeline / stats / workspace 七组能力（`deps.ts` 的七条
 * Port）。子层内实现一律经 `impl/service` 的端口持有者取数——W7 接线后 I2① 的七条
 * `connection/orchestrator|*` 值边消失，跨域只剩类型边。
 */
import type { OrchestratorDeps } from "./deps.ts";
import { orchestratorPorts } from "./impl/service/index.ts";

/**
 * 装配连接编排子层：把组合根持有的七组端口写入子层内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——七条 Port 全是静态模块引用，不需要宿主 ctx。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的 analyzeInjectionFaces）
 * 按 `export function installXxx(` 采点，`async` 前缀会让这条对账静默失明（附录 G·G12）。
 * 本子层装配是纯同步写标记，签名保持同步形态即可。
 */
export function installOrchestrator(deps: OrchestratorDeps): void {
  orchestratorPorts.install(deps);
}

/** 卸载连接编排子层。只复位装配标记：本子层读的是外部递进来的能力，没有活资源要释放。 */
export function releaseOrchestrator(): void {
  orchestratorPorts.release();
}

export { stripMcpPrefix } from "./tool-names.ts";
export { McpManager } from "./manager.ts";
