/**
 * dsh-mcp-manager — pipeline/deps.ts：执行管道域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准，附录 E.4）：authorize 块取
 * workspace 域的全名解析（真实消费点：`parseFullServerName` 一处）。宿主能力实测 0 命中
 * （无 ctx/Context/logger/settings），故只有一条 Port——比 §3.4 表的
 * 预期「workspace + 宿主 logger」窄，按实测收窄。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：端口成员 = 域内真实的消费点。
 * `fullServerName` / `bareServerName` 本域从不引用（#767 笔 2 删策略族后只剩
 * `parseFullServerName`），端口不为零消费者的符号开口；跨端契约常量 MIDDLEWARE_GLOBAL_ROOT
 * 已按 §3.6 规则 6 迁 `src/shared/constants.ts`（W3b），故不在端口面内。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。域内取数一律经
 * `impl/service` 的 `pipelinePorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as workspaceApi from "../workspace/interface.ts";

/** workspace 域给本域的能力面：全名解析（@<root>/<server>）。 */
export type WorkspacePort = Pick<typeof workspaceApi, "parseFullServerName">;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installPipeline` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface PipelineDeps {
  /** workspace 域：全名解析与裸名回落。 */
  workspace: WorkspacePort;
}
