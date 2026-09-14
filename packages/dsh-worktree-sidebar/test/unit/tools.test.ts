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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BindingRecord } from "../../src/contract.ts";
import type { ToolsDeps } from "../../src/server/tools/deps.ts";
import { buildCreateTool } from "../../src/server/tools/impl/create/index.ts";
import { buildRegisterTool } from "../../src/server/tools/impl/register/index.ts";
import { buildRemoveTool } from "../../src/server/tools/impl/remove/index.ts";
import type { ToolResultValue } from "../../src/server/tools/impl/protocol/index.ts";
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

function fakeDeps(
  options: { belongs?: boolean; putOk?: boolean; addOk?: boolean; removeOk?: boolean } = {},
) {
  const table = new Map<string, BindingRecord>();
  const gitCalls: string[][] = [];
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
      belongsTo: async (dir) =>
        options.belongs === false ? false : dir.startsWith(root) && !dir.startsWith(repo),
      headBranch: async () => "feature",
      checkRefFormat: async (branch) => !branch.includes(" "),
      addWorktree: async (r, path, branch) => {
        gitCalls.push(["add", r, path, branch ?? ""]);
        return options.addOk === false ? { ok: false, reason: "already exists" } : { ok: true };
      },
      removeWorktree: async (r, path, force) => {
        gitCalls.push(["remove", r, path, String(force)]);
        return options.removeOk === false
          ? { ok: false, reason: "contains modified files" }
          : { ok: true };
      },
      listWorktrees: async () => [
        { path: repo, branch: "refs/heads/main", detached: false },
        { path: existingWt, branch: "refs/heads/feature", detached: false },
      ],
    },
    agents: { subscribe: () => () => undefined, list: () => [], publish: () => () => undefined },
  };

  return { deps, table, gitCalls, writes, drops, warns };
}

const exec = () => ({ agent: { session: { id: "s1", header: { cwd: repo } } } });

async function run(
  tool: { execute: (a: unknown, e: unknown) => Promise<unknown> },
  args: unknown,
  ctx: unknown = exec(),
) {
  return (await tool.execute(args, ctx)) as ToolResultValue;
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

  it("会话不在 git 仓库里判失败", async () => {
    const { deps, writes } = fakeDeps();
    const value = await run(
      buildRegisterTool(deps),
      { worktree: existingWt },
      { agent: { session: { id: "s1", header: { cwd: "/outside-root" } } } },
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
    expect(gitCalls).toEqual([["add", repo, newPath(), "feat-x"]]);
    expect(writes[0]?.record.worktreeRoot).toBe(newPath());
  });

  it("不给分支时不传 -b（argv 里是空串）", async () => {
    const { deps, gitCalls } = fakeDeps();
    await run(buildCreateTool(deps), { path: newPath() });
    expect(gitCalls[0]?.[3]).toBe("");
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
    const { deps } = fakeDeps({ belongs: false });
    const value = await run(buildCreateTool(deps), { path: newPath() });
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("The worktree was created at " + newPath());
    expect(value.detail).toContain("left in place");
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

describe("返回文本", () => {
  it("渲染永远带当前状态行（模型不必再调一次确认）", async () => {
    const { deps } = fakeDeps();
    const tool = buildRegisterTool(deps);
    const value = await run(tool, { worktree: existingWt });
    const rendered = tool.output.render(undefined, value) as Array<{ type: string; text: string }>;
    expect(rendered[0]?.type).toBe("text");
    expect(rendered[0]?.text).toContain("bound worktree: " + existingWt + " [feature]");
  });

  it("未绑定时状态行说明没有绑定", async () => {
    const { deps } = fakeDeps();
    const tool = buildRemoveTool(deps);
    const value = await run(tool, {});
    const rendered = tool.output.render(undefined, value) as Array<{ type: string; text: string }>;
    expect(rendered[0]?.text.startsWith("no worktree bound to this session")).toBe(true);
  });
});
