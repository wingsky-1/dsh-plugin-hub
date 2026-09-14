/**
 * scope 域对外契约：接管 `workspaceFileScope` 的解析，命中绑定就把会话的文件根指到 worktree。
 *
 * 本文件只做收口——`ScopeApi` 与 `createScope` 的物理定义在 `impl/service`，
 * 解析判定在 `impl/resolve`，provider 未注册时的等价实现兜底在 `impl/fallback`。
 */
export { createScope } from "./impl/service/index.ts";
export type { ScopeApi } from "./impl/service/index.ts";
