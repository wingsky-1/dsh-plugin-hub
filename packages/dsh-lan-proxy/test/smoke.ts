// @ts-nocheck
// dsh-lan-proxy 冒烟测试 —— 无外部依赖。
//
// 在 127.0.0.1:19090 起一个"假 dsh web 服务器"（回显请求要素、对 WebSocket
// 升级应答字节回显），把代理挂在 127.0.0.1:19091（HTTP）/ 19092（HTTPS）上
// 指向它，然后验证：
//   - Host/Origin 被重写为回环目标（围栏要求）
//   - 无 Origin 的非浏览器请求也能通过
//   - DNS 域名 Host 头被拒绝（重绑定防护）
//   - 缺失 Host 被拒绝
//   - WebSocket 升级可穿透且 Host/Origin 被重写
//   - HTTPS 监听（自签证书）与 HTTP 并存：https 请求 / wss 升级 / 重绑定防护
//   - 自签证书生成幂等、有效期检查、SAN 编码
//
// 运行：node dsh-lan-proxy/test/smoke.mjs   （在仓库根目录下）
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { createServer, request as httpRequest } from "node:http";
import { constants as zlibConstants } from "node:zlib";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
import { apply, loadFileConfig, writeConfigFile, sanitizeSettings, rpcHandler, ROUTES, CHANNEL, pluginDir,
  hostnameAllowed, formatAuthority, rewriteHeaders, createLanProxy, isLoopbackTarget, DEFAULT_OPTIONS,
  compressWsPath, DEFAULT_WSS_COMPRESS_PATHS,
  ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT,
  isCompressible, resolveCompressionOptions } from "../lib/index.js";

const UPSTREAM_PORT = 19090;
const PROXY_PORT = 19091;
const PROXY_HTTPS_PORT = 19092;
const LAN_HOST = "192.168.1.50";
const failures = [];
const pendingChecks = []; // 收集全部 async 用例 promise，收尾统一 allSettled（防迟到失败漏计 → 假绿）
const check = (name, fn) => {
  const fail = (err) => {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
  };
  try {
    const result = fn();
    // promise 感知：async 断言失败同样记入 failures（否则静默丢失、报告失真）。
    if (result && typeof result.then === "function") {
      pendingChecks.push(result);
      result.then(() => console.log(`  ok   ${name}`), fail);
      return;
    }
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail(err);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP 压缩层测试桩（迁移自 dsh-gzip smoke）───────────────────────────────
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

/** fake webServer：prefixes/exact Map + register/registerFallback + port（转发器目标端口）。 */
function makeWebServer() {
  const prefixes = new Map();
  const exact = new Map();
  const ws = {
    prefixes,
    exact,
    fallback: undefined,
    port: 30800,
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
    // apply 内 randomUUID polyfill 经 tapIndex 注入；smoke 无需断言 HTML。
    tapIndex() {
      return () => {};
    },
  };
  return ws;
}

function makeReq(over = {}) {
  return {
    method: "GET",
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    ...over,
  };
}


// ── upstream fake dsh web server ────────────────────────────────────────────
const upstream = createServer((req, res) => {
  // 回归用例路径：永不响应（模拟 SSE/WS 类长响应被客户端断开后悬挂）。
  if (req.url === "/hang") return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin ?? null,
      secFetchSite: req.headers["sec-fetch-site"] ?? null,
    }),
  );
});
upstream.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    socket.write(chunk); // 回显
    if (bytes.length >= 32) socket.end();
  });
  socket.on("end", () => socket.destroy());
});

// ── proxy under test ────────────────────────────────────────────────────────
const certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-test-"));
const tls = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
const proxy = createLanProxy({
  host: "127.0.0.1",
  port: PROXY_PORT,
  httpsPort: PROXY_HTTPS_PORT,
  tls,
  targetHost: "127.0.0.1",
  targetPort: UPSTREAM_PORT,
});

