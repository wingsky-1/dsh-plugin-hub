/**
 * git 域 —— 真仓库、真 worktree、真子进程。
 *
 * 单测断言的是 argv 长什么样，这里断言的是 **git 真的接受那份 argv**。
 * 两者不可互相替代：`--` 的位置在纸面上再合理，git 也可能不认；
 * 而这只在真 git 上跑一次才知道。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitExecPort } from "../../src/server/git/deps.ts";
import * as gitApi from "../../src/server/git/interface.ts";
import { cleanup, initRepo, tempDir } from "../helpers.ts";

const dirs: string[] = [];

function fixture(): { repo: string } {
  const root = tempDir("git");
  dirs.push(root);
  const repo = join(root, "repo");
  initRepo(repo);
  gitApi.installGit({ exec: gitApi.gitExec });
  return { repo };
}

afterEach(() => {
  gitApi.releaseGit();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("仓库识别", () => {
  it("commonDir 返回绝对路径（git 自己会返回相对的 .git）", async () => {
    const { repo } = fixture();
    const dir = await gitApi.commonDir(repo);
    expect(dir).toBeDefined();
    expect(dir?.startsWith("/")).toBe(true);
    expect(dir?.endsWith(".git")).toBe(true);
  });

  it("非仓库目录返回 undefined 而不是抛异常", async () => {
    const root = tempDir("norepo");
    dirs.push(root);
    fixture();
    expect(await gitApi.commonDir(root)).toBeUndefined();
  });
});

describe("worktree 增删（argv 的真实可执行性）", () => {
  it("addWorktree 建出目录，belongsTo 认它，headBranch 报分支名", async () => {
    const { repo } = fixture();
    const wt = join(repo, "..", "wt-feature");
    expect(await gitApi.addWorktree(repo, wt, "feature", undefined)).toEqual({ ok: true });

    expect(existsSync(wt)).toBe(true);
    expect(await gitApi.belongsTo(wt, repo)).toEqual({ kind: "same" });
    expect(await gitApi.headBranch(wt)).toBe("feature");
    expect(await gitApi.commonDir(wt)).toBe(await gitApi.commonDir(repo));
  });

  it("省略分支时走 --detach：含空格的 basename 也建得出来（这条默认路径以前是 fatal）", async () => {
    const { repo } = fixture();
    // macOS 家目录常含空格（John Doe / My Project）：不做 --detach 的话 git 会拿 basename
    // 当新分支名，报 fatal: 'wt space' is not a valid branch name。
    const wt = join(repo, "..", "wt space");
    expect(await gitApi.addWorktree(repo, wt, undefined, undefined)).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(true);
    // detached ⇒ 没有分支显示名，工具结果里的 branch 因此是空串（见 tools 域）。
    expect(await gitApi.headBranch(wt)).toBeUndefined();
  });

  it("listWorktrees 同时列出主仓库与新增的 worktree", async () => {
    const { repo } = fixture();
    const wt = join(repo, "..", "wt-two");
    await gitApi.addWorktree(repo, wt, "two", undefined);
    const paths = (await gitApi.listWorktrees(repo)).map((entry) => entry.path);
    expect(paths.length).toBe(2);
    expect(paths).toContain(repo);
    expect(paths).toContain(wt);
    const branches = (await gitApi.listWorktrees(repo)).map((entry) => entry.branch);
    expect(branches).toContain("refs/heads/two");
  });

  it("分支名非法时 addWorktree 判失败并给出 git 的原因", async () => {
    const { repo } = fixture();
    const wt = join(repo, "..", "wt-bad");
    expect(await gitApi.checkRefFormat("bad name")).toBe(false);
    expect(await gitApi.checkRefFormat("good-name")).toBe(true);
    const result = await gitApi.addWorktree(repo, wt, "bad name", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("removeWorktree 删掉 worktree：目录没了，归属读数随之变成「问不出来」", async () => {
    const { repo } = fixture();
    const wt = join(repo, "..", "wt-remove");
    await gitApi.addWorktree(repo, wt, "to-remove", undefined);
    expect(await gitApi.removeWorktree(repo, wt, false)).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(false);
    // 真机形态：目录消失后 git 报的是退出码 128 的失败（cannot change to …），与 `chmod 000`
    // 这类权限失败在读数上同形。所以这里必须是 unknown 而不是 different——
    // 摘不摘由 scope 域的「目录是否存在」那条硬判据决定，而不是由这次读不出来决定。
    expect((await gitApi.belongsTo(wt, repo)).kind).toBe("unknown");
  });

  it("删除不存在的工作区判失败而不是静默成功", async () => {
    const { repo } = fixture();
    const result = await gitApi.removeWorktree(repo, join(repo, "..", "nope"), false);
    expect(result.ok).toBe(false);
  });

  it("belongsTo 把两个都读得到的仓库判成 different（这才允许摘掉登记）", async () => {
    const { repo } = fixture();
    const root = tempDir("other");
    dirs.push(root);
    const other = join(root, "other");
    initRepo(other);
    expect(await gitApi.belongsTo(other, repo)).toEqual({ kind: "different" });
    expect(await gitApi.belongsTo(repo, other)).toEqual({ kind: "different" });
  });

  it("belongsTo 对不存在的路径返回 unknown 而不是抛异常", async () => {
    const { repo } = fixture();
    const reading = await gitApi.belongsTo(join(repo, "..", "ghost"), repo);
    expect(reading.kind).toBe("unknown");
  });
});

describe("装配守卫与 release 复位", () => {
  it("第二次装配当场抛错，不静默建成第二份状态", () => {
    fixture();
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => gitApi.installGit({ exec: gitApi.gitExec })).toThrow(
      "dsh-worktree-sidebar: git 域只能装配一次",
    );
  });

  it("release 丢掉归属缓存：换了 exec 之后不再返回旧结论", async () => {
    const { repo } = fixture();
    const root = tempDir("other");
    dirs.push(root);
    const other = join(root, "other");
    initRepo(other);
    // 先让缓存记住一个假结论（两个不同仓库）。
    expect(await gitApi.belongsTo(other, repo)).toEqual({ kind: "different" });

    gitApi.releaseGit();
    // 换成「所有目录的公共 git 目录都一样」的执行面：缓存若没被丢掉，这里还会看到 different。
    gitApi.installGit({ exec: sameCommonDirExec });
    expect(await gitApi.belongsTo(other, repo)).toEqual({ kind: "same" });
  });

  it("release 之后能力面当场失败，不拿旧 exec 出结果", async () => {
    gitApi.releaseGit();
    await expect(gitApi.commonDir("/")).rejects.toThrow("dsh-worktree-sidebar: git 域尚未装配");
  });
});

describe("归属缓存：与客户端刷新节拍解耦", () => {
  it("TTL 内不重复起 git，过期后才重算", async () => {
    const left = tempDir("ttl-left");
    const right = tempDir("ttl-right");
    dirs.push(left, right);
    let runs = 0;
    gitApi.releaseGit();
    gitApi.installGit({
      exec: {
        run: async () => {
          runs += 1;
          return { ok: true, stdout: "/shared/common\n", stderr: "", code: 0 };
        },
      },
    });

    vi.useFakeTimers();
    try {
      expect(await gitApi.belongsTo(left, right)).toEqual({ kind: "same" });
      // 一次归属判定 = 两个目录各问一次公共 git 目录。
      expect(runs).toBe(2);

      expect(await gitApi.belongsTo(left, right)).toEqual({ kind: "same" });
      expect(runs).toBe(2);

      // 恰好走过 TTL：缓存必须失效，否则「删掉的 worktree 仍被认作同一仓库」会被永久缓存。
      vi.advanceTimersByTime(30_000);
      expect(await gitApi.belongsTo(left, right)).toEqual({ kind: "same" });
      expect(runs).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 所有目录都报同一个公共 git 目录的执行面：用来把「缓存里的旧结论」与「新 exec 的答案」分开。 */
const sameCommonDirExec: GitExecPort = {
  run: async () => ({ ok: true, stdout: "/shared/common\n", stderr: "", code: 0 }),
};
