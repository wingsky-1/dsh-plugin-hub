/**
 * git 域装配：把「一次 git 调用」翻译成归属查询与增删。
 *
 * 所有 argv 构造在 `impl/inspect`（纯函数，可逐字断言），本块只负责执行与把退出码翻译成答案。
 *
 * 状态（归属校验与仓库判定的 TTL 缓存、装配入参）住在实例里；域是**进程内单例**，第二次 `install` 由
 * `installed` 守卫**显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import { resolve } from "node:path";
import type {
  BelongsToReading,
  CommonDirReading,
  GitDeps,
  GitExecPort,
  GitRunResult,
} from "../../deps.ts";
import {
  addWorktreeArgs,
  checkRefFormatArgs,
  commonDirArgs,
  headBranchArgs,
  parseSingleLine,
  parseWorktreeList,
  removeWorktreeArgs,
  revParseCommitArgs,
  worktreeListArgs,
} from "../inspect/index.ts";
import type { WorktreeEntry } from "../inspect/index.ts";

/**
 * 归属校验结论的缓存存活时长。解析器每次目录展开都要问一次，裸起子进程会随展开线性增长。
 *
 * 取值**刻意与任何客户端刷新节拍无关**：早先它与浏览器轮询同为 5s，于是每轮轮询恰好落在
 * 缓存过期点上，一个绑定会话每小时白起约 1500 个 git 子进程。归属只在 worktree 被删除或
 * 移动时才变，而写侧的绑定还另有一道「目录是否存在」的本地检查，故 30s 的不新鲜期不放大风险。
 *
 * 注意它间接吃 `commonDir` 的缓存：本条的条目用「最多 30s 旧」的输入算出，自己再存活 30s，
 * 于是**最坏**不新鲜期是 60s 而不是 30s（两层 TTL 同值同纪律，但读数是叠加的）。
 *
 * 只缓存**已定**读数（`same` / `different`）：`unknown` 不进缓存，理由与 `COMMON_DIR_TTL_MS`
 * 的负答案不缓存同一条——写路径对 `unknown` 是 fail-closed 且文案让调用方「等目录可读后重试」，
 * 把那次 `unknown` 缓存住就等于把这句重试建议变成 30s 内的确定性失败。
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
 *
 * 它只缓存**拿到了公共 git 目录**的那种答案。负答案不缓存：`git init` 可能就发生在下一次调用之前
 * （用户在一个空目录里刚初始化完就调工具），而「读不出来」本就该重试而不是记住。
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
  /**
   * `dir` 与 `repoRoot` 是否属于同一仓库（带 TTL 缓存）。
   *
   * 回三态而不是布尔：`unknown`（有一侧读不出公共 git 目录）与 `different`（两侧都读出来了、值不同）
   * 对调用方的处置相反——前者要保住用户已有的登记，后者才是「确实换了仓库」。
   */
  belongsTo(dir: string, repoRoot: string): Promise<BelongsToReading>;
  /** 某 worktree 的当前分支显示名。 */
  headBranch(dir: string): Promise<string | undefined>;
  /** 让 git 校验分支名。 */
  checkRefFormat(branch: string): Promise<boolean>;
  /**
   * 新建 worktree。`base` 必须是**已经归一化的 commit SHA**——argv 里 `<path>` 之后的
   * 参数会被 git 重新解析成选项，起点直接传用户输入就等于把注入面留在那里（见 `impl/inspect`）。
   */
  addWorktree(
    repoRoot: string,
    path: string,
    branch: string | undefined,
    base: string | undefined,
  ): Promise<GitMutation>;
  /** 把起点解析成 commit SHA；解析不出来回 undefined（调用方据此给一句可操作的失败）。 */
  resolveCommit(dir: string, rev: string): Promise<string | undefined>;
  /** 删除 worktree。 */
  removeWorktree(repoRoot: string, path: string, force: boolean): Promise<GitMutation>;
}

