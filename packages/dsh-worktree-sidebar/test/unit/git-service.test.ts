/**
 * git 域**服务层** —— 白盒用例：递手写 exec 面直接驱动门面（真子进程只出现在 integration/git-real）。
 *
 * 为什么这一层必须有判据：仓库判定在**安装期**要给每个新 agent 判一次，而官方 `agents.create()`
 * 的契约是「setup → publication → loop start complete 才返回」（`dsh-agent/lib/index.js:415`），
 * 子会话的**第一回合**正落在那次判定之后。所以「同一个 cwd 不重复起子进程」是功能判据而不是性能优化：
 * 它决定子会话第一回合看不看得见本插件的工具（第六轮第三臂实验：一次 git 子进程 = 103ms = 输；
 * 缓存命中 ≈ 微任务级 = 赢）。TTL 取值纪律与 `belongsTo` 同源，见 `impl/service` 的注释。
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

const inRepo: GitRunResult = { ok: true, stdout: ".git\n", stderr: "" };
const notRepo: GitRunResult = { ok: false, stdout: "", stderr: "fatal: not a git repository" };

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

  it("「不是仓库」也进缓存：同一个非仓库目录不重复起子进程", async () => {
    const exec = fakeExec(() => notRepo);
    gitApi.installGit({ exec: exec.port });

    expect(await gitApi.commonDir("/plain")).toBeUndefined();
    expect(await gitApi.commonDir("/plain")).toBeUndefined();

    expect(exec.calls.length).toBe(1);
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
