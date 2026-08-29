/**
 * dsh-mcp-manager — 中间层常量与模式归一化（单一事实源）。
 */

import type { MiddlewareMode } from "./middleware-types.ts";

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
/** ws_mcp_list 每服务器工具条数默认上限。 */
export const LIST_DEFAULT_TOOLS_PER_SERVER = 50;
/** ws_mcp_list 每服务器工具条数硬上限（目录采集边界内）。 */
export const LIST_MAX_TOOLS_PER_SERVER = 500;

/** 归一化中间层模式（非法值回落 off）。 */
export function normalizeMiddlewareMode(value: unknown): MiddlewareMode {
  return value === "project" || value === "all" ? value : "off";
}