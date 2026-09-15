/**
 * 三个工具的**宿主端端到端**：真 git 仓库、真 worktree、真 bindings.json。
 *
 * 单测断言的是「我们调用了什么」，这里断言的是「在真 git 上跑完之后磁盘与仓库是什么样」。
 * 两者不可互相替代：参数顺序、git 对 -- 的接受程度、以及「绑定是否真的落了盘」只有真跑才知道。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { BindingRecord } from "../../src/server/binding/interface.ts";
import * as bindingApi from "../../src/server/binding/interface.ts";
import * as gitApi from "../../src/server/git/interface.ts";
import type { ToolsDeps } from "../../src/server/tools/deps.ts";
import { buildCreateTool } from "../../src/server/tools/impl/create/index.ts";
import { buildRegisterTool } from "../../src/server/tools/impl/register/index.ts";
import { buildRemoveTool } from "../../src/server/tools/impl/remove/index.ts";
import type { ToolResultValue } from "../../src/server/tools/impl/protocol/index.ts";
import { cleanup, git, initRepo, tempDir } from "../helpers.ts";

const dirs: string[] = [];
const warns: string[] = [];

interface Harness {
  readonly repo: string;
  readonly root: string;
  readonly file: string;
  readonly deps: ToolsDeps;
  readonly exec: ToolRunContext;
}

function harness(): Harness {
  const root = tempDir("tools-real");
  dirs.push(root);
  const repo = join(root, "repo");
  initRepo(repo);
  const file = join(root, "dsh-home", "@wingsky-1", "dsh-worktree-sidebar", "bindings.json");

  // 两个域都是进程内单例：装的是它们，递进工具域的是**门面命名空间对象**（消费方用 Pick 收窄）。
  bindingApi.installBinding({
    logger: { warn: (m: string) => warns.push(m) },
    file,
  });
  gitApi.installGit({ exec: gitApi.gitExec });

  return {
    repo,
    root,
    file,
    deps: {
      logger: { warn: (m: string) => warns.push(m) },
      now: () => "2026-09-14T00:00:00.000Z",
      binding: bindingApi,
      git: gitApi,
      agents: { subscribe: () => () => undefined, list: () => [], publish: () => () => undefined },
    },
    // 假执行上下文：被测代码只读 exec.agent.session，其余字段本插件一个都不碰。
    // header.createdAt 是绑定记录的凭据（会话 id 会被重启后的新会话复用），所以它必须在场。
    exec: {
      agent: { session: { id: "s1", header: { cwd: repo, createdAt: 1_700_000_000_000 } } },
    } as unknown as ToolRunContext,
  };
}

async function run(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolRunContext,
): Promise<ToolResultValue> {
  return (await tool.execute(args, ctx)) as ToolResultValue;
}

function bindingsOnDisk(file: string): Record<string, BindingRecord> {
  return (JSON.parse(readFileSync(file, "utf8")) as { bindings: Record<string, BindingRecord> })
    .bindings;
}

afterEach(async () => {
  // 先释放两个域再删目录：binding 的 release 会等在飞的写盘落定，反过来那次写会把刚删的目录又建回来。
  await bindingApi.releaseBinding();
  gitApi.releaseGit();
  for (const dir of dirs.splice(0)) cleanup(dir);
  warns.splice(0);
});

describe("ws_worktree_create 端到端", () => {
  it("建出真 worktree、落真绑定、绑到正确的分支", async () => {
    const h = harness();
    const target = join(h.root, "wt-created");
    const value = await run(
      buildCreateTool(h.deps),
      { path: target, branch: "wt-created-branch" },
      h.exec,
    );

    expect(value.ok).toBe(true);
    expect(value.worktree).toBe(target);
    expect(value.branch).toBe("wt-created-branch");
    expect(existsSync(target)).toBe(true);
    expect(bindingsOnDisk(h.file)["s1"]?.worktreeRoot).toBe(target);
    expect(bindingsOnDisk(h.file)["s1"]?.branch).toBe("wt-created-branch");
    // 新 worktree 确实与主仓库同源（这是「归属校验」在真 git 上的对照）。
    expect(git(h.repo, ["worktree", "list", "--porcelain"])).toContain(target);
  });

  it("不给分支时走 --detach：目录照建、绑定照落，branch 是空串", async () => {
    const h = harness();
    // 路径 basename 含空格：这条以前会 fatal（git 拿 basename 当新分支名），--detach 之后能建。
    const target = join(h.root, "wt no branch");
    const value = await run(buildCreateTool(h.deps), { path: target }, h.exec);

    expect(value.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(value.branch).toBe("");
    expect(bindingsOnDisk(h.file)["s1"]?.worktreeRoot).toBe(target);
  });

  it("非法分支名不建目录", async () => {
    const h = harness();
    const target = join(h.root, "wt-bad");
    const value = await run(buildCreateTool(h.deps), { path: target, branch: "bad name" }, h.exec);
    expect(value.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("目录已存在且非空时回传 git 的原因，且不落绑定", async () => {
    const h = harness();
    const target = join(h.root, "wt-dup");
    // 空目录 git 是接受的（实测），所以这里必须先放一个文件进去才构成「已存在」的失败场景。
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "occupied.txt"), "x\n", "utf8");
    const value = await run(buildCreateTool(h.deps), { path: target }, h.exec);
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("git worktree add failed");
    expect(existsSync(h.file)).toBe(false);
  });
});

describe("ws_worktree_register 端到端", () => {
  it("登记一个用 git 手工建出来的 worktree", async () => {
    const h = harness();
    const target = join(h.root, "wt-manual");
    git(h.repo, ["worktree", "add", "-b", "manual", "--", target]);

    const value = await run(buildRegisterTool(h.deps), { worktree: target }, h.exec);
    expect(value.ok).toBe(true);
    expect(value.branch).toBe("manual");
    expect(bindingsOnDisk(h.file)["s1"]?.repoRoot).toBe(h.repo);
  });

  it("普通目录（不是 worktree）判失败且不落绑定", async () => {
    const h = harness();
    const plain = join(h.root, "plain");
    mkdirSync(plain, { recursive: true });
    const value = await run(buildRegisterTool(h.deps), { worktree: plain }, h.exec);
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("not a worktree of this session's repository");
    expect(existsSync(h.file)).toBe(false);
  });

  it("不存在的路径判失败", async () => {
    const h = harness();
    const value = await run(buildRegisterTool(h.deps), { worktree: join(h.root, "ghost") }, h.exec);
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No such directory");
  });
});

describe("ws_worktree_remove 端到端", () => {
  it("默认只摘登记，目录留着", async () => {
    const h = harness();
    const target = join(h.root, "wt-keep");
    await run(buildCreateTool(h.deps), { path: target, branch: "keep" }, h.exec);

    const value = await run(buildRemoveTool(h.deps), {}, h.exec);
    expect(value.ok).toBe(true);
    expect(value.bound).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(bindingsOnDisk(h.file)["s1"]).toBeUndefined();
    // git 侧的 worktree 登记仍在：摘绑定不等于删目录。
    expect(git(h.repo, ["worktree", "list", "--porcelain"])).toContain(target);
  });

  it("removeDirectory 走 git worktree remove，目录与 git 登记一起消失", async () => {
    const h = harness();
    const target = join(h.root, "wt-gone");
    await run(buildCreateTool(h.deps), { path: target, branch: "gone" }, h.exec);

    const value = await run(buildRemoveTool(h.deps), { removeDirectory: true }, h.exec);
    expect(value.ok).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(bindingsOnDisk(h.file)["s1"]).toBeUndefined();
    expect(git(h.repo, ["worktree", "list", "--porcelain"])).not.toContain(target);
  });

  it("未绑定时判失败", async () => {
    const h = harness();
    const value = await run(buildRemoveTool(h.deps), {}, h.exec);
    expect(value.ok).toBe(false);
    expect(value.detail).toContain("No worktree is bound");
  });
});
