/**
 * dsh-mcp-manager — workspace/middleware-mode.ts：中间层模式归一化函数。
 *
 * 阶段 4 自 src/middleware-const.ts 迁出——middleware-const.ts 仅保留执行域
 * 语义常量（limits/超时等，阶段 6 归 connection/runtime/limits.ts），函数
 * 归工作空间路由域；引用面经 workspace/interface.ts。
 */

import type { MiddlewareMode } from "../types/interface.ts";

/** 归一化中间层模式（非法值回落 off）。 */
export function normalizeMiddlewareMode(value: unknown): MiddlewareMode {
  return value === "project" || value === "all" ? value : "off";
}