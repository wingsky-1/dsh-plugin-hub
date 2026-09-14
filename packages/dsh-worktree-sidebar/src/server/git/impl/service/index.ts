/**
 * git 域装配：把「一次 git 调用」翻译成归属查询与增删。
 *
 * 所有 argv 构造在 `impl/inspect`（纯函数，可逐字断言），本块只负责执行与把退出码翻译成答案。
 *
 * 状态（归属校验的 TTL 缓存）住在实例里而不是模块里（#733 宪法第 1 条）：缓存是一份加速设施，
 * 它不该跨装配共享，更不该让第二次装配抛「已装配」。
 */
import { resolve } from "node:path";
import type { GitDeps, GitRunResult } from "../../deps.ts";
import {
  addWorktreeArgs,
  checkRefFormatArgs,
  commonDirArgs,
  headBranchArgs,
  parseSingleLine,
  parseWorktreeList,
  removeWorktreeArgs,
  worktreeListArgs,
} from "../inspect/index.ts";
import type { WorktreeEntry } from "../inspect/index.ts";

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

/** 装配 git 域。 */
export function createGit(deps: GitDeps): GitApi {
  const belongsCache = new Map<string, { at: number; ok: boolean }>();
  const run = (args: readonly string[]): Promise<GitRunResult> => deps.exec.run(args);

  const commonDir = async (dir: string): Promise<string | undefined> => {
    const result = await run(commonDirArgs(dir));
    if (!result.ok) return undefined;
    const value = parseSingleLine(result.stdout);
    if (value === undefined) return undefined;
    // `--git-common-dir` 会返回相对 `dir` 的路径（实测是 `.git`），
    // 直接拿字符串比较会让「同一仓库的两个 worktree」判成不同仓库。
    return resolve(dir, value);
  };

  return {
    commonDir,
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
      const [left, right] = await Promise.all([commonDir(dir), commonDir(repoRoot)]);
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

/** 失败原因的取值口径只有这一处：git 的 stderr 优先，空则给退出码。 */
function reasonOf(result: GitRunResult): string {
  const text = result.stderr.trim();
  return text.length > 0 ? text : "git 退出码非零";
}
