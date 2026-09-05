/**
 * dsh-mem0 — Git Canonical 命名空间解析（单一事实源）。
 *
 * 核心目标（ADR-2 & ADR-3）：
 * 1. 自动从当前会话工作目录 (cwd) 派生统一的项目命名空间；
 * 2. 消除 Git Worktree 导致的记忆割裂：向上寻址 git-common-dir 与
 *    remote.origin.url，使同一项目的主检出与所有 worktree 共享同一份长期记忆；
 * 3. 非 Git 目录安全回退至目录标识；
 * 4. 内存缓存（TTL / LRU），避免高频重复执行子进程。
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/** 命名空间缓存条目。 */
interface CacheEntry {
  namespace: string;
  expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 分钟 TTL

/** 全局命名空间。 */
export const GLOBAL_NAMESPACE = "global";

/**
 * 规范化 Git remote URL 为统一标识符。
 * 例：git@github.com:wingsky-1/dsh-plugin-hub.git -> github.com/wingsky-1/dsh-plugin-hub
 * 例：https://github.com/wingsky-1/dsh-plugin-hub.git -> github.com/wingsky-1/dsh-plugin-hub
 */
export function normalizeGitRemote(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  // SSH 格式：git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return `${host}/${owner}/${repo}`.toLowerCase();
  }
  // HTTP/HTTPS 格式：https://github.com/owner/repo.git
  const httpMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpMatch) {
    const [, host, owner, repo] = httpMatch;
    return `${host}/${owner}/${repo}`.toLowerCase();
  }
  // 其他回退
  return trimmed.replace(/\.git$/, "").toLowerCase();
}

/**
 * 安全执行 git 命令（超时 2s，静默捕获异常）。
 */
function runGit(args: string[], cwd: string): string {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * 查找并计算 Git Canonical 命名空间。
 */
function deriveNamespace(targetDir: string): string {
  // 1. 尝试获取 remote.origin.url
  const remoteUrl = runGit(["config", "--get", "remote.origin.url"], targetDir);
  if (remoteUrl) {
    const norm = normalizeGitRemote(remoteUrl);
    if (norm) return `proj:${norm}`;
  }

  // 2. 尝试寻找 common-dir 获取主仓库路径
  const commonDir = runGit(["rev-parse", "--git-common-dir"], targetDir);
  if (commonDir) {
    const absCommon = resolve(targetDir, commonDir);
    // 如果 commonDir 是 .git 结尾，取其父目录名
    const repoRoot = absCommon.endsWith("/.git") || absCommon.endsWith("\\.git")
      ? resolve(absCommon, "..")
      : absCommon;
    return `proj:${basename(repoRoot)}`;
  }

  // 3. 非 Git 目录，回退至所在文件夹名
  return `proj:${basename(targetDir)}`;
}

/**
 * 核心对外导出：从当前 cwd 计算 Git Canonical 命名空间。
 * 纯函数逻辑，附带内存缓存。
 */
export function resolveGitCanonicalNamespace(cwd?: string): string {
  if (!cwd || typeof cwd !== "string") {
    return GLOBAL_NAMESPACE;
  }

  const normalized = resolve(cwd);
  try {
    if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
      return GLOBAL_NAMESPACE;
    }
  } catch {
    return GLOBAL_NAMESPACE;
  }

  const now = Date.now();
  const cached = CACHE.get(normalized);
  if (cached && cached.expiresAt > now) {
    return cached.namespace;
  }

  const ns = deriveNamespace(normalized);
  CACHE.set(normalized, { namespace: ns, expiresAt: now + CACHE_TTL_MS });
  return ns;
}

/** 清理命名空间缓存（供测试使用）。 */
export function resetNamespaceCache(): void {
  CACHE.clear();
}
