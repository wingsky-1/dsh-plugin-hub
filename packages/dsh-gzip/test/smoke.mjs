/**
 * dsh-gzip —— 宿主端冒烟测试（fake ctx + fake webServer，无网络）。
 *
 * 覆盖：
 * - 纯函数：acceptsGzip（q 值/多编码/非字符串）、isCompressible（SSE/zip/已编码）、joinVary
 * - wrapResponse：真实 zlib 压缩→解压一致；headers（content-encoding/vary/content-length 删除）；
 *   无 Accept-Encoding / q=0 / SSE / 已带 content-encoding / 单参 writeHead 均不压缩
 * - installWrappers 双挂点：/api 已注册（replace）与未注册（register-patch）均生效；
 *   非 /api 路由不受影响；卸载完整恢复
 * - apply：enabled=false 不注册；health 路由 GET 200 / POST 405 / 非回环 403
 * - ROUTES 常量一致性
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { apply, ROUTES, acceptsGzip, isCompressible, joinVary, wrapResponse, installWrappers } from "../lib/index.js";

// ---------------------------------------------------------------- 纯函数

assert.equal(acceptsGzip("gzip"), true);
assert.equal(acceptsGzip("br, gzip"), true);
assert.equal(acceptsGzip("gzip;q=1"), true);
assert.equal(acceptsGzip("gzip;q=0"), false, "q=0 拒绝");
assert.equal(acceptsGzip("gzip;q=0.0"), false, "q=0.0 拒绝");
assert.equal(acceptsGzip("br"), false);
assert.equal(acceptsGzip(undefined), false, "非字符串拒绝");
assert.equal(acceptsGzip(""), false, "空串拒绝");

assert.equal(isCompressible("application/json"), true);
assert.equal(isCompressible("application/json; charset=utf-8"), true);
assert.equal(isCompressible("application/vnd.test+json"), true);
assert.equal(isCompressible("text/html"), true);
assert.equal(isCompressible("text/event-stream"), false, "SSE 豁免");
assert.equal(isCompressible("application/zip"), false, "zip 豁免");
assert.equal(isCompressible(undefined), false);

assert.equal(joinVary(undefined), "accept-encoding");
assert.equal(joinVary("origin"), "origin, accept-encoding");

// ---------------------------------------------------------------- fake 桩

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this._headers = new Map();
    this._chunks = [];
    this.ended = false;
    this.destroyed = false;
  }
  getHeader(name) {
    return this._headers.get(String(name).toLowerCase());
  }
  setHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), value);
  }
  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
  }
  writeHead(code, msg, headers) {
    if (typeof msg === "object" && msg !== null) {
      headers = msg;
      msg = undefined;
    }
    this.statusCode = code;
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) this._headers.set(key.toLowerCase(), value);
    }
    this.headersSent = true;
  }
  write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), encoding);
    this._chunks.push(buf);
    if (typeof callback === "function") callback();
    return true;
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.ended = true;
    if (typeof callback === "function") callback();
  }
  destroy() {
    this.destroyed = true;
  }
}

/** 跑一次完整压缩流程，等待 gzip 排空（originalEnd 触发）后返回结果。 */
async function runCompressed(contentType, bodyText, reqHeaders) {
  const res = new FakeRes();
  const req = { headers: reqHeaders ?? {} };
  const stats = { compressed: 0, passthrough: 0 };
  const wrapped = wrapResponse(res, req, stats);
  wrapped.writeHead(200, { "content-type": contentType });
  wrapped.write(bodyText);
  wrapped.end();
  await waitEnded(res);
  return { res, stats };
}

/** 轮询等待 gzip 排空（originalEnd → FakeRes.ended）。 */
function waitEnded(res, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (res.ended) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("response did not end within timeout"));
      }
    }, 5);
  });
}

// ---------------------------------------------------------------- wrapResponse

// 压缩正确性：内容解压一致 + 响应头正确
{
  const body = JSON.stringify({ hello: "world", n: 42, list: [1, 2, 3] });
  const { res, stats } = await runCompressed("application/json; charset=utf-8", body, { "accept-encoding": "gzip" });
  assert.equal(stats.compressed, 1, "压缩计数 +1");
  assert.equal(stats.passthrough, 0);
  assert.equal(res.getHeader("content-encoding"), "gzip");
  assert.equal(res.getHeader("vary"), "accept-encoding");
  assert.equal(res.getHeader("content-length"), undefined, "content-length 必须删除");
  const inflated = gunzipSync(Buffer.concat(res._chunks)).toString("utf8");
  assert.equal(inflated, body, "解压后内容一致");
}

// 无 Accept-Encoding：不压缩
{
  const body = "plain";
  const { res, stats } = await runCompressed("application/json", body, {});
  assert.equal(stats.passthrough, 1, "透传计数 +1");
  assert.equal(res.getHeader("content-encoding"), undefined);
  assert.equal(Buffer.concat(res._chunks).toString("utf8"), body, "原文透传");
}

// q=0：不压缩
{
  const { res } = await runCompressed("application/json", "x", { "accept-encoding": "gzip;q=0" });
  assert.equal(res.getHeader("content-encoding"), undefined);
}

// SSE：豁免
{
  const { res } = await runCompressed("text/event-stream", "data: hi\n\n", { "accept-encoding": "gzip" });
  assert.equal(res.getHeader("content-encoding"), undefined);
}

// 已带 content-encoding：不再包装
{
  const res = new FakeRes();
  res.setHeader("content-encoding", "br");
  const req = { headers: { "accept-encoding": "gzip" } };
  wrapResponse(res, req, null).writeHead(200, { "content-type": "application/json" });
  assert.equal(res.getHeader("content-encoding"), "br", "上游编码保留");
}

