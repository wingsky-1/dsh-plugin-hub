/**
 * dsh-mcp-manager — 中间层常量（执行域语义，单一事实源）。
 *
 * 本文件保留 limits/超时/目录边界常量，阶段 6 归
 * connection/runtime/limits.ts（v3 C-DIR）。
 */

/** 单次远端工具调用超时（ms）。 */
export const CALL_TIMEOUT_MS = 30_000;
/** 目录 TTL（ms）：24h。 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 目录安全边界：单服务器工具数上限。 */
export const MAX_TOOLS_PER_SERVER = 512;
/** 目录安全边界：单工具描述字节上限。 */
export const MAX_BYTES_PER_TOOL = 4096;
/** 目录安全边界：目录总字节上限。 */
export const MAX_TOTAL_CATALOG_BYTES = 256 * 1024;
/** ws_mcp_list 每服务器工具条数硬上限（目录采集边界内）。 */
export const LIST_MAX_TOOLS_PER_SERVER = 500;

// 物理定义已上移 server/shared/constants.ts（#767 S1-2b）：连接/发现超时的消费方从「我方协议栈」
// 变成 servers/lifecycle 的句柄等待窗口与仍在的 runtime 子层，两处消费按 I5 归共享层。本文件
// 保留转出，connection 门面与入口的 re-export 链、以及 inject/middleware 现有引用点均不变。
// 转出必须经 server/shared 门面——直引 constants.ts 会被判「impl 引用他域实现文件」（directImpl）。
export {
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  LIST_DEFAULT_TOOLS_PER_SERVER,
} from "../../shared/interface.ts";
