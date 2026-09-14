/**
 * dsh-mcp-manager — 中间层常量（执行域语义，单一事实源）。
 *
 * normalizeMiddlewareMode 阶段 4 迁至工作空间路由域（B2.2 后就地重构为
 * src/workspace/impl/mode/index.ts，经 src/workspace/interface.ts 门面转出）；
 * 本文件保留 limits/超时/目录边界常量，阶段 6 归
 * connection/runtime/limits.ts（v3 C-DIR）。
 */

/** 连接超时（ms）。 */
export const CONNECT_TIMEOUT_MS = 10_000;
/** 工具发现（tools/list 全量）超时（ms）。 */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** 单次远端工具调用超时（ms）。 */
export const CALL_TIMEOUT_MS = 30_000;
/** 目录 TTL（ms）：24h。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 每工作空间目录 LRU 上限。 */
export const CATALOG_LRU_MAX = 16;
/** 目录安全边界：单服务器工具数上限。 */
export const MAX_TOOLS_PER_SERVER = 512;
/** 目录安全边界：单工具描述字节上限。 */
export const MAX_BYTES_PER_TOOL = 4096;
/** 目录安全边界：目录总字节上限。 */
export const MAX_TOTAL_CATALOG_BYTES = 256 * 1024;
/** ws_mcp_list 每服务器工具条数硬上限（目录采集边界内）。 */
export const LIST_MAX_TOOLS_PER_SERVER = 500;

// 物理定义已上移 server/shared/constants.ts（catalog 与 inject 两域消费，§3.6 规则 6）：本文件
// 保留转出，connection 门面与入口的 re-export 链、以及 inject 现有引用点均不变。转出必须经
// server/shared 门面——直引 constants.ts 会被判「impl 引用他域实现文件」（directImpl）。
export { LIST_DEFAULT_TOOLS_PER_SERVER } from "../../shared/interface.ts";
