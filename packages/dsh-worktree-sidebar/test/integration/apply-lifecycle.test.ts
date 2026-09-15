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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES } from "../../src/shared/interface.ts";
import { apply } from "../../src/index.ts";
import * as apiApi from "../../src/server/api/interface.ts";
import * as bindingApi from "../../src/server/binding/interface.ts";
import * as gitApi from "../../src/server/git/interface.ts";
import * as scopeApi from "../../src/server/scope/interface.ts";
import * as toolsApi from "../../src/server/tools/interface.ts";
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
    stat(id: string): Promise<{ readonly header: { readonly parentSession?: string } } | undefined>;
  }): void;
  /** 走 cordis 的卸载路径：把每个 effect 的 disposer 逐个 await 掉。 */
  disposeAll(): Promise<void>;
}

interface FakeHostOptions {
  /** 官方 workspaceFileScope provider：没有它 scope 域停在 waiting，解析请求根本不碰会话链。 */
  readonly descriptor?: {
    resolve(id: string): Promise<{ sessionId: string; workspaceRoot: string } | undefined>;
  };
  /** 官方 **live** 会话表：id 在表里即「在册」，值是它的父（undefined = 顶层）。 */
  readonly live?: Record<string, string | undefined>;
}

function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const routes: WebRoute[] = [];
  const serviceGets: string[] = [];
  const disposers: Array<() => unknown> = [];
  let persistence: unknown = undefined;
  const ctx = {
    logger: { warn: () => undefined },
    on: () => () => undefined,
    agents: {
      list: () => [],
      // 组合根只允许用 list()：roots() 看不到子 agent，用它就等于子会话拿不到工具。
      // 这里留一个会抛的同名方法，把这条约束变成有意判据（否则只靠「假件恰好没实现 roots」的偶然 TypeError）。
      roots: () => {
        throw new Error("组合根不该用 agents.roots()：子 agent 也要装工具");
      },
    },
    webServer: {
      register: (route: WebRoute) => {
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
        return { header: parent === undefined ? {} : { parentSession: parent } };
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
    });
    host.mountPersistence({ stat: async () => ({ header: { parentSession: "parent" } }) });
    expect(await scopeApi.effectiveWorktree("child")).toBe(dir);
    // 按调用时刻取：两次解析就是两次现取，而不是装配期缓存下来的那个 undefined。
    expect(host.serviceGets).toEqual(["sessionPersistence", "sessionPersistence"]);

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
