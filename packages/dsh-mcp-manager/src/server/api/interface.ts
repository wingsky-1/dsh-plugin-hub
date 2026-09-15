/**
 * dsh-mcp-manager — api/interface.ts：API 层门面（D10，#664 阶段 6）。
 *
 * API 层 = 路由装配（routes）+ 端点控制器（routes-controllers）+ 查询辅助
 * （routes-helpers）。目录外模块**只能**从这里引用（verify-dir-imports
 * 静态强制）。
 *
 * 本域**有对上依赖**（§3.1 规则 2；决策⑥ 以运行时能力消费为准）：路由控制器取 workspace
 * 域的 scope/全名/工具名/模式归一化与 config/model 子层的 mcpServers JSON 解析（`deps.ts`
 * 的两条 Port）。域内实现一律经 `impl/service` 的端口持有者取数——W9 接线后 I2① 的
 * `api|workspace` 与 `api|config/model` 两条值边消失，域间只剩类型边。对 `manager` 的
 * 结构参数消费没有 import 边，不在本刀范围（附录 G·G19，归 W10）。
 */
import type { ApiDeps } from "./deps.ts";
import { apiPorts } from "./impl/service/index.ts";

/**
 * 装配 API 层域：把组合根持有的两组端口写入域内注册表（见 impl/service）。组合根在
 * `src/index.ts` 顶层调用，模块求值期即完成——两条 Port 全是静态模块引用，不需要宿主 ctx。
 *
 * 为什么不是 `export async function`：注入面对账（verify-dir-imports 的
 * analyzeInjectionFaces）按 `export function installXxx(` 采点，`async` 前缀会让这条对账
 * 静默失明（附录 G·G12）。本域装配是纯同步写标记，签名保持同步形态即可。
 */
export function installApi(deps: ApiDeps): void {
  apiPorts.install(deps);
}

/** 卸载 API 层域。只复位装配标记：本域读的是外部递进来的能力，没有活资源要释放。 */
export function releaseApi(): void {
  apiPorts.release();
}

export {
  ROUTES,
  queryParam,
  makeRoutes,
  makeEventsRoute,
  makeHealthRoute,
  uiConfigChangedFrame,
  broadcastFrame,
  SSE_HEARTBEAT_MS,
  SSE_PING_FRAME,
} from "./routes.ts";
export type { ServerStatus } from "./impl/health/type.ts";
