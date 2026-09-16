/**
 * git 查询的 argv 构造与输出解析：全是纯函数。
 *
 * 执行被隔离在装配层之后，所以「branch 名是否经过校验」「positional 前是否加了 `--`」
 * 这类安全属性可以被单测逐字断言，而不需要真仓库。
 *
 * 一律用 `-C <dir>` 而不是依赖进程 cwd：cwd 是全局状态，并发调用会互相污染。
 */
/** 一个 worktree 在 `git worktree list --porcelain` 里的样子。 */
export interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
}

/** 问某目录所属仓库的公共 git 目录（同一仓库的所有 worktree 共享它，故它标识「属于哪个仓库」）。 */
export function commonDirArgs(dir: string): readonly string[] {
  return ["-C", dir, "rev-parse", "--git-common-dir"];
}

/** 列出某目录所属仓库的全部 worktree。 */
export function worktreeListArgs(dir: string): readonly string[] {
  return ["-C", dir, "worktree", "list", "--porcelain"];
}

/** 读某 worktree 当前 HEAD 的分支名（`detached` 时 git 返回 `HEAD`）。 */
export function headBranchArgs(dir: string): readonly string[] {
  return ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"];
}

/** 让 git 自己校验分支名。`--branch` 还会拒绝 `-` 开头的名字，这是把参数注入挡在 argv 之外的第一道。 */
export function checkRefFormatArgs(branch: string): readonly string[] {
  return ["check-ref-format", "--branch", branch];
}

/**
 * 新建 worktree。`--` 结束选项解析，路径即使形如选项也不会被当成标志。
 *
 * 省略 branch 时必须显式 `--detach`：`git worktree add <path>` 的默认行为是**新建一个以目录
 * basename 命名的分支**并 checkout（实测 `Preparing worktree (new branch 'wtA')`），而不是
 * 「check out the repository HEAD」。那条默认路径还有两个后果——basename 含空格时 git 直接
 * `fatal: 'wt spaceB' is not a valid branch name`（macOS 的家目录常见空格），basename 以 `-` 开头时
 * `--` 只挡住了 worktree add 自己的选项解析、挡不住它把 basename 当分支名后的二次解析（`unknown switch`）。
 * `--detach` 让「省略 branch」的语义与文档一致，也把这条二次解析链路整个绕开。
 */
export function addWorktreeArgs(
  repoRoot: string,
  path: string,
  branch: string | undefined,
): readonly string[] {
  const flags = branch === undefined ? ["--detach"] : ["-b", branch];
  return ["-C", repoRoot, "worktree", "add", ...flags, "--", path];
}

/** 删除 worktree。`force` 只在调用方显式要求时出现——默认可丢未提交改动的删除不该是默认值。 */
export function removeWorktreeArgs(
  repoRoot: string,
  path: string,
  force: boolean,
): readonly string[] {
  const flags = force ? ["--force"] : [];
  return ["-C", repoRoot, "worktree", "remove", ...flags, "--", path];
}

/** 取 `rev-parse` 的单行输出。相对路径返回值（`--git-common-dir` 可能是相对路径）由调用方补全。 */
export function parseSingleLine(stdout: string): string | undefined {
  const line = stdout.split("\n")[0]?.trim() ?? "";
  return line.length === 0 ? undefined : line;
}

/** 解析 `worktree list --porcelain`：空行分块，每块首行是路径，其余是属性。 */
export function parseWorktreeList(stdout: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    let detached = false;
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
      else if (line === "detached") detached = true;
    }
    if (path !== undefined && path.length > 0) entries.push({ path, branch, detached });
  }
  return entries;
}
