/**
 * 纪律工具（工具层硬纪律）——codegraph_explore 封装。
 *
 * 核心价值（评审①②的 P1 修正落地）：
 * - **查询前强制 sync**：worktree 索引的新鲜度完全由 sync 驱动（watcher 只盯
 *   serve 根 = 主 checkout，worktree 无 watcher 覆盖）——不 sync 就查询会拿到
 *   旧内容（silent wrong answer）。故每次查询前先对目标 projectPath 执行
 *   `codegraph sync <path>`（~0.8s 固定开销，实测可接受）。
 * - **校验/补全 projectPath**：不传 projectPath 时自动补全为当前会话 worktree
 *   （agent.session.header.cwd 向上找 .git 标记）；补全不了（无 worktree 上下文）
 *   → 拒绝调用并提示。杜绝「漏传 projectPath 静默查主 checkout 基线」。
 * - 自动补全 + 拒绝兜底：能自动（sync、补全 projectPath）就自动；自动不了
 *   （无 worktree 上下文、sync 失败）→ 拒绝并给出明确提示。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 沿 cwd 向上找 .git 标记（文件或目录，worktree 的 .git 文件也识别）——findProjectRoot 同款逻辑。 */
export function findGitRoot(cwd: string | undefined): string | undefined {
  let current = resolve(cwd ?? process.cwd());
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 判断某目录是否为 git 仓（requireGit 判定）。 */
export function isGitRepo(cwd: string | undefined): boolean {
  return findGitRoot(cwd) !== undefined;
}

/** 执行 codegraph sync（增量更新索引）。返回是否成功。 */
export function syncCodegraph(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile("codegraph", ["sync", projectPath], { env, timeout: 30000 }, (error) => {
      resolvePromise(error === null);
    });
  });
}

/** 执行 codegraph explore（CLI 形态，与 MCP 工具同输出）。 */
export function exploreCodegraph(
  query: string,
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(
      "codegraph",
      ["explore", query, "--project", projectPath],
      { env, timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolvePromise(`codegraph explore 失败：${String(error.message)}${stderr ? `\n${stderr}` : ""}`);
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

/**
 * 纪律工具主入口（ctx.tools 注册的 execute）。
 * 流程：解析 projectPath（缺省补全为当前 worktree）→ 强制 sync → 校验 → explore。
 * 任一环节无法自动完成 → 拒绝并返回明确提示（不抛错，工具返回文本）。
 */
export async function guardedExplore(
  args: { query: string; projectPath?: string },
  cwd: string | undefined,
): Promise<string> {
  // 1. projectPath 解析：显式传入优先；缺省补全为当前会话 worktree。
  let projectPath = args.projectPath;
  if (projectPath === undefined || projectPath === "") {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot === undefined) {
      return "codegraph_explore 被纪律拦截：无法确定 projectPath（当前目录非 git 仓或无 worktree 上下文）。请显式传 projectPath 指向已 init 的 worktree，或先 codegraph init <path> 建索引。";
    }
    projectPath = gitRoot;
  }
  // 2. 校验 projectPath 有索引（.codegraph 目录存在），否则引导 init。
  if (!existsSync(join(projectPath, ".codegraph"))) {
    return `codegraph_explore 被纪律拦截：${projectPath} 没有 .codegraph 索引。请先执行：codegraph init ${projectPath}`;
  }
  // 3. 强制 sync（新鲜度硬保证，~0.8s 固定开销）。
  const synced = await syncCodegraph(projectPath);
  if (!synced) {
    return `codegraph_explore 被纪律拦截：codegraph sync ${projectPath} 失败。请检查 codegraph CLI 是否可用（codegraph status ${projectPath}）。`;
  }
  // 4. explore。
  return exploreCodegraph(args.query, projectPath);
}
