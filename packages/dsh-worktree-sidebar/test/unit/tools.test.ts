/**
 * 三个 agent 工具 —— 用假端口驱动，逐条断言「调用了什么」与「回了什么」。
 *
 * 为什么值得这样测：工具是写绑定的**唯一**入口，它的每条失败路径都对应一种「模型会照着一个
 * 错的结论继续干活」——比如把创建成功但绑定失败报成纯失败，模型会去重试创建；
 * 比如缺 exec.agent 时回落到 process.cwd()，绑定会挂到一个与调用者无关的目录上。
 *
 * `ws_worktree_register` 会做一次真实的「存在且是目录」检查（那是它最容易给出含糊失败的地方），
 * 所以本文件用真临时目录作路径；git 侧仍是假端口。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { BindingRecord } from "../../src/server/binding/interface.ts";
import type { AgentFace, AgentPort, ToolsDeps } from "../../src/server/tools/deps.ts";
import { installTools, releaseTools } from "../../src/server/tools/interface.ts";
import { buildCreateTool } from "../../src/server/tools/impl/create/index.ts";
import { buildRegisterTool } from "../../src/server/tools/impl/register/index.ts";
import { buildRemoveTool } from "../../src/server/tools/impl/remove/index.ts";
import type { ToolResultValue } from "../../src/server/tools/impl/protocol/index.ts";
import {
  RESULT_SCHEMA,
  argBool,
  argString,
  renderResult,
} from "../../src/server/tools/impl/protocol/index.ts";
import { cleanup, tempDir } from "../helpers.ts";

let root = "";
let repo = "";
let existingWt = "";

beforeAll(() => {
  root = tempDir("tools-unit");
  repo = join(root, "repo");
  existingWt = join(root, "wt-feature");
  mkdirSync(repo, { recursive: true });
  mkdirSync(existingWt, { recursive: true });
});

afterAll(() => cleanup(root));

/** 会话 header 的创建时间：绑定记录要靠它区分「同一个会话」与「重启后复用同一 id 的另一个会话」。 */
const SESSION_CREATED_AT = 1_700_000_000_000;

/** 假 git 域把起点归一化成的 SHA：断言 argv 里出现的是它，而不是调用方给的原始 rev。 */
const START_SHA = "1111111111111111111111111111111111111111";

