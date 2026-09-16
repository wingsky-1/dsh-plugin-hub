/**
 * dsh-mcp-manager — connection/orchestrator/deps.ts：连接编排子层的对上依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本子层运行时能力消费非零（决策⑥ 以运行时能力消费为准），按提供方分七组：catalog 取目录缓存
 * 文件路径、工具描述摘要与目录视图工厂；config 域取配置归一化三函数；store 域取 store
 * 类与 user-state / 工具禁用 / 目录缓存路径的读写面；connection/runtime 取监督器与中间层两个类；
 * pipeline 取错误取消息与凭据脱敏；stats 取调用统计收集器；workspace 取项目根发现与 scope 归一。
 * 宿主能力实测 0 命中（无 ctx/Context/logger/settings 取自门面）——本子层的 ctx 与 store 是
 * 构造入参，不经端口。
 *
 * SCOPE_GLOBAL / SCOPE_PROJECT / MIDDLEWARE_GLOBAL_ROOT 不在 WorkspacePort 内：W3b 已按跨端性把它们
 * 收到 `shared/constants.ts`（两端唯一物理定义），本子层直接取共享层门面——指向共享层的值边是
 * I2① 明确允许的出口，不算域间值边。
 *
 * 类型面（CatalogCache / CatalogViewResolver / ServerConfig 等）走 `import type` 直连各自门面，
 * 不进 Pick：类型边编译期擦除，不是本子层要取的运行时能力。McpStore 是刻意的例外——它既是类型
 * 又是值（`new McpStore(...)`），故必须进 ConfigStorePort。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。子层内取数一律经
 * `impl/service` 的 `orchestratorPorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as catalogApi from "../../catalog/interface.ts";
import type * as configModelApi from "../../config/interface.ts";
import type * as configStoreApi from "../../store/interface.ts";
import type * as statsApi from "../../stats/interface.ts";
import type * as workspaceApi from "../../workspace/interface.ts";
import type * as runtimeApi from "../runtime/interface.ts";
import type * as pipelineApi from "../../pipeline/interface.ts";

/** catalog 子域给本子层的能力面：目录缓存文件路径、描述摘要、目录视图工厂，以及目录条目的
 * 读/删口（#767 S1-3b：remove/update 清幽灵条目与 summarize 的目录投影都经此）。 */
export type CatalogPort = Pick<
  typeof catalogApi,
  "catalogCacheFile" | "summarizeToolDescriptions" | "makeCatalogViewFor" | "catalogDirectory"
>;

/** config 域给本子层的能力面：服务器条目与 UI 配置归一化、UI 配置补丁构造。 */
export type ConfigModelPort = Pick<
  typeof configModelApi,
  "normalizeServer" | "normalizeUiConfig" | "buildConfigUiPatch"
>;

/** store 域给本子层的能力面：store 类 + user-state / 工具禁用 / 目录缓存路径的读写面。 */
export type ConfigStorePort = Pick<
  typeof configStoreApi,
  | "McpStore"
  | "userStateFile"
  | "loadUserState"
  | "saveUserState"
  | "catalogCacheFileFor"
  | "loadDisabledTools"
  | "saveDisabledTools"
>;

/** runtime 子层给本子层的能力面：单服务器监督器与中间层池两个类（均以 `new` 消费）。 */
export type RuntimePort = Pick<typeof runtimeApi, "ConnectionSupervisor" | "McpMiddleware">;

/** pipeline 域给本子层的能力面：错误取消息与凭据脱敏器工厂。 */
export type PipelinePort = Pick<typeof pipelineApi, "msgOf" | "createRedactor">;

/** stats 域给本子层的能力面：调用统计收集器（以 `new` 消费）。 */
export type StatsPort = Pick<typeof statsApi, "McpStatsCollector">;

/** workspace 域给本子层的能力面：项目根发现、归一化与 scope 归一。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "normalizeScope" | "findProjectRoot" | "normalizedProjectRoot"
>;

/**
 * 装配入参：本子层依赖的全部外部。键集与组合根 `installOrchestrator` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface OrchestratorDeps {
  /** catalog 子域：目录缓存文件路径、描述摘要与目录视图工厂。 */
  catalog: CatalogPort;
  /** config 域：配置归一化三函数。 */
  configModel: ConfigModelPort;
  /** store 域：store 类与状态持久化读写面。 */
  configStore: ConfigStorePort;
  /** runtime 子层：监督器与中间层两个类。 */
  runtime: RuntimePort;
  /** pipeline 域：错误取消息与凭据脱敏。 */
  pipeline: PipelinePort;
  /** stats 域：调用统计收集器。 */
  stats: StatsPort;
  /** workspace 域：项目根发现与 scope 归一。 */
  workspace: WorkspacePort;
}
