/**
 * 组合根 —— 真 `apply(ctx)` 走一遍「装配五域 → ctx.effect 的 disposer → 再装配」。
 *
 * 为什么值得单列：五域各自「第二次 install 抛错」的守卫只有在**释放链完整**时才允许第二次装配；
 * 漏掉组合根里任一 `disposers.push(releaseXxx)`，第二次 `apply` 就会撞上那一个域的守卫。
 * 域自己的用例看不到这件事（它们不经过组合根），所以这条判据必须在这里。
 *
 * 假 ctx 只提供组合根真正读到的面：日志、`on`、`agents.list()`、`webServer.register`、
 * `typert.lookups` 与 `effect`。窄是有意的——补全其余字段只会让夹具和真 ctx 一样重。
 * `DSH_HOME` 指向隔离目录：binding 域在装配期会读 bindings.json（产物零污染是红线 #218）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES } from "../../src/shared/interface.ts";
import { apply } from "../../src/index.ts";
import * as apiApi from "../../src/server/api/interface.ts";
import * as bindingApi from "../../src/server/binding/interface.ts";
import * as gitApi from "../../src/server/git/interface.ts";
import * as scopeApi from "../../src/server/scope/interface.ts";
import * as toolsApi from "../../src/server/tools/interface.ts";
import type { ToolResultValue } from "../../src/server/tools/impl/protocol/index.ts";
import { cleanup, tempDir } from "../helpers.ts";

/** 组合根用到的窄宿主面 + 它的卸载路径。 */
interface FakeHost {
  readonly ctx: Context;
  /** 已注册的路由（api 域在这里留痕）。 */
  readonly routes: WebRoute[];
  /** 组合根软取过哪些可选服务（装配期不该有——按调用时刻取）。 */
  readonly serviceGets: string[];
  /** 装配**之后**才把持久会话后端挂上：晚挂的后端必须当场生效，而不是永久缺席。 */
  mountPersistence(face: {
    stat(
      id: string,
    ): Promise<
      | { readonly header: { readonly parentSession?: string; readonly createdAt: number } }
      | undefined
    >;
  }): void;
  /** 走 cordis 的卸载路径：把每个 effect 的 disposer 逐个 await 掉。 */
  disposeAll(): Promise<void>;
  /** 按 0.1.7-rc.1 serial 语义派发 agent/created：逐个等待 listener 返回。 */
  emitAgentCreated(agent: FakeAgent): Promise<void>;
  /** 装配中途的失败：恢复路由注册口（用来验证「失败后同一进程还能重新装」）。 */
  allowRegister(): void;
}

interface FakeHostOptions {
  /** 官方 workspaceFileScope provider：没有它 scope 域停在 waiting，解析请求根本不碰会话链。 */
  readonly descriptor?: {
    resolve(id: string): Promise<{ sessionId: string; workspaceRoot: string } | undefined>;
  };
  /** 官方 **live** 会话表：id 在表里即「在册」，值是它的父（undefined = 顶层）。 */
  readonly live?: Record<string, string | undefined>;
  /** 让 `webServer.register` 抛错：组合根的第 5 步（api 域）失败，前 4 个域已装上。 */
  readonly registerThrows?: boolean;
  /** 这个「进程」里会话 header 的创建时间。重启后新会话会拿到新值（而 id 会被复用）。 */
  readonly birth?: number;
  /** 在跑的 agent（tools 域会给其中 cwd 在 git 仓库里的那些装工具）。 */
  readonly agents?: readonly FakeAgent[];
}

/** 会话 header 的创建时间：登记里存的凭据必须与它一致，绑定才算属于当前这个会话。 */
const BIRTH = 1_700_000_000_000;

/**
 * 假 agent：tools 域只读它的 id / cwd / 注册口 / effect 面（形状见 `host/agents.ts` 的 `HostAgentLike`）。
 * `definitions` 是断言面——组合根注入的时钟就靠「真的执行一次工具」才走得到。
 */
interface FakeAgent {
  readonly id: string;
  readonly session: { readonly header: { readonly cwd: string; readonly createdAt: number } };
  readonly ctx: {
    readonly tools: { register(definition: ToolDefinition): () => void };
    effect(execute: () => () => void): () => unknown;
  };
  readonly definitions: ToolDefinition[];
  /** 等到实际发生指定次数的注册；初始 list 仍 fire-and-forget，但测试不靠时间猜完成。 */
  waitForDefinitions(count: number): Promise<void>;
}