function fakeDeps(
  options: {
    /** 归属判定读数；缺省按「本临时根下、且不是主仓库本身」判 same。 */
    belongs?: "same" | "different" | "unknown";
    putOk?: boolean;
    addOk?: boolean;
    removeOk?: boolean;
    worktreeList?: readonly { path: string; branch: string | undefined; detached: boolean }[];
    agents?: AgentPort;
    /** 起点归一化失败（git 说不认识这个 rev）。 */
    resolveCommitFails?: boolean;
    /** 活会话的父链：子会话 id → 父会话 id（缺省没有父）。 */
    parents?: Record<string, string>;
    /** 已经确认失效的登记：scope 端口解析到它就摘掉并继续上跳，复刻真实自愈。 */
    staleBindings?: readonly string[];
    /** 让 scope 端口抛出这个错误（复刻域未装配 / 已释放），用来钉住异常收口的文案面。 */
    scopeThrows?: string;
  } = {},
) {
  const table = new Map<string, BindingRecord>();
  const gitCalls: string[][] = [];
  /** 起点归一化的入参（dir, rev）：形态 guard 命中时这里必须一条都没有。 */
  const resolveCalls: Array<[string, string]> = [];
  const writes: Array<{ session: string; record: BindingRecord }> = [];
  const drops: string[] = [];
  const warns: string[] = [];

  const deps: ToolsDeps = {
    logger: { warn: (m: string) => warns.push(m) },
    now: () => "2026-09-14T00:00:00.000Z",
    binding: {
      get: (id) => table.get(id),
      put: async (id, record) => {
        if (options.putOk === false) return { ok: false, reason: "disk full" };
        table.set(id, record);
        writes.push({ session: id, record });
        return { ok: true };
      },
      drop: async (id) => {
        table.delete(id);
        drops.push(id);
        return { ok: true };
      },
    },
    git: {
      // 只有本临时根下的目录「在仓库里」；它之外一律不是。
      commonDir: async (dir) => (dir.startsWith(root) ? join(root, ".git") : undefined),
      // 归属判定：本临时根下、且不是主仓库本身（主仓库是 worktree，但不是「某个 worktree」）。
      belongsTo: async (dir) => {
        if (options.belongs === "unknown") {
          return { kind: "unknown", reason: "git 执行失败（EACCES）", notRepo: false } as const;
        }
        if (options.belongs === "different") return { kind: "different" } as const;
        return dir.startsWith(root) && !dir.startsWith(repo)
          ? ({ kind: "same" } as const)
          : ({ kind: "different" } as const);
      },
      headBranch: async () => "feature",
      checkRefFormat: async (branch) => !branch.includes(" "),
      addWorktree: async (r, path, branch, base) => {
        gitCalls.push(["add", r, path, branch ?? "", base ?? ""]);
        return options.addOk === false ? { ok: false, reason: "already exists" } : { ok: true };
      },
      resolveCommit: async (dir, rev) => {
        resolveCalls.push([dir, rev]);
        return options.resolveCommitFails === true ? undefined : START_SHA;
      },
      removeWorktree: async (r, path, force) => {
        gitCalls.push(["remove", r, path, String(force)]);
        return options.removeOk === false
          ? { ok: false, reason: "contains modified files" }
          : { ok: true };
      },
      listWorktrees: async () =>
        options.worktreeList ?? [
          { path: repo, branch: "refs/heads/main", detached: false },
          { path: existingWt, branch: "refs/heads/feature", detached: false },
        ],
    },
    scope: {
      // 复刻 scope 域的真实三态（own / inherited / none）与它的一条硬语义：解析到已确认失效的
      // 登记时**摘掉并继续上跳**。写成「找不到就硬编码 inherited」会让下面所有继承态用例变成装饰。
      worktreeOrigin: async (id) => {
        // 抛的可以是内部装配文案（`dsh-worktree-sidebar: scope 域尚未装配`）——收口后它不该到模型面前。
        if (options.scopeThrows !== undefined) throw new Error(options.scopeThrows);
        const seen = new Set<string>([id]);
        let current = id;
        for (;;) {
          const record = table.get(current);
          if (record !== undefined) {
            if (options.staleBindings?.includes(current) === true) {
              table.delete(current);
              drops.push(current);
            } else if (current === id) {
              return { kind: "own", record };
            } else {
              return { kind: "inherited", record, ownerSessionId: current };
            }
          }
          const parent = options.parents?.[current];
          if (parent === undefined || seen.has(parent)) return { kind: "none" };
          seen.add(parent);
          current = parent;
        }
      },
    },
    agents: options.agents ?? {
      subscribe: () => () => undefined,
      list: () => [],
      publish: () => () => undefined,
    },
  };

  return { deps, table, gitCalls, resolveCalls, writes, drops, warns };
}

/**
 * 父会话那条登记（继承面的源）。写成函数是因为 repo / existingWt 在 beforeAll 里才赋值——
 * 模块级常量会取到空串，用例就在测一个不存在的路径。
 */
const parentRecord = (): BindingRecord => ({
  repoRoot: repo,
  worktreeRoot: existingWt,
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
  sessionCreatedAt: SESSION_CREATED_AT,
});

/**
 * 假执行上下文。被测代码只读 `exec.agent.session`：身份、取消信号与上下文延迟这些字段
 * 本插件一个都不碰，所以断言面刻意只收到那一个字段——补全其余字段只会让夹具和真实上下文
 * 一样重，却不会让任何判据变强。
 */
interface FakeExec {
  readonly agent?: {
    readonly session?: {
      readonly id: string;
      readonly header: { readonly cwd: string | undefined; readonly createdAt?: number };
    };
  };
}

/** 显式传 undefined 会被默认参数吃掉，所以「没有 createdAt」必须走这个工厂。 */
const execWithSession = (cwd: string, createdAt: number | undefined): FakeExec => ({
  agent: { session: { id: "s1", header: { cwd, createdAt } } },
});

const exec = (cwd: string = repo): FakeExec => execWithSession(cwd, SESSION_CREATED_AT);

async function run(
  tool: ToolDefinition,
  args: unknown,
  ctx: FakeExec = exec(),
): Promise<ToolResultValue> {
  // 唯一一处断言：把窄假件递给要求完整 ToolRunContext 的入口，收窄面见上面的 FakeExec。
  return (await tool.execute(args, ctx as ToolRunContext)) as ToolResultValue;
}

