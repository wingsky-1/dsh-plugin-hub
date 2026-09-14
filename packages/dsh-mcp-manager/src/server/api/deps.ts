/**
 * dsh-mcp-manager — api/deps.ts：API 层域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准）：路由控制器取 workspace 域的
 * scope 归一化 / 全名解析 / 工具名归一化 / 中间层模式归一化（真实使用行见
 * routes-controllers.ts:109/164/320/370/394），以及 config/model 子层的 mcpServers JSON
 * 解析（routes-controllers.ts:323）。宿主能力实测 0 命中（无 ctx/Context/logger/settings），
 * 故只有两条 Port——比 §3.4/§3.5 表的预期窄得多，按实测收窄。
 *
 * **不为 `manager` 开口**（附录 G·G19 + D.3·37）：本域对 `RoutesManager` 的 44 处直取走的是
 * 结构参数类型、**没有 import 边**，而 `connection/interface.ts` 今天一个 manager 能力都没
 * 导出（§3.5 表里那 30 个成员名在门面 grep 命中 0）——物理上开不出 Port。把 22 个成员命名成
 * 能力对象不在本刀范围（附录 G·G19；D.3·37），归后续刀。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：端口成员 = 域内真实的消费点。
 * 跨端契约常量 SCOPE_PROJECT / MIDDLEWARE_GLOBAL_ROOT 已按 §3.6 规则 6 迁 `src/shared/`
 * （W3b），消费方直接从 `src/shared/interface.ts` 取，不在端口面内。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。域内取数一律经
 * `impl/service` 的 `apiPorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as workspaceApi from "../workspace/interface.ts";
import type * as configModelApi from "../config/interface.ts";

/** workspace 域给本域的能力面：scope 归一化 / 全名解析 / 工具名归一化 / 中间层模式归一化。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "normalizeScope" | "parseFullServerName" | "normalizeToolName" | "normalizeMiddlewareMode"
>;

/** config/model 子层给本域的能力面：mcpServers JSON 导入解析。 */
export type ConfigModelPort = Pick<typeof configModelApi, "parseClaudeJson">;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installApi` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface ApiDeps {
  /** workspace 域：scope 归一化 / 全名解析 / 工具名归一化 / 中间层模式归一化。 */
  workspace: WorkspacePort;
  /** config/model 子层：mcpServers JSON 导入解析。 */
  configModel: ConfigModelPort;
}
