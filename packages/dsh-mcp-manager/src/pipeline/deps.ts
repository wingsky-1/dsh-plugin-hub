/**
 * dsh-mcp-manager — pipeline/deps.ts：执行管道域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准，附录 E.4）：authorize 块取
 * workspace 域的全名解析与裸名回落。宿主能力实测 0 命中（无 ctx/Context/logger/settings），
 * 故只有一条 Port——比 §3.4 表的预期「workspace + 宿主 logger」窄，按实测收窄。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：端口成员 = 域内真实的消费点。
 * 历史死导入（authorize 的 fullServerName）随 W1 删除后不再被引用，端口不为已不存在的符号
 * 开口；跨端契约常量 MIDDLEWARE_GLOBAL_ROOT 已按 §3.6 规则 6 迁 shared/constants.ts，故不在
 * 端口面内（W3b）。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。端口等「本域
 * 改成 install(deps)」那一笔接线；届时 authorize 的直接值引改经端口取数，I2① 的
 * `pipeline|workspace` 值边随之消失。
 */
import type * as workspaceApi from "../workspace/interface.ts";

/** workspace 域给本域的能力面：全名解析（@<root>/<server>）与裸名回落。 */
export type WorkspacePort = Pick<typeof workspaceApi, "parseFullServerName" | "bareServerName">;
