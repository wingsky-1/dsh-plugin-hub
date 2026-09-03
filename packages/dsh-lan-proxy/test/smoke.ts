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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
import { apply, sanitizeSettings, validateSettings, ROUTES, pluginDir,
  migrateFileConfig, MIGRATED_BAK_NAME, SETTINGS_NS, buildConfigRoutes, applyConfigPatch,
  hostnameAllowed, formatAuthority, rewriteHeaders, createLanProxy, isLoopbackTarget, DEFAULT_OPTIONS,
  compressWsPath, DEFAULT_WSS_COMPRESS_PATHS, normalizeLegacyWsCompressPaths,
  ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT,
  isCompressible, resolveCompressionOptions } from "../lib/index.js";

// 结构化单元测试（issue #82 批次 2：清零未覆盖 CRAP 超阈热点）。
// 注意：单元测试在模块加载期执行（早于下方 main() 的集成区），
// 全 localhost 随机端口 + 临时 DSH_HOME，无外网、无子进程。
import "./unit-proxy.test.ts";
import "./unit-apply.test.ts";

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

/** 构造 fake owner scope + settings service（官方 settings 存储文档的内存形态）。 */
function makeSettings(initialUser: Record<string, unknown> = {}) {
  const state: any = {
    user: { ...initialUser },
    base: {},
    revision: 1,
    registeredNs: null as string | null,
    updates: [] as any[],
    replaces: [] as any[],
    watchers: [] as Array<(next?: any, prev?: any) => void>,
    watchDisposed: 0,
  };
  const scope = {
    get: () => ({ ...state.base, ...state.user }),
    watch: (cb: any) => {
      state.watchers.push(cb);
      return () => { state.watchDisposed += 1; };
    },
    update: async (patch: Record<string, unknown>, expectedRevision?: number) => {
      state.updates.push({ patch, expectedRevision });
      Object.assign(state.user, patch);
      state.revision += 1;
      const next = { ...state.base, ...state.user };
      for (const cb of [...state.watchers]) cb(next, {});
    },
    replace: async (section: Record<string, unknown>, expectedRevision?: number) => {
      state.replaces.push({ section, expectedRevision });
      state.user = { ...section };
      state.revision += 1;
      const next = { ...state.base, ...state.user };
      for (const cb of [...state.watchers]) cb(next, {});
    },
  };
  const service = {
    register(ns: string, _schema: unknown, opts: any) {
      if (state.registeredNs !== null) throw new Error("duplicate register");
      state.registeredNs = ns;
      state.base = { ...(opts?.base ?? {}) };
      return scope;
    },
    describe(_opts?: any) {
      return [{ ns: state.registeredNs, user: JSON.parse(JSON.stringify(state.user)), revision: state.revision }];
    },
  };
  return { state, scope, service };
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

  console.log("unit: migrateFileConfig（存量 config.json 一次性迁移，rename-first marker）");
  {
    const cfgDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-"));
    /** fake owner scope：update 增量 merge 进内存 user 层（官方存储文档的 fake 形态）。 */
    const makeScope = () => {
      const state = { user: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[] };
      return {
        state,
        async update(patch: Record<string, unknown>) { state.updates.push(patch); Object.assign(state.user, patch); },
      };
    };
    // 有效配置：改名 + 过滤未知键 + 增量写入官方存储。
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ port: 4081, printBanner: false, unknownKey: "dropped", httpCompressLevel: 6 }));
    let scope = makeScope();
    let outcome = await migrateFileConfig(cfgDir, scope);
    check("迁移：原子改名为 .bak 且增量写入有效键（旧档位 6→3、未知键丢弃）", () => {
      assert.equal(outcome.performed && outcome.migrated, true, `outcome=${JSON.stringify(outcome)}`);
      assert.equal(existsSync(join(cfgDir, "config.json")), false, "config.json 已改名消失");
      assert.equal(existsSync(join(cfgDir, MIGRATED_BAK_NAME)), true, ".bak 备份存在");
      const bak = JSON.parse(readFileSync(join(cfgDir, MIGRATED_BAK_NAME), "utf8"));
      assert.equal(bak.port, 4081, "bak 保留原始内容供用户回滚");
      assert.deepEqual(scope.state.user, { port: 4081, printBanner: false, httpCompressLevel: 3 }, `写入官方存储的用户层=${JSON.stringify(scope.state.user)}`);
    });
    // 幂等：config.json 与 .bak 都不存在（用户已清理备份的稳态）→ 跳过，不写。
    // 注：正常迁移成功后 .bak 保留，二次启动会命中中断态重放（同值 merge 无害，
    // 见下方用例）；真正「跳过」的稳态是备份被清理之后。
    rmSync(join(cfgDir, MIGRATED_BAK_NAME));
    scope = makeScope();
    outcome = await migrateFileConfig(cfgDir, scope);
    check("迁移幂等：config.json 与备份都不存在 → 跳过且不写", () => {
      assert.deepEqual(outcome, { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: false });
      assert.equal(scope.state.updates.length, 0, "未产生第二次写入");
    });
    rmSync(cfgDir, { recursive: true, force: true });

    // 中断态重放：.bak 存在且 config.json 不存在（改名成功后写入完成前进程被杀）
    // → 视为未完成迁移，从 bak 重放「解析→sanitize→update」，配置不再永滞 bak。
    // （正常迁移成功后 bak 保留，因此二次启动也会命中重放——同值 merge 无害。）
    const resumeDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-"));
    writeFileSync(join(resumeDir, MIGRATED_BAK_NAME), JSON.stringify({ port: 4077, printBanner: false }));
    const warns: string[] = [];
    scope = makeScope();
    outcome = await migrateFileConfig(resumeDir, scope, { warn: (m) => warns.push(String(m)) });
    check("中断重放：.bak 存在且 config.json 不存在 → 从 bak 重写官方存储且保留备份", () => {
      assert.equal(outcome.resumed && outcome.migrated, true, `outcome=${JSON.stringify(outcome)}`);
      assert.equal(scope.state.user.port, 4077, "滞留 .bak 的配置已重放进官方存储");
      assert.equal(existsSync(join(resumeDir, MIGRATED_BAK_NAME)), true, "重放成功后保留 bak");
      assert.ok(warns.some((m) => m.includes("重放写入设置")), `warn 明示恢复路径，实际 ${JSON.stringify(warns)}`);
    });
    // 二次启动（bak 未清理）→ 再次重放同值，无副作用、不抛错。
    const again = await migrateFileConfig(resumeDir, scope);
    check("中断重放幂等：二次启动重放同值无害", () => {
      assert.equal(again.resumed && again.migrated, true);
      assert.equal(scope.state.user.port, 4077);
      assert.deepEqual(scope.state.updates[0], scope.state.updates[1], "两次重放内容一致");
    });
    // 重放遇损坏 bak：warn 手动恢复路径，不抛错。
    const badBak = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-bad-"));
    writeFileSync(join(badBak, MIGRATED_BAK_NAME), "{not json");
    const badWarns: string[] = [];
    const badResume = await migrateFileConfig(badBak, makeScope(), { warn: (m) => badWarns.push(String(m)) });
    check("中断重放：bak 损坏时 warn 手动恢复路径且不写入", () => {
      assert.equal(badResume.resumed, true);
      assert.equal(badResume.migrated, false);
      assert.ok(badWarns.some((m) => m.includes("无法自动恢复")), `warn 含手动恢复指引，实际 ${JSON.stringify(badWarns)}`);
    });
    rmSync(resumeDir, { recursive: true, force: true });
    rmSync(badBak, { recursive: true, force: true });

    // 损坏 / 非 object / 全非法值 JSON：只改名标记、不写入。
    for (const [label, raw] of [
      ["损坏 json 只标记不写", "{broken json"],
      ["数组 json 只标记不写", JSON.stringify(["array"])],
      ["含类型非法值只标记不写", JSON.stringify({ port: "not-a-number" })],
    ] as Array<[string, string]>) {
      const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-bad-"));
      writeFileSync(join(dir, "config.json"), raw);
      const s = makeScope();
      const bad = await migrateFileConfig(dir, s);
      check(`迁移：${label}（.bak 存在、scope 未被调用）`, () => {
        assert.equal(bad.skippedCorrupt, true, `outcome=${JSON.stringify(bad)}`);
        assert.equal(bad.migrated, false);
        assert.equal(existsSync(join(dir, MIGRATED_BAK_NAME)), true, "仅改名标记");
        assert.equal(s.state.updates.length, 0, "不写入 scope");
      });
      rmSync(dir, { recursive: true, force: true });
    }

    // 写入失败回滚：scope.update 抛错 → config.json 还原，下次启动可重试。
    {
      const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-rollback-"));
      writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 4099 }));
      const failing = { updates: [] as unknown[], async update() { throw new Error("disk full"); } };
      const rb = await migrateFileConfig(dir, failing as any);
      check("迁移：写入失败回滚 rename（config.json 还原、下次启动重试）", () => {
        assert.equal(rb.rolledBack, true, `outcome=${JSON.stringify(rb)}`);
        assert.equal(existsSync(join(dir, "config.json")), true, "config.json 已还原");
        assert.equal(failing.updates.length, 0);
      });
      rmSync(dir, { recursive: true, force: true });
    }

    // M2（#395）：迁移含旧默认白名单的 config.json → 写入归一化后的新值；
    // 自定义白名单（含废弃端点的组合）迁移后原样保留。
    {
      const m2Dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2-"));
      writeFileSync(join(m2Dir, "config.json"), JSON.stringify({ wsCompressPaths: ["/api/events.host", "/api/events.mux"] }));
      const m2Scope = makeScope();
      const m2 = await migrateFileConfig(m2Dir, m2Scope);
      check("迁移：含旧默认白名单的 config.json 写入归一化后的 remote.mux", () => {
        assert.equal(m2.migrated, true, `outcome=${JSON.stringify(m2)}`);
        assert.deepEqual(m2Scope.state.user, { wsCompressPaths: ["/api/remote.mux"] },
          `写入官方存储的用户层=${JSON.stringify(m2Scope.state.user)}`);
      });
      rmSync(m2Dir, { recursive: true, force: true });

      const m2CustomDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2c-"));
      writeFileSync(join(m2CustomDir, "config.json"), JSON.stringify({ wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] }));
      const m2CustomScope = makeScope();
      const m2c = await migrateFileConfig(m2CustomDir, m2CustomScope);
      check("迁移：自定义白名单（含废弃端点组合）原样保留不改写", () => {
        assert.equal(m2c.migrated, true, `outcome=${JSON.stringify(m2c)}`);
        assert.deepEqual(m2CustomScope.state.user, { wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] },
          `写入官方存储的用户层=${JSON.stringify(m2CustomScope.state.user)}`);
      });
      rmSync(m2CustomDir, { recursive: true, force: true });
    }
  }

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

  // issue #33 子项 1：校验失败指明首个非法字段与合法范围。
  console.log("unit: validateSettings（非法值定位到字段与范围）");
  check("validateSettings 定位首个非法键并给出范围提示", () => {
    const bad = validateSettings({ enabled: "yes", port: "abc" });
    assert.ok(bad !== null);
    assert.equal(bad.key, "enabled", "按 FILE_CONFIG_VALIDATORS 键序取首个非法键");
    assert.ok(bad.hint.includes("布尔"), `hint 指明类型要求，实际「${bad.hint}」`);
  });
  check("validateSettings 端口越界提示 1-65535", () => {
    for (const v of [0, 70000, 1.5, "4099"]) {
      const bad = validateSettings({ port: v });
      assert.ok(bad !== null, `port=${String(v)} 应非法`);
      assert.equal(bad.key, "port");
      assert.ok(bad.hint.includes("1-65535"), `hint 含合法范围，实际「${bad.hint}」`);
    }
  });
  check("validateSettings 档位越界提示 0-3；旧档位 4..9 迁移后合法；全合法返回 null", () => {
    const bad = validateSettings({ httpCompressLevel: 10 });
    assert.ok(bad !== null);
    assert.equal(bad.key, "httpCompressLevel");
    assert.ok(bad.hint.includes("0-3"), `hint 含档位范围，实际「${bad.hint}」`);
    assert.equal(validateSettings({ httpCompressLevel: 6 }), null, "旧档位 4..9 迁移为高档后合法");
    assert.equal(validateSettings({ enabled: false, port: 4099, httpsPort: 3443, printBanner: true, wsCompressPaths: ["/x"], httpCompressEnabled: true, httpCompressLevel: 2 }), null);
  });
  check("validateSettings 非对象 payload 指明需配置对象", () => {
    const bad = validateSettings("nope");
    assert.ok(bad !== null && bad.key === "(payload)");
  });

  console.log("unit: WebSocket 压缩桥接配置");
  // 默认白名单为 api-gateway 的 Remote 流 mux 端点（dsh 0.1.2 起取代 events.mux/events.host）。
  check("默认压缩白名单为 remote.mux", () => {
    assert.deepEqual(DEFAULT_WSS_COMPRESS_PATHS, ["/api/remote.mux"]);
  });
  // compressWsPath：命中 / 未命中 / 查询串忽略 / 传入 undefined 拒绝。
  check("compressWsPath 命中默认 path 忽略查询串", () =>
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/remote.mux?x=1"), true));
  check("compressWsPath 命中非默认 path", () => {
    assert.equal(compressWsPath(["/api/events.mux", "/api/events.host"], "/api/events.host"), true);
    assert.equal(compressWsPath(["/custom/ws"], "/custom/ws"), true);
  });
  check("compressWsPath 未命中 / 空列表 / undefined", () => {
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/other"), false);
    assert.equal(compressWsPath([], "/api/remote.mux"), false);
    assert.equal(compressWsPath(undefined, "/api/remote.mux"), false);
    assert.equal(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, undefined), false);
  });
  // sanitize：接受 wsCompressEnabled / wsCompressPaths（字符串数组），非法整体拒绝。
  check("sanitize 接受 ws 压缩配置", () => {
    const out = sanitizeSettings({ wsCompressEnabled: false, wsCompressPaths: ["/api/remote.mux"] });
    assert.deepEqual(out, { wsCompressEnabled: false, wsCompressPaths: ["/api/remote.mux"] });
  });
  check("sanitize 拒绝非字符串数组 paths", () =>
    assert.equal(sanitizeSettings({ wsCompressPaths: [1, 2] }), null));
  // normalizeLegacyWsCompressPaths（#395 M2）：旧默认乱序等价归一化，自定义不动。
  check("normalizeLegacyWsCompressPaths 旧默认无序等价归一化到 remote.mux", () => {
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"]), ["/api/remote.mux"]);
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/events.host", "/api/events.mux"]), ["/api/remote.mux"], "顺序不同也等价");
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"]), [...DEFAULT_WSS_COMPRESS_PATHS], "与默认常量同源");
  });
  check("normalizeLegacyWsCompressPaths 自定义/undefined/空数组原样", () => {
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/custom/ws"]), ["/api/custom/ws"]);
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/custom/ws"]), ["/api/events.mux", "/api/custom/ws"], "含废弃端点的自定义组合不改写");
    assert.equal(normalizeLegacyWsCompressPaths(undefined), undefined);
    assert.deepEqual(normalizeLegacyWsCompressPaths([]), []);
    assert.deepEqual(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.mux"]), ["/api/events.mux", "/api/events.mux"], "重复元素非等价");
  });

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

  // ── sanitize 接受 httpCompress 新键 ──────────────────────────────────────
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


  console.log("unit: applyConfigPatch（PUT /config 主体：校验 → 官方存储写入）");
  {
    /** fake deps：update 增量 merge / replace 整节替换，内存即官方存储文档。 */
    const makeDeps = (initialUser: Record<string, unknown> = {}, opts: { broken?: boolean; conflict?: boolean } = {}) => {
      const state = {
        user: { ...initialUser },
        updates: [] as Array<{ patch: Record<string, unknown>; expectedRevision?: number }>,
        replaces: [] as Array<{ section: Record<string, unknown>; expectedRevision?: number }>,
      };
      return {
        state,
        deps: {
          resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpsEnabled: true, httpsPort: 3443, targetHost: "127.0.0.1", printBanner: true }) as any,
          readUser: () => ({ user: { ...state.user }, revision: 7 }),
          writable: () => true,
          update: async (patch: Record<string, unknown>, expectedRevision?: number) => {
            if (opts.broken) throw new Error("disk full");
            if (opts.conflict) throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" });
            state.updates.push({ patch, expectedRevision });
            Object.assign(state.user, patch);
          },
          replace: async (section: Record<string, unknown>, expectedRevision?: number) => {
            // 与 update 同口径注入写入失败/乐观并发冲突（清除路径走 replace）。
            if (opts.broken) throw new Error("disk full");
            if (opts.conflict) throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" });
            state.replaces.push({ section, expectedRevision });
            state.user = { ...section };
          },
          compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: true, httpCompressStats: { compressed: 7, passthrough: 2 } }),
        } as any,
      };
    };

    // 合法 patch：validate/sanitize 后增量 update（expectedRevision 透传）。
    let h = makeDeps({ tlsCertFile: "/x.pem" as unknown });
    let r = await applyConfigPatch(h.deps, { patch: { port: 4099, printBanner: false }, expectedRevision: 7 });
    check("patch 合法提交走 update 增量合并且透传 expectedRevision", () => {
      assert.equal(r.ok, true);
      assert.deepEqual(h.state.updates, [{ patch: { port: 4099, printBanner: false }, expectedRevision: 7 }]);
      assert.deepEqual(h.state.user, { tlsCertFile: "/x.pem", port: 4099, printBanner: false }, "未提交键保持原值");
      assert.deepEqual((r as any).value.revision, 7);
    });

    // 清除证书路径：raw 空字符串 → replace 整节（unset 语义），其余键保留。
    h = makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 });
    r = await applyConfigPatch(h.deps, { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } });
    check("tls 双空串触发 replace 整节替换并从用户层剔除两个键", () => {
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(h.state.replaces.length, 1, "走了 replace 路径");
      assert.equal(h.state.updates.length, 0, "不走 update");
      assert.deepEqual(h.state.user, { port: 4000, printBanner: false }, "tls 键已剔除、其余键保留");
    });

    // 校验失败：首个非法键定位 + 范围提示。
    const badPort = await applyConfigPatch(makeDeps().deps, { patch: { port: 70000 } });
    check("patch 非法端口 400 且 details 含键名与范围", () => {
      assert.equal(badPort.ok, false);
      assert.deepEqual((badPort as any).status === 400 && (badPort as any).code, "invalid");
      assert.ok((badPort as any).details.includes("port") && (badPort as any).details.includes("1-65535"));
    });
    // tls 成对约束。
    const lone = await applyConfigPatch(makeDeps().deps, { patch: { tlsCertFile: "/x.pem" } });
    check("patch 单边证书被拒（tls-pair）", () => assert.equal(lone.ok === false && (lone as any).code, "tls-pair"));
    // P2-1：单边空串 + 单侧非空字符串 → raw 层直接拒绝（不再被 sanitize 剔除绕过）。
    const mixedClear = await applyConfigPatch(makeDeps({ port: 4000 }).deps, { patch: { tlsCertFile: "", tlsKeyFile: "/keep.pem" } });
    const mixedSet = await applyConfigPatch(makeDeps().deps, { patch: { tlsCertFile: "/new.pem", tlsKeyFile: "" } });
    check("patch 单边空串混非空值被拒（raw 层成对形态判定）", () => {
      assert.equal(mixedClear.ok, false, JSON.stringify(mixedClear));
      assert.equal((mixedClear as any).code, "tls-pair");
      assert.equal((mixedClear as any).status, 400);
      assert.equal(mixedSet.ok, false);
      assert.equal((mixedSet as any).code, "tls-pair");
    });
    // settings 服务不可用。
    const unavail = makeDeps();
    (unavail.deps as any).writable = () => false;
    const na = await applyConfigPatch(unavail.deps, { patch: { port: 4000 } });
    check("settings 服务不可用时写入 503 拒绝", () => assert.equal(na.ok === false && (na as any).status, 503));
    // ── #467 验收：TLS 成对清除语义（只清 cert / 只清 key / 双清 / 清除遇 409 /
    //    user 层已不完整）。
    const clearCertOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "" } },
    );
    check("#467 只清 cert（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
      assert.equal(clearCertOnly.ok, false, JSON.stringify(clearCertOnly));
      assert.equal((clearCertOnly as any).status, 400);
      assert.equal((clearCertOnly as any).code, "tls-pair");
    });
    const clearKeyOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "" } },
    );
    check("#467 只清 key（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
      assert.equal(clearKeyOnly.ok, false, JSON.stringify(clearKeyOnly));
      assert.equal((clearKeyOnly as any).status, 400);
      assert.equal((clearKeyOnly as any).code, "tls-pair");
    });
    const clearBoth = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } },
    );
    check("#467 双清（同空）整套成对剔除，user 层不留任何 tls 键", () => {
      assert.equal(clearBoth.ok, true, JSON.stringify(clearBoth));
      assert.equal((clearBoth as any).value.user.tlsCertFile, undefined, "tlsCertFile 已剔除");
      assert.equal((clearBoth as any).value.user.tlsKeyFile, undefined, "tlsKeyFile 已剔除");
      assert.equal((clearBoth as any).value.user.port, 4000, "其余键保留");
      assert.equal((clearBoth as any).value.user.printBanner, false);
    });
    const clearConflict = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem" }, { conflict: true }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    check("#467 清除遇 SETTINGS_CONFLICT 映射 409/conflict 固定文案", () => {
      assert.equal(clearConflict.ok, false, JSON.stringify(clearConflict));
      assert.equal((clearConflict as any).status, 409);
      assert.equal((clearConflict as any).code, "conflict");
      assert.equal((clearConflict as any).details, "设置已被其他窗口修改，请刷新后重试");
    });
    const brokenUser = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    check("#467 双清不会产生含 undefined 段的路径（user 层干净成对）", () => {
      const user = (brokenUser as any).value.user;
      const fsPath = join(user?.tlsCertFile ?? "", user?.tlsKeyFile ?? "");
      assert.ok(!fsPath.includes("undefined"), `不得产生含 undefined 段的路径，实际 ${fsPath}`);
    });
    const inPair = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "/new-key.pem", printBanner: false } },
    );
    check("#467 只设 key 亦被拒（任一单侧显式即 400，含未清除意图）", () => {
      assert.equal(inPair.ok, false, JSON.stringify(inPair));
      assert.equal((inPair as any).code, "tls-pair");
    });
    // 场景 5：user 层已不完整（历史孤儿 { tlsCertFile: "/x.pem" } 残留）时，
    // 双清仍整体剔除两键并走 replace 自愈；单侧清除请求仍被 raw 层拒绝（双清是唯一出口）。
    const orphanPair = makeDeps({ tlsCertFile: "/x.pem", port: 4000 });
    const orphanRes = await applyConfigPatch(orphanPair.deps, { patch: { tlsCertFile: "", tlsKeyFile: "" } });
    check("#467 user 层已不完整（孤儿单侧残留）双清 replace 自愈，无孤儿留存", () => {
      assert.equal(orphanRes.ok, true, JSON.stringify(orphanRes));
      assert.equal((orphanRes as any).value.user.tlsCertFile, undefined);
      assert.equal((orphanRes as any).value.user.tlsKeyFile, undefined);
      assert.equal(orphanPair.state.replaces.length, 1, "走 replace 整节替换");
    });
    const orphanLone = await applyConfigPatch(makeDeps({ tlsCertFile: "/x.pem", port: 4000 }).deps, { patch: { tlsCertFile: "" } });
    check("#467 user 层已不完整时单侧清除仍被拒（不落盘半套）", () => {
      assert.equal(orphanLone.ok, false, JSON.stringify(orphanLone));
      assert.equal((orphanLone as any).code, "tls-pair");
    });
    const logWarns: string[] = [];
    const brokenDeps = makeDeps({}, { broken: true });
    (brokenDeps.deps as any).logWarn = (m: string) => logWarns.push(m);
    const broken = await applyConfigPatch(brokenDeps.deps, { patch: { port: 4000 } });
    check("写入异常映射 500/error 且 details 不泄露底层错误原文", () => {
      assert.equal(broken.ok === false && (broken as any).status, 500);
      assert.equal((broken as any).code, "error");
      assert.equal((broken as any).details, "保存失败，请查看服务端日志");
      assert.ok(!((broken as any).details.includes("disk full")), "details 不含 err.message 原文");
      assert.ok(logWarns.some((m) => m.includes("disk full")), "err.message 走服务端日志");
    });
    const conflict = await applyConfigPatch(makeDeps({}, { conflict: true }).deps, { patch: { port: 4000 } });
    check("SETTINGS_CONFLICT 映射 409/conflict", () => assert.equal(conflict.ok === false && (conflict as any).status, 409) && assert.equal((conflict as any).code, "conflict"));
  }

  console.log("unit: buildConfigRoutes（GET 快照 / PUT 写入 / 围栏）");
  {
    let putPayload: any = null;
    const deps = {
      resolve: () => ({ enabled: false, host: "0.0.0.0", port: 3082, httpsEnabled: true, httpsPort: 3443, targetHost: "127.0.0.1", printBanner: true, wsCompressEnabled: true, wsCompressPaths: [], httpCompressEnabled: true, httpCompressLevel: 2 }) as any,
      readUser: () => ({ user: { port: 3082 } as Record<string, unknown>, revision: 3 }),
      writable: () => true,
      update: async (patch: any, rev: any) => { putPayload = { kind: "update", patch, rev }; },
      replace: async (section: any, rev: any) => { putPayload = { kind: "replace", section, rev }; },
      compress: () => ({ httpCompressEnabled: true, httpCompressLevel: 1, httpCompressMounted: true, httpCompressStats: { compressed: 5, passthrough: 6 } }),
    } as any;
    const route = buildConfigRoutes(deps)[0];
    const callRoute = (method: string, overrides: any = {}, body?: any) =>
      Promise.resolve().then(async () => {
        const req: any = Object.assign(
          { method, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
          overrides,
        );
        if (body !== undefined) req._body = body;
        const chunks: string[] = [];
        let status = 0;
        const res: any = {
          writeHead(code: number) { status = code; },
          end(c?: any) { if (c !== undefined) chunks.push(String(c)); },
          getHeader() { return undefined; },
          setHeader() {},
        };
        if (body !== undefined) {
          // readBody 从 req 事件流读——这里直接给一个最小可读流形态。
          const { EventEmitter } = await import("node:events");
          const stream: any = new EventEmitter();
          Object.assign(stream, req);
          process.nextTick(() => {
            stream.emit("data", Buffer.from(JSON.stringify(body)));
            stream.emit("end");
          });
          await route.handler(stream, res);
        } else {
          await route.handler(req, res);
        }
        return { status: status || 200, body: chunks.join("") };
      });

    const forbidden = await callRoute("GET", { socket: { remoteAddress: "192.168.1.9" } });
    check("config 路由非回环 403", () => assert.equal(forbidden.status, 403));
    const notAllowed = await callRoute("POST", {}, { patch: {} });
    check("config 路由 POST 405（仅 GET/PUT）", () => assert.equal(notAllowed.status, 405));

    const got = await callRoute("GET");
    check("GET 返回 user 层 + effective 生效值 + 压缩快照 + revision（只读面不收缩）", () => {
      const payload = JSON.parse(got.body);
      assert.equal(got.status, 200);
      assert.deepEqual(payload.user, { port: 3082 });
      assert.equal(payload.effective.port, 3082, "effective 生效值可见");
      assert.equal(payload.compress.httpCompressStats.compressed, 5, "压缩协商计数可见");
      assert.equal(payload.revision, 3);
      assert.equal(payload.writable, true);
    });
    const put = await callRoute("PUT", {}, { patch: { port: 4099 }, expectedRevision: 3 });
    check("PUT 合法 patch 转 scope.update 并回传新 user 层", () => {
      const payload = JSON.parse(put.body);
      assert.equal(put.status, 200);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.user, { port: 3082 });
      assert.equal(putPayload.kind, "update");
      assert.equal(putPayload.rev, 3, "expectedRevision 透传");
    });
    const putBad = await callRoute("PUT", {}, { patch: { port: 70000 } });
    check("PUT 非法 patch 400 带 error.details", () => {
      const payload = JSON.parse(putBad.body);
      assert.equal(putBad.status, 400);
      assert.ok(payload.error.details.includes("port"));
    });
  }

  // fake ctx + apply：转发器用一个高位随机端口（不碰 3081），DSH_HOME 隔离。
  console.log("apply: 注册、围栏与 settings 命名空间接线");
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    // 预置存量 config.json → apply 后应自动迁移进 fake 官方存储。
    mkdirSync(join(applyHome, "lan-proxy"), { recursive: true });
    writeFileSync(join(applyHome, "lan-proxy", "config.json"), JSON.stringify({ port: 19997 }));
    const { state: settingsState, service } = makeSettings();
    const routes = [];
    const rpcHandles = [];
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3080,
        register(route) { routes.push(route); return () => {}; },
        tapIndex() { return () => {}; },
      },
      inject(services, fn) {
        if (services.includes("connection")) {
          fn({
            connection: { rpc: { handle(channel, h, opts) { rpcHandles.push({ channel, h, opts }); return () => {}; } } },
            effect(fn2) { return fn2(); },
          });
        }
        if (services.includes("settings")) {
          fn({ settings: service, effect(fn2) { const d = fn2(); if (typeof d === "function") disposers.push(d); return d; } });
        }
      },
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19991, httpsEnabled: false });
    const cleanup = () => { for (const d of disposers.reverse()) { try { d(); } catch {} } };
    check("RPC 配置通道不再注册（自建通道移除）", () => assert.equal(rpcHandles.length, 0));
    const healthRoute = routes.filter((r) => r.path === ROUTES.health)[0];
    check("health route registered", () => assert.ok(healthRoute));
    const configRoute = routes.filter((r) => r.path === ROUTES.config)[0];
    check("config route registered", () => assert.ok(configRoute));
    // 迁移是 async fire-and-forget：轮询等待（防 flake 纪律，不用固定 sleep）。
    const migratedDeadline = Date.now() + 5000;
    while (!existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME)) && Date.now() < migratedDeadline) await sleep(25);
    check("apply 后存量 config.json 自动迁移进官方存储（attach 即迁移）", () => {
      assert.equal(existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME)), true, ".bak 幂等标记存在");
      assert.deepEqual(settingsState.updates, [{ patch: { port: 19997 }, expectedRevision: undefined }]);
      assert.equal(settingsState.user.port, 19997, "user 层已写入");
      assert.equal(settingsState.registeredNs, SETTINGS_NS);
    });
    // GET /config 快照（经真实路由 handler）：effective + compress + user + revision。
    const callRoute = async (method: string, overrides: any = {}, body?: any) => {
      const req: any = Object.assign(
        { method, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
        overrides,
      );
      const chunks: string[] = [];
      let status = 0;
      const res: any = {
        writeHead(code: number) { status = code; },
        end(c?: any) { if (c !== undefined) chunks.push(String(c)); },
        getHeader() { return undefined; },
        setHeader() {},
      };
      if (body !== undefined) {
        const { EventEmitter } = await import("node:events");
        const stream: any = new EventEmitter();
        Object.assign(stream, req);
        process.nextTick(() => {
          stream.emit("data", Buffer.from(JSON.stringify(body)));
          stream.emit("end");
        });
        await configRoute.handler(stream, res);
      } else {
        await configRoute.handler(req, res);
      }
      return { status: status || 200, body: chunks.join("") };
    };
    const snapshot = await callRoute("GET");
    check("GET /config 快照含 effective 生效值 + 压缩快照 + user 层 + revision", () => {
      const payload = JSON.parse(snapshot.body);
      assert.equal(snapshot.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.effective.port, 19997, "迁移后的生效端口可见");
      assert.equal(payload.effective.host, "127.0.0.1", "组合层 entry 兜底生效");
      assert.equal(payload.compress.httpCompressMounted, true, "转发器已监听 → 压缩已挂载");
      assert.equal(typeof payload.compress.httpCompressStats.compressed, "number");
      assert.deepEqual(payload.user, { port: 19997 });
      assert.equal(typeof payload.revision, "number");
      assert.equal(payload.writable, true);
    });
    const cfg403 = await callRoute("GET", { socket: { remoteAddress: "192.168.100.9" } });
    check("config 路由非回环 403", () => assert.equal(cfg403.status, 403));
    const cfg405 = await callRoute("DELETE");
    check("config 路由 DELETE 405", () => assert.equal(cfg405.status, 405));
    // PUT 写入：经路由 → deps.update（fake scope）→ watch 触发。
    const put = await callRoute("PUT", {}, { patch: { printBanner: false }, expectedRevision: settingsState.revision });
    check("PUT 经路由写入官方存储并触发 watch 回调", () => {
      const payload = JSON.parse(put.body);
      assert.equal(put.status, 200, put.body);
      assert.equal(payload.ok, true);
      assert.equal(settingsState.user.printBanner, false);
      assert.equal(settingsState.watchers.length >= 1 && settingsState.watchDisposed, 0, "watch 已挂接未释放");
    });
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

  // apply：settings 服务缺失 → 降级（卡片可读不可写，主体不受影响）。
  console.log("apply: settings 服务缺失降级");
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-nosettings-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes = [];
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: { port: 3080, register(route) { routes.push(route); return () => {}; }, tapIndex() { return () => {}; } },
      inject() {},
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19992, httpsEnabled: false });
    const configRoute = routes.find((r) => r.path === ROUTES.config);
    check("降级态：health 与 config 路由仍注册（卡片可读）", () => {
      assert.ok(routes.find((r) => r.path === ROUTES.health));
      assert.ok(configRoute);
    });
    const req = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } };
    const chunks: string[] = [];
    let status = 0;
    configRoute.handler(req as any, { writeHead: (c: number) => { status = c; }, end: (c?: any) => { if (c !== undefined) chunks.push(String(c)); }, getHeader: () => undefined, setHeader: () => {} } as any);
    check("降级态 GET：writable=false 且 effective 为组合层兜底", () => {
      const payload = JSON.parse(chunks.join(""));
      assert.equal(status, 200);
      assert.equal(payload.writable, false);
      assert.equal(payload.effective.port, 19992);
    });
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
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

  // apply：运行中经设置保存热关闭——scope.watch 必须驱动压缩生效状态翻转。
  console.log("apply: 运行中热关闭（PUT /config → scope.watch → 压缩卸载）");
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
    const { service } = makeSettings();
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject(services, fn) {
        if (services.includes("settings")) {
          fn({ settings: service, effect(fn2) { const d = fn2(); if (typeof d === "function") disposers.push(d); return d; } });
        }
      },
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { host: "127.0.0.1", port: 19995, httpsEnabled: false });
    const healthMounted = () => {
      const hRes = new FakeRes();
      ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
      return JSON.parse(Buffer.concat(hRes._chunks).toString("utf8")).httpCompressMounted;
    };
    // 前置条件用例化（qa 复核）：纳入 check() 统计且失败信息内联实际值；
    // 前置不满足时跳过本 case 余下步骤（避免连锁误报掩盖真实原因）。
    const mountedBefore = healthMounted();
    check(`${label}：前置压缩已生效`, () => {
      assert.equal(mountedBefore, true, `前置 health httpCompressMounted 应为 true，实际 ${mountedBefore}`);
    });
    if (!mountedBefore) {
      for (const d of [...disposers].reverse()) { try { d(); } catch {} }
      process.env.DSH_HOME = prevHome;
      rmSync(applyHome, { recursive: true, force: true });
      return;
    }
    // 运行中经配置路由保存（客户端同链路）：PUT → scope.update → watch 触发
    // onChange=scheduleSync（3s 防抖）→ sync 重建。轮询等待生效，不用固定 sleep
    // （防 flake 纪律）；deadline 覆盖 3s 防抖窗口。
    const putBody = JSON.stringify({ patch });
    const putStatus = await new Promise<number>((resolveRoute) => {
      let status = 0;
      const stream: any = new EventEmitter();
      Object.assign(stream, makeReq({ method: "PUT" }));
      const chunks: string[] = [];
      const res: any = {
        writeHead(code: number) { status = code; },
        end(c?: any) {
          if (c !== undefined) chunks.push(String(c));
          resolveRoute(status || 200);
        },
        getHeader() { return undefined; },
        setHeader() {},
      };
      process.nextTick(() => {
        stream.emit("data", Buffer.from(putBody));
        stream.emit("end");
      });
      void (async () => { await ws.exact.get(ROUTES.config).handler(stream, res); })();
    });
    if (expectProxyOff) {
      // 整插件关闭：listening 反映转发器实例存活，须等 watch 驱动 sync 重建才翻转。
      const deadline = Date.now() + 12000;
      const healthPayload = () => {
        const hRes = new FakeRes();
        ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
        return JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
      };
      while (healthPayload().listening && Date.now() < deadline) await sleep(100);
      check(`${label}：保存成功且 watch 热更新停掉转发器`, () => {
        assert.equal(putStatus, 200, "PUT 保存回执成功");
        const payload = healthPayload();
        assert.equal(payload.listening, false, "转发器已停（scope.watch 热更新生效）");
        assert.equal(payload.httpCompressMounted, false);
        assert.equal(ws.prefixes.get("/api").handler, apiHandler, "webServer handler 全程原样");
      });
    } else {
      // 只关压缩：生效值经 resolve() 立即可见（GET 快照不撒谎），转发器由
      // watch 防抖后按新配置重建（不影响 listening）。
      check(`${label}：保存成功且压缩生效状态随保存翻转`, () => {
        assert.equal(putStatus, 200, "PUT 保存回执成功");
        assert.equal(healthMounted(), false, "health mounted=false（生效配置即时可见）");
        const hRes = new FakeRes();
        ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
        const payload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
        assert.equal(payload.httpCompressEnabled, false);
        assert.equal(ws.prefixes.get("/api").handler, apiHandler, "webServer handler 全程原样");
      });
    }
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  };
  await hotOffCase("热关 httpCompressEnabled=false", { httpCompressEnabled: false }, false);
  await hotOffCase("热关 enabled=false（整插件）", { enabled: false }, true);

  // apply：enabled=false 启动态 → 转发器不启动，但路由与 settings 注册照常、
  // 存量 config.json 迁移先行于 enabled 判定（issue #110 P0-2：禁用用户升级
  // 同样迁移，重新启用不丢配置）。
  {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-all-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    mkdirSync(join(applyHome, "lan-proxy"), { recursive: true });
    writeFileSync(join(applyHome, "lan-proxy", "config.json"), JSON.stringify({ enabled: false, port: 19996 }));
    const { service: offService } = makeSettings();
    const ws = makeWebServer();
    const disposers = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject(services, fn) {
        if (services.includes("settings")) {
          fn({ settings: offService, effect(fn2) { return fn2(); } });
        }
      },
      effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    };
    apply(ctx, { enabled: false });
    const migratedDeadline = Date.now() + 5000;
    while (!existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME)) && Date.now() < migratedDeadline) await sleep(25);
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
    const payload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    check("enabled=false：迁移仍执行、health/config 路由注册、转发器不启动", () => {
      assert.equal(existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME)), true, "禁用态也完成存量迁移");
      assert.ok(ws.exact.has(ROUTES.health), "health 路由注册");
      assert.ok(ws.exact.has(ROUTES.config), "config 路由注册");
      assert.equal(payload.listening, false, "转发器未启动");
      assert.equal(payload.enabled, false);
    });
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }

  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）。
  {
    const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    check("client source contract（IIFE/use strict/load id/SymbolTag/factory/load once）", () => assertClientSourceContract(pkgDir));
    check("client product contract（执行断言：arrive 可解析/apply/inject）", () => assertClientProductContract(pkgDir));
    check("client shares CONFIG route with host", () => assert.ok(client.includes(ROUTES.config)));
    check("client i18n 接线 + 设置卡字段字典覆盖（issue #348）", () => {
      // i18n 哨兵：NS / register / bind / slots locale 参数 / 双语字典进产物
      assert.ok(client.includes('"settings.lanProxy"'), "i18n 命名空间 NS 进产物");
      assert.ok(client.includes("locale.register"), "locale.register（字典注册）进产物");
      assert.ok(client.includes("locale.bind"), "locale.bind（t 装配）进产物");
      assert.ok(client.includes("locale: NS"), "slots.register locale 参数进产物");
      assert.ok(client.includes("Enabled") && client.includes("enable"), "en/zh 双语字典进产物");
      // zh 字典覆盖卡片全部字段（渲染正确性由 client-shim 执行断言 + 浏览器实测保证）
      assert.ok(client.includes("LAN 端口"));
      assert.ok(client.includes("HTTPS 端口"));
      assert.ok(client.includes("证书文件"));
      assert.ok(client.includes("启动时打印访问地址"));
      assert.ok(client.includes("HTTP 响应压缩"), "HTTP 压缩开关已渲染");
      assert.ok(client.includes("压缩档位") && client.includes("高（最高压缩比：gzip 9 / br 9）"), "压缩档位下拉框已渲染");
    });
    // issue #33 子项 1：客户端 save() 前本地校验，错误指明字段与范围。
    check("client 本地校验文案指明字段与合法范围", () => {
      assert.ok(client.includes('t("portRangeFail")'), "端口范围提示（i18n key）");
      assert.ok(client.includes('t("httpsPortRangeFail")'), "HTTPS 端口范围提示（i18n key）");
      assert.ok(client.includes('t("levelRangeFail")'), "档位范围提示（i18n key）");
      assert.ok(client.includes("Number.isInteger"), "本地整数校验");
    });
    // issue #33 子项 2：effective 校准展示 + 增量 diff 提交。
    check("client 以 effective 校准展示且增量提交", () => {
      assert.ok(client.includes("effective"), "state.effective 被消费");
      assert.ok(client.includes("baseline"), "加载基线快照（diff 基准）");
      assert.ok(client.includes("sameSetting"), "增量 diff 键值比较");
      assert.ok(client.indexOf("Object.keys(payload).length === 0") >= 0, "无改动不发起保存请求");
    });
    // issue #33 子项 3：压缩状态 GUI 可见（卡片底部轻量状态行）。
    check("client 渲染压缩状态行", () => {
      assert.ok(client.includes("compressStatusLine"), "状态行文案函数");
      assert.ok(client.includes('t("compressOn"'), "已启用 + 协商计数文案（i18n key）");
      assert.ok(client.includes('t("compressOff"'), "关闭态文案（i18n key）");
      assert.ok(client.includes("lp-set-status"), "状态行样式类");
    });
    // issue #33 子项 4：可达性——label/input 经 htmlFor+id 全关联，数字输入带 inputMode。
    check("client 全部 label 经 htmlFor/id 关联且 number 输入带 inputMode", () => {
      const expectedIds = [
        "lp-set-enabled", "lp-set-port", "lp-set-https-enabled", "lp-set-https-port",
        "lp-set-cert", "lp-set-key", "lp-set-banner", "lp-set-ws-compress",
        "lp-set-ws-paths", "lp-set-http-compress", "lp-set-level", "lp-set-inject-token",
      ];
      const forIds = [...client.matchAll(/htmlFor:\s*"([^"]+)"/g)].map((m: any) => m[1]);
      assert.deepEqual([...forIds].sort(), [...expectedIds].sort(), "12 行全部 htmlFor 关联");
      for (const fid of forIds) {
        assert.ok(new RegExp(`id:\\s*"${fid}"`).test(client), `控件侧存在同名 id「${fid}」`);
      }
      const inputModeCount = [...client.matchAll(/inputMode:\s*"numeric"/g)].length;
      assert.equal(inputModeCount, 2, "port/httpsPort 两个 number 输入均带 inputMode=numeric");
    });
    // issue #380：injectToken 开关渲染 + 开启态常驻安全警示（评审要求：横幅一次性警示不足）。
    check("client 渲染 injectToken 开关与开启态警示", () => {
      assert.ok(client.includes('t("injectToken")'), "开关 label（i18n key）");
      assert.ok(client.includes('t("injectTokenOnHint")'), "开启态警示文案（i18n key）");
      assert.ok(client.includes("lp-set-warn"), "警示样式类");
      assert.ok(client.includes("injectToken: true"), "DEFAULTS 缺省开启（前向兼容：存量用户升级即生效）");
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
