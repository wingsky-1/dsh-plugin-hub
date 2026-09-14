/**
 * dsh-mcp-manager — connection/runtime/interface.ts：连接域 runtime 子层门面（D10）。
 *
 * runtime = supervisor 代际 / 中间层池 / transport / protocol / limits（阶段 6
 * 集中搬移完成，实现均已落位本目录）。连接域外部一律经 ../interface.ts 引用，
 * 本文件只被连接域内部与 index.ts 汇聚转发。
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

export { RECONNECT_DEFAULTS, resolveReconnect } from "./reconnect.ts";
export type { ReconnectPolicy } from "./reconnect.ts";
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  publicToolName,
  truncateText,
  assertSupportedOutputSchema,
  buildToolDefinition,
  ConnectionSupervisor,
} from "./supervisor.ts";
export { McpMiddleware } from "./middleware.ts";
export {
  expandEnv,
  HttpTransport,
  parseSsePayload,
  StdioTransport,
  createTransport,
} from "./transport.ts";
export { MCPClient } from "./protocol.ts";
export {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  CATALOG_TTL_MS,
  CATALOG_LRU_MAX,
  MAX_TOOLS_PER_SERVER,
  MAX_BYTES_PER_TOOL,
  MAX_TOTAL_CATALOG_BYTES,
  LIST_DEFAULT_TOOLS_PER_SERVER,
  LIST_MAX_TOOLS_PER_SERVER,
} from "./limits.ts";
