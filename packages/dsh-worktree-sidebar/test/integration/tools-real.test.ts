/**
 * 三个工具的**宿主端端到端**：真 git 仓库、真 worktree、真 bindings.json。
 *
 * 单测断言的是「我们调用了什么」，这里断言的是「在真 git 上跑完之后磁盘与仓库是什么样」。
 * 两者不可互相替代：参数顺序、git 对 -- 的接受程度、以及「绑定是否真的落了盘」只有真跑才知道。
 *
 * scope 域在这里装的是**真件**而不是桩：继承解析、失效自愈、来源读数只有一份实现，
 * 于是「工具面与浏览器面说的是同一句话」这条判据能在真域上被断言，而不是靠一份复刻的假解析。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { BindingRecord } from "../../src/server/binding/interface.ts";
import * as bindingApi from "../../src/server/binding/interface.ts";
import * as gitApi from "../../src/server/git/interface.ts";
import type { LiveParent, LookupDescriptorPort, ScopeDeps } from "../../src/server/scope/deps.ts";
import * as scopeApi from "../../src/server/scope/interface.ts";
import type { ToolsDeps } from "../../src/server/tools/deps.ts";
import { buildCreateTool } from "../../src/server/tools/impl/create/index.ts";
import { buildRegisterTool } from "../../src/server/tools/impl/register/index.ts";
import { buildRemoveTool } from "../../src/server/tools/impl/remove/index.ts";
import type { ToolResultValue } from "../../src/server/tools/impl/protocol/index.ts";
import { cleanup, git, initRepo, tempDir } from "../helpers.ts";

const dirs: string[] = [];
const warns: string[] = [];

/** 会话 header 的创建时间：登记里的凭据必须与它一致，绑定才算属于这个会话。 */
const SESSION_CREATED_AT = 1_700_000_000_000;

interface Harness {
  readonly repo: string;
  readonly root: string;
  readonly file: string;
  readonly deps: ToolsDeps;
  readonly exec: ToolRunContext;
  /** 同一条链上另一个会话的执行上下文（构造 fork / 子会话的继承场景）。 */
  readonly execFor: (sessionId: string) => ToolRunContext;
}

/**
 * 假 typert 查找表。descriptor **必须**在 install 时就位：本域 install 会立刻 subscribe + attempt，
 * 拿不到它就停在 waiting —— 而不变量断言要的正是 live（waiting 下 effectiveWorktree 恒为 null）。
 * configure 不抛：抛了会被本域读成「已有第三方接管」，状态直接变 abandoned。
 */
function fakeTypert(): ScopeDeps["typert"] {
  const descriptor: LookupDescriptorPort = { resolve: async () => undefined };
  return {
    current: () => descriptor,
    subscribe: () => () => undefined,
    configure: () => () => undefined,
  };
}

/**
 * 假会话链：父链由一个 map 驱动，身份凭据统一是 SESSION_CREATED_AT。
 * 父链是继承解析的唯一输入，用 map 驱动才构造得出「本会话 → 无登记的中转会话 → 有登记的祖先」。
 */
function fakeSessions(parents: Record<string, string>): ScopeDeps["sessions"] {
  const known = new Set<string>([...Object.keys(parents), ...Object.values(parents)]);
  const identity = (id: string): { createdAt: number } | undefined =>
    known.has(id) ? { createdAt: SESSION_CREATED_AT } : undefined;
  return {
    liveParentOf: (id): LiveParent => {
      const parent = parents[id];
      return parent === undefined ? { kind: "root" } : { kind: "parent", id: parent };
    },
    storedParentOf: async () => undefined,
    liveIdentityOf: identity,
    storedIdentityOf: async (id) => identity(id),
  };
}

