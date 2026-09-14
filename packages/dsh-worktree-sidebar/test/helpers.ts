/**
 * 测试支撑模块（support，不是测试条目——层登记见 mutation-topology 的 `$testLayers`）。
 *
 * 所有落盘都在 mkdtempSync 的隔离目录里：仓库纪律 #218 的产物零污染是红线，
 * 而 git fixture 天然要写很多文件，靠 `.gitignore` 兜底不算合规。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 建一个用后即弃的隔离目录。 */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), "dsh-worktree-sidebar-" + prefix + "-"));
}

/** 递归删除。清理失败不该让用例判红，故吞掉异常。 */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 跑一条 git（fixture 搭建期用）。被测代码一律走注入的 exec 面，
 * 只有「把仓库造成那个样子」这一步不属于被测范围。
 */
export function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** 在隔离目录里造一个真仓库并提交一次。关掉 gpgsign：用户的全局配置不该让 fixture 失败。 */
export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}
