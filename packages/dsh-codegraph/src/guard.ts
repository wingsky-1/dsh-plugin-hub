/**
 * 纪律工具（工具层硬纪律）——codegraph 裸名工具通用守护执行器。
 *
 * 覆盖 7 个裸名纪律工具：codegraph_explore（既有）+ codegraph_impact / node /
 * callers / callees / search / files（#363 新增），全部共用 guardedCodegraph。
 *
 * 核心价值（评审①②的 P1 修正落地）：
 * - **查询前强制 sync**：worktree 索引的新鲜度完全由 sync 驱动（watcher 只盯
 *   serve 根 = 主 checkout，worktree 无 watcher 覆盖）——不 sync 就查询会拿到
 *   旧内容（silent wrong answer）。故每次查询前先对目标 projectPath 执行
 *   `codegraph sync <path>`（~0.8s 固定开销，实测可接受）。
 * - **sync TTL 缓存（#363 补充）**：进程内 TTL——30s 内同一 projectPath 已 sync
 *   成功则跳过（模型一步内连调 callers + callees 是常见组合，串行两次 0.8s+）。
 *   只缓存 sync 步骤、**不缓存查询结果**（新鲜度硬保证不变）。
 * - **区分「命令失败」与「查询空结果」（#363 补充）**：CLI 1.6.0 实测各子命令
 *   空结果均走 stdout 提示且退出码 0：
 *     - impact/callers/callees 未找到符号 → `ℹ Symbol "X" not found`；
 *     - query 无结果 → `ℹ No results found for "X"`；
 *     - callees/callers 无调用 → `ℹ No callees found` / `ℹ No callers found`；
 *     - node 未找到符号 → `Symbol "X" not found in the codebase`；
 *     - files 无匹配 → `ℹ No files found matching the criteria.`；
 *     - explore 无相关内容 → `No relevant code found for "X"`。
 *   真正失败（未知选项 / 缺参 / 未初始化）走 stderr 且退出码 1。因此以
 *   「退出码 0 + stdout 含空结果特征」判定为空结果 → 返回中文空结果提示
 *   而非错误。
 * - **校验/补全 projectPath**：不传 projectPath 时自动补全为当前会话 worktree
 *   （agent.session.header.cwd 向上找 .git 标记）；补全不了（无 worktree 上下文）
 *   → 拒绝调用并提示。杜绝「漏传 projectPath 静默查主 checkout 基线」。
 * - 自动补全 + 拒绝兜底：能自动（sync、补全 projectPath）就自动；自动不了
 *   （无 worktree 上下文、sync 失败）→ 拒绝并给出明确提示。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveCodegraphPath } from "./install.ts";

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

/** sync TTL（毫秒）：30s 内同一 projectPath 已 sync 成功则跳过（#363 补充）。 */
export const SYNC_TTL_MS = 30_000;

/**
 * 进程内 sync TTL 缓存：projectPath → 上次 sync 成功时间戳。
 * 只缓存 sync 步骤、不缓存查询结果（新鲜度硬保证不变）。
 * 顶层模块级变量（进程生命周期），测试用 resetSyncCache() 清理。
 */
const syncCache = new Map<string, number>();

/** 清空 sync TTL 缓存（测试隔离用）。 */
export function resetSyncCache(): void {
  syncCache.clear();
}

/** 执行 codegraph sync（增量更新索引）。返回是否成功。 */
export function syncCodegraph(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const bin = resolveCodegraphPath(env);
    if (bin === undefined) {
      resolvePromise(false);
      return;
    }
    execFile(bin, ["sync", projectPath], { env, timeout: 30000 }, (error) => {
      resolvePromise(error === null);
    });
  });
}

/**
 * 带 TTL 缓存的 sync：30s 内同一 projectPath 已 sync 成功 → 跳过（不重复 0.8s）。
 * 只缓存成功；失败不缓存（下次重试）。
 */
export async function syncCodegraphCached(projectPath: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const now = Date.now();
  const last = syncCache.get(projectPath);
  if (last !== undefined && now - last < SYNC_TTL_MS) return true;
  const ok = await syncCodegraph(projectPath, env);
  if (ok) syncCache.set(projectPath, Date.now());
  else syncCache.delete(projectPath);
  return ok;
}

/**
 * 空结果特征判定：退出码 0 + stdout 含任一空结果特征 → 查询空结果（非命令失败）。
 * CLI 1.6.0 实测（见文件头）：
 * - impact/callers/callees 未找到符号 → `ℹ Symbol "X" not found`（stdout, exit 0）；
 * - query 无结果 → `ℹ No results found for "X"`（stdout, exit 0）；
 * - callees 无调用 → `ℹ No callees found for "X"`（stdout, exit 0）；
 * - callers 无调用 → `ℹ No callers found for "X"`（stdout, exit 0）；
 * - node 未找到符号 → `Symbol "X" not found in the codebase`（stdout, exit 0）；
 * - files 无匹配 → `ℹ No files found matching the criteria.`（stdout, exit 0）。
 */
export function isNoResultOutput(stdout: string): boolean {
  if (/ℹ .*not found/i.test(stdout)) return true;
  if (/No results found/i.test(stdout)) return true;
  if (/No (callers|callees|files) found/i.test(stdout)) return true;
  if (/not found in the codebase/i.test(stdout)) return true;
  if (/No relevant code found/i.test(stdout)) return true;
  return false;
}

