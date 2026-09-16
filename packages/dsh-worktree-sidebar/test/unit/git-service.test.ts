/**
 * git 域**服务层** —— 白盒用例：递手写 exec 面直接驱动门面（真子进程只出现在 integration/git-real）。
 *
 * 为什么这一层必须有判据：仓库判定在**安装期**要给每个新 agent 判一次，而官方 `agents.create()`
 * 的契约是「setup → publication → loop start complete 才返回」（`dsh-agent/lib/index.js:415`），
 * 子会话的**第一回合**正落在那次判定之后。所以「同一个 cwd 不重复起子进程」是功能判据而不是性能优化：
 * 它决定子会话第一回合看不看得见本插件的工具（第六轮第三臂实验：一次 git 子进程 = 103ms = 输；
 * 缓存命中 ≈ 微任务级 = 赢）。TTL 取值纪律与 `belongsTo` 同源，见 `impl/service` 的注释。
 *
 * 缓存只认**正结果**、归属判定回**三态**——这两条都是「一次读不出来不该变成一次永久摘除」的落地：
 * 前者管 `commonDir`（负结果下一刻就可能变真，比如用户在空目录里 `git init`），
 * 后者管 `belongsTo`（只有两侧都确实读到了公共 git 目录，才有资格说「换了仓库」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRunResult } from "../../src/server/git/deps.ts";
import * as gitApi from "../../src/server/git/interface.ts";

/** 记原始事实的 exec 面：跑了哪些 argv、跑了几次。 */
function fakeExec(answer: (args: readonly string[]) => GitRunResult) {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      run: async (args: readonly string[]): Promise<GitRunResult> => {
        calls.push([...args]);
        return answer(args);
      },
    },
  };
}

const inRepo: GitRunResult = { ok: true, stdout: ".git\n", stderr: "", code: 0 };
/** git 跑完了并给出否定答案：这是一个**答案**。 */
const notRepo: GitRunResult = {
  ok: false,
  stdout: "",
  stderr: "fatal: not a git repository",
  code: 128,
};
/** 进程根本没起来（spawn ENOENT / 超时被杀）：这不是答案，是问不出来。 */
const execFailed: GitRunResult = { ok: false, stdout: "", stderr: "spawn git ENOENT", code: null };

describe("git 域：仓库判定的 TTL 缓存", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
  });

  afterEach(() => {
    gitApi.releaseGit();
    vi.useRealTimers();
  });

  it("同一个目录第二次判定不再起子进程（这就是子会话首回合的那个窗口）", async () => {
    const exec = fakeExec(() => inRepo);
    gitApi.installGit({ exec: exec.port });

    await gitApi.commonDir("/repo");
    await gitApi.commonDir("/repo");

    expect(exec.calls.length).toBe(1);
  });

  it("负结果不进缓存：空目录 git init 之后，下一次判定立刻看得到", async () => {
    // 缓存负结果会把一次「刚 git init 完」的合法调用挡在 30s 之外，而它换来的只是一次省不掉的
    // 子进程（非仓库目录的判定本来就不在热路径上：安装期每个 agent 判一次，工具调用更是稀疏）。
    let initialized = false;
    const exec = fakeExec(() => (initialized ? inRepo : notRepo));
    gitApi.installGit({ exec: exec.port });

    expect(await gitApi.commonDir("/plain")).toBeUndefined();
    initialized = true;
    expect(await gitApi.commonDir("/plain")).toBe("/plain/.git");

    expect(exec.calls.length).toBe(2);
  });

  it("TTL 之内命中、过期后重新问 git", async () => {
    const exec = fakeExec(() => inRepo);
    gitApi.installGit({ exec: exec.port });

    await gitApi.commonDir("/repo");
    vi.setSystemTime(new Date(Date.now() + 29_000));
    await gitApi.commonDir("/repo");
    expect(exec.calls.length).toBe(1);

    vi.setSystemTime(new Date(Date.now() + 2_000));
    await gitApi.commonDir("/repo");
    expect(exec.calls.length).toBe(2);
  });

  it("release 丢掉缓存：下一次装配必须重新判定", async () => {
    const exec = fakeExec(() => inRepo);
    gitApi.installGit({ exec: exec.port });
    await gitApi.commonDir("/repo");

    gitApi.releaseGit();
    gitApi.installGit({ exec: exec.port });
    await gitApi.commonDir("/repo");

    expect(exec.calls.length).toBe(2);
  });

  it("条目上限：写满即整表丢弃（加速缓存，不是需要保真的状态）", async () => {
    const exec = fakeExec(() => inRepo);
    gitApi.installGit({ exec: exec.port });

    for (let i = 0; i < 257; i += 1) await gitApi.commonDir("/repo-" + i);
    // 上限 256：写第 257 个时整表被丢弃，于是最早那个目录要重新判定。
    await gitApi.commonDir("/repo-0");

    expect(exec.calls.filter((args) => args[1] === "/repo-0").length).toBe(2);
  });
});

