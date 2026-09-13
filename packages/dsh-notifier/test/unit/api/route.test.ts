/**
 * dsh-notifier api 域 route 块 —— 每条浏览器请求都要穿过的三道围栏。
 *
 * 为什么单独一测：围栏是**唯一**的实现（本域是浏览器唯一入口），少一道就是一个洞，而洞的症状不会
 * 出现在功能用例里——非回环请求照样能读到设置、写设置、清历史。故这里逐道断言：回环 → 方法 →
 * 异常收口，且顺序不能颠倒（403 必须早于 405：安全判定不能被方法判定绕过）。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { registerEndpoints, sendJson } from "../../../src/server/api/impl/route/index.ts";
import type { Endpoint, RouteHandler } from "../../../src/server/api/impl/route/type.ts";
import { jsonReq, makeLogger, makeRegister, makeRes, pollUntil } from "../../helpers.ts";

/** 假请求：默认是合法回环请求，`body` 由 async 迭代器吐出（`readJsonBody` 走的就是这条路）。 */
function makeReq(
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    remoteAddress?: string;
    host?: string;
  } = {},
): IncomingMessage {
  return jsonReq({
    method: options.method ?? "GET",
    url: "/api/dsh-notifier/config",
    body: options.body,
    rawBody: options.rawBody,
    remoteAddress: options.remoteAddress,
    host: options.host,
  });
}

/** 一个端点组，handler 可替换：围栏用例只关心 handler 有没有被调到。 */
function endpointWith(handler: RouteHandler, methods: Array<"GET" | "POST"> = ["GET"]): Endpoint {
  return {
    path: "/api/dsh-notifier/probe",
    methods: Object.fromEntries(methods.map((method) => [method, handler])),
  };
}

/** 注册一个端点并取回宿主真正会调用的那个 handler。 */
function install(handler: RouteHandler, methods: Array<"GET" | "POST"> = ["GET"]) {
  const hub = makeRegister();
  const logger = makeLogger();
  const disposers = registerEndpoints(hub.register, [endpointWith(handler, methods)], logger);
  return { route: hub.routes[0]!, logger, disposers, hub };
}

describe("回环围栏：非回环一律 403", () => {
  it("局域网来源的请求被拒且 handler 根本不被调用（能读到设置就等于把设置面板暴露给了整个内网）", () => {
    let called = 0;
    const { route } = install(() => {
      called += 1;
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq({ remoteAddress: "192.168.1.5", host: "192.168.1.5:3080" }), res);
    expect(rec.status).toBe(403);
    expect(json()).toEqual({ error: "forbidden: loopback-only" });
    expect(called).toBe(0);
  });

  it("Host 头指向外部域名时同样被拒（DNS 重绑定：来源地址是回环也不够）", () => {
    let called = 0;
    const { route } = install(() => {
      called += 1;
    });
    const { res, rec } = makeRes();
    route.handler(makeReq({ host: "evil.example.com" }), res);
    expect(rec.status).toBe(403);
    expect(called).toBe(0);
  });
});

describe("方法围栏：表里没有的方法给 405 而不是 404", () => {
  it("支持的方法放行到 handler，且 JSON 响应带 no-store（设置视图被浏览器缓存住 = 页面一直显示旧设置）", () => {
    const { route } = install((_req, res) => {
      sendJson(res, 200, { ok: true });
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq(), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true });
    expect(rec.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(rec.headers["cache-control"]).toBe("no-store");
  });

  it.each(["POST", "OPTIONS"])("%s 不在方法表里 → 405，并带 allow 头列出支持的方法", (method) => {
    let called = 0;
    const { route } = install((_req, res) => {
      called += 1;
      sendJson(res, 200, { ok: true });
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq({ method }), res);
    expect(rec.status).toBe(405);
    expect(rec.headers.allow).toBe("GET");
    expect(json()).toEqual({ error: `method not allowed: ${method}` });
    expect(called).toBe(0);
  });

  it("403 先于 405：非回环 + 非法方法给 403（安全判定不能被方法判定绕过去）", () => {
    const { route } = install((_req, res) => sendJson(res, 200, { ok: true }));
    const { res, rec, json } = makeRes();
    route.handler(
      makeReq({ method: "POST", remoteAddress: "10.0.0.9", host: "10.0.0.9:3080" }),
      res,
    );
    expect(rec.status).toBe(403);
    expect(json()).toEqual({ error: "forbidden: loopback-only" });
  });
});

describe("异常收口：端点失败必须变成一次响应，而不是挂住的连接", () => {
  it("同步抛出 → 500 + 失败体，并记一条 warn（漏出去的异常留下的不是错误页，是挂住的连接）", () => {
    const { route, logger } = install(() => {
      throw new Error("读设置炸了");
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq(), res);
    expect(rec.status).toBe(500);
    expect(json()).toEqual({ ok: false, error: { error: "读设置炸了" } });
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("读设置炸了");
  });

  it("异步端点 reject 也被收口（异步端点的异常否则会变成未捕获拒绝）", async () => {
    const { route, logger } = install(async () => {
      throw new Error("写盘炸了");
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq(), res);
    expect(rec.status).toBe(0);
    await pollUntil(() => rec.status === 500, "异步端点失败被收口为 500");
    expect(json()).toEqual({ ok: false, error: { error: "写盘炸了" } });
    expect(logger.warns[0]).toContain("写盘炸了");
  });

  it("响应头已发出后失败只记日志不重写头（重复写会抛 ERR_HTTP_HEADERS_SENT，把端点失败升级成宿主侧未捕获异常）", () => {
    const { route, logger } = install((_req, res) => {
      sendJson(res, 200, { ok: true });
      throw new Error("晚到的失败");
    });
    const { res, rec, json } = makeRes();
    route.handler(makeReq(), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true });
    expect(logger.warns[0]).toContain("晚到的失败");
  });
});

describe("注册与摘除", () => {
  it("摘除器与端点一一对应：宿主收回路由靠它，漏一个就是卸载后路由还在", () => {
    const hub = makeRegister();
    const disposers = registerEndpoints(
      hub.register,
      [
        endpointWith((_req, res) => sendJson(res, 200, {})),
        {
          path: "/api/dsh-notifier/other",
          methods: { GET: (_req, res) => sendJson(res, 200, {}) },
        },
      ],
      makeLogger(),
    );
    expect(disposers).toHaveLength(2);
    for (const dispose of disposers) dispose();
    expect(hub.disposed).toEqual(["/api/dsh-notifier/probe", "/api/dsh-notifier/other"]);
  });
});
