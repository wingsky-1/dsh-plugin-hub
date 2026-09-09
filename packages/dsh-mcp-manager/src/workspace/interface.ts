/**
 * dsh-mcp-manager — workspace/interface.ts：工作空间路由域唯一对外引用面（D10，#664 阶段 4）。
 *
 * 工作空间路由域 = 项目根发现/归一化（root-resolution）+ server 全名与工具名
 * 解析（full-name）+ scope 常量（scope）+ 中间层模式归一化（middleware-mode）
 * + 全局虚拟 root 单源（constants）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 */
export { findProjectRoot, normalizedProjectRoot, makeResolveRoot } from "./root-resolution.ts";
export { fullServerName, parseFullServerName, bareServerName, normalizeToolName } from "./full-name.ts";
export { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./scope.ts";
export { normalizeMiddlewareMode } from "./middleware-mode.ts";
export { MIDDLEWARE_GLOBAL_ROOT } from "./constants.ts";