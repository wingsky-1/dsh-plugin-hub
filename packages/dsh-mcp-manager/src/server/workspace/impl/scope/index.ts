/**
 * dsh-mcp-manager — workspace/impl/scope/index.ts：scope 归一化（域内实现）。
 *
 * scope 常量 "global"/"project" 的**物理定义已上移 shared/constants.ts**：客户端把它们以
 * 字面量重复实现（src/client/core/api.ts），故它们是跨端契约而非宿主内部常量（W3b）。本文件
 * 保留 normalizeScope 并转出两个常量，目录外引用面仍经 workspace/interface.ts。
 *
 * 历史：scope 字符串曾在宿主/监督器/路由硬编码 25+ 处，独立成模块以避免
 * index.js ↔ supervisor/routes 的循环依赖；阶段 4 自 src/scope.ts 迁入 workspace 域。
 */

import { SCOPE_GLOBAL, SCOPE_PROJECT } from "../../../../shared/interface.ts";

export { SCOPE_GLOBAL, SCOPE_PROJECT };

/** 归一化 scope（非法值回落 global）。 */
export function normalizeScope(value: string): "global" | "project" {
  return value === SCOPE_PROJECT ? SCOPE_PROJECT : SCOPE_GLOBAL;
}
