/**
 * api 域 —— 围栏、方法判定、查询语义与异常收口。
 *
 * 为什么逐条断言：这四条每一条失效都不会有报错，只会安静地少一道防线或回错东西——
 * 少了回环围栏，局域网里任何人能读你哪个会话指向哪个目录；少了 403 先于 405，
 * 探测者能靠状态码区分「方法不对」与「路径存在」；把 repoRoot 一起回出去，
 * 等于把主仓库位置送到浏览器。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTES } from "../../src/shared/interface.ts";
import { installApi, releaseApi } from "../../src/server/api/interface.ts";

/** 捕获注册的路由，并按真实语义提供摘除器。 */
function capturingRegister() {
  const routes: WebRoute[] = [];
  return {
    routes,
    register(route: WebRoute): () => void {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/** 伪造请求：围栏只看 socket.remoteAddress 与 headers.host。 */
function fakeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  return {
    method: "GET",
    url: ROUTES.bindings,
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  } as unknown as IncomingMessage;
}

/** 伪造响应：只记录状态码、头与 body。 */
function fakeRes() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    get headersSent() {
      return captured.status !== 0;
    },
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(text?: string) {
      captured.body = text ?? "";
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

const warns: string[] = [];
const logger = { warn: (message: string) => warns.push(message) };

function install(
  overrides: Partial<{
    revision: () => number;
    effectiveWorktree: (id: string) => Promise<string | null>;
    takeoverState: () => "idle" | "waiting" | "live" | "abandoned";
    chainDiagnostics: () => {
      storedReads: number;
      storedFailures: number;
      lastFailure: string | undefined;
    };
  }> = {},
) {
  const reg = capturingRegister();
  // 两个事实来自两个域，故这里是两个互不搭界的窄端口（一个提供方一行）。
  const binding = { revision: overrides.revision ?? (() => 7) };
  const scope = {
    effectiveWorktree:
      overrides.effectiveWorktree ?? (async (id: string) => (id === "s1" ? "/wt" : null)),
    takeoverState: overrides.takeoverState ?? (() => "live" as const),
    chainDiagnostics:
      overrides.chainDiagnostics ??
      (() => ({ storedReads: 0, storedFailures: 0, lastFailure: undefined })),
  };
  installApi({ register: reg.register, logger, binding, scope });
  const route = (path: string): WebRoute => {
    const found = reg.routes.find((candidate) => candidate.path === path);
    if (found === undefined) throw new Error("未注册该路径：" + path);
    return found;
  };
  return { reg, route };
}

/** 调一次端点。注册的是**包装器**（含围栏与异常收口），所以这里也走包装器。 */
function jsonOf(captured: { body: string }): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

/** 域是进程内单例：每个用例装一次、afterEach 统一释放——漏掉会让下一个用例撞「只能装配一次」。 */
afterEach(() => {
  releaseApi();
  warns.splice(0);
});

describe("围栏", () => {
  it("非回环来源一律 403", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ socket: { remoteAddress: "10.0.0.5" } }), res);
    expect(captured.status).toBe(403);
  });

  it("回环来源但 Host 不是回环一律 403", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ headers: { host: "evil.example.com" } }), res);
    expect(captured.status).toBe(403);
  });

  it("缺少 Host 头一律 403（fail-closed）", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ headers: {} }), res);
    expect(captured.status).toBe(403);
  });

  it("方法不在白名单给 405", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ method: "POST" }), res);
    expect(captured.status).toBe(405);
  });

  it("403 先于 405：非回环 + 方法错仍然只回 403（不泄露路径存在性）", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(
      fakeReq({ method: "POST", socket: { remoteAddress: "10.0.0.5" } }),
      res,
    );
    expect(captured.status).toBe(403);
  });

  it("拒绝体不带 referrer（共享层围栏的既定行为）", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ headers: { host: "evil.example.com" } }), res);
    expect(captured.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("绑定查询", () => {
  it("缺 session 参数判 400 而不是回空", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings }), res);
    expect(captured.status).toBe(400);
  });

  it("空 session 参数同样判 400", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=" }), res);
    expect(captured.status).toBe(400);
  });

  it("命中绑定回 revision 与 worktreePath，且不回 repoRoot", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=s1" }), res);
    expect(captured.status).toBe(200);
    const body = jsonOf(captured);
    expect(body["revision"]).toBe(7);
    expect(body["worktreePath"]).toBe("/wt");
    expect(Object.keys(body).sort()).toEqual(["revision", "worktreePath"]);
  });

  it("未命中回 worktreePath: null", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=other" }), res);
    expect(jsonOf(captured)["worktreePath"]).toBeNull();
  });

  it("回的是**生效值**：失效绑定（生效值为 null）时路由也回 null，两端不分叉", async () => {
    const { route } = install({ effectiveWorktree: async () => null });
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=s1" }), res);
    expect(jsonOf(captured)["worktreePath"]).toBeNull();
  });

  it("revision 读的是活的现值而不是装配期快照", async () => {
    let revision = 1;
    const { route } = install({ revision: () => revision });
    revision = 42;
    const { captured, res } = fakeRes();
    await route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=s1" }), res);
    expect(jsonOf(captured)["revision"]).toBe(42);
  });
});

