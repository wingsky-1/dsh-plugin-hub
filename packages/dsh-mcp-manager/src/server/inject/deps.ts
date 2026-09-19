/**
 * dsh-mcp-manager — inject/deps.ts：工具注册域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准）：工具注册面取四个提供域的能力
 * ——catalog 的检索族（`searchCatalogMulti` / `listCatalog` / `findToolDetail`）、runtime
 * 的限额常量（`CONNECT_TIMEOUT_MS` / `DISCOVERY_TIMEOUT_MS` / `CALL_TIMEOUT_MS` /
 * `LIST_MAX_TOOLS_PER_SERVER`）、pipeline 的超时兜底与工具级禁用裁决（`withTimeout` /
 * `isToolDenied` / `toolDisabledReason`）、
 * workspace 的全名解析与拼装（`parseFullServerName` / `fullServerName`）。宿主能力实测 0
 * 命中（无 ctx/Context/logger/settings），故只有四条 Port——比 §3.4 表的预期窄，按实测收窄。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：端口成员 = 域内真实的消费点
 * （逐符号使用行见 middleware-register.ts）。跨端契约常量 MIDDLEWARE_GLOBAL_ROOT 与 ≥2 域消费
 * 的值常量 LIST_DEFAULT_TOOLS_PER_SERVER 已按 §3.6 规则 6 迁共享层（W3b），本域直接取自
 * `shared/` 与 `server/shared/` 门面，故不在端口面内——不为零消费者的符号开口。
 *
 * 类型面（`McpMiddleware` / `DisabledToolsMap` / `McpStatsCollector`）
 * 走 `import type` 直连各自门面，不进 Pick：类型边编译期擦除，不是本域要取的运行时能力。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。域内取数一律经
 * `impl/service` 的 `injectPorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as catalogApi from "../catalog/interface.ts";
import type * as runtimeApi from "../connection/runtime/interface.ts";
import type * as pipelineApi from "../pipeline/interface.ts";
import type * as workspaceApi from "../workspace/interface.ts";

/**
 * catalog 域给本域的能力面：目录检索族（多 root 搜索 / 全量列表 / 单工具详情）+ 目录读口
 * （#767 S1-3b：`visibleProjectServers` 与全局服务器判定改经 `catalogDirectory` 读目录，
 * 单元表已不再持目录）。
 */
export type CatalogPort = Pick<
  typeof catalogApi,
  "searchCatalogMulti" | "listCatalog" | "findToolDetail" | "catalogDirectory"
>;

/** runtime 域给本域的能力面：连接/发现/调用超时与列表装箱上限常量。 */
export type RuntimeLimitsPort = Pick<
  typeof runtimeApi,
  "CONNECT_TIMEOUT_MS" | "DISCOVERY_TIMEOUT_MS" | "CALL_TIMEOUT_MS" | "LIST_MAX_TOOLS_PER_SERVER"
>;

/** pipeline 域给本域的能力面：超时兜底与工具级禁用裁决（裁决 / 禁用文案）
 * + 调用统计落盘前的错误脱敏（#770-A4：msgOf 取文案、createRedactor 按 C 快照脱敏；
 * 收集器保持纯，不引 pipeline，脱敏是调用方的职责）。 */
export type PipelinePort = Pick<
  typeof pipelineApi,
  "withTimeout" | "isToolDenied" | "toolDisabledReason" | "msgOf" | "createRedactor"
>;

/** workspace 域给本域的能力面：`@<root>/<server>` 全名解析与拼装。 */
export type WorkspacePort = Pick<typeof workspaceApi, "parseFullServerName" | "fullServerName">;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installInject` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface InjectDeps {
  /** catalog 域：目录检索族。 */
  catalog: CatalogPort;
  /** runtime 域：连接/发现/调用超时与列表装箱上限常量。 */
  runtime: RuntimeLimitsPort;
  /** pipeline 域：超时兜底与策略裁决族。 */
  pipeline: PipelinePort;
  /** workspace 域：全名解析与拼装。 */
  workspace: WorkspacePort;
}
