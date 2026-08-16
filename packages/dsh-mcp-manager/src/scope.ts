// dsh-mcp-manager — scope 常量与归一化（单一事实源）。
//
// 历史：scope 字符串 "global"/"project" 曾在宿主/监督器/路由硬编码 25+ 处，
// 新增 scope 类型需多处协调。独立成模块以避免 index.js ↔ supervisor/routes
// 的循环依赖，Manager / supervisor / routes 统一从此 import。

/** 全局作用域。 */
export const SCOPE_GLOBAL = "global";

/** 项目级作用域。 */
export const SCOPE_PROJECT = "project";

/** 归一化 scope（非法值回落 global）。 */
export function normalizeScope(value: string): "global" | "project" {
  return value === SCOPE_PROJECT ? SCOPE_PROJECT : SCOPE_GLOBAL;
}
