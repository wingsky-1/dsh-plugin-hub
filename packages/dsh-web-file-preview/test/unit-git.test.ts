// @ts-nocheck
/**
 * dsh-web-file-preview — unit：git diff 探测（computeGitDiff）。
 *
 * mkdtemp 建真实 git 仓库（git init 不可用时跳过仓库段，不影响其余断言）：
 * - no-changes：已提交无变化
 * - hasDiff：已修改 + diff 含新增行
 * - untracked：未跟踪新文件
 * - 非 git 目录 → not-git（git 缺失时 rev-parse ENOENT 同样归 not-git，无需 git 环境）
 * - 仓库外路径 → outside-repo（cwd 落在仓库的符号链接路径上）
 */
import { assert } from "./helpers.ts";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { computeGitDiff } from "../lib/index.js";

const root = mkdtempSync(join(tmpdir(), "fwp-ut-git-"));

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

try {
  const plain = join(root, "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "hello.txt"), "hi", "utf8");
  assert.deepEqual(
    await computeGitDiff(plain, "hello.txt"),
    { hasDiff: false, reason: "not-git" },
    "非 git 目录 → not-git",
  );

  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (args) => git(repo, args);
  if (g(["init"]).status === 0) {
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "line1\n", "utf8");
    g(["add", "."]);
    g(["commit", "-m", "c1"]);

    assert.deepEqual(
      await computeGitDiff(repo, "a.txt"),
      { hasDiff: false, reason: "no-changes" },
      "已提交无变化 → no-changes",
    );

    writeFileSync(join(repo, "a.txt"), "line1\nline2\n", "utf8");
    const r = await computeGitDiff(repo, "a.txt");
    assert.equal(r.hasDiff, true, "已修改 → hasDiff");
    assert.ok(r.diff !== undefined && r.diff.includes("+line2"), "diff 含新增行");
    assert.equal(r.path, "a.txt", "diff 结果带相对路径");

    writeFileSync(join(repo, "new.txt"), "x\n", "utf8");
    const u = await computeGitDiff(repo, "new.txt");
    assert.equal(u.hasDiff, true, "未跟踪 → hasDiff");
    assert.equal(u.untracked, true, "未跟踪 → untracked");
    assert.equal(u.path, "new.txt", "untracked 带相对路径");

    // outside-repo：cwd 落在符号链接路径上（link → repo），git rev-parse 返回
    // realpath 后的 toplevel（repo），而 resolved 仍走未归一化的 link 前缀 →
    // relative(repo, link/a.txt) = ../link/a.txt → outside-repo
    let linked = false;
    try {
      symlinkSync(repo, join(root, "repo-link"), "dir");
      linked = true;
    } catch {
      /* Windows 权限受限 → 跳过 */
    }
    if (linked) {
      assert.deepEqual(
        await computeGitDiff(join(root, "repo-link"), "a.txt"),
        { hasDiff: false, reason: "outside-repo" },
        "仓库外路径（符号链接 cwd）→ outside-repo",
      );
    } else {
      console.log("  (跳过 outside-repo 断言：symlink 不可用)");
    }
  } else {
    console.log("  (跳过 git 仓库断言：git init 不可用)");
  }

  console.log("PASS unit-git");
} finally {
  rmSync(root, { recursive: true, force: true });
}
