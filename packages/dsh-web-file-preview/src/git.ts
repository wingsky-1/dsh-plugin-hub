/**
 * dsh-web-file-preview — git diff 计算（宿主端，F2-B）。
 *
 * 对给定文件判断是否「在 git 仓库且与 HEAD 有变化」，并在有变化时返回其 diff：
 *  - not-git       → 文件不在任何 git 仓库内
 *  - outside-repo  → 文件解析后落在 git 仓库之外
 *  - no-changes    → 已跟踪但无未提交变更
 *  - untracked     → 存在新文件（未跟踪，无基线；hasDiff=true 但无 diff 文本）
 *  - error         → git 进程级故障（不可用/超时/输出超限），与「无变化」区分
 *  - 其余         → hasDiff=true + diff（`git diff HEAD -- <rel>` 统一 diff 文本）
 *
 * 说明（评审 C3/C4）：改用异步 execFile（promisify）——不阻塞服务事件循环
 * （原 spawnSync 在每个 diff 请求上同步跑 2~3 次 git，最大 3×8s，会卡死 SSE
 * 对话流）；显式 maxBuffer（spawnSync 默认 1MB 会让大 diff 静默判成 no-changes）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import untildify from "untildify";

const execFileAsync = promisify(execFile);

/** diff 探测结果。 */
export interface GitDiffResult {
  hasDiff: boolean;
  untracked?: boolean;
  reason?: "not-git" | "outside-repo" | "no-changes" | "error";
  diff?: string;
  path?: string;
}

interface GitRun {
  ok: boolean;
  out: string;
  /** 进程级故障（git 缺失/超时/输出超限），区别于「命令正常退出且无输出」。 */
  failed: boolean;
}

/** git 输出上限（评审 C4：默认 1MB 会静默丢弃大 diff，显式放宽并标记失败）。 */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * 执行 git 命令（异步、限时、限输出）。
 * @param args - git 参数。
 * @param timeoutMs - 超时毫秒。
 */
async function runGit(args: string[], timeoutMs = 8000): Promise<GitRun> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return { ok: true, out: String(stdout ?? ""), failed: false };
  } catch (error) {
    // 超时 → error.killed；输出超限 → message 含 maxBuffer；命令缺失 → code ENOENT。
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    const failed =
      err.killed === true ||
      err.code === "ENOMEM" ||
      /maxBuffer/i.test(String(err.message)) ||
      err.code === "ETIMEDOUT";
    return { ok: false, out: "", failed };
  }
}

/**
 * 计算某文件相对其 git 仓库 HEAD 的 diff（若有）。
 * @param cwd - 会话 cwd（用于解析路径）。
 * @param path - 相对或绝对路径。
 * @returns diff 探测结果（async，不阻塞事件循环）。
 */
export async function computeGitDiff(cwd: string, path: string): Promise<GitDiffResult> {
  const resolved = resolve(cwd, untildify(path));
  const dir = dirname(resolved);

  const top = await runGit(["-C", dir, "rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out.trim() === "") {
    return { hasDiff: false, reason: top.failed ? "error" : "not-git" };
  }
  const root = top.out.trim();
  const rel = relative(root, resolved);
  if (rel === "" || isAbsolute(rel) || rel.startsWith("..")) {
    return { hasDiff: false, reason: "outside-repo" };
  }

  const status = await runGit(["-C", root, "status", "--porcelain", "--", rel]);
  if (status.failed) {
    return { hasDiff: false, reason: "error" };
  }
  const lines = status.out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  if (lines.length === 0) {
    return { hasDiff: false, reason: "no-changes" };
  }
  const untracked = lines.some((l) => /^\?\?/.test(l));
  if (untracked) {
    return { hasDiff: true, untracked: true, path: rel };
  }

  const diff = await runGit(["-C", root, "diff", "--no-ext-diff", "HEAD", "--", rel]);
  if (diff.failed) {
    return { hasDiff: false, reason: "error" };
  }
  if (!diff.ok || diff.out.trim() === "") {
    return { hasDiff: false, reason: "no-changes" };
  }
  return { hasDiff: true, diff: diff.out, path: rel };
}