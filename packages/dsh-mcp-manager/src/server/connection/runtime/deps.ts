/**
 * dsh-mcp-manager — connection/runtime/deps.ts：连接域 runtime 子层的对上依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本子层运行时能力消费非零（决策⑥ 以运行时能力消费为准），按提供方分三组：catalog 取目录新鲜判定
 * 与工具装箱；pipeline 取两执行路径共用的结果投影、超时兜底、错误取消息、凭据脱敏、参数归一与
 * 策略裁决族；workspace 取全名解析 / 归一与拼装。宿主能力实测 0 命中——本子层的 ctx 面是
 * `MiddlewareHost` 构造入参，不经端口。
 *
 * 两条**不为零消费者开口**的裁量（附录 H·1·4 实测）：`RECONNECT_DEFAULTS` / `resolveReconnect` /
 * `ReconnectPolicy` / `createTransport` / `CATALOG_LRU_MAX` 在本子层内部经 `./reconnect.ts` /
 * `./transport.ts` / `./limits.ts` 直取，域外零消费者，故不进任何 Port（端口只承载跨域能力，
 * 同子层直引不是跨域值边）。
 *
 * `SCOPE_GLOBAL` 与 `MIDDLEWARE_GLOBAL_ROOT` 不在 WorkspacePort 内：W3b 已按跨端性把它们收到
 * `src/shared/constants.ts`（两端唯一物理定义），本子层直接取共享层门面——指向共享层的值边是
 * I2① 明确允许的出口，不算域间值边。
 *
 * 类型面（`ServerConfig` / `ToolDefinition` 等）走 `import type` 直连各自门面，不进 Pick：
 * 类型边编译期擦除，不是本子层要取的运行时能力。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。子层内取数一律经
 * `impl/service` 的 `runtimePorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as catalogApi from "../../catalog/interface.ts";
import type * as pipelineApi from "../../pipeline/interface.ts";
import type * as workspaceApi from "../../workspace/interface.ts";

/** catalog 域给本子层的能力面：目录新鲜判定与工具装箱。 */
export type CatalogPort = Pick<typeof catalogApi, "isCatalogFresh" | "boundCatalogTools">;

/** pipeline 域给本子层的能力面：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决。 */
export type PipelinePort = Pick<
  typeof pipelineApi,
  | "defaultCallResultFallbackText"
  | "projectCallToolResult"
  | "withTimeout"
  | "msgOf"
  | "createRedactor"
  | "normalizeArguments"
  | "policyAllows"
  | "policyDenialReason"
  | "isToolDenied"
  | "toolDisabledReason"
>;

/** workspace 域给本子层的能力面：`@<root>/<server>` 全名解析、工具名归一与全名拼装。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "parseFullServerName" | "normalizeToolName" | "fullServerName"
>;

/**
 * 装配入参：本子层依赖的全部外部。键集与组合根 `installRuntime` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface RuntimeDeps {
  /** catalog 域：目录新鲜判定与工具装箱。 */
  catalog: CatalogPort;
  /** pipeline 域：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决。 */
  pipeline: PipelinePort;
  /** workspace 域：全名解析、工具名归一与全名拼装。 */
  workspace: WorkspacePort;
}