describe("ws_worktree_register", () => {
  it("成功：落一条绑定，repoRoot 取会话 cwd、branch 取自 worktree", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(buildRegisterTool(deps), { worktree: existingWt });
    expect(value.ok).toBe(true);
    expect(value.bound).toBe(true);
    expect(value.worktree).toBe(existingWt);
    expect(value.branch).toBe("feature");
    expect(writes).toEqual([
      {
        session: "s1",
        record: {
          repoRoot: repo,
          worktreeRoot: existingWt,
          branch: "feature",
          createdAt: "2026-09-14T00:00:00.000Z",
          sessionCreatedAt: SESSION_CREATED_AT,
        },
      },
    ]);
  });

  it("缺少 worktree 参数判失败且不落盘", async () => {
    const { deps, writes } = fakeDeps();
    expect((await run(buildRegisterTool(deps), {})).ok).toBe(false);
    expect(writes.length).toBe(0);
  });

  it("目录不存在判失败，并在 detail 里给出可用 worktree 清单", async () => {
    const { deps } = fakeDeps();
    const ghost = join(root, "ghost");
    const value = await run(buildRegisterTool(deps), { worktree: ghost });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No such directory: " + ghost);
    expect(value.detail).toContain(existingWt);
  });

  it("存在但不是本仓库的 worktree 判失败", async () => {
    const { deps, writes } = fakeDeps();
    // repo 本身存在且是目录，但假 git 的归属判定只认 existingWt。
    const value = await run(buildRegisterTool(deps), { worktree: repo });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("not a worktree of this session's repository");
    expect(writes.length).toBe(0);
  });

  it("归属读不出来时 fail-closed：拒绝绑定，且不把它说成「不是本仓库」", async () => {
    const { deps, writes } = fakeDeps({ belongs: "unknown" });
    const value = await run(buildRegisterTool(deps), { worktree: existingWt });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Could not verify");
    expect(value.detail).toContain("EACCES");
    expect(writes.length).toBe(0);
  });

  it("会话没有创建时间戳时拒绝绑定（不可核对的登记比不登记更危险）", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(
      buildRegisterTool(deps),
      { worktree: existingWt },
      execWithSession(repo, undefined),
    );
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("no creation timestamp");
    expect(writes.length).toBe(0);
  });

  it("会话 cwd 是空串时判失败，不拿空串去问 git", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(buildRegisterTool(deps), { worktree: existingWt }, exec(""));
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("no working directory");
    expect(writes.length).toBe(0);
  });

  it("路径参数前后空白按 trim 后解析（空白串视同缺席）", async () => {
    const padded = fakeDeps();
    await run(buildRegisterTool(padded.deps), { worktree: "  " + existingWt + "  " });
    expect(padded.writes[0]?.record.worktreeRoot).toBe(existingWt);

    const blank = fakeDeps();
    const value = await run(buildRegisterTool(blank.deps), { worktree: "   " });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Missing required parameter: worktree.");
    expect(blank.writes.length).toBe(0);
  });

  it("可用 worktree 清单为空时，失败文案不挂一个空标题", async () => {
    const { deps } = fakeDeps({ worktreeList: [] });
    const value = await run(buildRegisterTool(deps), { worktree: join(root, "ghost") });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No such directory");
    expect(value.detail).not.toContain("Available worktrees");
  });

  it("listWorktrees 失败降级成空清单：工具照常给出原本的失败原因", async () => {
    const { deps } = fakeDeps();
    const failing: ToolsDeps = {
      ...deps,
      // git 域把「列出失败」翻成空清单（见 git-service 的 listWorktrees 判据），工具因此不会
      // 因为一次附带提示的失败而变成框架级错误。
      git: { ...deps.git, listWorktrees: async () => [] },
    };
    const value = await run(buildRegisterTool(failing), { worktree: join(root, "ghost") });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No such directory");
  });

  it("会话不在 git 仓库里判失败", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(
      buildRegisterTool(deps),
      { worktree: existingWt },
      exec("/outside-root"),
    );
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("not inside a git repository");
    expect(writes.length).toBe(0);
  });

  it("相对路径按会话 cwd 解析（不是进程 cwd）", async () => {
    const { deps, writes } = fakeDeps();
    await run(buildRegisterTool(deps), { worktree: "../wt-feature" });
    expect(writes[0]?.record.worktreeRoot).toBe(existingWt);
  });

  it("缺少 exec.agent 时明确失败，不猜会话", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(buildRegisterTool(deps), { worktree: existingWt }, {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("needs an agent session");
    expect(writes.length).toBe(0);
  });

  it("落盘失败时 ok 为假、并给出原因", async () => {
    const { deps } = fakeDeps({ putOk: false });
    const value = await run(buildRegisterTool(deps), { worktree: existingWt });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("disk full");
    expect(value.bound).toBe(false);
  });
});

