/**
 * git 域 argv 构造与输出解析 —— 纯函数逐字断言。
 *
 * 为什么逐字断言 argv：`--` 的位置与 `-b` / `--detach` 的次序是**安全属性**而不是风格。
 * 少了 `--`，一个名为 `--force` 的路径就会被 git 当成标志；省略分支时不显式 `--detach`，
 * 路径 basename 会被 git 当成新分支名二次解析（含空格即 fatal，以 `-` 开头即被当开关）；
 * 分支名校验少一步，一个含换行的分支名就能改写 git 的其它参数。这些失效都不报错，只做错事。
 */
import { describe, expect, it } from "vitest";
import {
  addWorktreeArgs,
  checkRefFormatArgs,
  commonDirArgs,
  headBranchArgs,
  parseSingleLine,
  parseWorktreeList,
  removeWorktreeArgs,
  worktreeListArgs,
} from "../../src/server/git/impl/inspect/index.ts";

describe("argv 构造", () => {
  it("查询类一律用 -C 指定目录，不依赖进程 cwd", () => {
    expect(commonDirArgs("/repo")).toEqual(["-C", "/repo", "rev-parse", "--git-common-dir"]);
    expect(worktreeListArgs("/repo")).toEqual(["-C", "/repo", "worktree", "list", "--porcelain"]);
    expect(headBranchArgs("/repo")).toEqual(["-C", "/repo", "rev-parse", "--abbrev-ref", "HEAD"]);
  });

  it("分支名交给 git 自己校验", () => {
    expect(checkRefFormatArgs("feature/x")).toEqual(["check-ref-format", "--branch", "feature/x"]);
  });

  it("新建 worktree：有分支时 -b 在 -- 之前，路径在 -- 之后", () => {
    expect(addWorktreeArgs("/repo", "/wt", "feature")).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "-b",
      "feature",
      "--",
      "/wt",
    ]);
  });

  it("新建 worktree：不给分支时补 --detach，而不是没有标志", () => {
    // 省略 branch 时 git 的默认行为是「新建一个以目录 basename 命名的分支」：basename 含空格
    // （macOS 家目录常见）会 fatal，以 `-` 开头会被当成开关——`--` 挡不住这条二次解析链路。
    expect(addWorktreeArgs("/repo", "/wt", undefined)).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "--detach",
      "--",
      "/wt",
    ]);
    // 对含空格与以 - 开头的 basename 也一视同仁：argv 里没有把它们当分支名的那条路径。
    expect(addWorktreeArgs("/repo", "/wt space", undefined)).toContain("--detach");
    expect(addWorktreeArgs("/repo", "/-dash", undefined)).toContain("--detach");
  });

  it("删除 worktree：--force 在 -- 之前", () => {
    expect(removeWorktreeArgs("/repo", "/wt", true)).toEqual([
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--force",
      "--",
      "/wt",
    ]);
    expect(removeWorktreeArgs("/repo", "/wt", false)).toEqual([
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--",
      "/wt",
    ]);
  });

  it("形如选项的路径落在 -- 之后（参数注入的挡板）", () => {
    const args = addWorktreeArgs("/repo", "--force", undefined);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("--force"));
    const removal = removeWorktreeArgs("/repo", "--force", false);
    expect(removal.indexOf("--")).toBeLessThan(removal.indexOf("--force"));
  });
});

describe("parseSingleLine", () => {
  it("取首行并去掉首尾空白", () => {
    expect(parseSingleLine("  /repo/.git  \n")).toBe("/repo/.git");
  });

  it("空输出返回 undefined 而不是空串", () => {
    expect(parseSingleLine("")).toBeUndefined();
    expect(parseSingleLine("   \n  ")).toBeUndefined();
  });
});

describe("parseWorktreeList", () => {
  it("解析多块、分支与 detached", () => {
    const stdout = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /wt",
      "HEAD def",
      "branch refs/heads/feature",
      "",
      "worktree /wt2",
      "HEAD 123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(stdout)).toEqual([
      { path: "/repo", branch: "refs/heads/main", detached: false },
      { path: "/wt", branch: "refs/heads/feature", detached: false },
      { path: "/wt2", branch: undefined, detached: true },
    ]);
  });

  it("忽略没有 worktree 行的块", () => {
    expect(parseWorktreeList("HEAD abc\n\n")).toEqual([]);
  });

  it("空输入返回空数组", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
