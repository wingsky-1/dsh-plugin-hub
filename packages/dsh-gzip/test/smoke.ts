// @ts-nocheck
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
import { apply, ROUTES, acceptsGzip, isCompressible, joinVary, normalizeLevel, wrapResponse, installWrappers } from "../lib/index.js";

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

// normalizeLevel：非数字回退 1、clamp 1..9、截断小数
assert.equal(normalizeLevel(undefined), 1);
assert.equal(normalizeLevel("x"), 1);
assert.equal(normalizeLevel(NaN), 1);
assert.equal(normalizeLevel(0), 1);
assert.equal(normalizeLevel(-3), 1);
assert.equal(normalizeLevel(99), 9);
assert.equal(normalizeLevel(5), 5);
assert.equal(normalizeLevel(5.7), 5);

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
async function runCompressed(contentType, bodyText, reqHeaders, level) {
  const res = new FakeRes();
  const req = { method: "GET", headers: reqHeaders ?? {} };
  const stats = { compressed: 0, passthrough: 0 };
  const wrapped = wrapResponse(res, req, stats, level ?? 1);
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

// HEAD：不压缩透传（node 对 HEAD 无 body，压了产生误导头）
{
  const res = new FakeRes();
  const req = { method: "HEAD", headers: { "accept-encoding": "gzip" } };
  const wrapped = wrapResponse(res, req, null);
  wrapped.writeHead(200, { "content-type": "text/html" });
  wrapped.write("body");
  wrapped.end();
  assert.equal(res.getHeader("content-encoding"), undefined, "HEAD 不压缩");
  assert.equal(Buffer.concat(res._chunks).toString("utf8"), "body", "HEAD 原样");
}

// Range：不压缩透传（保留范围语义）
{
  const res = new FakeRes();
  const req = { method: "GET", headers: { "accept-encoding": "gzip", "range": "bytes=0-100" } };
  const wrapped = wrapResponse(res, req, null);
  wrapped.writeHead(200, { "content-type": "text/javascript" });
  wrapped.write("code");
  wrapped.end();
  assert.equal(res.getHeader("content-encoding"), undefined, "Range 不压缩");
  assert.equal(Buffer.concat(res._chunks).toString("utf8"), "code");
}

// level 9：压缩仍生效且解压一致
{
  const body = JSON.stringify({ big: "x".repeat(5000), n: 7 });
  const { res, stats } = await runCompressed("application/json; charset=utf-8", body,
    { "accept-encoding": "gzip" }, 9);
  assert.equal(stats.compressed, 1, "level 9 压缩计数 +1");
  assert.equal(res.getHeader("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.concat(res._chunks)).toString("utf8"), body, "level 9 解压一致");
}

// ---------------------------------------------------------------- fake webServer

function makeWebServer() {
  const prefixes = new Map();
  const exact = new Map();
  const ws = {
    prefixes,
    exact,
    fallback: undefined,
    register(route) {
      const table = route.kind === "exact" ? exact : prefixes;
      if (table.has(route.path)) throw new Error("duplicate");
      table.set(route.path, route);
      return () => {
        table.delete(route.path);
      };
    },
    registerFallback(handler) {
      ws.fallback = handler;
      return () => {
        ws.fallback = undefined;
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

// ---------------------------------------------------------------- /plugins prefix 接管

{
  const ws = makeWebServer();
  const pluginsHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.write("alert(1);");
    res.end();
  };
  ws.prefixes.set("/plugins", { kind: "prefix", path: "/plugins", handler: pluginsHandler });
  const { handlers } = installWrappers(ws, { compressed: 0, passthrough: 0 });
  assert.equal(handlers.plugins, "replace", "/plugins 走 replace 挂点");
  const route = ws.prefixes.get("/plugins");
  assert.notEqual(route.handler, pluginsHandler, "/plugins handler 已替换");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "/plugins client.js 被压缩");
  assert.equal(gunzipSync(Buffer.concat(res._chunks)).toString("utf8"), "alert(1);", "/plugins 解压一致");
}

// ---------------------------------------------------------------- fallback 席位接管

{
  const ws = makeWebServer();
  const original = (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>index</h1>");
  };
  ws.fallback = original;
  const { handlers, disposers } = installWrappers(ws, { compressed: 0, passthrough: 0 });
  assert.equal(handlers.fallback, "replace", "fallback 已占位走 replace");
  const res = await runHandler(ws.fallback, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "fallback 一次 end(body) 被压缩");
  assert.equal(gunzipSync(Buffer.concat(res._chunks)).toString("utf8"), "<h1>index</h1>", "fallback 解压一致");

  // 卸载恢复原 fallback
  for (const dispose of [...disposers].reverse()) dispose();
  assert.equal(ws.fallback, original, "fallback 卸载恢复");
}

// ---------------------------------------------------------------- registerFallback 兜底

{
  const ws = makeWebServer();
  const { handlers } = installWrappers(ws, { compressed: 0, passthrough: 0 });
  assert.equal(handlers.fallback, "register-patch", "fallback 未占位走 patch 兜底");
  assert.equal(ws.fallback, undefined, "未占位时 patch 不误设 fallback");
  // fallback 之后注册：registerFallback patch 立即包装
  ws.registerFallback((req, res) => {
    res.writeHead(200, { "content-type": "text/css" });
    res.end("a{color:red}");
  });
  const res = await runHandler(ws.fallback, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "registerFallback 兜底压缩");
  assert.equal(gunzipSync(Buffer.concat(res._chunks)).toString("utf8"), "a{color:red}");
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
  assert.ok(okBody.handlers && typeof okBody.handlers === "object", "health 含 handlers");
  for (const v of Object.values(okBody.handlers)) {
    assert.ok(["replace", "register-patch", "passthrough"].includes(v), `handlers 取值合法: ${v}`);
  }

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

// ---------------------------------------------------------------- 方案 A：exact 路由纳入压缩面

// 挂点 1b：已注册 exact 全量替换 → 其响应被 gzip
{
  const ws = makeWebServer();
  const handle = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: "x".repeat(200) }));
  };
  ws.exact.set("/api/dsh-demo/history", { kind: "exact", path: "/api/dsh-demo/history", handler: handle });
  installWrappers(ws, { compressed: 0, passthrough: 0 });
  const route = ws.exact.get("/api/dsh-demo/history");
  assert.notEqual(route.handler, handle, "exact handler 已被替换");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "已注册 exact（挂点1）被压缩");
  assert.equal(JSON.parse(gunzipSync(Buffer.concat(res._chunks)).toString("utf8")).ok, true, "解压内容一致");
}

// 挂点 2：later 注册的 exact 也被 wrap → 压缩
{
  const ws = makeWebServer();
  installWrappers(ws, { compressed: 0, passthrough: 0 });
  ws.register({
    kind: "exact",
    path: "/api/dsh-demo/stats",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"n":1}');
    },
  });
  const route = ws.exact.get("/api/dsh-demo/stats");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "后注册 exact（挂点2）被压缩");
}