describe("health", () => {
  it("回 ok、当前 revision、接管状态与会话链读数", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.health).handler(fakeReq(), res);
    expect(captured.status).toBe(200);
    expect(jsonOf(captured)).toEqual({
      ok: true,
      revision: 7,
      scopeTakeover: "live",
      scopeChain: { storedReads: 0, storedFailures: 0 },
    });
  });

  it("会话链读数读的是活值：持久面坏过一次与坏过两次必须能分开", async () => {
    // 「继承悄悄退回 live-only」是无声降级，探针上的这个读数就是它唯一的落地痕迹。
    let failures = 0;
    const { route } = install({
      chainDiagnostics: () => ({
        storedReads: failures + 1,
        storedFailures: failures,
        lastFailure: failures === 0 ? undefined : "session store unreadable",
      }),
    });
    const first = fakeRes();
    route(ROUTES.health).handler(fakeReq(), first.res);
    expect(jsonOf(first.captured)["scopeChain"]).toEqual({ storedReads: 1, storedFailures: 0 });

    failures = 1;
    const second = fakeRes();
    route(ROUTES.health).handler(fakeReq(), second.res);
    expect(jsonOf(second.captured)["scopeChain"]).toEqual({
      storedReads: 2,
      storedFailures: 1,
      lastFailure: "session store unreadable",
    });
  });

  it("接管状态读的是活值：provider 还没出现时报 waiting", async () => {
    // 「文件根没换」的三种成因必须能从探针上分开，否则真机上只剩「不工作」一个结论。
    let state: "waiting" | "live" = "waiting";
    const { route } = install({ takeoverState: () => state });
    const { captured, res } = fakeRes();
    route(ROUTES.health).handler(fakeReq(), res);
    expect(jsonOf(captured)["scopeTakeover"]).toBe("waiting");

    state = "live";
    const second = fakeRes();
    route(ROUTES.health).handler(fakeReq(), second.res);
    expect(jsonOf(second.captured)["scopeTakeover"]).toBe("live");
  });
});

describe("两端路由一致性", () => {
  it("注册的路径就是 contract 里那两条（单一事实源）", () => {
    const { reg } = install();
    expect(reg.routes.map((r) => r.path).sort()).toEqual([ROUTES.bindings, ROUTES.health].sort());
  });
});

describe("异常收口与卸载", () => {
  it("异步处理器抛异常回 500 并出声，不把异常抛回宿主", async () => {
    const { route } = install({
      effectiveWorktree: async () => {
        throw new Error("boom");
      },
    });
    const { captured, res } = fakeRes();
    route(ROUTES.bindings).handler(fakeReq({ url: ROUTES.bindings + "?session=s1" }), res);
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.status).toBe(500);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("boom");
  });

  it("同步处理器抛异常也回 500 并出声（异步 promise 之外的第二个入口）", () => {
    const { route } = install({
      revision: () => {
        throw new Error("sync boom");
      },
    });
    const { captured, res } = fakeRes();
    // health 的处理器是**同步**的：它抛在 handle(req, res) 那一行，只有同步 catch 接得住。
    route(ROUTES.health).handler(fakeReq(), res);
    expect(captured.status).toBe(500);
    expect(warns.some((warning) => warning.includes("sync boom"))).toBe(true);
  });

  it("注册中途失败：已挂的那条被摘回去再抛，域也不留在半装态", () => {
    const routes: WebRoute[] = [];
    let calls = 0;
    const register = (route: WebRoute): (() => void) => {
      calls += 1;
      // 第一条照常挂上，第二条才炸：这条判据要的正是「已挂的那条会不会被摘回去」。
      if (calls === 2) throw new Error("second register exploded");
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    };
    expect(() =>
      installApi({
        register,
        logger,
        binding: { revision: () => 1 },
        scope: {
          effectiveWorktree: async () => null,
          takeoverState: () => "live" as const,
          chainDiagnostics: () => ({ storedReads: 0, storedFailures: 0, lastFailure: undefined }),
        },
      }),
    ).toThrow("second register exploded");
    // 半挂的出口比不挂更糟：它在册、会响应，而摘除器从未生成。
    expect(routes).toEqual([]);
    // 域也没被标成已装配——同一进程里再装一次必须成功（否则组合根的回滚路径就白写了）。
    expect(() => install()).not.toThrow();
  });

  it("release 摘掉全部路由且幂等", () => {
    const { reg } = install();
    expect(reg.routes.length).toBe(2);
    releaseApi();
    expect(reg.routes.length).toBe(0);
    releaseApi();
    expect(reg.routes.length).toBe(0);
  });
});

describe("装配守卫与 release 复位", () => {
  it("第二次装配当场抛错，不静默挂第二份路由", () => {
    const first = install();
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => install()).toThrow("dsh-worktree-sidebar: api 域只能装配一次");
    expect(first.reg.routes.length).toBe(2);
  });

  it("release 之后再装配只注册一份路由（不叠加）", () => {
    const first = install();
    expect(first.reg.routes.length).toBe(2);
    releaseApi();
    expect(first.reg.routes.length).toBe(0);
    // 重新装配必须重新注册，而不是「反正已经挂过」——否则 release 之后页面就再也读不到数据。
    const second = install();
    expect(second.reg.routes.length).toBe(2);
  });
});