// ── helpers ─────────────────────────────────────────────────────────────────
function getViaProxy(headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: PROXY_PORT, path: "/hello", method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
function upgradeViaProxy() {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      path: "/socket",
      method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket", host: `${LAN_HOST}:${PROXY_PORT}`, origin: `http://${LAN_HOST}:${PROXY_PORT}` },
    });
    req.on("upgrade", (res, socket) => {
      let echoed = "";
      socket.on("data", (c) => {
        echoed += c.toString();
        if (echoed.length >= 16) {
          socket.end();
          resolve({ status: res.statusCode, echoed });
        }
      });
      socket.write("ping-from-lan-client");
    });
    req.on("error", reject);
    req.end();
  });
}
/** HTTPS 版请求 helper（自签证书：rejectUnauthorized 关闭）。 */
function getViaHttpsProxy(headers) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { hostname: "127.0.0.1", port: PROXY_HTTPS_PORT, path: "/hello", method: "GET", headers, rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
/** HTTPS 版 wss 升级 helper。 */
function upgradeViaHttpsProxy() {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: PROXY_HTTPS_PORT,
        path: "/socket",
        method: "GET",
        rejectUnauthorized: false,
        headers: { connection: "Upgrade", upgrade: "websocket", host: `${LAN_HOST}:${PROXY_HTTPS_PORT}`, origin: `https://${LAN_HOST}:${PROXY_HTTPS_PORT}` },
      },
      () => {},
    );
    req.on("upgrade", (res, socket) => {
      let echoed = "";
      socket.on("error", () => {});
      socket.on("data", (c) => {
        echoed += c.toString();
        if (echoed.length >= 16) {
          socket.end();
          resolve({ status: res.statusCode, echoed });
        }
      });
      socket.write("ping-over-wss-0123456789");
    });
    req.on("error", reject);
    req.end();
  });
}
/** Hand-write a raw HTTP/1.1 request over a socket (no implicit Host). */
function rawRequest(requestText) {
  return new Promise((resolve, reject) => {
    const socket = connect(PROXY_PORT, "127.0.0.1");
    let raw = "";
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", (c) => {
      raw += c.toString();
      const at = raw.indexOf("\r\n\r\n");
      if (at !== -1) {
        socket.destroy();
        resolve({ statusLine: raw.slice(0, raw.indexOf("\r\n")), body: raw.slice(at + 4) });
      }
    });
    socket.on("error", reject);
  });
}

