/**
 * dsh-mcp-manager — catalog/deps.ts：目录域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准），按提供方分三组：store 取
 * 磁盘目录缓存读面；connection 取目录 TTL 与检索/装箱限额常量；workspace 取全名解析、
 * 工具名归一与全局虚拟 root 常量。宿主能力实测 0 命中（无 ctx/Context/logger/settings），
 * 故比 §3.4 表的预期「config + store + connection + logger」窄，按实测收窄；config 域
 * 实测 0 值引，不预置。
 *
 * CatalogViewHost 不进端口：它是本域声明的**入参契约**——connection 在调用点构造具体对象
 * 递入 makeCatalogViewFor，不是本域向提供方 import 的能力面。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：search 对 bareServerName
 * 是死导入（决策⑦ 登记、B2 本域重写时自然消失），端口不为它开口。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。三条域间值边
 * （catalog|config/store、catalog|connection、catalog|workspace）已随 W4 接线消失——域内取数
 * 一律经 `impl/service` 的 `catalogPorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as storeApi from "../config/store/interface.ts";
import type * as connectionApi from "../connection/interface.ts";
import type * as workspaceApi from "../workspace/interface.ts";

/** store 域给本域的能力面：磁盘 last-good 目录缓存读面。 */
export type StorePort = Pick<typeof storeApi, "readCatalogServerFromDisk">;

/** connection 域给本域的能力面：目录 TTL 与检索/装箱限额常量。 */
export type ConnectionPort = Pick<
  typeof connectionApi,
  | "CATALOG_TTL_MS"
  | "LIST_DEFAULT_TOOLS_PER_SERVER"
  | "MAX_BYTES_PER_TOOL"
  | "MAX_TOOLS_PER_SERVER"
  | "MAX_TOTAL_CATALOG_BYTES"
>;

/** workspace 域给本域的能力面：全名解析、工具名归一与全局虚拟 root 常量。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  | "normalizedProjectRoot"
  | "SCOPE_PROJECT"
  | "MIDDLEWARE_GLOBAL_ROOT"
  | "fullServerName"
  | "parseFullServerName"
  | "normalizeToolName"
>;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installCatalog` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface CatalogDeps {
  /** store 域：磁盘 last-good 目录缓存读面。 */
  store: StorePort;
  /** connection 域：目录 TTL 与检索/装箱限额常量。 */
  connection: ConnectionPort;
  /** workspace 域：全名解析、工具名归一与全局虚拟 root 常量。 */
  workspace: WorkspacePort;
}
