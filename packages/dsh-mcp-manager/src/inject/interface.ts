/**
 * dsh-mcp-manager — inject/interface.ts：工具注册域（inject）门面（D10，#664 阶段 6）。
 *
 * 工具注册面：ws_mcp_* 四原子 + pre-execute guard（registerMiddlewareTools /
 * registerDirectMcpGuard）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 *
 * 本域**有对上依赖**（§3.1 规则 2；决策⑥ 以运行时能力消费为准）：catalog 检索族 / runtime
 * 限额常量 / pipeline 裁决族 / workspace 全名解析（`deps.ts` 的四条 Port）。域内实现一律经
 * `impl/service` 的端口持有者取数——W6 接线后 I2① 的 `inject|catalog`、
 * `inject|connection/runtime`、`inject|pipeline`、`inject|workspace` 四条值边消失，
 * 域间只剩类型边。
 */
import type { InjectDeps } from "./deps.ts";
import { injectPorts } from "./impl/service/index.ts";

/**
 * 装配工具注册域：把组合根持有的四组端口写入域内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——四条 Port 全是静态模块引用，不需要宿主 ctx。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的
 * analyzeInjectionFaces）按 `export function installXxx(` 采点，`async` 前缀会让这条对账
 * 静默失明（附录 G·G12）。本域装配是纯同步写标记，签名保持同步形态即可。
 */
export function installInject(deps: InjectDeps): void {
  injectPorts.install(deps);
}

/** 卸载工具注册域。只复位装配标记：本域读的是外部递进来的能力，没有活资源要释放。 */
export function releaseInject(): void {
  injectPorts.release();
}

export { registerMiddlewareTools, registerDirectMcpGuard } from "./middleware-register.ts";
