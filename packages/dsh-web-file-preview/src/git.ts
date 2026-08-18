/**
 * dsh-web-file-preview — git diff 计算（宿主端，F2-B）。
 *
 * 对给定文件判断是否「在 git 仓库且与 HEAD 有变化」，并在有变化时返回其 diff：
 *  - not-git       → 文件不在任何 git 仓库内
 *  - outside-repo  → 文件解析后落在 git 仓库之外
 *  - no-changes    → 已跟踪但无未提交变更
 *  - untracked     → 存在新文件（未跟踪，无基线；hasDiff=true 但无 diff 文本）
 *  - 其余         → hasDiff=true + diff（`git diff HEAD -- <rel>` 统一 diff 文本）
 *
 * 说明：用同步 spawnSync（请求级小成本），git 未安装或超时安全降级。
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import untildify from "untildify";

/** diff 探测结果。 */
export interface GitDiffResult {
  hasDiff: boolean;
  untracked?: boolean;
  reason?: "not-git" | "outside-repo" | "no-changes";
  diff?: string;
  path?: string;
}

interface GitRun {
  ok: boolean;
  out: string;
}

function runGit(args: string[], timeoutMs = 8000): GitRun {
  try {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: timeoutMs });
    return { ok: r.status === 0, out: String(r.stdout ?? "") };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * 计算某文件相对其 git 仓库 HEAD 的 diff（若有）。
 * @param cwd - 会话 cwd（用于解析路径）。
 * @param path - 相对或绝对路径。
 */
export function computeGitDiff(cwd: string, path: string): GitDiffResult {
  const resolved = resolve(cwd, untildify(path));
  const dir = dirname(resolved);

  const top = runGit(["-C", dir, "rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out.trim() === "") {
    return { hasDiff: false, reason: "not-git" };
  }
  const root = top.out.trim();
  const rel = relative(root, resolved);
  if (rel === "" || isAbsolute(rel) || rel.startsWith("..")) {
    return { hasDiff: false, reason: "outside-repo" };
  }

  const status = runGit(["-C", root, "status", "--porcelain", "--", rel]);
  const lines = status.out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  if (lines.length === 0) {
    return { hasDiff: false, reason: "no-changes" };
  }
  const untracked = lines.some((l) => /^\?\?/.test(l));
  if (untracked) {
    return { hasDiff: true, untracked: true, path: rel };
  }

  const diff = runGit(["-C", root, "diff", "--no-ext-diff", "HEAD", "--", rel]);
  if (!diff.ok || diff.out.trim() === "") {
    return { hasDiff: false, reason: "no-changes" };
  }
  return { hasDiff: true, diff: diff.out, path: rel };
}