describe("git 域：归属判定是三态", () => {
  afterEach(() => gitApi.releaseGit());

  /** 每个目录一个公共 git 目录答案；缺席的目录一律答「不是仓库」。 */
  function byDir(answers: Record<string, GitRunResult>) {
    return fakeExec((args) => answers[args[1] ?? ""] ?? notRepo);
  }

  it("两侧读到同一个公共 git 目录 ⇒ same", async () => {
    // worktree 侧必须回**同一个绝对路径**：`--git-common-dir` 平时回相对的 `.git`，
    // 而相对路径要按各自的 dir 解析，所以夹具这里直接给绝对值（解析规则由 computeCommonDir 负责）。
    const exec = byDir({ "/repo": inRepo, "/repo-wt": { ...inRepo, stdout: "/repo/.git\n" } });
    gitApi.installGit({ exec: exec.port });
    expect(await gitApi.belongsTo("/repo-wt", "/repo")).toEqual({ kind: "same" });
  });

  it("两侧都读到了、值不同 ⇒ different（这才允许摘掉用户的登记）", async () => {
    const exec = byDir({ "/repo": inRepo, "/other": inRepo });
    gitApi.installGit({ exec: exec.port });
    const reading = await gitApi.belongsTo("/other", "/repo");
    expect(reading.kind).toBe("different");
  });

  it("worktree 侧 git 执行失败 ⇒ unknown，原因里带上 stderr", async () => {
    const exec = byDir({ "/repo": inRepo, "/gone": execFailed });
    gitApi.installGit({ exec: exec.port });
    const reading = await gitApi.belongsTo("/gone", "/repo");
    expect(reading.kind).toBe("unknown");
    if (reading.kind !== "unknown") throw new Error("unreachable");
    expect(reading.reason).toContain("spawn git ENOENT");
    // 「问不出来」不是「不是工作树」：写路径要据此给出不同的失败文案。
    expect(reading.notRepo).toBe(false);
  });

  it("worktree 侧是「不是仓库」也归 unknown（权限失败与目录被换掉在读数上同形）", async () => {
    // 这条判据是刻意的保守：`chmod 000` 的真实 git 也是退出码 128 的失败，与「真的不是仓库」
    // 在读数上分不开。分不开就不摘——摘错的代价是永久丢掉用户的登记，留下的代价只是一次告警。
    const exec = byDir({ "/repo": inRepo, "/gone": notRepo });
    gitApi.installGit({ exec: exec.port });
    const reading = await gitApi.belongsTo("/gone", "/repo");
    expect(reading.kind).toBe("unknown");
    if (reading.kind !== "unknown") throw new Error("unreachable");
    expect(reading.reason).toContain("/gone");
    expect(reading.notRepo).toBe(true);
  });

  it("主仓库侧读不出来 ⇒ unknown", async () => {
    const exec = byDir({ "/repo-wt": inRepo });
    gitApi.installGit({ exec: exec.port });
    expect((await gitApi.belongsTo("/repo-wt", "/repo")).kind).toBe("unknown");
  });

  it("结论进缓存：同一个键第二次判定不再起子进程", async () => {
    const exec = byDir({ "/repo": inRepo, "/other": inRepo });
    gitApi.installGit({ exec: exec.port });
    await gitApi.belongsTo("/other", "/repo");
    await gitApi.belongsTo("/other", "/repo");
    expect(exec.calls.length).toBe(2);
  });

  it("unknown 不进缓存：问不出来之后状态变了，下一次判定必须重新问（否则「稍后重试」是空话）", async () => {
    // 写路径对 unknown 是 fail-closed，并回给调用方一句「等目录可读后重试」。把那次 unknown 缓存 30s
    // 就把这句建议变成确定性失败——真实的重试场景正是「目录刚变成 worktree」或「权限刚修好」。
    let ready = false;
    const exec = fakeExec((args) =>
      (args[1] ?? "") === "/repo"
        ? inRepo
        : ready
          ? { ...inRepo, stdout: "/repo/.git\n" }
          : notRepo,
    );
    gitApi.installGit({ exec: exec.port });

    expect((await gitApi.belongsTo("/repo-wt", "/repo")).kind).toBe("unknown");
    ready = true;
    expect(await gitApi.belongsTo("/repo-wt", "/repo")).toEqual({ kind: "same" });
  });
});

describe("git 域：其余读数的失败形态", () => {
  afterEach(() => gitApi.releaseGit());

  it("listWorktrees 失败回空数组，不抛异常（它只是失败提示的附带信息）", async () => {
    const exec = fakeExec(() => notRepo);
    gitApi.installGit({ exec: exec.port });
    await expect(gitApi.listWorktrees("/repo")).resolves.toEqual([]);
  });

  it("headBranch 把 detached 的 HEAD 读成「没有分支名」", async () => {
    const exec = fakeExec(() => ({ ok: true, stdout: "HEAD\n", stderr: "", code: 0 }));
    gitApi.installGit({ exec: exec.port });
    expect(await gitApi.headBranch("/wt")).toBeUndefined();
  });

  it("headBranch 在 git 失败时回 undefined", async () => {
    const exec = fakeExec(() => notRepo);
    gitApi.installGit({ exec: exec.port });
    expect(await gitApi.headBranch("/wt")).toBeUndefined();
  });

  it("git 成功但没有输出 ⇒ 公共目录读不出来（failed，不是「不是仓库」）", async () => {
    const exec = fakeExec(() => ({ ok: true, stdout: "", stderr: "", code: 0 }));
    gitApi.installGit({ exec: exec.port });
    const reading = await gitApi.belongsTo("/wt", "/repo");
    expect(reading.kind).toBe("unknown");
  });
});
