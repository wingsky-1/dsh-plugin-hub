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
import { ROUTES } from "../../src/contract.ts";
import { createApi } from "../../src/server/api/interface.ts";
import type { ApiInstance } from "../../src/server/api/interface.ts";

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
  bindingOverrides: Partial<{
    revision: () => number;
    effectiveWorktree: (id: string) => Promise<string | null>;
  }> = {},
) {
  const reg = capturingRegister();
  const binding = {
    revision: () => 7,
    effectiveWorktree: async (id: string) => (id === "s1" ? "/wt" : null),
    ...bindingOverrides,
  };
  trackApi(createApi({ register: reg.register, logger, binding }));
  const route = (path: string): WebRoute => {
    const found = reg.routes.find((candidate) => candidate.path === path);
    if (found === undefined) throw new Error("未注册该路径：" + path);
    return found;
  };
  return { reg, route, api: created[created.length - 1] as ApiInstance };
}

/** 调一次端点。注册的是**包装器**（含围栏与异常收口），所以这里也走包装器。 */
function jsonOf(captured: { body: string }): Record<string, unknown> {
  return JSON.parse(captured.body) as Record<string, unknown>;
}

/** 本文件建过的实例，逐个在 afterEach 释放（没有全局单例可依赖）。 */
const created: ApiInstance[] = [];
function trackApi(api: ApiInstance): ApiInstance {
  created.push(api);
  return api;
}

afterEach(() => {
  for (const api of created.splice(0)) api.dispose();
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
  it("回 ok 与当前 revision", async () => {
    const { route } = install();
    const { captured, res } = fakeRes();
    route(ROUTES.health).handler(fakeReq(), res);
    expect(captured.status).toBe(200);
    expect(jsonOf(captured)).toEqual({ ok: true, revision: 7 });
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

  it("dispose 摘掉全部路由且幂等", () => {
    const { reg, api } = install();
    expect(reg.routes.length).toBe(2);
    api.dispose();
    expect(reg.routes.length).toBe(0);
    api.dispose();
    expect(reg.routes.length).toBe(0);
  });

  it("两份实例互相独立（没有模块级状态）", () => {
    const first = install();
    const second = install();
    expect(first.reg.routes.length).toBe(2);
    expect(second.reg.routes.length).toBe(2);
    first.api.dispose();
    // 摘掉第一份不影响第二份。
    expect(first.reg.routes.length).toBe(0);
    expect(second.reg.routes.length).toBe(2);
  });
});
