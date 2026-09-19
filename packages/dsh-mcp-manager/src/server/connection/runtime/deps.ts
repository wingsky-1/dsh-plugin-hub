/**
 * dsh-mcp-manager — connection/runtime/deps.ts：连接域 runtime 子层的对上依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本子层运行时能力消费非零（决策⑥ 以运行时能力消费为准），按提供方分六组：catalog 取目录的
 * 投影写口与读口（#767 S1-3b：目录内存态与 last-good 均已搬进该域，本子层只剩调用点）；config 取配置模板 ${ENV} 预展开与凭据词根（#767 S1-1 迁入 config 域后经端口取用）；
 * pipeline 取两执行路径共用的结果投影、超时兜底、错误取消息、凭据脱敏、参数归一与
 * 策略裁决族；workspace 取全名解析 / 归一与拼装；servers/dispatch 取 ws_mcp_call 执行器
 * （#767 S1-3a 的执行路径搬迁：转发壳在本子层，执行器在新域，值经本端口递入）；
 * servers/lifecycle 取官方实例的装载 / 拆卸 / 六态投影（#767 S1-4d 换引擎：本子层不再自建
 * 连接栈，连接生命周期整体交还该域的账本）。宿主能力实测
 * 0 命中——本子层的 ctx 面以
 * `ManagerLite` / `MiddlewareHost` 两条构造入参类型就地声明（#767 W11b2a 自 types/host-faces.ts
 * 落位本文件），不经端口。
 *
 * 两条**不为零消费者开口**的裁量（附录 H·1·4 实测）：`CATALOG_TTL_MS` 一族在本子层内部经
 * `./limits.ts` 直取，域外零消费者，故不进任何 Port（端口只承载跨域能力，同子层直引不是
 * 跨域值边）。#767 S1-5c 之前另有一条同类裁量覆盖 reconnect / transport 两文件的符号，随自研
 * 连接栈整体退役一并消失。
 *
 * `SCOPE_GLOBAL` 与 `MIDDLEWARE_GLOBAL_ROOT` 不在 WorkspacePort 内：W3b 已按跨端性把它们收到
 * `src/shared/constants.ts`（两端唯一物理定义），本子层直接取共享层门面——指向共享层的值边是
 * I2① 明确允许的出口，不算域间值边。
 *
 * 类型面（`ServerConfig` / `ProjectUnit` / `McpStore` / `ToolDefinition` 等）走 `import type`
 * 直连各自门面，不进 Pick：类型边编译期擦除，不是本子层要取的运行时能力。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。子层内取数一律经
 * `impl/service` 的 `runtimePorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type * as catalogApi from "../../catalog/interface.ts";
import type * as configApi from "../../config/interface.ts";
import type * as dispatchApi from "../../servers/dispatch/interface.ts";
import type * as lifecycleApi from "../../servers/lifecycle/interface.ts";
import type * as pipelineApi from "../../pipeline/interface.ts";
import type * as workspaceApi from "../../workspace/interface.ts";
import type { ServerConfig } from "../../config/interface.ts";
import type { McpStatsCollector } from "../../stats/interface.ts";
import type { ProjectUnit } from "./impl/middleware/type.ts";

/**
 * catalog 域给本子层的能力面：目录的投影写口 + 读口（#767 S1-3b 目录内存态搬迁后换面）。
 *
 * 常量与纯检索函数不再出现：`isCatalogFresh`/`boundCatalogTools` 已被投影本体吸收进 catalog
 * 域，本子层的调用点全部改经 `projectRegisteredTools`/`projectWrappedTools`。`redact` 与
 * `isRuntimeServer` 走投影入参而**不**进端口：前者是本子层的凭据脱敏闭包，后者是组合根
 * 的宿主事实，两者都不是 catalog 域要自己取的能力。
 */
export type CatalogPort = Pick<typeof catalogApi, "catalogDirectory">;

/** pipeline 域给本子层的能力面：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 禁用裁决。 */
export type PipelinePort = Pick<
  typeof pipelineApi,
  | "defaultCallResultFallbackText"
  | "projectCallToolResult"
  | "withTimeout"
  | "msgOf"
  | "createRedactor"
  | "normalizeArguments"
  | "isToolDenied"
  | "toolDisabledReason"
>;

/** config 域给本子层的能力面：配置模板 ${ENV} 预展开与凭据词根（stdio 子进程环境过滤）。 */
export type ConfigEnvPort = Pick<typeof configApi, "expandEnvObject" | "SECRET_ENV_NAME">;

/** workspace 域给本子层的能力面：`@<root>/<server>` 全名解析、工具名归一与全名拼装。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "parseFullServerName" | "normalizeToolName" | "fullServerName"
>;

/**
 * servers/dispatch 域给本子层的能力面：ws_mcp_call 执行器（#767 S1-3a）。
 *
 * 这是**过渡期**的下游端口：执行路径已搬出本子层（middleware.callTool 只剩转发壳），但转发壳
 * 与它签发的工具都还住在 connection/runtime，值只能经本子层的端口表递进来——直引新域门面会
 * 新增一条域间值边（I2①）。S1-4 接线后壳消失，本端口随 middleware.ts 一并删除。
 */
