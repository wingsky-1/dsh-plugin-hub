/**
 * dsh-mcp-manager — servers/lifecycle/deps.ts：装载生命周期域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费面只有两条，都取「实际使用」而非「import 面」（附录 E.6 第 3 条）：
 * - 宿主装载口（LoaderPort）：官方引擎按包名解析 + 挂载，形状由 server/shared/host-faces.ts
 *   自持声明（官方 loader 包不在 catalog，仓库内不可解析，只能拿结构面）；
 * - pipeline 域的超时兜底（withTimeout）：官方 Config 里没有连接超时（只有 toolCallTimeoutMs），
 *   「10s 内失败」这个产品语义只能由我方包在句柄等待上。
 *
 * LoaderPort 是**类型边**（经 server/shared 门面取），不产生跨域值边；域内取数一律经
 * `impl/service` 的 `lifecyclePorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。
 */
import type * as pipelineApi from "../../pipeline/interface.ts";
import type { LoaderPort } from "../../shared/interface.ts";

/** pipeline 域给本域的能力面：超时兜底一样，用于装载等待窗口（§3.4）。 */
export type PipelinePort = Pick<typeof pipelineApi, "withTimeout">;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installLifecycle` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 *
 * 刻意不含 `idFactory`：id 的生成与 `(scope,name)→id` 表归 workspace 域（767-v6-STAGED-PLAN
 * §2.6 裁定 B），本域的账本键由调用方给字符串。
 */
export interface LifecycleDeps {
  /** 宿主能力面：官方引擎的装载口。 */
  loader: LoaderPort;
  /** pipeline 域：装载等待窗口的超时兜底。 */
  pipeline: PipelinePort;
}