/** 执行 codegraph explore（CLI 形态，与 MCP 工具同输出；-p/--path 指定项目）。 */
export function exploreCodegraph(
  query: string,
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolvePromise) => {
    const bin = resolveCodegraphPath(env);
    if (bin === undefined) {
      resolvePromise("codegraph CLI 未安装（PATH 未找到）。请先安装：npm install -g @colbymchenry/codegraph");
      return;
    }
    execFile(
      bin,
      ["explore", query, "--path", projectPath],
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
 * 纪律工具通用守护执行器（#363）：所有 codegraph 裸名纪律工具共用的
 * 「projectPath 解析 → 索引校验 → 强制 sync（TTL）→ 执行」管线。
 *
 * 8 类异常分支统一中文提示 + 下一步指引（见 issue 补充异常分支清单）：
 * 1. 非 git 无 worktree → 拒绝并提示显式传 projectPath；
 * 2. 无 .codegraph 索引 → 引导 codegraph init <path>；
 * 3. sync 失败 → 提示检查 codegraph CLI（codegraph status <path>）；
 * 4. CLI 未装 → 提示 npm install -g @colbymchenry/codegraph；
 * 5. 符号未找到（CLI 空结果提示）→ 空结果提示 + 下一步（codegraph_search 查
 *    有效符号名 / 确认已 sync）；
 * 6. 同名歧义 → 由 execute 层 query 列候选后返回消歧提示（本函数不判定）；
 * 7. 空结果（找到符号但无调用者/影响面等）→ 提示可用 codegraph status 确认
 *    索引范围；
 * 8. 超时/进程错误 → 提示检查 codegraph CLI 是否可用。
 *
 * 返回纯文本（含拒绝/提示），不抛错（纪律工具惯例返回文本）。
 */
export async function guardedCodegraph(
  args: { projectPath?: string },
  cwd: string | undefined,
  run: (projectPath: string) => Promise<{ stdout: string; stderr: string; code: number }>,
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // 1. projectPath 解析：显式传入优先；缺省补全为当前会话 worktree。
  let projectPath = args.projectPath;
  if (projectPath === undefined || projectPath === "") {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot === undefined) {
      return `${toolName} 被纪律拦截：无法确定 projectPath（当前目录非 git 仓）。请显式传 projectPath 或先在工作区打开 git 仓。`;
    }
    projectPath = gitRoot;
  }
  // 2. 校验 projectPath 有索引（.codegraph 目录存在），否则引导 init。
  if (!existsSync(join(projectPath, ".codegraph"))) {
    return `${toolName} 被纪律拦截：${projectPath} 没有 .codegraph 索引。请先执行：codegraph init ${projectPath}`;
  }
  // 3. 强制 sync（TTL 缓存，30s 内同 projectPath 不重复）。
  const synced = await syncCodegraphCached(projectPath, env);
  if (!synced) {
    if (resolveCodegraphPath(env) === undefined) {
      return `${toolName}：codegraph CLI 未安装，请执行 npm install -g @colbymchenry/codegraph 后重试。`;
    }
    return `${toolName} 被纪律拦截：sync 失败。请检查 codegraph CLI（codegraph status ${projectPath}）。`;
  }
  // 4. 执行查询子命令。
  const { stdout, stderr, code } = await run(projectPath);
  // 5. 区分「命令失败」与「查询空结果」：退出码 1（stderr 有错误）→ 命令失败；
  //    退出码 0 + stdout 空结果特征 → 查询空结果（非错误）。
  if (code !== 0) {
    if (stderr.includes("codegraph CLI 未安装")) {
      return `${toolName}：codegraph CLI 未安装，请执行 npm install -g @colbymchenry/codegraph 后重试。`;
    }
    const detail = stderr.trim() !== "" ? stderr.trim() : stdout.trim();
    return `${toolName} 执行失败：${detail || String(code)}。请检查 codegraph CLI 是否可用。`;
  }
  if (isNoResultOutput(stdout)) {
    return `${toolName}：查询无结果。可先用 codegraph_search 查有效符号名，或确认已 sync。`;
  }
  return stdout;
}

/** 执行 codegraph 子命令（-p/--path 指定项目），返回 stdout/stderr/退出码。 */
export function runCodegraph(
  cmdArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const bin = resolveCodegraphPath(env);
    if (bin === undefined) {
      resolvePromise({ stdout: "", stderr: "codegraph CLI 未安装", code: 127 });
      return;
    }
    execFile(bin, cmdArgs, { env, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ stdout, stderr, code: 0 });
        return;
      }
      // 失败：退出码优先取 error.code（number）；stderr 为空时附 error.message
      //（如 ENOENT 等进程级错误），供 guardedCodegraph 的中文提示使用。
      const code = typeof error.code === "number" ? error.code : 1;
      const detail = stderr !== "" ? stderr : error.message ?? "";
      resolvePromise({ stdout, stderr: detail, code });
    });
  });
}

/**
 * 纪律工具主入口（ctx.tools 注册的 execute）——codegraph_explore。
 * 流程：解析 projectPath（缺省补全为当前 worktree）→ 强制 sync → 校验 → explore。
 * 任一环节无法自动完成 → 拒绝并返回明确提示（不抛错，工具返回文本）。
 */
export async function guardedExplore(
  args: { query: string; projectPath?: string },
  cwd: string | undefined,
): Promise<string> {
  return guardedCodegraph(args, cwd, async (projectPath) => {
    const r = await runCodegraph(["explore", args.query, "--path", projectPath]);
    // explore 无结果时 CLI 输出 `ℹ No results found` 形态，交由统一判定。
    return r;
  }, "codegraph_explore");
}
