/**
 * dsh-mcp-manager — pipeline/deps.ts：执行管道域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准，附录 E.4）：authorize 块取
 * workspace 域的全名解析、裸名回落与全局虚拟 root 常量。宿主能力实测 0 命中（无
 * ctx/Context/logger/settings），故只有一条 Port——比 §3.4 表的预期「workspace + 宿主
 * logger」窄，按实测收窄。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：authorize 对
 * `fullServerName` 是死导入（决策⑦ 登记、B2 本域重写时自然消失），端口不为它开口。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。端口等「本域
 * 改成 install(deps)」那一笔接线；届时 authorize 的直接值引改经端口取数，I2① 的
 * `pipeline|workspace` 值边随之消失。
 */
import type * as workspaceApi from "../workspace/interface.ts";

/** workspace 域给本域的能力面：全名解析（@<root>/<server>）、裸名回落、全局虚拟 root 常量。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "parseFullServerName" | "bareServerName" | "MIDDLEWARE_GLOBAL_ROOT"
>;
