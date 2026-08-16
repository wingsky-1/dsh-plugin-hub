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
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, loadFileConfig, writeConfigFile, sanitizeSettings, rpcHandler, ROUTES, CHANNEL,
  hostnameAllowed, formatAuthority, rewriteHeaders, createLanProxy, isLoopbackTarget, DEFAULT_OPTIONS,
  ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT } from "../lib/index.js";

const UPSTREAM_PORT = 19090;
const PROXY_PORT = 19091;
const PROXY_HTTPS_PORT = 19092;
const LAN_HOST = "192.168.1.50";
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  check("SAN entry: IPv4 literal", () => assert.equal(toSanEntry("192.168.1.5"), "IP:192.168.1.5"));
  check("SAN entry: IPv6 literal", () => assert.equal(toSanEntry("::1"), "IP:::1"));
  check("SAN entry: hostname", () => assert.equal(toSanEntry("myhost.lan"), "DNS:myhost.lan"));
  check("SAN entry: localhost", () => assert.equal(toSanEntry("localhost"), "DNS:localhost"));
  check("self-signed files written", () => {
    assert.ok(existsSync(join(certDir, SELF_SIGNED_CERT)));
    assert.ok(existsSync(join(certDir, SELF_SIGNED_KEY)));
  });
  check("self-signed cert parses and is valid", () => assert.equal(certStillValid(join(certDir, SELF_SIGNED_CERT)), true));
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

  // 客户端契约（构建产物文本断言）。
  {
    const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    check("client exports.apply", () => assert.ok(/exports\.apply = apply/.test(client)));
    check("client exports.inject", () => assert.ok(/exports\.inject = inject/.test(client)));
    check("client carries Symbol.toStringTag", () => assert.ok(client.includes("Symbol.toStringTag")));
    check("client factory is function form", () => assert.ok(/factory:\s*function\s*\(/.test(client)));
    check("client load once at end", () => assert.ok(/__ModuleLoader__\.load/.test(client)) && assert.ok(client.trimEnd().endsWith("})();")));
    check("client shares CHANNEL with host", () => assert.ok(client.includes(CHANNEL)));
    check("client renders settings card fields", () => {
      assert.ok(client.includes("LAN 端口"));
      assert.ok(client.includes("HTTPS 端口"));
      assert.ok(client.includes("证书文件"));
      assert.ok(client.includes("启动时打印访问地址"));
    });
  }

  // Node 24 全局 agent 默认 keep-alive，销毁它让事件循环干净退出
  const { globalAgent } = await import("node:http");
  globalAgent.destroy();
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
