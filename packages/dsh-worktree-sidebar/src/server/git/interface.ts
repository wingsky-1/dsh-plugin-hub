/**
 * git 域对外契约：worktree 归属查询与增删。所有 argv 构造在 `impl/inspect`（纯函数，可逐字断言），
 * 本文件只负责「执行 + 把退出码翻译成答案」。
 */
import { resolve } from "node:path";
import type { GitDeps, GitRunResult } from "./deps.ts";
import {
  addWorktreeArgs,
  branchLabel,
  checkRefFormatArgs,
  commonDirArgs,
  headBranchArgs,
  parseSingleLine,
  parseWorktreeList,
  removeWorktreeArgs,
  worktreeListArgs,
} from "./impl/inspect/index.ts";
import type { WorktreeEntry } from "./impl/inspect/index.ts";

export type { WorktreeEntry } from "./impl/inspect/index.ts";
// 真实执行面经门面出去：组合根只允许引 interface.ts（verify-dir-imports 规则 1/2），
// 把它藏进 impl 会让组合根要么直引实现、要么自己重写一份 exec。
export { createGitExec } from "./impl/exec/index.ts";
export type { GitExecPort, GitRunResult } from "./deps.ts";

/** 归属校验结论的缓存存活时长。解析器每次目录展开都要问一次，裸起子进程会随展开线性增长。 */
const BELONGS_TTL_MS = 5_000;

/** 缓存条目上限。超出即整表丢弃——这是一份加速缓存，不是需要保真的状态。 */
const BELONGS_CACHE_MAX = 256;

/** git 域的服务面。 */
export interface GitApi {
  /** 该目录是否在某个仓库里；是则给公共 git 目录的**绝对**路径。 */
  commonDir(dir: string): Promise<string | undefined>;
  /** 同一主仓库下的全部 worktree。 */
  listWorktrees(dir: string): Promise<readonly WorktreeEntry[]>;
  /** `dir` 与 `repoRoot` 是否属于同一仓库（带 TTL 缓存）。 */
  belongsTo(dir: string, repoRoot: string): Promise<boolean>;
  /** 某 worktree 的当前分支显示名。 */
  headBranch(dir: string): Promise<string | undefined>;
  /** 让 git 校验分支名。 */
  checkRefFormat(branch: string): Promise<boolean>;
  /** 新建 worktree。`ok=false` 时 `reason` 是 git 的原文，直接给模型看。 */
  addWorktree(
    repoRoot: string,
    path: string,
    branch: string | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 删除 worktree。 */
  removeWorktree(
    repoRoot: string,
    path: string,
    force: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

let installed: GitDeps | null = null;
const belongsCache = new Map<string, { at: number; ok: boolean }>();

/** 装配 git 域。 */
export function installGit(deps: GitDeps): GitApi {
  if (installed !== null) throw new Error("dsh-worktree-sidebar: git 域已装配");
  installed = deps;
  belongsCache.clear();
  return api();
}

/** 卸载 git 域。幂等。 */
export function releaseGit(): void {
  installed = null;
  belongsCache.clear();
}

function requireDeps(): GitDeps {
  if (installed === null) throw new Error("dsh-worktree-sidebar: git 域未装配");
  return installed;
}

/** 失败原因的取值口径只有这一处：git 的 stderr 优先，空则给退出码。 */
function reasonOf(result: GitRunResult): string {
  const text = result.stderr.trim();
  return text.length > 0 ? text : "git 退出码非零";
}

function api(): GitApi {
  const run = (args: readonly string[]): Promise<GitRunResult> => requireDeps().exec.run(args);

  return {
    async commonDir(dir) {
      const result = await run(commonDirArgs(dir));
      if (!result.ok) return undefined;
      const value = parseSingleLine(result.stdout);
      if (value === undefined) return undefined;
      // `--git-common-dir` 会返回相对 `dir` 的路径（实测是 `.git`），
      // 直接拿字符串比较会让「同一仓库的两个 worktree」判成不同仓库。
      return resolve(dir, value);
    },
    async listWorktrees(dir) {
      const result = await run(worktreeListArgs(dir));
      if (!result.ok) return [];
      return parseWorktreeList(result.stdout);
    },
    async belongsTo(dir, repoRoot) {
      const key = dir + "\u0000" + repoRoot;
      const hit = belongsCache.get(key);
      const now = Date.now();
      if (hit !== undefined && now - hit.at < BELONGS_TTL_MS) return hit.ok;
      const [left, right] = await Promise.all([this.commonDir(dir), this.commonDir(repoRoot)]);
      const ok = left !== undefined && right !== undefined && left === right;
      if (belongsCache.size >= BELONGS_CACHE_MAX) belongsCache.clear();
      belongsCache.set(key, { at: now, ok });
      return ok;
    },
    async headBranch(dir) {
      const result = await run(headBranchArgs(dir));
      if (!result.ok) return undefined;
      const value = parseSingleLine(result.stdout);
      if (value === undefined || value === "HEAD") return undefined;
      return value;
    },
    async checkRefFormat(branch) {
      const result = await run(checkRefFormatArgs(branch));
      return result.ok;
    },
    async addWorktree(repoRoot, path, branch) {
      const result = await run(addWorktreeArgs(repoRoot, path, branch));
      return result.ok ? { ok: true } : { ok: false, reason: reasonOf(result) };
    },
    async removeWorktree(repoRoot, path, force) {
      const result = await run(removeWorktreeArgs(repoRoot, path, force));
      return result.ok ? { ok: true } : { ok: false, reason: reasonOf(result) };
    },
  };
}

/** 供日志与工具返回文本使用：把一个 worktree 条目渲染成一行摘要。 */
export function describeWorktree(entry: WorktreeEntry): string {
  return entry.path + "  [" + branchLabel(entry) + "]";
}