function fakeAgent(id: string, cwd: string): FakeAgent {
  const definitions: ToolDefinition[] = [];
  const definitionWaiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    id,
    session: { header: { cwd, createdAt: BIRTH } },
    ctx: {
      tools: {
        register: (definition) => {
          definitions.push(definition);
          for (const waiter of [...definitionWaiters]) {
            if (definitions.length >= waiter.count) {
              definitionWaiters.splice(definitionWaiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          }
          return () => {
            const index = definitions.indexOf(definition);
            if (index >= 0) definitions.splice(index, 1);
          };
        },
      },
      effect: (execute) => {
        execute();
        return () => undefined;
      },
    },
    definitions,
    waitForDefinitions(count: number): Promise<void> {
      if (definitions.length >= count) return Promise.resolve();
      return new Promise((resolve) => definitionWaiters.push({ count, resolve }));
    },
  };
}

function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const routes: WebRoute[] = [];
  const serviceGets: string[] = [];
  const disposers: Array<() => unknown> = [];
  const liveAgents = [...(options.agents ?? [])];
  const agentCreatedHandlers: Array<
    (payload: { agent: FakeAgent }) => undefined | PromiseLike<undefined>
  > = [];
  let persistence: unknown = undefined;
  let registerThrows = options.registerThrows === true;
  const ctx = {
    logger: { warn: () => undefined },
    on: (
      event: string,
      handler: (payload: { agent: FakeAgent }) => undefined | PromiseLike<undefined>,
    ) => {
      if (event === "agent/created") agentCreatedHandlers.push(handler);
      return () => true;
    },
    agents: {
      list: () => liveAgents,
      // 组合根只允许用 list()：roots() 看不到子 agent，用它就等于子会话拿不到工具。
      // 这里留一个会抛的同名方法，把这条约束变成有意判据（否则只靠「假件恰好没实现 roots」的偶然 TypeError）。
      roots: () => {
        throw new Error("组合根不该用 agents.roots()：子 agent 也要装工具");
      },
    },
    webServer: {
      register: (route: WebRoute) => {
        if (registerThrows) throw new Error("webServer.register exploded");
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    sessions: {
      // 官方 live 面：在册才有记录，有父才写 parentSession（两种「没有」不是一回事）。
      get: (id: string) => {
        const present = options.live !== undefined && id in options.live;
        if (!present) return undefined;
        const parent = options.live?.[id];
        return {
          header: {
            createdAt: options.birth ?? BIRTH,
            ...(parent === undefined ? {} : { parentSession: parent }),
          },
        };
      },
    },
    // 可选服务的软取必须发生在**调用时刻**：装配期取一次会让晚挂的后端永久缺席
    // （`cordis/lib/index.js:754-771` 的 `get` 就是「取当刻值」）。这里挂一个可变的表。
    get: (name: string) => {
      serviceGets.push(name);
      return persistence;
    },
    typert: {
      lookups: {
        get: () => options.descriptor,
        configure: () => () => undefined,
        subscribe: () => () => undefined,
      },
    },
    effect: (body: () => () => unknown) => {
      const disposer = body();
      disposers.push(disposer);
      return () => disposer();
    },
  };
  return {
    // 唯一一处断言：把窄假件递给要求完整 Context 的入口，收窄面见上面的字面量。
    ctx: ctx as unknown as Context,
    routes,
    serviceGets,
    mountPersistence(face) {
      persistence = face;
    },
    async disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
    async emitAgentCreated(agent: FakeAgent) {
      if (!liveAgents.includes(agent)) liveAgents.push(agent);
      for (const handler of agentCreatedHandlers) await handler({ agent });
    },
    allowRegister() {
      registerThrows = false;
    },
  };
}

let home = "";
const originalHome = process.env.DSH_HOME;

beforeEach(() => {
  home = tempDir("apply");
  process.env.DSH_HOME = home;
});

afterEach(async () => {
  // 兜底释放：某个用例在装配中途判红时，残留的域会让下一个用例撞「只能装配一次」。
  await bindingApi.releaseBinding();
  gitApi.releaseGit();
  scopeApi.releaseScope();
  toolsApi.releaseTools();
  apiApi.releaseApi();
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  cleanup(home);
});

describe("组合根的生命周期", () => {
  it("卸载后再 apply 不抛「只能装配一次」——五个域都进了释放链", async () => {
    const host = fakeHost();
    await apply(host.ctx);
    expect(host.routes.map((route) => route.path).sort()).toEqual(
      [ROUTES.bindings, ROUTES.health].sort(),
    );

    await host.disposeAll();
    expect(host.routes.length).toBe(0);

    // 漏掉任一 `disposers.push(releaseXxx)`：这里会撞上那个域自己的「只能装配一次」。
    await apply(host.ctx);
    expect(host.routes.map((route) => route.path).sort()).toEqual(
      [ROUTES.bindings, ROUTES.health].sort(),
    );
    await host.disposeAll();
  });

  it("装配期不软取可选服务：持久会话面按调用时刻取，晚挂的后端不算缺席", async () => {
    const host = fakeHost();
    await apply(host.ctx);

    expect(host.serviceGets).toEqual([]);
    await host.disposeAll();
  });

  it("会话链接缝：装配期不取持久面、解析请求当场取，晚挂的后端当场生效", async () => {
    const host = fakeHost({
      descriptor: { resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }) },
      live: { s1: undefined },
    });
    await apply(host.ctx);
    expect(host.serviceGets).toEqual([]);

    // 活着的顶层会话是**确定的到顶**：为它去问持久面等于给每个普通会话白加一次 IO。
    expect(await scopeApi.effectiveWorktree("s1")).toBeNull();
    expect(host.serviceGets).toEqual([]);

    // 不在册 → 回落持久面；后端此刻还没挂，这一次读取必须**当场发生**（不是装配期那一次）。
    expect(await scopeApi.effectiveWorktree("child")).toBeNull();
    expect(host.serviceGets).toEqual(["sessionPersistence"]);

    // 晚挂后端 + 父会话有登记：同一条路径再走一次就要给出父的 worktree。
    // repoRoot 取同一个真实目录：belongsTo(同一目录) 恒真，这条判据关心的是
    // 「持久面 → 父链 → 登记」这条链本身，git 语义由 integration/git-real 覆盖。
    const dir = process.cwd();
    await bindingApi.put("parent", {
      repoRoot: dir,
      worktreeRoot: dir,
      branch: "feature",
      createdAt: "2026-09-15T00:00:00.000Z",
      sessionCreatedAt: BIRTH,
    });
    host.mountPersistence({
      stat: async () => ({ header: { parentSession: "parent", createdAt: BIRTH } }),
    });
    expect(await scopeApi.effectiveWorktree("child")).toBe(dir);
    // 按调用时刻取：三次现取，而不是装配期缓存下来的那个 undefined。
    // 两条来源各一次：给「child」读父链一次，给「parent」核对会话身份一次——身份也必须当场取，
    // 否则晚挂的后端会让每一次核对都答「不知道」，而「不知道」的处置是保住登记（＝不摘失效绑定）。
    expect(host.serviceGets).toEqual([
      "sessionPersistence",
      "sessionPersistence",
      "sessionPersistence",
    ]);

    await host.disposeAll();
  });

  it("装配中途失败：已装域被逐个回滚、异常照原样抛给宿主，同一进程还能重新装", async () => {
    const host = fakeHost({ registerThrows: true });
    await expect(apply(host.ctx)).rejects.toThrow("webServer.register exploded");
    expect(host.routes.length).toBe(0);

    // 回滚真的执行过：域是进程内单例，漏掉任一 releaseXxx 都会让下面这次装配撞上「只能装配一次」。
    // 同时按「未装配」失败——半装残留会让它在旧 deps 上继续服务。
    expect(() => bindingApi.revision()).toThrow("binding 域尚未装配");

    host.allowRegister();
    await apply(host.ctx);
    expect(host.routes.length).toBe(2);
    await host.disposeAll();
  });

  it("重启后新会话复用同一个 id：凭据不同 ⇒ 摘掉登记、不继承（S1）", async () => {
    const descriptor = {
      resolve: async (id: string) => ({ sessionId: id, workspaceRoot: "/official" }),
    };
    const dir = process.cwd();

    // 第一个「进程」：装配 → 登记 → 释放。磁盘上留下 bindings.json（持久化本来就在工作）。
    const first = fakeHost({ descriptor, live: { s1: undefined } });
    await apply(first.ctx);
    await bindingApi.put("s1", {
      repoRoot: dir,
      worktreeRoot: dir,
      branch: "feature",
      createdAt: "2026-09-15T00:00:00.000Z",
      sessionCreatedAt: BIRTH,
    });
    expect(await scopeApi.effectiveWorktree("s1")).toBe(dir);
    await first.disposeAll();

    // 第二个「进程」：全新的域实例读同一份 bindings.json。id 一样，但这是**另一个**会话。
    const restarted = fakeHost({ descriptor, live: { s1: undefined }, birth: BIRTH + 1 });
    await apply(restarted.ctx);
    expect(await scopeApi.effectiveWorktree("s1")).toBeNull();
    expect(bindingApi.get("s1")).toBeUndefined();
    await restarted.disposeAll();
  });

  it("真恢复的会话（凭据一致）在重启后仍然拿回自己的登记（对照臂）", async () => {
    const descriptor = {
      resolve: async (id: string) => ({ sessionId: id, workspaceRoot: "/official" }),
    };
    const dir = process.cwd();

    const first = fakeHost({ descriptor, live: { s1: undefined } });
    await apply(first.ctx);
    await bindingApi.put("s1", {
      repoRoot: dir,
      worktreeRoot: dir,
      branch: "feature",
      createdAt: "2026-09-15T00:00:00.000Z",
      sessionCreatedAt: BIRTH,
    });
    await first.disposeAll();

    // 同一个凭据 = 恢复回来的那个会话：登记必须还在（否则「重启即丢绑定」是另一种静默错）。
    const restarted = fakeHost({ descriptor, live: { s1: undefined } });
    await apply(restarted.ctx);
    expect(await scopeApi.effectiveWorktree("s1")).toBe(dir);
    await restarted.disposeAll();
  });

  it("ctx.on 的 agent/created listener 返回前已注册 create/register/remove", async () => {
    const agent = fakeAgent("created", process.cwd());
    const host = fakeHost();
    await apply(host.ctx);
    expect(agent.definitions).toHaveLength(0);

    const serial = host.emitAgentCreated(agent);
    expect(agent.definitions).toHaveLength(0);

    await serial;

    expect(agent.definitions.map((definition) => definition.name).sort()).toEqual([
      "ws_worktree_create",
      "ws_worktree_register",
      "ws_worktree_remove",
    ]);
    await host.disposeAll();
  });

  it("组合根的 now 闭包被真执行一遍：登记时间戳由它产出（顺带覆盖 tools 注册链）", async () => {
    const dir = process.cwd();
    const agent = fakeAgent("s1", dir);
    const host = fakeHost({
      descriptor: { resolve: async (id) => ({ sessionId: id, workspaceRoot: "/official" }) },
      agents: [agent],
    });
    await apply(host.ctx);
    // 初始 list 路径刻意保持 fire-and-forget；这里等实际注册事实，不轮询时间。
    await agent.waitForDefinitions(1);

    const definition = agent.definitions.find((entry) => entry.name === "ws_worktree_register");
    if (definition === undefined) throw new Error("工具没有装进 agent");
    const exec = {
      agent: { session: { id: "s1", header: { cwd: dir, createdAt: BIRTH } } },
    };
    const value = (await definition.execute(
      { worktree: dir },
      exec as ToolRunContext,
    )) as ToolResultValue;

    expect(value.ok).toBe(true);
    // 断言的是**形状**：值由组合根那个 `now` 产出（精确等值断言在 tools.test.ts 的时针用例里，
    // 那里递的是可控时钟）。本用例的贡献是把 `src/index.ts` 里那个闭包真执行一次。
    expect(bindingApi.get("s1")?.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    await host.disposeAll();
  });

  it("enabled=false 一个域都不装：没路由，也没占住任何域", async () => {
    const host = fakeHost();
    await apply(host.ctx, { enabled: false });
    expect(host.routes.length).toBe(0);

    await host.disposeAll();
    // 没占位：随后用同一个 ctx 正常装一次必须成功。
    await apply(host.ctx);
    expect(host.routes.length).toBe(2);
    await host.disposeAll();
  });
});
