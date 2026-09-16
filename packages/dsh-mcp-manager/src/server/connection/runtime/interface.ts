/**
 * dsh-mcp-manager — connection/runtime/interface.ts：连接域 runtime 子层门面（D10）。
 *
 * runtime = 中间层池 / limits（阶段 6 集中搬移完成，实现均已落位本目录）。自研连接栈
 * protocol / transport / supervisor / reconnect 已在 #767 S1-5c 整体退役，由官方引擎承担。
 * 本子层的**值面**是子层对外的直接引用点（#767 B2a-wire W10：消费者不再经 ../interface.ts
 * 转出）；类型面仍可经 ../interface.ts 取。
 *
 * 本子层**有对上依赖**（§3.1 规则 2；决策⑥ 以运行时能力消费为准）：catalog / pipeline /
 * workspace 三组能力（`deps.ts` 的三条 Port）。子层内实现一律经 `impl/service` 的端口
 * 持有者取数——W8 接线后 I2① 的 `connection/runtime|catalog`、`connection/runtime|pipeline`、
 * `connection/runtime|workspace` 三条值边消失，跨域只剩类型边。
 */
import type { RuntimeDeps } from "./deps.ts";
import { runtimePorts } from "./impl/service/index.ts";

/**
 * 装配连接运行时子层：把组合根持有的三组端口写入子层内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——三条 Port 全是静态模块引用，不需要宿主 ctx。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的 analyzeInjectionFaces）
 * 按 `export function installXxx(` 采点，`async` 前缀会让这条对账静默失明（附录 G·G12）。
 * 本子层装配是纯同步写标记，签名保持同步形态即可。
 */
export function installRuntime(deps: RuntimeDeps): void {
  runtimePorts.install(deps);
}

/** 卸载连接运行时子层。只复位装配标记：本子层读的是外部递进来的能力，没有活资源要释放。 */
export function releaseRuntime(): void {
  runtimePorts.release();
}

export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
} from "../../shared/interface.ts";
export { McpMiddleware } from "./middleware.ts";
export {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./limits.ts";
export type { ProjectUnit, ConnectionEntry } from "./impl/middleware/type.ts";
