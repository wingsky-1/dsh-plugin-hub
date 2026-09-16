/**
 * dsh-mcp-manager — catalog/deps.ts：目录域的上对依赖声明（纯类型面，§3.1 规则 2）。
 *
 * 本域运行时能力消费**非零**（决策⑥ 以运行时能力消费为准），按提供方分三组：store 取
 * 磁盘目录缓存读面；connection 取目录 TTL 与装箱限额常量；workspace 取全名解析与工具名
 * 归一。config 域实测 0 值引，不预置。
 *
 * **宿主能力（工具注册表读口、logger）不进端口**：它们是本域声明的**入参契约**——由
 * connection 在调用点构造具体对象递入（同 `CatalogViewHost` 的口径，见下）。理由是这两条
 * 能力每次调用都由调用方给：注册面视图取自 `host.ctx.tools.schemas()`、告警出口是
 * `host.logger.warn`、目录落盘路径是 `host.catalogCachePath(root)`——它们是连接的宿主面
 * 事实，本域只按值使用，不持有、不推导。端口只承载「本域真的要自己去取」的静态能力。
 *
 * CatalogViewHost 同理不进端口：它是本域声明的**入参契约**——connection 在调用点构造具体对象
 * 递入 makeCatalogViewFor，不是本域向提供方 import 的能力面。
 *
 * 口径取「实际使用」而非「import 面」（附录 E.6 第 3 条的建议）：端口成员 = 域内真实的消费点。
 * 历史死导入（search 的 bareServerName）随 W1 删除后不再被引用，端口不为已不存在的符号开口；
 * 跨端契约常量（SCOPE_PROJECT / MIDDLEWARE_GLOBAL_ROOT）与 ≥2 域消费的值常量
 * （LIST_DEFAULT_TOOLS_PER_SERVER）已按 §3.6 规则 6 迁共享层，故不在端口面内（W3b）。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。三条域间值边
 * （catalog|config/store、catalog|connection、catalog|workspace）已随 W4 接线消失——域内取数
 * 一律经 `impl/service` 的 `catalogPorts.get()`，写入只由组合根在 `src/index.ts` 顶层完成。
 */
import type * as storeApi from "../store/interface.ts";
import type * as connectionRuntimeApi from "../connection/runtime/interface.ts";
import type * as workspaceApi from "../workspace/interface.ts";

/** store 域给本域的能力面：磁盘 last-good 目录缓存读面。 */
export type StorePort = Pick<typeof storeApi, "readCatalogServerFromDisk">;

/**
 * connection 域给本域的能力面：目录 TTL 与装箱限额常量。
 *
 * 指向 runtime 子层门面：这 4 个常量的物理定义在 connection/runtime/limits.ts，而 connection
 * 门面自 W10 起不再转发 runtime 的值面（那条转发边就是 I2① `connection|connection/runtime`）。
 */
export type ConnectionPort = Pick<
  typeof connectionRuntimeApi,
  "CATALOG_TTL_MS" | "MAX_BYTES_PER_TOOL" | "MAX_TOOLS_PER_SERVER" | "MAX_TOTAL_CATALOG_BYTES"
>;

/** workspace 域给本域的能力面：全名解析与工具名归一。 */
export type WorkspacePort = Pick<
  typeof workspaceApi,
  "normalizedProjectRoot" | "fullServerName" | "parseFullServerName" | "normalizeToolName"
>;

/**
 * 装配入参：本域依赖的全部外部。键集与组合根 `installCatalog` 的实参字面量由
 * verify-dir-imports 的注入面对账强制**严格相等**（多一个键、少一个键都判红）。
 */
export interface CatalogDeps {
  /** store 域：磁盘 last-good 目录缓存读面。 */
  store: StorePort;
  /** connection 域：目录 TTL 与装箱限额常量。 */
  connection: ConnectionPort;
  /** workspace 域：全名解析与工具名归一。 */
  workspace: WorkspacePort;
}