export type DispatchPort = Pick<typeof dispatchApi, "executeMcpCall">;

/**
 * servers/lifecycle 域给本子层的能力面：装载 / 拆卸 / 六态投影。
 *
 * 这是换引擎后中间层**唯一**的连接入口：官方实例由 lifecycle 的账本持有，本子层不再自建
 * transport 与 client，装载只能经此端口、拆卸只能经此端口（直引该域门面会产生一条 I2① 值边）。
 * 只取生命周期符号，不取 `mountLedger` 对象本身——账本类未导出，Pick 出的实例类型不可名。
 */
export type LifecyclePort = Pick<
  typeof lifecycleApi,
  "mountServer" | "releaseServer" | "disposeServer" | "projectServerState"
>;

/**
 * 装配入参：本子层依赖的全部外部。键集与组合根 `installRuntime` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface RuntimeDeps {
  /** catalog 域：目录新鲜判定与工具装箱。 */
  catalog: CatalogPort;
  /** config 域：配置模板预展开与凭据词根。 */
  configEnv: ConfigEnvPort;
  /** servers/dispatch 域：ws_mcp_call 执行器（过渡端口，见 DispatchPort）。 */
  dispatch: DispatchPort;
  /** servers/lifecycle 域：官方实例的装载 / 拆卸 / 六态投影。 */
  lifecycle: LifecyclePort;
  /** pipeline 域：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决。 */
  pipeline: PipelinePort;
  /** workspace 域：全名解析、工具名归一与全名拼装。 */
  workspace: WorkspacePort;
}

/** McpManager 最小面（supervisor 使用；避免 index↔supervisor 循环 import）。
 * tools 面取官方 Context，register 入参为官方 ToolDefinition。 */
export interface ManagerLite {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  emitStatus(): void;
  recordCatalogTools(
    serverName: string,
    toolMeta: Map<string, { description?: unknown }>,
  ): Promise<void>;
  /**
   * 行为扩展（#664 阶段 2）：调用统计最小面，supervisor 直呼路径埋点。
   * 必填（#767 终态评审）：组合根建的 McpManager 恒有 stats（manager.ts 构造期 new），
   * 假体漏填即类型报错——可选会让「漏填」退化成静默不埋点。
   */
  stats: Pick<McpStatsCollector, "isEnabled" | "recordCall">;
}

/** 中间层宿主最小面（McpManager 实现；McpMiddleware 构造注入）。 */
export interface MiddlewareHost {
  ctx: Pick<Context, "tools">;
  logger: LoggerService;
  /** 按 root 读取项目级服务器配置（惰性；root 无标记 → undefined）。 */
  projectServersFor(root: string): Promise<ServerConfig[] | undefined>;
  /** 脱敏秘密源的同步快照（#770-8）：持有 store/projectStores/runtimeRegistry 的一侧
   *（McpManager.getRedactionServers）提供，全集含 disabled/unconnected。中间层与派发域的
   * 脱敏只经此口取值，不在中间层内拼全集、不跨域直取对方状态；同步形态是刻意选择——
   * redact/callTool 是同步路径，同步内不可 await 按 root 取配置的 async 口。 */
  redactionServers(): readonly ServerConfig[];
  /** 全局服务器配置（@global 单元装载用）。 */
  globalServers(): ServerConfig[];
  /** 路由解析：cwd → 归一化项目根。 */
  normalizedProjectRoot(cwd: string | undefined): Promise<string | undefined>;
  /** 持久化 userDisabled。 */
  saveUserState(units: Map<string, ProjectUnit>): Promise<void>;
  /** 状态变化通知（SSE 标脏）。 */
  emitStatus(): void;
  /** 目录缓存文件路径（last-good 持久化；由本层算好按入参递进 catalog 域，本域不推路径）。 */
  catalogCachePath(root: string): string;
  /** 该 server 是否全局级（双源：store.data.servers + runtimeRegistry；runtime 注册的服务器不落 store）。 */
  isGlobalServer(name: string): boolean;
  /** 该 server 是否 runtime 注入（registerServer 内存态；目录不写盘判定，#413）。 */
  isRuntimeServer(name: string): boolean;
  /**
   * 连接成功后把该服务器的工具体写进 B 层目录摘要缓存（digest 的稳定数据源）。
   *
   * 为什么仍在：这条落点原是直连账本 `mountEntry` 结算路径的行为，单池（#767 笔 1a）
   * 后由池侧 continue 喂——`/health.catalogCacheEntries` 与注入端目录视图的 B 层兜底
   * 都读它，停了就是对外可观察的行为变化。取数源与目录投影同一次注册面读取。
   * 缺省（未给该成员）视为「无 B 层」——只驱动池自身的夹具不必实现它。
   */
  recordCatalogTools?(
    serverName: string,
    tools: Map<string, { description?: unknown }>,
  ): Promise<void>;
}