const main = async () => {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
  await proxy.listen();
  console.log("unit: hostnameAllowed / formatAuthority");
  check("accepts IPv4 literal", () => assert.equal(hostnameAllowed(`${LAN_HOST}:${PROXY_PORT}`), true));
  check("accepts bare IPv4 literal", () => assert.equal(hostnameAllowed(LAN_HOST), true));
  check("accepts IPv6 literal", () => assert.equal(hostnameAllowed("[fe80::1]:3081"), true));
  check("accepts localhost", () => assert.equal(hostnameAllowed("localhost:3081"), true));
  check("rejects DNS name", () => assert.equal(hostnameAllowed("evil.com:3081"), false));
  check("rejects missing host", () => assert.equal(hostnameAllowed(undefined), false));
  check("rejects malformed authority", () => assert.equal(hostnameAllowed("http://evil.com:3081"), false));
  check("formats IPv6 authority", () => assert.equal(formatAuthority("::1", 3080), "[::1]:3080"));

  console.log("unit: rewriteHeaders");
  check("Host replaced by target authority", () => {
    const out = rewriteHeaders({ host: "192.168.1.50:3081", "user-agent": "x" }, "127.0.0.1:3080");
    assert.equal(out.host, "127.0.0.1:3080");
    assert.equal(out["user-agent"], "x");
  });
  check("Origin rewritten to loopback authority", () => {
    const out = rewriteHeaders({ host: "192.168.1.50:3081", origin: "http://192.168.1.50:3081" }, "127.0.0.1:3080");
    assert.equal(out.origin, "http://127.0.0.1:3080");
  });
  check("absent Origin stays absent", () => {
    const out = rewriteHeaders({ host: "192.168.1.50:3081" }, "127.0.0.1:3080");
    assert.equal(out.origin, undefined);
  });
  check("input headers not mutated", () => {
    const input = { host: "192.168.1.50:3081", origin: "http://192.168.1.50:3081" };
    rewriteHeaders(input, "127.0.0.1:3080");
    assert.equal(input.host, "192.168.1.50:3081");
    assert.equal(input.origin, "http://192.168.1.50:3081");
  });

  console.log("http: browser-style request (Host + Origin, same-origin)");
  const browser = await getViaProxy({
    host: `${LAN_HOST}:${PROXY_PORT}`,
    origin: `http://${LAN_HOST}:${PROXY_PORT}`,
    "sec-fetch-site": "same-origin",
  });
  check("proxied 200", () => assert.equal(browser.status, 200));
  const facts = JSON.parse(browser.body);
  check("Host rewritten to loopback target", () => assert.equal(facts.host, `127.0.0.1:${UPSTREAM_PORT}`));
  check("Origin rewritten to loopback target", () => assert.equal(facts.origin, `http://127.0.0.1:${UPSTREAM_PORT}`));
  check("sec-fetch-site passed through", () => assert.equal(facts.secFetchSite, "same-origin"));
  check("path forwarded", () => assert.equal(facts.url, "/hello"));

  console.log("http: non-browser LAN client (no Origin)");
  const plain = await getViaProxy({ host: `${LAN_HOST}:${PROXY_PORT}` });
  check("proxied 200", () => assert.equal(plain.status, 200));
  const plainFacts = JSON.parse(plain.body);
  check("Host rewritten, Origin stays absent", () => assert.equal(plainFacts.host, `127.0.0.1:${UPSTREAM_PORT}`) && assert.equal(plainFacts.origin, null));

  console.log("http: rebinding guard");
  const evil = await getViaProxy({ host: "evil.com:3081" });
  check("DNS-name Host refused with 403", () => assert.equal(evil.status, 403));
  // HTTP/1.1 无 Host：Node 解析层直接拒绝（请求到不了代理 handler）
  const h11 = await rawRequest("GET /nohost HTTP/1.1\r\nConnection: close\r\n\r\n");
  check("HTTP/1.1 missing Host refused (Node 400)", () => assert.ok(h11.statusLine.startsWith("HTTP/1.1 400")));
  // HTTP/1.0 无 Host：合法到达代理 handler，触发我们自己的 403 守卫
  const h10 = await rawRequest("GET /nohost HTTP/1.0\r\n\r\n");
  check("HTTP/1.0 missing Host refused with 403", () => assert.ok(h10.statusLine.startsWith("HTTP/1.1 403")));

  console.log("unit: cert module");
  check("SAN entry: IPv4 literal", () => assert.deepEqual(toSanEntry("192.168.1.5"), { type: 7, ip: "192.168.1.5" }));
  check("SAN entry: IPv6 literal", () => assert.deepEqual(toSanEntry("::1"), { type: 7, ip: "::1" }));
  check("SAN entry: hostname", () => assert.deepEqual(toSanEntry("myhost.lan"), { type: 2, value: "myhost.lan" }));
  check("SAN entry: localhost", () => assert.deepEqual(toSanEntry("localhost"), { type: 2, value: "localhost" }));
  check("self-signed files written", () => {
    assert.ok(existsSync(join(certDir, SELF_SIGNED_CERT)));
    assert.ok(existsSync(join(certDir, SELF_SIGNED_KEY)));
  });
  check("self-signed cert parses and is valid", () => assert.equal(certStillValid(join(certDir, SELF_SIGNED_CERT)), true));
  check("certStillValid rejects unparseable cert", () => {
    const bad = join(mkdtempSync(join(tmpdir(), "dsh-lan-proxy-badcert-")), "bad.pem");
    writeFileSync(bad, "not a pem");
    assert.equal(certStillValid(bad), false);
    assert.equal(certStillValid("/nonexistent/cert.pem"), false);
  });
  check("self-signed idempotent reuse (same materials)", () => {
    const again = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
    assert.equal(again.cert.toString(), tls.cert.toString());
  });
  check("loadTlsFromFiles reads provided PEMs", () => {
    const loaded = loadTlsFromFiles(join(certDir, SELF_SIGNED_CERT), join(certDir, SELF_SIGNED_KEY));
    assert.equal(loaded.cert.toString(), tls.cert.toString());
  });
  check("loadTlsFromFiles rejects missing file", () => {
    assert.throws(() => loadTlsFromFiles("/nonexistent/cert.pem", "/nonexistent/key.pem"));
  });

  console.log("unit: loadFileConfig（插件目录 config.json）");
  const cfgDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-cfg-"));
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      enabled: true,
      host: "0.0.0.0",
      port: 4081,
      httpsEnabled: true,
      httpsPort: 4443,
      tlsCertFile: "/x/cert.pem",
      tlsKeyFile: "/x/key.pem",
      targetHost: "127.0.0.1",
      targetPort: 4080,
      unknownKey: "dropped",
    }),
  );
  const parsed = loadFileConfig(cfgDir);
  check("parses valid keys", () => {
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.host, "0.0.0.0");
    assert.equal(parsed.port, 4081);
    assert.equal(parsed.httpsPort, 4443);
    assert.equal(parsed.tlsCertFile, "/x/cert.pem");
    assert.equal(parsed.targetPort, 4080);
  });
  check("drops unknown keys", () => assert.equal(parsed.unknownKey, undefined));
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ port: "not-a-number", httpsPort: "x", enabled: "yes" }));
  check("drops type-invalid values", () => assert.deepEqual(loadFileConfig(cfgDir), {}));
  const emptyDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-cfg-empty-"));
  check("missing file -> empty object", () => assert.deepEqual(loadFileConfig(emptyDir), {}));
  writeFileSync(join(emptyDir, "config.json"), "{broken json");
  check("invalid JSON -> empty object", () => assert.deepEqual(loadFileConfig(emptyDir), {}));
  writeFileSync(join(emptyDir, "config.json"), JSON.stringify(["array"]));
  check("non-object JSON -> empty object", () => assert.deepEqual(loadFileConfig(emptyDir), {}));
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });

  console.log("websocket: upgrade forwarding");
  const ws = await upgradeViaProxy();
  check("101 Switching Protocols", () => assert.equal(ws.status, 101));
  check("echoed payload", () => assert.equal(ws.echoed, "ping-from-lan-client"));

  console.log("https: browser-style request (Host + Origin, same-origin)");
  const secure = await getViaHttpsProxy({
    host: `${LAN_HOST}:${PROXY_HTTPS_PORT}`,
    origin: `https://${LAN_HOST}:${PROXY_HTTPS_PORT}`,
    "sec-fetch-site": "same-origin",
  });
  check("proxied 200", () => assert.equal(secure.status, 200));
  const secureFacts = JSON.parse(secure.body);
  check("Host rewritten to loopback target", () => assert.equal(secureFacts.host, `127.0.0.1:${UPSTREAM_PORT}`));
  check("Origin rewritten to loopback http target", () => assert.equal(secureFacts.origin, `http://127.0.0.1:${UPSTREAM_PORT}`));
  check("sec-fetch-site passed through", () => assert.equal(secureFacts.secFetchSite, "same-origin"));
  check("path forwarded", () => assert.equal(secureFacts.url, "/hello"));

  console.log("https: rebinding guard");
  const secureEvil = await getViaHttpsProxy({ host: "evil.com:3443" });
  check("DNS-name Host refused with 403", () => assert.equal(secureEvil.status, 403));

  console.log("wss: upgrade forwarding");
  const wss = await upgradeViaHttpsProxy();
  check("101 Switching Protocols", () => assert.equal(wss.status, 101));
  check("echoed payload", () => assert.equal(wss.echoed, "ping-over-wss-0123456789"));

  console.log("regression: 客户端中途断开不悬挂上游连接（keep-alive 池泄漏）");
  // 上游 /hang 永不响应；客户端连上 30ms 后即断开（模拟关标签页/断网）。
  // 70 次超过上游池上限（64），修复前悬挂请求占满池 → 后续请求排队挂死；
  // 修复后每次断开都会销毁上游请求，池始终有可用槽位。
  async function hangAndAbort(port) {
    return new Promise((resolve) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port, path: "/hang", method: "GET", headers: { host: `${LAN_HOST}:${port}` } },
        () => {},
      );
      req.on("error", () => {});
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
  }
  for (let i = 0; i < 70; i += 1) await hangAndAbort(PROXY_PORT);
  await sleep(300); // 等销毁传播到上游
  const afterAbort = await Promise.race([
    getViaProxy({ host: `${LAN_HOST}:${PROXY_PORT}` }),
    sleep(3000).then(() => ({ status: 0, body: "timeout" })),
  ]);
  check("http pool not leaked after 70 aborted clients", () => assert.equal(afterAbort.status, 200));
  const afterAbortTls = await Promise.race([
    getViaHttpsProxy({ host: `${LAN_HOST}:${PROXY_HTTPS_PORT}` }),
    sleep(3000).then(() => ({ status: 0, body: "timeout" })),
  ]);
  check("https pool not leaked after 70 aborted clients", () => assert.equal(afterAbortTls.status, 200));

  await proxy.close();
  await new Promise((r) => upstream.close(r));
  rmSync(certDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- apply / health / RPC

  console.log("unit: sanitizeSettings");
  check("keeps valid keys, drops empty cert paths", () => {
    const out = sanitizeSettings({ enabled: false, port: 4099, tlsCertFile: "", tlsKeyFile: "", printBanner: true, unknownKey: 1 });
    assert.deepEqual(out, { enabled: false, port: 4099, printBanner: true });
  });
  check("rejects type-invalid value wholesale", () => assert.equal(sanitizeSettings({ port: "abc" }), null));
  check("rejects non-object payload", () => assert.equal(sanitizeSettings("nope"), null));
  check("rejects null payload", () => assert.equal(sanitizeSettings(null), null));
  check("rejects out-of-range port", () => assert.equal(sanitizeSettings({ port: 70000 }), null));

  console.log("unit: WebSocket 压缩桥接配置");
  // 默认白名单包含会话事件流两个端点。
  check("默认压缩白名单含 events.mux / events.host", () => {
    assert.deepEqual(DEFAULT_WSS_COMPRESS_PATHS, ["/api/events.mux", "/api/events.host"]);
  });
  // compressWsPath：命中 / 未命中 / 查询串忽略 / 传入 undefined 拒绝。
  check("compressWsPath 命中默认 path 忽略查询串", () =>
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/events.mux?days=30"), true));
  check("compressWsPath 命中非默认 path", () => {
    assert.equal(compressWsPath(["/api/events.mux", "/api/events.host"], "/api/events.host"), true);
    assert.equal(compressWsPath(["/custom/ws"], "/custom/ws"), true);
  });
  check("compressWsPath 未命中 / 空列表 / undefined", () => {
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/other"), false);
    assert.equal(compressWsPath([], "/api/events.mux"), false);
    assert.equal(compressWsPath(undefined, "/api/events.mux"), false);
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, undefined), false);
  });
  // sanitize：接受 wsCompressEnabled / wsCompressPaths（字符串数组），非法整体拒绝。
  check("sanitize 接受 ws 压缩配置", () => {
    const out = sanitizeSettings({ wsCompressEnabled: false, wsCompressPaths: ["/api/events.mux"] });
    assert.deepEqual(out, { wsCompressEnabled: false, wsCompressPaths: ["/api/events.mux"] });
  });
  check("sanitize 拒绝非字符串数组 paths", () =>
    assert.equal(sanitizeSettings({ wsCompressPaths: [1, 2] }), null));

  // ── HTTP 响应压缩（转发层 compression 中间件）：纯函数 ────────────────────
  console.log("unit: HTTP 压缩纯函数（isCompressible / normalizeLevel）");
  check("isCompressible json/+json/text/SSE 豁免/zip 豁免", () => {
    assert.equal(isCompressible("application/json"), true);
    assert.equal(isCompressible("application/json; charset=utf-8"), true);
    assert.equal(isCompressible("application/vnd.test+json"), true);
    assert.equal(isCompressible("text/html"), true);
    assert.equal(isCompressible("text/event-stream"), false, "SSE 豁免");
    assert.equal(isCompressible("application/zip"), false, "zip 豁免");
    assert.equal(isCompressible(undefined), false);
  });
  check("resolveCompressionOptions：四档位对 gzip 与 Brotli 双生效 / 非法按默认", () => {
    const Q = zlibConstants.BROTLI_PARAM_QUALITY;
    // 0/缺省/非法 → 空选项（库默认：gzip Z_DEFAULT_COMPRESSION=6 / br 质量 4）
    for (const v of [undefined, "x", NaN, 0, -3, 4.5, 99]) {
      assert.deepEqual(resolveCompressionOptions(v), {}, `preset=${String(v)}`);
    }
    // 1 低：gzip 1 / br 2
    const low = resolveCompressionOptions(1);
    assert.equal(low.level, 1);
    assert.ok(Number(low.brotli.params[Q]) >= 0 && Number(low.brotli.params[Q]) <= 3);
    // 2 中：gzip 5 / br 5
    const mid = resolveCompressionOptions(2);
    assert.equal(mid.level, 5);
    assert.equal(mid.brotli.params[Q], 5);
    // 3 高：gzip 9 / br 9
    const high = resolveCompressionOptions(3);
    assert.equal(high.level, 9);
    assert.equal(high.brotli.params[Q], 9);
  });

  // ── 转发层 HTTP 压缩：真实 upstream × 真实 createLanProxy ─────────────────
  console.log("integration: 转发层 HTTP 压缩（compression 中间件）");
  {
    const upPort = 19190, pxPort = 19191;
    const bigBody = JSON.stringify({ data: "y".repeat(300_000) });
    const upstream = createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (p === "/big") {
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(bigBody)) });
        res.end(bigBody);
      } else if (p === "/range") {
        res.writeHead(206, { "content-type": "application/json", "content-range": `bytes 0-9/${bigBody.length}`, "content-length": "10" });
        res.end("y".repeat(10));
      } else if (p === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: x\n\n");
      } else if (p === "/pregzip") {
        // 模拟 dsh-gzip 独立包在宿主端已压缩：转发层必须让位（单层）。
        const gz = gzipSync(Buffer.from(bigBody));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gz);
      } else if (p === "/cut") {
        // 悬挂回归：上游发头 + 部分 body 后暴力断连，客户端必须快速终止。
        res.writeHead(200, { "content-type": "application/json", "content-length": String(9_000_000) });
        res.write("y".repeat(300_000));
        setTimeout(() => { res.socket?.destroy(); }, 30);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => upstream.listen(upPort, "127.0.0.1", r));

    const requestThrough = (port, path, headers) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: "127.0.0.1", ...headers } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });

    const proxyOn = createLanProxy(
      { host: "127.0.0.1", port: pxPort, targetHost: "127.0.0.1", targetPort: upPort, httpCompress: { enabled: true, level: 1 } },
      console,
    );
    await proxyOn.listen();

    let r = await requestThrough(pxPort, "/big", { "accept-encoding": "gzip" });
    check("转发层：大 JSON 经代理被 gzip 且解压逐字节一致", () => {
      assert.equal(r.headers["content-encoding"], "gzip");
      assert.equal(r.headers["content-length"], undefined, "content-length 已删除");
      assert.equal(gunzipSync(r.body).toString(), bigBody);
    });
    r = await requestThrough(pxPort, "/big", {});
    check("转发层：无 Accept-Encoding 透传原文", () => {
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.body.toString(), bigBody);
    });
    r = await requestThrough(pxPort, "/range", { "accept-encoding": "gzip" });
    check("转发层：Range/206 豁免不压", () => {
      assert.equal(r.status, 206);
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.headers["content-range"], `bytes 0-9/${bigBody.length}`);
    });
    r = await requestThrough(pxPort, "/sse", { "accept-encoding": "gzip" });
    check("转发层：SSE 豁免不压", () => {
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.body.toString(), "data: x\n\n");
    });
    r = await requestThrough(pxPort, "/pregzip", { "accept-encoding": "gzip" });
    check("转发层：上游已压缩让位（dsh-gzip 宿主端共存，仅单层）", () => {
      assert.equal(r.headers["content-encoding"], "gzip");
      assert.equal(gunzipSync(r.body).toString(), bigBody, "gunzip 一次即原文（无双层）");
    });
    const statsOn = proxyOn.httpCompressStats();
    check("转发层：协商计数递增（协商口径：206 计入 compressed、无 AE 不进 filter）", () => {
      assert.ok(statsOn.compressed >= 3, `compressed=${statsOn.compressed}（/big×1 + /range + /pregzip）`);
      assert.ok(statsOn.passthrough >= 1, `passthrough=${statsOn.passthrough}（SSE）`);
    });
    // 计数防污染：本地生成的 403 围栏响应不得进入协商计数。
    {
      const before = proxyOn.httpCompressStats();
      await new Promise((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port: pxPort, path: "/big", headers: { host: "evil.example.com" } }, (res) => {
          res.resume(); res.on("end", resolve);
        });
        req.on("error", () => resolve());
        req.end();
      });
      const after = proxyOn.httpCompressStats();
      check("转发层：本地 403 响应不污染协商计数", () => {
        assert.deepEqual(after, before, `403 前后 stats 应一致，实际 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      });
    }
    // 悬挂回归（评审增量发现）：上游中途断连时 pipe 不传播错误，若不监听
    // aborted/error 终止下游，客户端将无限悬挂。修复后必须在短时限内结束。
    {
      const cut = await new Promise((resolve) => {
        const t0 = Date.now();
        const req = httpRequest({ host: "127.0.0.1", port: pxPort, path: "/cut", headers: { host: "127.0.0.1", "accept-encoding": "gzip" } }, (res) => {
          let bytes = 0;
          res.on("data", (c) => { bytes += c.length; });
          const finish = (how) => resolve({ how, bytes, ms: Date.now() - t0 });
          res.on("end", () => finish("end"));
          res.on("close", () => finish(`close(aborted=${res.aborted})`));
          res.on("error", (e) => finish(`error:${e.code ?? e.message}`));
        });
        req.on("error", (e) => resolve({ how: `reqError:${e.code ?? e.message}`, bytes: 0, ms: Date.now() - t0 }));
        req.end();
      });
      check("转发层：上游中途断连 → 客户端快速终止（不悬挂回归）", () => {
        assert.ok(cut.ms < 4000, `耗时 ${cut.ms}ms（>4s 视作悬挂），结束方式 ${cut.how}`);
      });
    }
    await proxyOn.close();

    const proxyOff = createLanProxy(
      { host: "127.0.0.1", port: pxPort + 1, targetHost: "127.0.0.1", targetPort: upPort, httpCompress: { enabled: false, level: 1 } },
      console,
    );
    await proxyOff.listen();
    r = await requestThrough(pxPort + 1, "/big", { "accept-encoding": "gzip" });
    check("转发层：enabled=false 全透传", () => {
      assert.equal(r.headers["content-encoding"], undefined);
      assert.equal(r.body.toString(), bigBody);
    });
    await proxyOff.close();
    upstream.close();
  }

  // ── sanitize / loadFileConfig 接受 httpCompress 新键 ─────────────────────
  console.log("unit: httpCompress 配置键");
  check("sanitize 接受 httpCompressEnabled/httpCompressLevel 档位", () => {
    const out = sanitizeSettings({ httpCompressEnabled: false, httpCompressLevel: 2 });
    assert.deepEqual(out, { httpCompressEnabled: false, httpCompressLevel: 2 });
  });
  check("sanitize 档位越界/非整数整体拒绝；旧档位 4..9 迁移为高（3）；0=默认合法", () => {
    assert.equal(sanitizeSettings({ httpCompressLevel: 1.5 }), null);
    assert.equal(sanitizeSettings({ httpCompressLevel: "3" }), null);
    assert.equal(sanitizeSettings({ httpCompressLevel: 10 }), null);
    assert.deepEqual(sanitizeSettings({ httpCompressLevel: 0 }), { httpCompressLevel: 0 });
    // 旧 0..9 档位迁移：整数 4..9 → 3（高）
    assert.deepEqual(sanitizeSettings({ httpCompressLevel: 6 }), { httpCompressLevel: 3 });
    assert.deepEqual(sanitizeSettings({ httpCompressLevel: 9 }), { httpCompressLevel: 3 });
  });
  check("loadFileConfig 解析档位键、旧值迁移并丢弃非法值", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-httpc-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ httpCompressEnabled: false, httpCompressLevel: 6, httpCompressLevelBad: "x" }));
    const parsed = loadFileConfig(dir);
    assert.equal(parsed.httpCompressEnabled, false);
    assert.equal(parsed.httpCompressLevel, 3, "旧档位 6 → 高（3）");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ httpCompressLevel: 12 }));
    assert.deepEqual(loadFileConfig(dir), {});
    rmSync(dir, { recursive: true, force: true });
  });


  console.log("unit: writeConfigFile（原子写）");
  {
    const cfgDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-write-"));
    writeConfigFile(cfgDir, { port: 4099, printBanner: false });
    const raw = readFileSync(join(cfgDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    check("writes config.json with only given keys", () => assert.deepEqual(parsed, { port: 4099, printBanner: false }));
    check("no tmp file left behind", () => assert.equal(existsSync(join(cfgDir, `config.json.tmp-${process.pid}`)), false));
    rmSync(cfgDir, { recursive: true, force: true });
  }

  console.log("unit: rpcHandler");
  {
    let saved = null;
    const handler = rpcHandler({
      resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpsEnabled: true, httpsPort: 3443, targetHost: "127.0.0.1", printBanner: true }),
      fileConfig: () => ({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem" }),
      save: (s) => { saved = s; },
    });
    const state = await handler("state", {});
    check("state returns persisted + effective", () => {
      assert.equal(state.ok, true);
      assert.equal(state.value.settings.tlsCertFile, "/x.pem");
      assert.equal(state.value.effective.port, 3081);
      assert.equal(state.value.effective.printBanner, true);
    });
    const ok = await handler("config", { settings: { enabled: false, port: 4099, tlsCertFile: "", tlsKeyFile: "", printBanner: false } });
    check("config saves sanitized settings (empty certs cleared)", () => {
      assert.equal(ok.ok, true);
      assert.deepEqual(saved, { enabled: false, port: 4099, printBanner: false });
    });
    const bad = await handler("config", { settings: { port: "abc" } });
    check("config rejects invalid values", () => assert.equal(bad.ok, false) && assert.equal(bad.error.code, "invalid"));
    const lone = await handler("config", { settings: { tlsCertFile: "/x.pem" } });
    check("config rejects lone cert without key", () => assert.equal(lone.ok, false) && assert.equal(lone.error.code, "tls-pair"));
    const unknown = await handler("nope", {});
    check("unknown endpoint rejected", () => assert.equal(unknown.ok, false) && assert.equal(unknown.error.code, "unknown"));
  }

  // fake ctx + apply：转发器用一个高位随机端口（不碰 3081），DSH_HOME 隔离。
  console.log("apply: 注册与围栏");
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes = [];
    const rpcHandles = [];
    const disposers = [];
    let routeDisposed = 0;
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3080,
        register(route) { routes.push(route); return () => { routeDisposed += 1; }; },
        tapIndex() { return () => {}; },
      },
      inject(services, fn) {
        if (services.includes("connection")) {
          const connectionCtx = {
            connection: { rpc: { handle(channel, h, opts) { rpcHandles.push({ channel, h, opts }); return () => {}; } } },
            effect(fn2) { return fn2(); },
          };
          fn(connectionCtx);
        }
      },
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19991, httpsEnabled: false });
    const cleanup = () => { for (const d of disposers) { try { d(); } catch {} } };
    check("RPC channel registered with loopback authority", () => {
      assert.equal(rpcHandles.length >= 1, true);
      assert.equal(rpcHandles[0].channel, CHANNEL);
      assert.equal(rpcHandles[0].opts.authority, "loopback");
    });
    const healthRoute = routes.filter((r) => r.path === ROUTES.health)[0];
    check("health route registered", () => assert.ok(healthRoute));
    const fakeReq = (overrides = {}) => Object.assign(
      { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" }, url: ROUTES.health },
      overrides,
    );
    const fakeRes = () => {
      let status = 0; let body = "";
      return {
        status: () => status,
        body: () => body,
        writeHead(s) { status = s; },
        end(payload) { body = payload; },
      };
    };
    const res403 = fakeRes();
    healthRoute.handler(fakeReq({ socket: { remoteAddress: "192.168.1.9" } }), res403);
    check("health 403 for non-loopback", () => assert.equal(res403.status(), 403));
    const res405 = fakeRes();
    healthRoute.handler(fakeReq({ method: "POST" }), res405);
    check("health 405 for non-GET", () => assert.equal(res405.status(), 405));
    const res200 = fakeRes();
    healthRoute.handler(fakeReq(), res200);
    check("health 200 with status summary", () => {
      assert.equal(res200.status(), 200);
      const payload = JSON.parse(res200.body());
      assert.equal(payload.ok, true);
      assert.equal(payload.plugin, "dsh-lan-proxy");
    });
    cleanup();
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }

  // apply 集成：HTTP 压缩层安装 + 合并标记路由 + health 扩展字段。
  console.log("apply: HTTP 压缩集成（转发 + 压缩并存 / 标记路由 / health 扩展）");
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-httpc-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const apiHandler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: 1, data: "y".repeat(300) }));
    };
    ws.prefixes.set("/api", { kind: "prefix", path: "/api", handler: apiHandler });
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19993, httpsEnabled: false });

    const apiRoute = ws.prefixes.get("/api");
    check("webServer handler 不被触碰（压缩在转发层，非宿主端 patch）", () => {
      assert.equal(apiRoute.handler, apiHandler, "/api handler 原样保留");
    });

    const healthRoute = ws.exact.get(ROUTES.health);
    const hRes = new FakeRes();
    healthRoute.handler(makeReq(), hRes);
    check("health 扩展返回压缩配置与生效状态", () => {
      assert.equal(ws.exact.has(ROUTES.health), true, "health 路由已注册");
      const payload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
      assert.equal(payload.httpCompressEnabled, true);
      assert.equal(payload.httpCompressLevel, 1);
      assert.equal(payload.httpCompressMounted, true);
      assert.equal(typeof payload.httpCompressStats.compressed, "number");
    });

    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    check("lifecycle 卸载撤下 health 路由且 webServer 原样", () => {
      assert.equal(ws.prefixes.get("/api").handler, apiHandler, "/api handler 全程原样");
      assert.equal(ws.exact.has(ROUTES.health), false, "health 路由移除");
    });
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }

  // apply：httpCompressEnabled=false 只关压缩，转发不受影响。
  console.log("apply: httpCompressEnabled=false 关闭压缩");
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-httpc-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const apiHandler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":1}');
    };
    ws.prefixes.set("/api", { kind: "prefix", path: "/api", handler: apiHandler });
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19994, httpsEnabled: false, httpCompressEnabled: false });
    check("关闭压缩：health mounted=false", () => {
      assert.equal(ws.prefixes.get("/api").handler, apiHandler, "webServer handler 原样");
      assert.ok(ws.exact.has(ROUTES.health), "health 路由仍注册（转发功能不受影响）");
      const hRes = new FakeRes();
      ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
      const payload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
      assert.equal(payload.httpCompressEnabled, false);
      assert.equal(payload.httpCompressMounted, false);
    });
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }

  // apply：运行中经 config.json 热关闭——压缩生效状态必须随 watch 翻转。
  console.log("apply: 运行中热关闭（config.json watch → 压缩卸载）");
  const hotOffCase = async (label, patch, expectProxyOff) => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-hotoff-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const apiHandler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":1}');
    };
    ws.prefixes.set("/api", { kind: "prefix", path: "/api", handler: apiHandler });
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19995, httpsEnabled: false });
    const healthMounted = () => {
      const hRes = new FakeRes();
      ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
      return JSON.parse(Buffer.concat(hRes._chunks).toString("utf8")).httpCompressMounted;
    };
    assert.ok(healthMounted() === true, "前置：压缩已生效");
    // 运行中写 config.json 触发热更新；轮询等待 watch（150ms 防抖）生效，
    // 不用固定 sleep（防 flake 纪律）。
    writeConfigFile(pluginDir(), patch);
    const deadline = Date.now() + 5000;
    while (healthMounted() && Date.now() < deadline) await sleep(25);
    check(`${label}：压缩卸载、webServer 原样`, () => {
      assert.equal(healthMounted(), false, "health mounted=false");
      assert.equal(ws.prefixes.get("/api").handler, apiHandler, "webServer handler 全程原样");
      const hRes = new FakeRes();
      ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
      const payload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
      if (expectProxyOff) assert.equal(payload.listening, false, "转发器已停");
    });
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  };
  await hotOffCase("热关 httpCompressEnabled=false", { httpCompressEnabled: false }, false);
  await hotOffCase("热关 enabled=false（整插件）", { enabled: false }, true);

  // apply：enabled=false 整插件关闭 → 压缩与转发都不注册（启动态）。
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-all-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn) { return fn(); },
    };
    apply(ctx, { enabled: false });
    check("enabled=false：压缩与转发都不注册", () => {
      assert.equal(ws.exact.size, 0);
      assert.equal(ws.prefixes.size, 0);
    });
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }

  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）。
  {
    const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    check("client source contract（IIFE/use strict/load id/SymbolTag/factory/load once）", () => assertClientSourceContract(pkgDir));
    check("client product contract（执行断言：arrive 可解析/apply/inject）", () => assertClientProductContract(pkgDir));
    check("client shares CHANNEL with host", () => assert.ok(client.includes(CHANNEL)));
    check("client renders settings card fields", () => {
      assert.ok(client.includes("LAN 端口"));
      assert.ok(client.includes("HTTPS 端口"));
      assert.ok(client.includes("证书文件"));
      assert.ok(client.includes("启动时打印访问地址"));
      assert.ok(client.includes("HTTP 响应压缩"), "HTTP 压缩开关已渲染");
      assert.ok(client.includes("压缩档位") && client.includes("高（最高压缩比：gzip 9 / br 9）"), "压缩档位下拉框已渲染");
    });
  }

  // Node 24 全局 agent 默认 keep-alive，销毁它让事件循环干净退出
  const { globalAgent } = await import("node:http");
  globalAgent.destroy();
  // 显式等 check() 收集的全部 async 用例落定后再统计失败：原先两轮 setImmediate
  // 只能等到微/宏任务队列的立即回调，晚于其落定的迟到断言（如 setTimeout 延迟
  // 失败）会漏计 failures → exit 0 假绿。
  await Promise.allSettled(pendingChecks);
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