describe("ws_worktree_create", () => {
  const newPath = () => join(root, "new-wt");

  it("合法分支：先 add 再绑定，argv 透传 repo/路径/分支", async () => {
    const { deps, gitCalls, writes } = fakeDeps();
    const value = await run(buildCreateTool(deps), { path: newPath(), branch: "feat-x" });
    expect(value.ok).toBe(true);
    expect(gitCalls).toEqual([["add", repo, newPath(), "feat-x", ""]]);
    expect(writes[0]?.record.worktreeRoot).toBe(newPath());
  });

  it("不给分支时不传 -b（argv 里是空串）", async () => {
    const { deps, gitCalls } = fakeDeps();
    await run(buildCreateTool(deps), { path: newPath() });
    expect(gitCalls[0]?.[3]).toBe("");
  });

  it("缺少 exec.agent 时明确失败，不猜会话", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(buildCreateTool(deps), { path: newPath() }, {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("needs an agent session");
    expect(gitCalls.length).toBe(0);
  });

  it("会话没有 cwd 时判失败，不去问 git", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(
      buildCreateTool(deps),
      { path: newPath() },
      execWithSession("", undefined),
    );
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("no working directory");
    expect(gitCalls.length).toBe(0);
  });

  it("会话不在 git 仓库里时判失败，且不建目录", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(buildCreateTool(deps), { path: newPath() }, exec("/outside-root"));
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("not inside a git repository");
    expect(gitCalls.length).toBe(0);
  });

  it("缺少 path 参数时判失败，且不调 git", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(buildCreateTool(deps), {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Missing required parameter: path.");
    expect(gitCalls.length).toBe(0);
  });

  it("非法分支名在调用 git 之前就判失败", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(buildCreateTool(deps), { path: newPath(), branch: "bad name" });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Not a valid git branch name");
    expect(gitCalls.length).toBe(0);
  });

  it("git worktree add 失败时回传 git 的原因", async () => {
    const { deps } = fakeDeps({ addOk: false });
    const value = await run(buildCreateTool(deps), { path: newPath() });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("git worktree add failed: already exists");
  });

  it("目录已创建但绑定失败时说明是部分成功，不报成纯失败", async () => {
    const { deps } = fakeDeps({ belongs: "different" });
    const value = await run(buildCreateTool(deps), { path: newPath() });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("The worktree was created at " + newPath());
    expect(value.detail).toContain("left in place");
  });

  it("base 归一化：git 侧拿到的是 SHA，原始 rev 只用于解析", async () => {
    const { deps, gitCalls, resolveCalls } = fakeDeps();
    const value = await run(buildCreateTool(deps), { path: newPath(), base: "origin/main" });
    expect(value.ok).toBe(true);
    expect(resolveCalls).toEqual([[repo, "origin/main"]]);
    expect(gitCalls).toEqual([["add", repo, newPath(), "", START_SHA]]);
  });

  it("base 以 - 开头一律在调用 git 之前判失败", async () => {
    // 实测：worktree add -b br -- <path> --force 与 -f 都 rc=0，但起点被静默忽略、从 HEAD 建；
    // -badref 会被二次解析成 git branch 的选项。三者都必须在 argv 之前拦下。
    for (const base of ["--force", "-f", "-badref"]) {
      const { deps, gitCalls, resolveCalls } = fakeDeps();
      const value = await run(buildCreateTool(deps), { path: newPath(), base });
      expect(value.ok).toBe(false);
      expect(value.detail).toContain("Not a valid start point: " + base);
      expect(gitCalls.length).toBe(0);
      expect(resolveCalls.length).toBe(0);
    }
  });

  it("base 解析不出来时判失败，且不建目录", async () => {
    const { deps, gitCalls, resolveCalls } = fakeDeps({ resolveCommitFails: true });
    const value = await run(buildCreateTool(deps), { path: newPath(), base: "nosuchref" });
    expect(value.ok).toBe(false);
    expect(value.detail).toBe("Not a valid start point: nosuchref.");
    expect(resolveCalls).toEqual([[repo, "nosuchref"]]);
    expect(gitCalls.length).toBe(0);
  });

  it("不给 base 时不解析起点，起点位置参数为空", async () => {
    const { deps, gitCalls, resolveCalls } = fakeDeps();
    await run(buildCreateTool(deps), { path: newPath(), branch: "feat-x" });
    expect(resolveCalls.length).toBe(0);
    expect(gitCalls).toEqual([["add", repo, newPath(), "feat-x", ""]]);
  });
});