function harness(options: { sessionId?: string; parents?: Record<string, string> } = {}): Harness {
  const root = tempDir("tools-real");
  dirs.push(root);
  const repo = join(root, "repo");
  initRepo(repo);
  const file = join(root, "dsh-home", "@wingsky-1", "dsh-worktree-sidebar", "bindings.json");

  // 三个域都是进程内单例：装的是它们，递进工具域的是**门面命名空间对象**（消费方用 Pick 收窄）。
  // scope 装真件：工具面读的「继承来源」与浏览器面读的「生效根」必须是同一份解析。
  bindingApi.installBinding({ logger: { warn: (m: string) => warns.push(m) }, file });
  gitApi.installGit({ exec: gitApi.gitExec });
  scopeApi.installScope({
    logger: { warn: (m: string) => warns.push(m) },
    binding: bindingApi,
    git: gitApi,
    typert: fakeTypert(),
    sessions: fakeSessions(options.parents ?? {}),
  });

  // 假执行上下文：被测代码只读 exec.agent.session，其余字段本插件一个都不碰。
  // header.createdAt 是绑定记录的凭据（会话 id 会被重启后的新会话复用），所以它必须在场。
  const execFor = (sessionId: string): ToolRunContext =>
    ({
      agent: { session: { id: sessionId, header: { cwd: repo, createdAt: SESSION_CREATED_AT } } },
    }) as unknown as ToolRunContext;

  return {
    repo,
    root,
    file,
    deps: {
      logger: { warn: (m: string) => warns.push(m) },
      now: () => "2026-09-14T00:00:00.000Z",
      binding: bindingApi,
      git: gitApi,
      scope: scopeApi,
      agents: { subscribe: () => () => undefined, list: () => [], publish: () => () => undefined },
    },
    exec: execFor(options.sessionId ?? "s1"),
    execFor,
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
  // 先释放三个域再删目录：scope 持有 binding / git 的入参，binding 的 release 会等在飞的写盘落定，
  // 反过来那次写会把刚删的目录又建回来。
  scopeApi.releaseScope();
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

describe("工面与浏览器面同源（唯一事实源的不变量）", () => {
  it("own / inherited / none 三态下 worktreeOrigin 与 effectiveWorktree 给出同一个根", async () => {
    // s2 是 s1 的 fork：s2 自己没有登记，父链上的 s1 有。
    const h = harness({ parents: { s2: "s1" } });
    const target = join(h.root, "wt-shared");
    expect(
      (await run(buildCreateTool(h.deps), { path: target, branch: "shared" }, h.exec)).ok,
    ).toBe(true);

    // 不变量只在 live 态成立：waiting / abandoned 下 effectiveWorktree 恒为 null，那是刻意的接管门。
    expect(scopeApi.takeoverState()).toBe("live");

    for (const sessionId of ["s1", "s2"]) {
      const origin = await scopeApi.worktreeOrigin(sessionId);
      expect(scopeApi.rootOf(origin)).toBe(target);
      expect(scopeApi.rootOf(origin)).toBe(await scopeApi.effectiveWorktree(sessionId));
    }
    expect((await scopeApi.worktreeOrigin("s2")).kind).toBe("inherited");

    // none：没有自己的登记，也没有父链。
    expect(scopeApi.rootOf(await scopeApi.worktreeOrigin("s9"))).toBeNull();
    expect(await scopeApi.effectiveWorktree("s9")).toBeNull();
  });

  it("双跳链取的是持有登记的那个祖先，不是直接父", async () => {
    const h = harness({ parents: { s2: "s1", s3: "s2" } });
    const target = join(h.root, "wt-two-hops");
    await run(buildCreateTool(h.deps), { path: target, branch: "hops" }, h.exec);

    const origin = await scopeApi.worktreeOrigin("s3");
    expect(origin.kind).toBe("inherited");
    expect(origin.kind === "inherited" ? origin.ownerSessionId : "").toBe("s1");
    expect(scopeApi.rootOf(origin)).toBe(target);
  });
});

describe("ws_worktree_create 的起点在真 git 上生效", () => {
  it("base 传 SHA 时新 worktree 的 HEAD 就是那个起点", async () => {
    const h = harness();
    // 造第二个提交：base 才有一个与 HEAD 不同的可用起点。
    writeFileSync(join(h.repo, "second.txt"), "second\n", "utf8");
    git(h.repo, ["add", "."]);
    git(h.repo, ["commit", "-m", "second"]);
    const first = git(h.repo, ["rev-parse", "HEAD~1"]).trim();

    const target = join(h.root, "wt-from-base");
    const value = await run(
      buildCreateTool(h.deps),
      { path: target, branch: "from-base", base: first },
      h.exec,
    );

    expect(value.ok).toBe(true);
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(first);
  });

  it("不传 base 时起点是仓库当前 HEAD", async () => {
    const h = harness();
    writeFileSync(join(h.repo, "second.txt"), "second\n", "utf8");
    git(h.repo, ["add", "."]);
    git(h.repo, ["commit", "-m", "second"]);
    const head = git(h.repo, ["rev-parse", "HEAD"]).trim();

    const target = join(h.root, "wt-from-head");
    const value = await run(buildCreateTool(h.deps), { path: target }, h.exec);

    expect(value.ok).toBe(true);
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(head);
  });
});

describe("继承态的解绑在真磁盘上什么都不动", () => {
  it("remove 与 removeDirectory 都被拒绝：登记、目录与 git 登记原样", async () => {
    const h = harness({ sessionId: "s2", parents: { s2: "s1" } });
    const target = join(h.root, "wt-parent");
    // 父会话先落一条自己的登记：fork 这边从此继承它。
    const parentRun = await run(
      buildCreateTool(h.deps),
      { path: target, branch: "parent" },
      h.execFor("s1"),
    );
    expect(parentRun.ok).toBe(true);

    const before = readFileSync(h.file, "utf8");
    const beforeList = git(h.repo, ["worktree", "list", "--porcelain"]);

    const plain = await run(buildRemoveTool(h.deps), {}, h.exec);
    expect(plain.ok).toBe(false);
    expect(plain.bound).toBe(true);
    expect(plain.worktree).toBe(target);
    expect(plain.detail).toContain("session s1");

    const withDirectory = await run(buildRemoveTool(h.deps), { removeDirectory: true }, h.exec);
    expect(withDirectory.ok).toBe(false);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(h.file, "utf8")).toBe(before);
    expect(git(h.repo, ["worktree", "list", "--porcelain"])).toBe(beforeList);
  });
});
