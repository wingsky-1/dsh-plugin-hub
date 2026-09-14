/**
 * git 域 —— 真仓库、真 worktree、真子进程。
 *
 * 单测断言的是 argv 长什么样，这里断言的是 **git 真的接受那份 argv**。
 * 两者不可互相替代：`--` 的位置在纸面上再合理，git 也可能不认；
 * 而这只在真 git 上跑一次才知道。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitExec, installGit, releaseGit } from "../../src/server/git/interface.ts";
import type { GitApi } from "../../src/server/git/interface.ts";
import { cleanup, initRepo, tempDir } from "../helpers.ts";

const dirs: string[] = [];

function fixture(): { repo: string; git: GitApi } {
  const root = tempDir("git");
  dirs.push(root);
  const repo = join(root, "repo");
  initRepo(repo);
  return { repo, git: installGit({ exec: createGitExec() }) };
}

afterEach(() => {
  releaseGit();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("仓库识别", () => {
  it("commonDir 返回绝对路径（git 自己会返回相对的 .git）", async () => {
    const { repo, git } = fixture();
    const dir = await git.commonDir(repo);
    expect(dir).toBeDefined();
    expect(dir?.startsWith("/")).toBe(true);
    expect(dir?.endsWith(".git")).toBe(true);
  });

  it("非仓库目录返回 undefined 而不是抛异常", async () => {
    const root = tempDir("norepo");
    dirs.push(root);
    const { git } = fixture();
    expect(await git.commonDir(root)).toBeUndefined();
  });
});

describe("worktree 增删（argv 的真实可执行性）", () => {
  it("addWorktree 建出目录，belongsTo 认它，headBranch 报分支名", async () => {
    const { repo, git } = fixture();
    const wt = join(repo, "..", "wt-feature");
    expect(await git.addWorktree(repo, wt, "feature")).toEqual({ ok: true });

    expect(existsSync(wt)).toBe(true);
    expect(await git.belongsTo(wt, repo)).toBe(true);
    expect(await git.headBranch(wt)).toBe("feature");
    expect(await git.commonDir(wt)).toBe(await git.commonDir(repo));
  });

  it("listWorktrees 同时列出主仓库与新增的 worktree", async () => {
    const { repo, git } = fixture();
    const wt = join(repo, "..", "wt-two");
    await git.addWorktree(repo, wt, "two");
    const paths = (await git.listWorktrees(repo)).map((entry) => entry.path);
    expect(paths.length).toBe(2);
    expect(paths).toContain(repo);
    expect(paths).toContain(wt);
    const branches = (await git.listWorktrees(repo)).map((entry) => entry.branch);
    expect(branches).toContain("refs/heads/two");
  });

  it("分支名非法时 addWorktree 判失败并给出 git 的原因", async () => {
    const { repo, git } = fixture();
    const wt = join(repo, "..", "wt-bad");
    expect(await git.checkRefFormat("bad name")).toBe(false);
    expect(await git.checkRefFormat("good-name")).toBe(true);
    const result = await git.addWorktree(repo, wt, "bad name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("removeWorktree 删掉 worktree，之后 belongsTo 为假", async () => {
    const { repo, git } = fixture();
    const wt = join(repo, "..", "wt-remove");
    await git.addWorktree(repo, wt, "to-remove");
    expect(await git.removeWorktree(repo, wt, false)).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(false);
    expect(await git.belongsTo(wt, repo)).toBe(false);
  });

  it("删除不存在的工作区判失败而不是静默成功", async () => {
    const { repo, git } = fixture();
    const result = await git.removeWorktree(repo, join(repo, "..", "nope"), false);
    expect(result.ok).toBe(false);
  });

  it("belongsTo 把不同仓库判成假", async () => {
    const { repo, git } = fixture();
    const root = tempDir("other");
    dirs.push(root);
    const other = join(root, "other");
    initRepo(other);
    expect(await git.belongsTo(other, repo)).toBe(false);
    expect(await git.belongsTo(repo, other)).toBe(false);
  });

  it("belongsTo 对不存在的路径返回假而不是抛异常", async () => {
    const { repo, git } = fixture();
    expect(await git.belongsTo(join(repo, "..", "ghost"), repo)).toBe(false);
  });
});

describe("装配守卫", () => {
  it("未装配时调用抛错", () => {
    releaseGit();
    expect(() => installGit({ exec: createGitExec() })).not.toThrow();
    releaseGit();
  });

  it("重复装配抛错", () => {
    fixture();
    expect(() => installGit({ exec: createGitExec() })).toThrow(/已装配/);
  });
});