// 单参 writeHead（headers 走 setHeader 提前设置）路径
{
  const res = new FakeRes();
  const req = { headers: { "accept-encoding": "gzip" } };
  const wrapped = wrapResponse(res, req, null);
  wrapped.setHeader("content-type", "application/json");
  wrapped.setHeader("vary", "origin");
  wrapped.writeHead(200);
  wrapped.write("z");
  wrapped.end();
  assert.equal(res.getHeader("content-encoding"), "gzip");
  assert.equal(res.getHeader("vary"), "origin, accept-encoding", "vary 追加不覆盖");
}

// ---------------------------------------------------------------- fake webServer

function makeWebServer() {
  const prefixes = new Map();
  const exact = new Map();
  const ws = {
    prefixes,
    exact,
    register(route) {
      const table = route.kind === "exact" ? exact : prefixes;
      if (table.has(route.path)) throw new Error("duplicate");
      table.set(route.path, route);
      return () => {
        table.delete(route.path);
      };
    },
  };
  return ws;
}

function makeCtx(webServer) {
  const disposers = [];
  const ctx = {
    webServer,
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
    _disposers: disposers,
  };
  return ctx;
}

function makeReq(over = {}) {
  return {
    method: "GET",
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    ...over,
  };
}

/** 收集一个 route handler 写出的原始 body（不经过 gzip 的对比基准）。 */
async function runHandler(handler, req) {
  const res = new FakeRes();
  await handler(req, res);
  return res;
}

// ---------------------------------------------------------------- 挂点 1：/api 已注册（replace）

{
  const ws = makeWebServer();
  const marker = { original: true };
  const apiHandler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(JSON.stringify(marker));
    res.end();
  };
  ws.prefixes.set("/api", { kind: "prefix", path: "/api", handler: apiHandler });

  const ctx = makeCtx(ws);
  const stats = { compressed: 0, passthrough: 0 };
  const { mounted } = installWrappers(ws, stats);
  assert.equal(mounted, "replace", "已注册场景走 replace 挂点");

  const route = ws.prefixes.get("/api");
  assert.notEqual(route.handler, apiHandler, "handler 已被替换");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  // 等 gzip 排空（end 经 gzip 异步触发）
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(res._chunks)).toString("utf8")), marker);
}

// ---------------------------------------------------------------- 挂点 2：/api 未注册（register-patch）

{
  const ws = makeWebServer();
  const stats = { compressed: 0, passthrough: 0 };
  const { mounted } = installWrappers(ws, stats);
  assert.equal(mounted, "register-patch", "未注册场景走 patch 兜底");

  let called = 0;
  ws.register({
    kind: "prefix",
    path: "/api",
    handler: (req, res) => {
      called += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
  });
  const route = ws.prefixes.get("/api");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(called, 1, "原 handler 仍被调用");
  assert.equal(res.getHeader("content-encoding"), "gzip");

  // 非 /api 路由不受影响
  let other = 0;
  ws.register({ kind: "exact", path: "/other", handler: () => { other += 1; } });
  const otherRoute = ws.exact.get("/other");
  const otherRes = await runHandler(otherRoute.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  assert.equal(other, 1);
  assert.equal(otherRes.getHeader("content-encoding"), undefined, "非 /api 不压缩");
}

// ---------------------------------------------------------------- 卸载恢复

{
  const ws = makeWebServer();
  const original = () => {};
  ws.prefixes.set("/api", { kind: "prefix", path: "/api", handler: original });
  const originalRegister = ws.register;
  const { disposers } = installWrappers(ws, { compressed: 0, passthrough: 0 });
  assert.notEqual(ws.register, originalRegister, "register 已 patch");
  assert.notEqual(ws.prefixes.get("/api").handler, original, "handler 已替换");
  for (const dispose of [...disposers].reverse()) dispose();
  assert.equal(ws.prefixes.get("/api").handler, original, "handler 恢复");
  assert.equal(ws.register, originalRegister, "register 恢复");
}

// ---------------------------------------------------------------- apply + health

{
  const ws = makeWebServer();
  const ctx = makeCtx(ws);
  apply(ctx);

  const route = ws.exact.get(ROUTES.health);
  assert.ok(route, "health 路由已注册");

  // GET 回环 → 200 ok
  const okRes = await runHandler(route.handler, makeReq());
  assert.equal(okRes.statusCode, 200);
  const okBody = JSON.parse(Buffer.concat(okRes._chunks).toString("utf8"));
  assert.equal(okBody.ok, true);
  assert.equal(okBody.plugin, "dsh-gzip");
  assert.ok(["replace", "register-patch", "replace+patch"].includes(okBody.mounted));

  // POST → 405
  const postRes = await runHandler(route.handler, makeReq({ method: "POST" }));
  assert.equal(postRes.statusCode, 405);

  // 非回环 → 403
  const badRes = await runHandler(route.handler, makeReq({ socket: { remoteAddress: "10.0.0.5" } }));
  assert.equal(badRes.statusCode, 403);

  // 卸载：health 路由移除、register 恢复
  for (const dispose of [...ctx._disposers].reverse()) dispose();
  assert.equal(ws.exact.has(ROUTES.health), false, "卸载后 health 路由移除");
}

// enabled=false：完全不注册
{
  const ws = makeWebServer();
  const ctx = makeCtx(ws);
  apply(ctx, { enabled: false });
  assert.equal(ws.exact.size, 0);
  assert.equal(ctx._disposers.length, 0);
}

// 路由常量
assert.equal(ROUTES.health, "/api/dsh-gzip/health");

console.log("dsh-gzip smoke: all passed");