describe("ws_worktree_remove", () => {
  async function withBinding() {
    const fake = fakeDeps();
    await run(buildRegisterTool(fake.deps), { worktree: existingWt });
    return fake;
  }

  it("没有绑定时判失败", async () => {
    const { deps, gitCalls } = fakeDeps();
    const value = await run(buildRemoveTool(deps), {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No worktree is bound");
    expect(gitCalls.length).toBe(0);
  });

  it("默认只摘登记，不删目录", async () => {
    const { deps, gitCalls, drops, table } = await withBinding();
    const value = await run(buildRemoveTool(deps), {});
    expect(value.ok).toBe(true);
    expect(value.bound).toBe(false);
    expect(drops).toEqual(["s1"]);
    expect(gitCalls.length).toBe(0);
    expect(table.has("s1")).toBe(false);
  });

  it("removeDirectory 才走 git worktree remove", async () => {
    const { deps, gitCalls, drops } = await withBinding();
    const value = await run(buildRemoveTool(deps), { removeDirectory: true });
    expect(value.ok).toBe(true);
    expect(gitCalls).toEqual([["remove", repo, existingWt, "false"]]);
    expect(drops).toEqual(["s1"]);
  });

  it("force 透传到 git worktree remove", async () => {
    const { deps, gitCalls } = await withBinding();
    await run(buildRemoveTool(deps), { removeDirectory: true, force: true });
    expect(gitCalls[0]?.[3]).toBe("true");
  });

  it("单独给 force 判失败，且不动任何状态", async () => {
    const { deps, gitCalls, drops, table } = await withBinding();
    const value = await run(buildRemoveTool(deps), { force: true });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("force only applies together with removeDirectory");
    expect(gitCalls.length).toBe(0);
    expect(drops.length).toBe(0);
    expect(table.has("s1")).toBe(true);
  });

  it("缺少 exec.agent 时明确失败，不猜会话", async () => {
    const { deps, drops } = fakeDeps();
    const value = await run(buildRemoveTool(deps), {}, {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("needs an agent session");
    expect(drops.length).toBe(0);
  });

  it("只摘登记时落盘失败：说清没能持久化，且不动内存状态", async () => {
    const fake = await withBinding();
    const failing: ToolsDeps = {
      ...fake.deps,
      binding: {
        ...fake.deps.binding,
        drop: async () => ({ ok: false, reason: "disk full" }),
      },
    };
    const value = await run(buildRemoveTool(failing), {});
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Could not persist the unbind: disk full");
    // 「写盘失败时内存不前移」这条性质住 binding 域，由 test/integration/binding-store.test.ts 的
    // 「目标路径不可写时回传原因、内存不前移、并出声」覆盖（那里递的是真实落盘面）。
    // 本用例这一层能判的只有「失败说得清」——上一条断言即是全部。
  });

  it("removeDirectory 用的是解析到的记录，不再回来读一次表", async () => {
    const fake = await withBinding();
    const snapshotOnly: ToolsDeps = {
      ...fake.deps,
      binding: {
        ...fake.deps.binding,
        // 解析走的是 scope 端口里的表快照；这里让**随后**的任何直接读表都拿不到记录，
        // 用来钉住「删目录用的是解析结果，不存在第二次读取造成的含糊失败」。
        get: () => undefined,
      },
    };
    const value = await run(buildRemoveTool(snapshotOnly), { removeDirectory: true });
    expect(value.ok).toBe(true);
    expect(value.detail).toContain("removed the worktree directory");
  });

  it("目录删掉了但摘登记失败：明确说这是陈旧登记、会被按未绑定处理", async () => {
    const fake = await withBinding();
    const failing: ToolsDeps = {
      ...fake.deps,
      binding: {
        ...fake.deps.binding,
        drop: async () => ({ ok: false, reason: "disk full" }),
      },
    };
    const value = await run(buildRemoveTool(failing), { removeDirectory: true });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("the binding could not be dropped");
    expect(value.detail).toContain("disk full");
  });

  it("git worktree remove 失败时保留绑定并回传原因", async () => {
    const { deps, drops, table } = await withBinding();
    const failing: ToolsDeps = {
      ...deps,
      git: {
        ...deps.git,
        removeWorktree: async () => ({ ok: false, reason: "contains modified files" }),
      },
    };
    const value = await run(buildRemoveTool(failing), { removeDirectory: true });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("contains modified files");
    expect(drops.length).toBe(0);
    expect(table.has("s1")).toBe(true);
  });
});

describe("继承态下的工具面（#847）", () => {
  it("remove（不删目录）：判失败、报来源会话与现状，不摘父记录、不调 git", async () => {
    const { deps, table, drops, gitCalls } = fakeDeps({ parents: { s1: "parent" } });
    table.set("parent", parentRecord());
    const value = await run(buildRemoveTool(deps), {});
    expect(value.ok).toBe(false);
    expect(value.bound).toBe(true);
    expect(value.worktree).toBe(existingWt);
    expect(value.branch).toBe("feature");
    expect(value.detail).toContain("inherited from session parent");
    expect(value.detail).toContain("ws_worktree_remove");
    expect(value.detail).toContain("ws_worktree_register");
    expect(drops).toEqual([]);
    expect(gitCalls.length).toBe(0);
    expect(table.has("parent")).toBe(true);
  });

  it("remove（removeDirectory: true）：同样不摘父记录、不删目录", async () => {
    const { deps, table, drops, gitCalls } = fakeDeps({ parents: { s1: "parent" } });
    table.set("parent", parentRecord());
    const value = await run(buildRemoveTool(deps), { removeDirectory: true, force: true });
    expect(value.ok).toBe(false);
    expect(value.bound).toBe(true);
    expect(drops).toEqual([]);
    expect(gitCalls.length).toBe(0);
    expect(table.has("parent")).toBe(true);
  });

  it("来源报的是最近一个持有登记的祖先，不是直接父", async () => {
    const { deps, table } = fakeDeps({ parents: { s1: "mid", mid: "grand" } });
    table.set("grand", parentRecord());
    const value = await run(buildRemoveTool(deps), {});
    expect(value.detail).toContain("inherited from session grand");
  });

  it("register / create 在继承态下的失败读数仍报继承现状（bound=true）", async () => {
    const { deps, table } = fakeDeps({ parents: { s1: "parent" } });
    table.set("parent", parentRecord());
    const missing = join(root, "no-such-dir");
    const registered = await run(buildRegisterTool(deps), { worktree: missing });
    expect(registered.ok).toBe(false);
    expect(registered.bound).toBe(true);
    expect(registered.worktree).toBe(existingWt);
    expect(registered.detail).toContain("inherited from session parent");
    const created = await run(buildCreateTool(deps), { path: missing, branch: "bad name" });
    expect(created.ok).toBe(false);
    expect(created.bound).toBe(true);
    expect(created.worktree).toBe(existingWt);
    expect(created.detail).toContain("inherited from session parent");
  });

  it("摘掉自己的登记后若父链还有登记，明说右栏改为继承", async () => {
    const { deps, table } = fakeDeps({ parents: { s1: "parent" } });
    table.set("parent", parentRecord());
    const registered = await run(buildRegisterTool(deps), { worktree: existingWt });
    expect(registered.ok).toBe(true);
    const value = await run(buildRemoveTool(deps), {});
    expect(value.ok).toBe(true);
    expect(value.bound).toBe(true);
    expect(value.worktree).toBe(existingWt);
    expect(value.detail).toContain("inherited from session parent");
  });

  it("父链上的登记已确认失效时，工具调用先摘掉它（自愈副作用在工具路径上照样发生）", async () => {
    const { deps, table, drops } = fakeDeps({
      parents: { s1: "parent" },
      staleBindings: ["parent"],
    });
    table.set("parent", parentRecord());
    const value = await run(buildRemoveTool(deps), {});
    expect(drops).toEqual(["parent"]);
    expect(table.has("parent")).toBe(false);
    expect(value.ok).toBe(false);
    expect(value.bound).toBe(false);
    expect(value.detail).toContain("No worktree is bound");
  });
});

describe("绑定来源读不出来时的收口（复核 P3-5）", () => {
  // 抛的正是 scope 域未装配时的内部文案：它不该出现在模型读到的 detail 里。
  const INTERNAL = "dsh-worktree-sidebar: scope 域尚未装配";

  it("remove：报可读失败、不透出内部装配文案，且原因进 logger", async () => {
    const { deps, warns } = fakeDeps({ scopeThrows: INTERNAL });
    const value = await run(buildRemoveTool(deps), {});
    expect(value.ok).toBe(false);
    expect(value.bound).toBe(false);
    expect(value.detail).toContain("Could not read this session's binding state");
    expect(value.detail).not.toContain("尚未装配");
    expect(warns.join("\n")).toContain("尚未装配");
  });

  it("create：报可读失败，且不建目录、不落绑定", async () => {
    const { deps, gitCalls, writes } = fakeDeps({ scopeThrows: INTERNAL });
    const value = await run(buildCreateTool(deps), { path: join(root, "wt-new") });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Could not read this session's binding state");
    expect(value.detail).not.toContain("尚未装配");
    expect(gitCalls.length).toBe(0);
    expect(writes.length).toBe(0);
  });

  it("register：报可读失败，且不落绑定", async () => {
    const { deps, writes } = fakeDeps({ scopeThrows: INTERNAL });
    const value = await run(buildRegisterTool(deps), { worktree: existingWt });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("Could not read this session's binding state");
    expect(value.detail).not.toContain("尚未装配");
    expect(writes.length).toBe(0);
  });
});

/** 假的 agent 注册面：只记原始事实（订了几个、装给谁、退订了吗），不替被测代码做判断。 */
function fakeAgents(initial: readonly AgentFace[]) {
  const handlers: Array<(agent: AgentFace) => void> = [];
  const published: string[] = [];
  const released: string[] = [];
  let unsubscribed = false;
  const port: AgentPort = {
    subscribe: (handler) => {
      handlers.push(handler);
      return () => {
        unsubscribed = true;
      };
    },
    list: () => initial,
    publish: (agent) => {
      published.push(agent.id);
      return () => {
        released.push(agent.id);
      };
    },
  };
  return {
    port,
    published,
    released,
    isUnsubscribed: () => unsubscribed,
    emit: (agent: AgentFace) => {
      for (const handler of handlers) handler(agent);
    },
  };
}

/** 排空一轮队列：工具域的判定链要走完一次 git 调用才会 publish。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("tools 域的装配与释放", () => {
  afterEach(() => releaseTools());

  it("装配时给已经在跑的 agent 装一次；release 摘掉工具并退订", async () => {
    const agents = fakeAgents([{ id: "a1", cwd: repo }]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    await settle();
    expect(agents.published).toEqual(["a1"]);

    releaseTools();
    expect(agents.released).toEqual(["a1"]);
    expect(agents.isUnsubscribed()).toBe(true);
  });

  it("父与子两个 agent 各装一次；release 两个都摘掉", async () => {
    const agents = fakeAgents([
      { id: "parent", cwd: repo },
      { id: "child", cwd: repo },
    ]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    await settle();
    expect(agents.published).toEqual(["parent", "child"]);

    releaseTools();
    // 逆序摘除；顺序写死，免得「漏摘一个」被掩成通过。
    expect(agents.released).toEqual(["child", "parent"]);
  });

  it("装配之后新发布的 agent 也会被装上（订阅入口）", async () => {
    const agents = fakeAgents([]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    agents.emit({ id: "a2", cwd: repo });
    await settle();
    expect(agents.published).toEqual(["a2"]);
  });

  it("不在 git 仓库里的 agent 一个工具都不装", async () => {
    const agents = fakeAgents([{ id: "a3", cwd: "/outside-root" }]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    await settle();
    expect(agents.published).toEqual([]);
  });

  it("判定期间出错时出声，不静默丢掉这个 agent", async () => {
    const agents = fakeAgents([{ id: "a5", cwd: repo }]);
    const { deps, warns } = fakeDeps({ agents: agents.port });
    const exploding: ToolsDeps = {
      ...deps,
      git: {
        ...deps.git,
        commonDir: async () => {
          throw new Error("git exploded");
        },
      },
    };
    installTools(exploding);
    await settle();
    expect(agents.published).toEqual([]);
    expect(warns.some((w) => w.includes("工具注册失败") && w.includes("git exploded"))).toBe(true);
  });

  it("没有 cwd 的 agent 不装（猜一个会给出错的工具）", async () => {
    const agents = fakeAgents([{ id: "a4", cwd: undefined }]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    await settle();
    expect(agents.published).toEqual([]);
  });

  it("release 之后再装配，同一个 agent 必须能再装一次（映射已复位）", async () => {
    const agents = fakeAgents([{ id: "a1", cwd: repo }]);
    const { deps } = fakeDeps({ agents: agents.port });
    installTools(deps);
    await settle();
    expect(agents.published).toEqual(["a1"]);

    releaseTools();
    installTools(deps);
    await settle();
    // perAgent 不复位的话这里会是 ["a1"]：工具永远装不上，而第二次装配一声不响。
    expect(agents.published).toEqual(["a1", "a1"]);
  });

  it("第二次装配当场抛错，不静默建成第二份注册表", () => {
    const { deps } = fakeDeps();
    installTools(deps);
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => installTools(deps)).toThrow("dsh-worktree-sidebar: tools 域只能装配一次");
  });
});

describe("返回文本", () => {
  it("渲染永远带当前状态行（模型不必再调一次确认）", async () => {
    const { deps } = fakeDeps();
    const tool = buildRegisterTool(deps);
    const value = await run(tool, { worktree: existingWt });
    const rendered = tool.output.render(undefined, { ...value }) as Array<{
      type: string;
      text: string;
    }>;
    expect(rendered[0]?.type).toBe("text");
    expect(rendered[0]?.text).toContain("bound worktree: " + existingWt + " [feature]");
  });

  it("create 的渲染也走同一张信封（它自己那个 render 闭包不能是死代码）", async () => {
    const { deps } = fakeDeps();
    const tool = buildCreateTool(deps);
    const target = join(root, "render-wt");
    const value = await run(tool, { path: target, branch: "feat-x" });
    const rendered = tool.output.render(undefined, { ...value }) as Array<{
      type: string;
      text: string;
    }>;
    expect(rendered[0]?.type).toBe("text");
    // branch 取自 headBranch（假 git 恒回 "feature"），不是入参里的分支名。
    expect(rendered[0]?.text).toContain("bound worktree: " + target + " [feature]");
  });

  it("结果信封的 schema 与宿主 enforced subset 逐字一致（字段名/类型/必填/禁增改即红）", () => {
    // 字面量逐字钉死宿主契约：这里故意不从实现 import 期望值。
    expect(RESULT_SCHEMA).toEqual({
      type: "object",
      properties: {
        ok: { type: "boolean", description: "Whether the requested operation succeeded." },
        bound: {
          type: "boolean",
          description:
            "Whether a worktree is bound to this session or inherited from a parent session after the call.",
        },
        worktree: {
          type: "string",
          description: "Absolute path of the bound worktree; empty when bound is false.",
        },
        branch: {
          type: "string",
          description: "Bound branch name; empty when bound is false or the worktree is detached.",
        },
        detail: {
          type: "string",
          description:
            "What happened: for failures, the reason and the next thing to try; for successes, the effect.",
        },
      },
      required: ["ok", "bound", "worktree", "branch", "detail"],
      additionalProperties: false,
    });
  });

  it("renderResult 三态逐字：绑定带分支、detached 无分支后缀、未绑定", () => {
    expect(
      renderResult({ ok: true, bound: true, worktree: "/wt", branch: "feat", detail: "done" }),
    ).toEqual([{ type: "text", text: "bound worktree: /wt [feat]\ndone" }]);
    expect(
      renderResult({ ok: true, bound: true, worktree: "/wt", branch: "", detail: "done" }),
    ).toEqual([{ type: "text", text: "bound worktree: /wt\ndone" }]);
    expect(
      renderResult({ ok: false, bound: false, worktree: "", branch: "", detail: "nope" }),
    ).toEqual([{ type: "text", text: "no worktree bound to this session\nnope" }]);
  });

  it("argString 真值表：非对象/缺席/非串/空白视同缺席，其余 trim 后返回", () => {
    expect(argString(null, "k")).toBe(undefined);
    expect(argString(42, "k")).toBe(undefined);
    expect(argString({}, "k")).toBe(undefined);
    expect(argString({ k: 42 }, "k")).toBe(undefined);
    expect(argString({ k: true }, "k")).toBe(undefined);
    expect(argString({ k: "" }, "k")).toBe(undefined);
    expect(argString({ k: "   " }, "k")).toBe(undefined);
    expect(argString({ k: "  /wt  " }, "k")).toBe("/wt");
    expect(argString({ k: "/wt" }, "k")).toBe("/wt");
  });

  it("argBool 真值表：只有显式 true 为真，缺席/非布尔/字符串 true 都不算", () => {
    expect(argBool(null, "k")).toBe(false);
    expect(argBool(42, "k")).toBe(false);
    expect(argBool({}, "k")).toBe(false);
    expect(argBool({ k: true }, "k")).toBe(true);
    expect(argBool({ k: false }, "k")).toBe(false);
    expect(argBool({ k: "true" }, "k")).toBe(false);
    expect(argBool({ k: 1 }, "k")).toBe(false);
  });

  it("未绑定时状态行说明没有绑定", async () => {
    const { deps } = fakeDeps();
    const tool = buildRemoveTool(deps);
    const value = await run(tool, {});
    const rendered = tool.output.render(undefined, { ...value }) as Array<{
      type: string;
      text: string;
    }>;
    expect(rendered[0]?.text.startsWith("no worktree bound to this session")).toBe(true);
  });
});
