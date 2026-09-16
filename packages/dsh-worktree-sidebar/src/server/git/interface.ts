/**
 * git 域对外契约：worktree 归属查询与增删。
 *
 * 本文件只做收口——`GitApi` 与单例的物理定义在 `impl/service`（`GitApi` 形状不从门面转出），argv 构造在 `impl/inspect`。
 * `gitExec` 也从这里出去：组合根只允许引 `interface.ts`（verify-dir-imports 规则 1/2），
 * 把它藏进 impl 会让组合根要么直引实现、要么自己重写一份 exec。
 * 单例本身不出这道门：它一旦被转出就成了本域的第二张公开契约，调用方还能持有它、绕过释放。
 */
import type { BelongsToReading, GitDeps } from "./deps.ts";
import type { WorktreeEntry } from "./impl/inspect/index.ts";
import type { GitMutation } from "./impl/service/index.ts";
import { gitService } from "./impl/service/index.ts";

/** 真实的 git 执行面：它没有状态，故按常量转出而不是工厂。 */
export { gitExec } from "./impl/exec/index.ts";

/** 装配 git 域（组合根在 `apply` 期调用一次）。重复装配是编程错误，当场抛错。 */
export function installGit(deps: GitDeps): void {
  gitService.install(deps);
}

/** 卸载 git 域，与 `installGit` 配对：丢掉归属缓存与装配入参。此后能力面当场失败。 */
export function releaseGit(): void {
  gitService.release();
}

/** 该目录是否在某个仓库里；是则给公共 git 目录的**绝对**路径。 */
export function commonDir(dir: string): Promise<string | undefined> {
  return gitService.commonDir(dir);
}

/** 同一主仓库下的全部 worktree。 */
export function listWorktrees(dir: string): Promise<readonly WorktreeEntry[]> {
  return gitService.listWorktrees(dir);
}

/** `dir` 与 `repoRoot` 是否属于同一仓库。三态：`unknown` 不是「不同」。 */
export function belongsTo(dir: string, repoRoot: string): Promise<BelongsToReading> {
  return gitService.belongsTo(dir, repoRoot);
}

/** 某 worktree 的当前分支显示名。 */
export function headBranch(dir: string): Promise<string | undefined> {
  return gitService.headBranch(dir);
}

/** 让 git 校验分支名。 */
export function checkRefFormat(branch: string): Promise<boolean> {
  return gitService.checkRefFormat(branch);
}

/**
 * 新建 worktree。`base` 必须已经被调用方归一化成 commit SHA（理由见 `resolveCommit`）。
 */
export function addWorktree(
  repoRoot: string,
  path: string,
  branch: string | undefined,
  base: string | undefined,
): Promise<GitMutation> {
  return gitService.addWorktree(repoRoot, path, branch, base);
}

/**
 * 把起点（分支 / tag / SHA / 相对 rev）解析成 commit SHA；解析不出来回 undefined。
 *
 * 这一层是**安全边界**而不是便利：`git worktree add` 在 `<path>` 之后会重新开始选项解析，
 * 起点位置的 `-` 开头值会被当选项（实测 `-f` / `--force` 会让起点被静默忽略、从 HEAD 建）。
 * 递进 argv 的必须是这里产出的 SHA。
 */
export function resolveCommit(dir: string, rev: string): Promise<string | undefined> {
  return gitService.resolveCommit(dir, rev);
}

/** 删除 worktree。 */
export function removeWorktree(
  repoRoot: string,
  path: string,
  force: boolean,
): Promise<GitMutation> {
  return gitService.removeWorktree(repoRoot, path, force);
}
