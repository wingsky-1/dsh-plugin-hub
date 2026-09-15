/**
 * git 域装配：把「一次 git 调用」翻译成归属查询与增删。
 *
 * 所有 argv 构造在 `impl/inspect`（纯函数，可逐字断言），本块只负责执行与把退出码翻译成答案。
 *
 * 状态（归属校验与仓库判定的 TTL 缓存、装配入参）住在实例里；域是**进程内单例**，第二次 `install` 由
 * `installed` 守卫**显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import { resolve } from "node:path";
import type { GitDeps, GitExecPort, GitRunResult } from "../../deps.ts";
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

/**
 * 归属校验结论的缓存存活时长。解析器每次目录展开都要问一次，裸起子进程会随展开线性增长。
 *
 * 取值**刻意与任何客户端刷新节拍无关**：早先它与浏览器轮询同为 5s，于是每轮轮询恰好落在
 * 缓存过期点上，一个绑定会话每小时白起约 1500 个 git 子进程。归属只在 worktree 被删除或
 * 移动时才变，而写侧的绑定还另有一道「目录是否存在」的本地检查，故 30s 的不新鲜期不放大风险。
 */
const BELONGS_TTL_MS = 30_000;

/** 缓存条目上限。超出即整表丢弃——这是一份加速缓存，不是需要保真的状态。 */
const BELONGS_CACHE_MAX = 256;

/**
 * 仓库判定结论的缓存存活时长。安装期要给**每个新 agent** 判一次「cwd 在不在仓库里」，
 * 裸起子进程会把这次判定推到几十到上百毫秒；而官方 `agents.create()` 是「发布之后立刻开跑」
 * （`dsh-agent/lib/index.js:415` 的契约），子会话的**第一回合**正落在这个窗口里——
 * 判定慢一拍，子会话第一回合就看不到工具。
 *
 * 与 `BELONGS_TTL_MS` 同值同纪律：仓库归属只在 worktree 被删/移动时变，执行期还另有一次兜底校验。
 */
const COMMON_DIR_TTL_MS = 30_000;

/** 仓库判定缓存的条目上限，与归属缓存同口径。 */
const COMMON_DIR_CACHE_MAX = 256;

/** 未装配时能力面的失败文案：读到它就说明装配守卫有洞，当场暴露而不是拿旧 deps 出结果。 */
const NOT_INSTALLED = "dsh-worktree-sidebar: git 域尚未装配";

/** git 域的服务面。 */
export interface GitApi {
  /** 该目录是否在某个仓库里；是则给公共 git 目录的**绝对**路径（带 TTL 缓存）。 */
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

/** git 域：唯一实例持有归属缓存与那一次 git 调用面。 */
class GitService implements GitApi {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参。释放即放开，能力面随之当场失败。 */
  private deps: GitDeps | undefined;
  private readonly belongsCache = new Map<string, { at: number; ok: boolean }>();
  private readonly commonDirCache = new Map<string, { at: number; value: string | undefined }>();

  /** 装配 git 域。重复装配是编程错误，当场暴露。 */
  install(deps: GitDeps): void {
    if (this.installed) throw new Error("dsh-worktree-sidebar: git 域只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 卸载：丢掉缓存与装配入参，复位装配标记——同进程的下一次 `install` 不该撞上「只能装配一次」。 */
  release(): void {
    this.installed = false;
    this.belongsCache.clear();
    this.commonDirCache.clear();
    this.deps = undefined;
  }

  async commonDir(dir: string): Promise<string | undefined> {
    const hit = this.commonDirCache.get(dir);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < COMMON_DIR_TTL_MS) return hit.value;
    const value = await this.computeCommonDir(dir);
    if (this.commonDirCache.size >= COMMON_DIR_CACHE_MAX) this.commonDirCache.clear();
    this.commonDirCache.set(dir, { at: now, value });
    return value;
  }

  /** 真起一次 git 求公共目录；缓存命中不走这里。 */
  private async computeCommonDir(dir: string): Promise<string | undefined> {
    const result = await this.exec().run(commonDirArgs(dir));
    if (!result.ok) return undefined;
    const value = parseSingleLine(result.stdout);
    if (value === undefined) return undefined;
    // `--git-common-dir` 会返回相对 `dir` 的路径（实测是 `.git`），
    // 直接拿字符串比较会让「同一仓库的两个 worktree」判成不同仓库。
    return resolve(dir, value);
  }

  async listWorktrees(dir: string): Promise<readonly WorktreeEntry[]> {
    const result = await this.exec().run(worktreeListArgs(dir));
    if (!result.ok) return [];
    return parseWorktreeList(result.stdout);
  }

  async belongsTo(dir: string, repoRoot: string): Promise<boolean> {
    const key = dir + "\u0000" + repoRoot;
    const hit = this.belongsCache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < BELONGS_TTL_MS) return hit.ok;
    const [left, right] = await Promise.all([this.commonDir(dir), this.commonDir(repoRoot)]);
    const ok = left !== undefined && right !== undefined && left === right;
    if (this.belongsCache.size >= BELONGS_CACHE_MAX) this.belongsCache.clear();
    this.belongsCache.set(key, { at: now, ok });
    return ok;
  }

  async headBranch(dir: string): Promise<string | undefined> {
    const result = await this.exec().run(headBranchArgs(dir));
    if (!result.ok) return undefined;
    const value = parseSingleLine(result.stdout);
    if (value === undefined || value === "HEAD") return undefined;
    return value;
  }

  async checkRefFormat(branch: string): Promise<boolean> {
    const result = await this.exec().run(checkRefFormatArgs(branch));
    return result.ok;
  }

  async addWorktree(
    repoRoot: string,
    path: string,
    branch: string | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.exec().run(addWorktreeArgs(repoRoot, path, branch));
    return result.ok ? { ok: true } : { ok: false, reason: reasonOf(result) };
  }

  async removeWorktree(
    repoRoot: string,
    path: string,
    force: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.exec().run(removeWorktreeArgs(repoRoot, path, force));
    return result.ok ? { ok: true } : { ok: false, reason: reasonOf(result) };
  }

  /** 取执行面：未装配时当场失败，而不是拿一份空执行面跑出「git 说没有」这种假答案。 */
  private exec(): GitExecPort {
    const deps = this.deps;
    if (deps === undefined) throw new Error(NOT_INSTALLED);
    return deps.exec;
  }
}

/** 本域唯一实例：类不外放，外面 `new` 不出第二份缓存。 */
export const gitService = new GitService();

/** 失败原因的取值口径只有这一处：git 的 stderr 优先，空则给退出码。 */
function reasonOf(result: GitRunResult): string {
  const text = result.stderr.trim();
  return text.length > 0 ? text : "git 退出码非零";
}
