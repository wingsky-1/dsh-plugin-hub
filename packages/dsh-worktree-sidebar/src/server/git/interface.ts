/**
 * git 域对外契约：worktree 归属查询与增删。
 *
 * 本文件只做收口——`GitApi` 与 `createGit` 的物理定义在 `impl/service`，
 * argv 构造在 `impl/inspect`。`createGitExec` 也从这里出去：组合根只允许引 `interface.ts`
 * （verify-dir-imports 规则 1/2），把它藏进 impl 会让组合根要么直引实现、要么自己重写一份 exec。
 */
export { createGit } from "./impl/service/index.ts";
export type { GitApi } from "./impl/service/index.ts";
export { createGitExec } from "./impl/exec/index.ts";
export type { GitExecPort } from "./deps.ts";
