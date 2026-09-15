/**
 * dsh-mcp-manager — servers/lifecycle/deps.ts：装载生命周期域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费面有六条，都取「实际使用」而非「import 面」（附录 E.6 第 3 条）：
 * - 宿主装载口（LoaderPort）：官方引擎按包名解析 + 挂载，形状由 server/shared/host-faces.ts
 *   自持声明（官方 loader 包不在 catalog，仓库内不可解析，只能拿结构面）；
 * - 宿主工具注册表的查询面（schemas）：官方不暴露状态 API，六态只能靠工具注册面投影
 *   （设计 §3.1 输入面 B）；
 * - pipeline 域的超时兜底（withTimeout）：官方 Config 里没有连接超时（只有 toolCallTimeoutMs），
 *   「10s 内失败」这个产品语义只能由我方包在句柄等待上；
 * - workspace 域的 serverName 分配（idFor）：官方按注册作用域活体预留 serverName、同 owner
 *   重名当场抛，而「同一 bare 名在全局与某项目都配」是常见写法（§2.6 裁定 B）；
 * - config 域的模板预展开（expandServerEnv）：官方 env / headers 只接受字面量，而落盘配置
 *   必须保持模板形态，展开只能发生在交给官方之前（设计 §2.4）；
 * - 宿主日志面的导出器（LogsPort）：官方日志是本插件**唯一**能拿到的错因——成功连接零日志，
 *   失败与放弃重连才带 `mcp-client(<serverName>)` 前缀说话，而宿主默认既不打印也不落盘
 *   （实测 dsh.log 只有一行 URL、shipped web-app 无日志消费者），不接这条面，首连失败对用户
 *   就是静默的。
 *
 * 六条都在这里声明、由组合根在 `src/index.ts` 顶层递入；域内取数一律经 `impl/service` 的
 * `lifecyclePorts.get()`，域间因此只有类型边，没有值边。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。
 */
import type * as configApi from "../../config/interface.ts";
import type * as pipelineApi from "../../pipeline/interface.ts";
import type { LoaderPort, LogsPort, ToolsPort } from "../../shared/interface.ts";
import type { ServerIdTable } from "../../workspace/interface.ts";

/** pipeline 域给本域的能力面：超时兜底一样，用于装载等待窗口（§3.4）。 */
export type PipelinePort = Pick<typeof pipelineApi, "withTimeout">;

/** config 域给本域的能力面：env / headers 的 ${ENV} 预展开，交给官方前只做一次。 */
export type ConfigPort = Pick<typeof configApi, "expandServerEnv">;

/**
 * workspace 域给本域的能力面：装载作用域内的 serverName 分配。
 *
 * scope 传的是 **root**（项目根绝对路径或 @global），不是 global/project 词表：官方的判重面
 * 按 root 分开，用词表会把两个项目的同名服务器又并成一条（见 workspace/impl/server-id 头注释）。
 */
export type WorkspacePort = Pick<ServerIdTable, "idFor">;

/** 宿主工具注册表的查询面：只取 `schemas`，注册仍归 loader 挂上的官方实例自己做。 */
export type ToolsRegistryPort = Pick<ToolsPort, "schemas">;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installLifecycle` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 *
 * 刻意不含 `idFactory`：id 的生成与 `(scope,name)→id` 表归 workspace 域（767-v6-STAGED-PLAN
 * §2.6 裁定 B），本域只经 `workspace.idFor` 取结果、账本键由调用方给字符串。
 */
export interface LifecycleDeps {
  /** 宿主能力面：官方引擎的装载口。 */
  loader: LoaderPort;
  /** 宿主能力面：工具注册表查询（六态投影的输入面 B）。 */
  tools: ToolsRegistryPort;
  /** pipeline 域：装载等待窗口的超时兜底。 */
  pipeline: PipelinePort;
  /** workspace 域：serverName 分配。 */
  workspace: WorkspacePort;
  /** config 域：官方 Config 构造前的模板预展开。 */
  config: ConfigPort;
  /** 宿主能力面：官方日志导出器，装载窗口内收集错因。 */
  logs: LogsPort;
}
