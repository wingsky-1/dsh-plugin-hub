/**
 * 组合根 —— 真 `apply(ctx)` 走一遍「装配五域 → ctx.effect 的 disposer → 再装配」。
 *
 * 为什么值得单列：五域各自「第二次 install 抛错」的守卫只有在**释放链完整**时才允许第二次装配；
 * 漏掉组合根里任一 `disposers.push(releaseXxx)`，第二次 `apply` 就会撞上那一个域的守卫。
 * 域自己的用例看不到这件事（它们不经过组合根），所以这条判据必须在这里。
 *
 * 假 ctx 只提供组合根真正读到的面：日志、`on`、`agents.roots()`、`webServer.register`、
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
  /** 走 cordis 的卸载路径：把每个 effect 的 disposer 逐个 await 掉。 */
  disposeAll(): Promise<void>;
}

function fakeHost(): FakeHost {
  const routes: WebRoute[] = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    logger: { warn: () => undefined },
    on: () => () => undefined,
    agents: { roots: () => [] },
    webServer: {
      register: (route: WebRoute) => {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    typert: {
      lookups: {
        get: () => undefined,
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