// exact SSE 仍豁免透传
{
  const ws = makeWebServer();
  installWrappers(ws, { compressed: 0, passthrough: 0 });
  ws.register({
    kind: "exact",
    path: "/stream",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: x\n\n");
    },
  });
  const route = ws.exact.get("/stream");
  const res = await runHandler(route.handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), undefined, "exact SSE 豁免透传");
}

// 幂等：重复 apply 不二次包裹
{
  const ws = makeWebServer();
  ws.exact.set("/x", { kind: "exact", path: "/x", handler: (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); } });
  const first = installWrappers(ws, { compressed: 0, passthrough: 0 });
  const firstHandler = ws.exact.get("/x").handler;
  installWrappers(ws, { compressed: 0, passthrough: 0 });
  assert.equal(ws.exact.get("/x").handler, firstHandler, "幂等：二次 apply 不重复包裹");
  const res = await runHandler(ws.exact.get("/x").handler, makeReq({ headers: { host: "127.0.0.1:3080", "accept-encoding": "gzip" } }));
  await waitEnded(res);
  assert.equal(res.getHeader("content-encoding"), "gzip", "幂等后仍压缩（单层）");
}

// ---------------------------------------------------------------- R1：无 body 状态不误压

{
  // 304 带可压 content-type：不标 content-encoding
  const res304 = new FakeRes();
  const w304 = wrapResponse(res304, { method: "GET", headers: { "accept-encoding": "gzip" } }, { compressed: 0, passthrough: 0 });
  w304.writeHead(304, { "content-type": "application/json" });
  w304.end();
  assert.equal(res304.getHeader("content-encoding"), undefined, "304 不误压");

  // 204 同理
  const res204 = new FakeRes();
  const w204 = wrapResponse(res204, { method: "GET", headers: { "accept-encoding": "gzip" } }, { compressed: 0, passthrough: 0 });
  w204.writeHead(204, { "content-type": "application/json" });
  w204.end();
  assert.equal(res204.getHeader("content-encoding"), undefined, "204 不误压");

  // 206 同理
  const res206 = new FakeRes();
  const w206 = wrapResponse(res206, { method: "GET", headers: { "accept-encoding": "gzip" } }, { compressed: 0, passthrough: 0 });
  w206.writeHead(206, { "content-type": "application/json" });
  w206.end();
  assert.equal(res206.getHeader("content-encoding"), undefined, "206 不误压");
}

console.log("dsh-gzip smoke: all passed");