/** git 写操作的结果：`reason` 是 git 的原文，直接给模型看。 */
export type GitMutation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** git 域：唯一实例持有归属缓存与那一次 git 调用面。 */
class GitService implements GitApi {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参。释放即放开，能力面随之当场失败。 */
  private deps: GitDeps | undefined;
  private readonly belongsCache = new Map<string, { at: number; reading: BelongsToReading }>();
  /** 只放正结果，所以值不是 `string | undefined`——负结果没有条目。 */
  private readonly commonDirCache = new Map<string, { at: number; dir: string }>();

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
    const reading = await this.reading(dir);
    return reading.kind === "repo" ? reading.dir : undefined;
  }

  /**
   * 带缓存的仓库判定读数。缓存只认正结果（见 `COMMON_DIR_TTL_MS`），负结果每次都真问一次 git。
   */
  private async reading(dir: string): Promise<CommonDirReading> {
    const hit = this.commonDirCache.get(dir);
    if (hit !== undefined && Date.now() - hit.at < COMMON_DIR_TTL_MS) {
      return { kind: "repo", dir: hit.dir };
    }
    const reading = await this.computeCommonDir(dir);
    if (reading.kind === "repo") {
      if (this.commonDirCache.size >= COMMON_DIR_CACHE_MAX) this.commonDirCache.clear();
      this.commonDirCache.set(dir, { at: Date.now(), dir: reading.dir });
    }
    return reading;
  }

  /** 真起一次 git 求公共目录；缓存命中不走这里。 */
  private async computeCommonDir(dir: string): Promise<CommonDirReading> {
    const result = await this.exec().run(commonDirArgs(dir));
    if (!result.ok) {
      return result.code === null
        ? { kind: "failed", reason: reasonOf(result) }
        : { kind: "not-repo" };
    }
    const value = parseSingleLine(result.stdout);
    if (value === undefined) return { kind: "failed", reason: "git 未返回公共 git 目录" };
    // `--git-common-dir` 会返回相对 `dir` 的路径（实测是 `.git`），
    // 直接拿字符串比较会让「同一仓库的两个 worktree」判成不同仓库。
    return { kind: "repo", dir: resolve(dir, value) };
  }

  async listWorktrees(dir: string): Promise<readonly WorktreeEntry[]> {
    const result = await this.exec().run(worktreeListArgs(dir));
    if (!result.ok) return [];
    return parseWorktreeList(result.stdout);
  }

  async belongsTo(dir: string, repoRoot: string): Promise<BelongsToReading> {
    const key = dir + "\u0000" + repoRoot;
    const hit = this.belongsCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < BELONGS_TTL_MS) return hit.reading;
    const [left, right] = await Promise.all([this.reading(dir), this.reading(repoRoot)]);
    // 只有两侧都**确实**给出了公共 git 目录时才有资格说「同 / 不同」；否则是问不出来。
    const reading: BelongsToReading =
      left.kind === "repo" && right.kind === "repo"
        ? left.dir === right.dir
          ? { kind: "same" }
          : { kind: "different" }
        : {
            kind: "unknown",
            reason: unreadableReason(dir, left, repoRoot, right),
            notRepo: left.kind === "not-repo" || right.kind === "not-repo",
          };
    // 只缓存已定读数：`unknown` 不缓存（理由见 `BELONGS_TTL_MS`）。写路径会告诉调用方
    // 「等目录可读后重试」，而那次重试要真的重新问一次 git 才算数。
    if (reading.kind !== "unknown") {
      if (this.belongsCache.size >= BELONGS_CACHE_MAX) this.belongsCache.clear();
      this.belongsCache.set(key, { at: Date.now(), reading });
    }
    return reading;
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
    base: string | undefined,
  ): Promise<GitMutation> {
    const result = await this.exec().run(addWorktreeArgs(repoRoot, path, branch, base));
    return result.ok ? { ok: true } : { ok: false, reason: reasonOf(result) };
  }

  /** 解析起点。`--quiet` 让「不是有效 rev」走退出码而不是 stderr，失败在这里就收成 undefined。 */
  async resolveCommit(dir: string, rev: string): Promise<string | undefined> {
    const result = await this.exec().run(revParseCommitArgs(dir, rev));
    if (!result.ok) return undefined;
    return parseSingleLine(result.stdout);
  }

  async removeWorktree(repoRoot: string, path: string, force: boolean): Promise<GitMutation> {
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

/** 归属判定「问不出来」的原因：把读不出来的那一侧与它的原因写进一句话，告警才有可操作性。 */
function unreadableReason(
  dir: string,
  left: CommonDirReading,
  repoRoot: string,
  right: CommonDirReading,
): string {
  const sides: string[] = [];
  const describe = (label: string, path: string, reading: CommonDirReading): void => {
    if (reading.kind === "repo") return;
    const why =
      reading.kind === "failed" ? "git 执行失败（" + reading.reason + "）" : "不是 git 工作树";
    sides.push(label + " " + path + " " + why);
  };
  describe("worktree 侧", dir, left);
  describe("主仓库侧", repoRoot, right);
  return sides.join("；");
}
