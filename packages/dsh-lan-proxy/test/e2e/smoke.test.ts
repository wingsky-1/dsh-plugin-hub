// @ts-nocheck
// dsh-lan-proxy 冒烟测试 —— 无外部依赖。
//
// 起一个"假 dsh web 服务器"（回显请求要素、对 WebSocket 升级应答字节回显），
// 把代理挂在它的 HTTP / HTTPS 监听上指向它；端口一律 bind(0) 动态分配
// （#690 S2c 端口治理：写死端口在并发或残留进程下会 EADDRINUSE 假阳性），然后验证：
//   - Host/Origin 被重写为回环目标（围栏要求）
//   - 无 Origin 的非浏览器请求也能通过
//   - DNS 域名 Host 头被拒绝（重绑定防护）
//   - 缺失 Host 被拒绝
//   - WebSocket 升级可穿透且 Host/Origin 被重写
//   - HTTPS 监听（自签证书）与 HTTP 并存：https 请求 / wss 升级 / 重绑定防护
//   - 自签证书生成幂等、有效期检查、SAN 编码
//
// 迁移说明（#722 阶段 1）：原文件用手写 `check(name, fn)` 收集器 + failures 数组 +
// process.exitCode 自建 runner，本文件迁为 vitest 结构化用例——原每条 assert 一个 it，
// 原 check 名成为其 describe/it 名。加载方式保持原样：仍直连 lib/ 产物、仍真实监听
// 端口（bind(0) 动态分配，未引入固定端口）。
//
// 交错动作纪律：原文件多处是「动作 → 断言 → 新动作 → 新断言」的交错序列（含临时目录、
// 真实端口、计数器），故统一以 beforeAll 逐行保留原动作顺序、并在**每个原断言位置**取
// 观测快照；每个 it 只对快照断言——不会出现「断言看到块尾状态」的语义漂移。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { apply, sanitizeSettings, validateSettings, ROUTES,
  migrateFileConfig, MIGRATED_BAK_NAME, SETTINGS_NS, buildConfigRoutes, applyConfigPatch,
  hostnameAllowed, formatAuthority, rewriteHeaders, createLanProxy,
  compressWsPath, DEFAULT_WSS_COMPRESS_PATHS, normalizeLegacyWsCompressPaths,
  ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT,
  isCompressible, resolveCompressionOptions } from "../../lib/index.js";
import { assertClientProductContract, assertClientSourceContract } from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

// 端口一律 bind(0) 之后回填（#690 S2c / #713 T5）：写死端口在并发运行或残留进程下会
// EADDRINUSE 假阳性；helpers 与断言按名引用，回填后语义不变。
let UPSTREAM_PORT = 0;
let PROXY_PORT = 0;
let PROXY_HTTPS_PORT = 0;
const LAN_HOST = "192.168.1.50";
let certDir;
let tls;
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

// proxy 在 beforeAll 里创建：targetPort 必须等 upstream 绑定到具体端口后才确定。
let proxy;

// ── helpers ─────────────────────────────────────────────────────────────────
/**
 * 取一个当前空闲的端口（bind(0) 后立即释放）。
 * 为什么需要：个别用例要断言「生效端口等于启动时传入的端口」，需要一个**确定且不写死**的值；
 * 直接传 0 会让断言退化成「0 == 0」，失去验证意义。
 */
async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const chosen = probe.address().port;
  await new Promise((r) => probe.close(r));
  return chosen;
}

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

// ============================ 真实转发（HTTP / HTTPS / WS） ============================
// 这一段对应原 main() 从起服务到 `proxy.close()` 的区间：所有用例都依赖真实端口，
// 故 proxy / upstream 的生命周期由本 describe 的 beforeAll / afterAll 持有。

describe("e2e: 真实转发（HTTP / HTTPS / WebSocket，端口 bind(0) 动态分配）", () => {
  let httpsListening;

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-test-"));
    tls = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    UPSTREAM_PORT = upstream.address().port;
    proxy = createLanProxy({
      host: "127.0.0.1",
      port: 0,
      httpsPort: 0,
      tls,
      targetHost: "127.0.0.1",
      targetPort: UPSTREAM_PORT,
    });
    const listening = await proxy.listen();
    PROXY_PORT = listening.httpPort;
    httpsListening = listening.httpsPort !== undefined;
    PROXY_HTTPS_PORT = listening.httpsPort;
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
    rmSync(certDir, { recursive: true, force: true });
  });

  it("HTTPS 应成功监听（端口动态分配）", () => {
    expect(httpsListening).toBe(true);
  });

  describe("unit: hostnameAllowed / formatAuthority", () => {
    it("accepts IPv4 literal", () => {
      expect(hostnameAllowed(`${LAN_HOST}:${PROXY_PORT}`)).toBe(true);
    });

    it("accepts bare IPv4 literal", () => {
      expect(hostnameAllowed(LAN_HOST)).toBe(true);
    });

    it("accepts IPv6 literal", () => {
      expect(hostnameAllowed("[fe80::1]:3081")).toBe(true);
    });

    it("accepts localhost", () => {
      expect(hostnameAllowed("localhost:3081")).toBe(true);
    });

    it("rejects DNS name", () => {
      expect(hostnameAllowed("evil.com:3081")).toBe(false);
    });

    it("rejects missing host", () => {
      expect(hostnameAllowed(undefined)).toBe(false);
    });

    it("rejects malformed authority", () => {
      expect(hostnameAllowed("http://evil.com:3081")).toBe(false);
    });

    it("formats IPv6 authority", () => {
      expect(formatAuthority("::1", 3080)).toBe("[::1]:3080");
    });
  });

  describe("unit: rewriteHeaders", () => {
    describe("Host replaced by target authority", () => {
      it("host 替换为目标 authority", () => {
        const out = rewriteHeaders({ host: "192.168.1.50:3081", "user-agent": "x" }, "127.0.0.1:3080");
        expect(out.host).toBe("127.0.0.1:3080");
      });

      it("其余头原样保留", () => {
        const out = rewriteHeaders({ host: "192.168.1.50:3081", "user-agent": "x" }, "127.0.0.1:3080");
        expect(out["user-agent"]).toBe("x");
      });
    });

    it("Origin rewritten to loopback authority", () => {
      const out = rewriteHeaders({ host: "192.168.1.50:3081", origin: "http://192.168.1.50:3081" }, "127.0.0.1:3080");
      expect(out.origin).toBe("http://127.0.0.1:3080");
    });

    it("absent Origin stays absent", () => {
      const out = rewriteHeaders({ host: "192.168.1.50:3081" }, "127.0.0.1:3080");
      expect(out.origin).toBe(undefined);
    });

    describe("input headers not mutated", () => {
      it("入参 host 不被就地修改", () => {
        const input = { host: "192.168.1.50:3081", origin: "http://192.168.1.50:3081" };
        rewriteHeaders(input, "127.0.0.1:3080");
        expect(input.host).toBe("192.168.1.50:3081");
      });

      it("入参 origin 不被就地修改", () => {
        const input = { host: "192.168.1.50:3081", origin: "http://192.168.1.50:3081" };
        rewriteHeaders(input, "127.0.0.1:3080");
        expect(input.origin).toBe("http://192.168.1.50:3081");
      });
    });
  });

  describe("http: browser-style request (Host + Origin, same-origin)", () => {
    let browser;
    let facts;

    beforeAll(async () => {
      browser = await getViaProxy({
        host: `${LAN_HOST}:${PROXY_PORT}`,
        origin: `http://${LAN_HOST}:${PROXY_PORT}`,
        "sec-fetch-site": "same-origin",
      });
      facts = JSON.parse(browser.body);
    });

    it("proxied 200", () => {
      expect(browser.status).toBe(200);
    });

    it("Host rewritten to loopback target", () => {
      expect(facts.host).toBe(`127.0.0.1:${UPSTREAM_PORT}`);
    });

    it("Origin rewritten to loopback target", () => {
      expect(facts.origin).toBe(`http://127.0.0.1:${UPSTREAM_PORT}`);
    });

    it("sec-fetch-site passed through", () => {
      expect(facts.secFetchSite).toBe("same-origin");
    });

    it("path forwarded", () => {
      expect(facts.url).toBe("/hello");
    });
  });

  describe("http: non-browser LAN client (no Origin)", () => {
    let plain;
    let plainFacts;

    beforeAll(async () => {
      plain = await getViaProxy({ host: `${LAN_HOST}:${PROXY_PORT}` });
      plainFacts = JSON.parse(plain.body);
    });

    it("proxied 200", () => {
      expect(plain.status).toBe(200);
    });

    describe("Host rewritten, Origin stays absent", () => {
      it("Host 重写为回环目标", () => {
        expect(plainFacts.host).toBe(`127.0.0.1:${UPSTREAM_PORT}`);
      });

      it("Origin 保持缺席（null）", () => {
        expect(plainFacts.origin).toBe(null);
      });
    });
  });

  describe("http: rebinding guard", () => {
    let evil;
    let h11;
    let h10;

    beforeAll(async () => {
      evil = await getViaProxy({ host: "evil.com:3081" });
      // HTTP/1.1 无 Host：Node 解析层直接拒绝（请求到不了代理 handler）
      h11 = await rawRequest("GET /nohost HTTP/1.1\r\nConnection: close\r\n\r\n");
      // HTTP/1.0 无 Host：合法到达代理 handler，触发我们自己的 403 守卫
      h10 = await rawRequest("GET /nohost HTTP/1.0\r\n\r\n");
    });

    it("DNS-name Host refused with 403", () => {
      expect(evil.status).toBe(403);
    });

    it("HTTP/1.1 missing Host refused (Node 400)", () => {
      expect(h11.statusLine.startsWith("HTTP/1.1 400")).toBeTruthy();
    });

    it("HTTP/1.0 missing Host refused with 403", () => {
      expect(h10.statusLine.startsWith("HTTP/1.1 403")).toBeTruthy();
    });
  });

  describe("unit: cert module", () => {
    it("SAN entry: IPv4 literal", () => {
      expect(toSanEntry("192.168.1.5")).toEqual({ type: 7, ip: "192.168.1.5" });
    });

    it("SAN entry: IPv6 literal", () => {
      expect(toSanEntry("::1")).toEqual({ type: 7, ip: "::1" });
    });

    it("SAN entry: hostname", () => {
      expect(toSanEntry("myhost.lan")).toEqual({ type: 2, value: "myhost.lan" });
    });

    it("SAN entry: localhost", () => {
      expect(toSanEntry("localhost")).toEqual({ type: 2, value: "localhost" });
    });

    describe("self-signed files written", () => {
      it("证书文件已写入", () => {
        expect(existsSync(join(certDir, SELF_SIGNED_CERT))).toBeTruthy();
      });

      it("私钥文件已写入", () => {
        expect(existsSync(join(certDir, SELF_SIGNED_KEY))).toBeTruthy();
      });
    });

    it("self-signed cert parses and is valid", () => {
      expect(certStillValid(join(certDir, SELF_SIGNED_CERT))).toBe(true);
    });

    describe("certStillValid rejects unparseable cert", () => {
      let bad;

      beforeAll(() => {
        bad = join(mkdtempSync(join(tmpdir(), "dsh-lan-proxy-badcert-")), "bad.pem");
        writeFileSync(bad, "not a pem");
      });

      it("内容不是 PEM → false", () => {
        expect(certStillValid(bad)).toBe(false);
      });

      it("路径不存在 → false", () => {
        expect(certStillValid("/nonexistent/cert.pem")).toBe(false);
      });
    });

    it("self-signed idempotent reuse (same materials)", () => {
      const again = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
      expect(again.cert.toString()).toBe(tls.cert.toString());
    });

    it("loadTlsFromFiles reads provided PEMs", () => {
      const loaded = loadTlsFromFiles(join(certDir, SELF_SIGNED_CERT), join(certDir, SELF_SIGNED_KEY));
      expect(loaded.cert.toString()).toBe(tls.cert.toString());
    });

    it("loadTlsFromFiles rejects missing file", () => {
      expect(() => loadTlsFromFiles("/nonexistent/cert.pem", "/nonexistent/key.pem")).toThrow();
    });
  });

  describe("unit: migrateFileConfig（存量 config.json 一次性迁移，rename-first marker）", () => {
    /** fake owner scope：update 增量 merge 进内存 user 层（官方存储文档的 fake 形态）。 */
    const makeScope = () => {
      const state = { user: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[] };
      return {
        state,
        async update(patch: Record<string, unknown>) { state.updates.push(patch); Object.assign(state.user, patch); },
      };
    };

    describe("迁移主链：有效配置 + 幂等跳过", () => {
      let cfgDir;
      let firstOutcome;
      let configExistsAfterFirst;
      let bakExistsAfterFirst;
      let bakRaw;
      let userAfterFirst;
      let secondOutcome;
      let secondUpdatesLength;

      beforeAll(async () => {
        cfgDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-"));
        // 有效配置：改名 + 过滤未知键 + 增量写入官方存储。
        writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ port: 4081, printBanner: false, unknownKey: "dropped", httpCompressLevel: 6 }));
        const scope1 = makeScope();
        firstOutcome = await migrateFileConfig(cfgDir, scope1);
        configExistsAfterFirst = existsSync(join(cfgDir, "config.json"));
        bakExistsAfterFirst = existsSync(join(cfgDir, MIGRATED_BAK_NAME));
        bakRaw = JSON.parse(readFileSync(join(cfgDir, MIGRATED_BAK_NAME), "utf8"));
        userAfterFirst = { ...scope1.state.user };

        // 幂等：config.json 与 .bak 都不存在（用户已清理备份的稳态）→ 跳过，不写。
        // 注：正常迁移成功后 .bak 保留，二次启动会命中中断态重放（同值 merge 无害，
        // 见下方用例）；真正「跳过」的稳态是备份被清理之后。
        rmSync(join(cfgDir, MIGRATED_BAK_NAME));
        const scope2 = makeScope();
        secondOutcome = await migrateFileConfig(cfgDir, scope2);
        secondUpdatesLength = scope2.state.updates.length;
        rmSync(cfgDir, { recursive: true, force: true });
      });

      describe("迁移：原子改名为 .bak 且增量写入有效键（旧档位 6→3、未知键丢弃）", () => {
        it("performed 且 migrated 为 true", () => {
          expect(firstOutcome.performed && firstOutcome.migrated).toBe(true);
        });

        it("config.json 已改名消失", () => {
          expect(configExistsAfterFirst).toBe(false);
        });

        it(".bak 备份存在", () => {
          expect(bakExistsAfterFirst).toBe(true);
        });

        it("bak 保留原始内容供用户回滚", () => {
          expect(bakRaw.port).toBe(4081);
        });

        it("写入官方存储的用户层（旧档位 6→3、未知键丢弃）", () => {
          expect(userAfterFirst).toEqual({ port: 4081, printBanner: false, httpCompressLevel: 3 });
        });
      });

      describe("迁移幂等：config.json 与备份都不存在 → 跳过且不写", () => {
        it("outcome 全 false", () => {
          expect(secondOutcome).toEqual({ performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: false });
        });

        it("未产生第二次写入", () => {
          expect(secondUpdatesLength).toBe(0);
        });
      });
    });

    describe("中断重放（bak 重放 / 二次重放 / 坏 bak）", () => {
      let resumeDir;
      let resumeScope;
      let resumeOutcome;
      let resumeWarns;
      let resumeBakExists;
      let againOutcome;
      let againUpdates;
      let badResume;
      let badResumeWarns;

      beforeAll(async () => {
        // 中断态重放：.bak 存在且 config.json 不存在（改名成功后写入完成前进程被杀）
        // → 视为未完成迁移，从 bak 重放「解析→sanitize→update」，配置不再永滞 bak。
        // （正常迁移成功后 bak 保留，因此二次启动也会命中重放——同值 merge 无害。）
        resumeDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-"));
        writeFileSync(join(resumeDir, MIGRATED_BAK_NAME), JSON.stringify({ port: 4077, printBanner: false }));
        resumeWarns = [];
        resumeScope = makeScope();
        resumeOutcome = await migrateFileConfig(resumeDir, resumeScope, { warn: (m) => resumeWarns.push(String(m)) });
        resumeBakExists = existsSync(join(resumeDir, MIGRATED_BAK_NAME));

        // 二次启动（bak 未清理）→ 再次重放同值，无副作用、不抛错。
        againOutcome = await migrateFileConfig(resumeDir, resumeScope);
        againUpdates = [...resumeScope.state.updates];

        // 重放遇损坏 bak：warn 手动恢复路径，不抛错。
        const badBak = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-bad-"));
        writeFileSync(join(badBak, MIGRATED_BAK_NAME), "{not json");
        badResumeWarns = [];
        badResume = await migrateFileConfig(badBak, makeScope(), { warn: (m) => badResumeWarns.push(String(m)) });
        rmSync(resumeDir, { recursive: true, force: true });
        rmSync(badBak, { recursive: true, force: true });
      });

      describe("中断重放：.bak 存在且 config.json 不存在 → 从 bak 重写官方存储且保留备份", () => {
        it("resumed 且 migrated 为 true", () => {
          expect(resumeOutcome.resumed && resumeOutcome.migrated).toBe(true);
        });

        it("滞留 .bak 的配置已重放进官方存储", () => {
          expect(resumeScope.state.user.port).toBe(4077);
        });

        it("重放成功后保留 bak", () => {
          expect(resumeBakExists).toBe(true);
        });

        it("warn 明示恢复路径", () => {
          expect(resumeWarns.some((m) => m.includes("重放写入设置"))).toBeTruthy();
        });
      });

      describe("中断重放幂等：二次启动重放同值无害", () => {
        it("resumed 且 migrated 为 true（第二次）", () => {
          expect(againOutcome.resumed && againOutcome.migrated).toBe(true);
        });

        it("user 层端口仍为 4077", () => {
          expect(resumeScope.state.user.port).toBe(4077);
        });

        it("两次重放内容一致", () => {
          expect(againUpdates[0]).toEqual(againUpdates[1]);
        });
      });

      describe("中断重放：bak 损坏时 warn 手动恢复路径且不写入", () => {
        it("resumed 为 true", () => {
          expect(badResume.resumed).toBe(true);
        });

        it("migrated 为 false", () => {
          expect(badResume.migrated).toBe(false);
        });

        it("warn 含手动恢复指引", () => {
          expect(badResumeWarns.some((m) => m.includes("无法自动恢复"))).toBeTruthy();
        });
      });
    });

    describe("迁移：损坏 / 非 object / 全非法值 JSON 只标记不写（3 种载荷）", () => {
      const badPayloads = [
        { label: "损坏 json 只标记不写", raw: "{broken json" },
        { label: "数组 json 只标记不写", raw: JSON.stringify(["array"]) },
        { label: "含类型非法值只标记不写", raw: JSON.stringify({ port: "not-a-number" }) },
      ];
      let records = [];

      beforeAll(async () => {
        records = [];
        for (const { raw } of badPayloads) {
          const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-bad-"));
          writeFileSync(join(dir, "config.json"), raw);
          const scope = makeScope();
          const bad = await migrateFileConfig(dir, scope);
          // bak 标记必须在 rmSync 之前观测（目录随即被回收）
          records.push({ bad, bakExists: existsSync(join(dir, MIGRATED_BAK_NAME)), updatesLength: scope.state.updates.length });
          rmSync(dir, { recursive: true, force: true });
        }
      });

      // 原脚本把 check 写在标签循环内，故按标签展开为逐条可见用例。
      const titled = (suffix) => badPayloads.map((c, i) => ({ title: `${c.label}（.bak 存在、scope 未被调用）：${suffix}`, i }));

      it.each(titled("skippedCorrupt"))("$title", ({ i }) => {
        expect(records[i].bad.skippedCorrupt).toBe(true);
      });

      it.each(titled("migrated=false"))("$title", ({ i }) => {
        expect(records[i].bad.migrated).toBe(false);
      });

      it.each(titled("仅改名标记"))("$title", ({ i }) => {
        expect(records[i].bakExists).toBe(true);
      });

      it.each(titled("不写入 scope"))("$title", ({ i }) => {
        expect(records[i].updatesLength).toBe(0);
      });
    });

    describe("迁移：写入失败回滚 rename（config.json 还原、下次启动重试）", () => {
      let rollbackOutcome;
      let configRestored;
      let failingUpdatesLength;

      beforeAll(async () => {
        const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-rollback-"));
        writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 4099 }));
        const failing = { updates: [] as unknown[], async update() { throw new Error("disk full"); } };
        rollbackOutcome = await migrateFileConfig(dir, failing as any);
        configRestored = existsSync(join(dir, "config.json"));
        failingUpdatesLength = failing.updates.length;
        rmSync(dir, { recursive: true, force: true });
      });

      it("rolledBack 为 true", () => {
        expect(rollbackOutcome.rolledBack).toBe(true);
      });

      it("config.json 已还原", () => {
        expect(configRestored).toBe(true);
      });

      it("失败时未写入 scope", () => {
        expect(failingUpdatesLength).toBe(0);
      });
    });

    describe("迁移：ws 压缩白名单归一化（#395 M2）", () => {
      let m2;
      let m2User;
      let m2Custom;
      let m2CustomUser;

      beforeAll(async () => {
        // M2（#395）：迁移含旧默认白名单的 config.json → 写入归一化后的新值；
        // 自定义白名单（含废弃端点的组合）迁移后原样保留。
        const m2Dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2-"));
        writeFileSync(join(m2Dir, "config.json"), JSON.stringify({ wsCompressPaths: ["/api/events.host", "/api/events.mux"] }));
        const m2Scope = makeScope();
        m2 = await migrateFileConfig(m2Dir, m2Scope);
        m2User = { ...m2Scope.state.user };
        rmSync(m2Dir, { recursive: true, force: true });

        const m2CustomDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2c-"));
        writeFileSync(join(m2CustomDir, "config.json"), JSON.stringify({ wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] }));
        const m2CustomScope = makeScope();
        m2Custom = await migrateFileConfig(m2CustomDir, m2CustomScope);
        m2CustomUser = { ...m2CustomScope.state.user };
        rmSync(m2CustomDir, { recursive: true, force: true });
      });

      describe("迁移：含旧默认白名单的 config.json 写入归一化后的 remote.mux", () => {
        it("migrated 为 true", () => {
          expect(m2.migrated).toBe(true);
        });

        it("写入官方存储的用户层为 remote.mux", () => {
          expect(m2User).toEqual({ wsCompressPaths: ["/api/remote.mux"] });
        });
      });

      describe("迁移：自定义白名单（含废弃端点组合）原样保留不改写", () => {
        it("migrated 为 true", () => {
          expect(m2Custom.migrated).toBe(true);
        });

        it("写入官方存储的用户层原样保留", () => {
          expect(m2CustomUser).toEqual({ wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] });
        });
      });
    });
  });

  describe("websocket: upgrade forwarding", () => {
    let ws;

    beforeAll(async () => {
      ws = await upgradeViaProxy();
    });

    it("101 Switching Protocols", () => {
      expect(ws.status).toBe(101);
    });

    it("echoed payload", () => {
      expect(ws.echoed).toBe("ping-from-lan-client");
    });
  });

  describe("https: browser-style request (Host + Origin, same-origin)", () => {
    let secure;
    let secureFacts;

    beforeAll(async () => {
      secure = await getViaHttpsProxy({
        host: `${LAN_HOST}:${PROXY_HTTPS_PORT}`,
        origin: `https://${LAN_HOST}:${PROXY_HTTPS_PORT}`,
        "sec-fetch-site": "same-origin",
      });
      secureFacts = JSON.parse(secure.body);
    });

    it("proxied 200", () => {
      expect(secure.status).toBe(200);
    });

    it("Host rewritten to loopback target", () => {
      expect(secureFacts.host).toBe(`127.0.0.1:${UPSTREAM_PORT}`);
    });

    it("Origin rewritten to loopback http target", () => {
      expect(secureFacts.origin).toBe(`http://127.0.0.1:${UPSTREAM_PORT}`);
    });

    it("sec-fetch-site passed through", () => {
      expect(secureFacts.secFetchSite).toBe("same-origin");
    });

    it("path forwarded", () => {
      expect(secureFacts.url).toBe("/hello");
    });
  });

  describe("https: rebinding guard", () => {
    let secureEvil;

    beforeAll(async () => {
      secureEvil = await getViaHttpsProxy({ host: "evil.com:3443" });
    });

    it("DNS-name Host refused with 403", () => {
      expect(secureEvil.status).toBe(403);
    });
  });

  describe("wss: upgrade forwarding", () => {
    let wss;

    beforeAll(async () => {
      wss = await upgradeViaHttpsProxy();
    });

    it("101 Switching Protocols", () => {
      expect(wss.status).toBe(101);
    });

    it("echoed payload", () => {
      expect(wss.echoed).toBe("ping-over-wss-0123456789");
    });
  });

  describe("regression: 客户端中途断开不悬挂上游连接（keep-alive 池泄漏）", () => {
    let afterAbort;
    let afterAbortTls;

    beforeAll(async () => {
      // 上游 /hang 永不响应；客户端连上 30ms 后即断开（模拟关标签页/断网）。
      // 70 次超过上游池上限（64），修复前悬挂请求占满池 → 后续请求排队挂死；
      // 修复后每次断开都会销毁上游请求，池始终有可用槽位。
      const hangAndAbort = (port) => new Promise((resolve) => {
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
      for (let i = 0; i < 70; i += 1) await hangAndAbort(PROXY_PORT);
      await sleep(300); // 等销毁传播到上游
      afterAbort = await Promise.race([
        getViaProxy({ host: `${LAN_HOST}:${PROXY_PORT}` }),
        sleep(3000).then(() => ({ status: 0, body: "timeout" })),
      ]);
      afterAbortTls = await Promise.race([
        getViaHttpsProxy({ host: `${LAN_HOST}:${PROXY_HTTPS_PORT}` }),
        sleep(3000).then(() => ({ status: 0, body: "timeout" })),
      ]);
    }, 120_000);

    it("http pool not leaked after 70 aborted clients", () => {
      expect(afterAbort.status).toBe(200);
    });

    it("https pool not leaked after 70 aborted clients", () => {
      expect(afterAbortTls.status).toBe(200);
    });
  });
});

// ============================ apply / health / RPC / client 契约 ============================
// 以下各段不依赖真实转发端口，沿用原文件顺序（原 main() 在关闭 proxy 之后的区间）。

describe("unit: sanitizeSettings", () => {
  it("keeps valid keys, drops empty cert paths", () => {
    const out = sanitizeSettings({ enabled: false, port: 4099, tlsCertFile: "", tlsKeyFile: "", printBanner: true, unknownKey: 1 });
    expect(out).toEqual({ enabled: false, port: 4099, printBanner: true });
  });

  it("rejects type-invalid value wholesale", () => {
    expect(sanitizeSettings({ port: "abc" })).toBe(null);
  });

  it("rejects non-object payload", () => {
    expect(sanitizeSettings("nope")).toBe(null);
  });

  it("rejects null payload", () => {
    expect(sanitizeSettings(null)).toBe(null);
  });

  it("rejects out-of-range port", () => {
    expect(sanitizeSettings({ port: 70000 })).toBe(null);
  });
});

// issue #33 子项 1：校验失败指明首个非法字段与合法范围。
describe("unit: validateSettings（非法值定位到字段与范围）", () => {
  describe("validateSettings 定位首个非法键并给出范围提示", () => {
    let bad;

    beforeAll(() => {
      bad = validateSettings({ enabled: "yes", port: "abc" });
    });

    it("非法配置返回非 null", () => {
      expect(bad !== null).toBeTruthy();
    });

    it("按 FILE_CONFIG_VALIDATORS 键序取首个非法键", () => {
      expect(bad.key).toBe("enabled");
    });

    it("hint 指明类型要求", () => {
      expect(bad.hint.includes("布尔")).toBeTruthy();
    });
  });

  // 原脚本把校验写在取值循环内，故按取值展开为逐条可见用例。
  describe("validateSettings 端口越界提示 1-65535", () => {
    const portValues = [0, 70000, 1.5, "4099"];
    const titled = (suffix) => portValues.map((v) => ({ title: `port=${String(v)} ${suffix}`, v }));

    it.each(titled("应非法"))("$title", ({ v }) => {
      expect(validateSettings({ port: v }) !== null).toBeTruthy();
    });

    it.each(titled("定位 key=port"))("$title", ({ v }) => {
      expect(validateSettings({ port: v }).key).toBe("port");
    });

    it.each(titled("hint 含合法范围"))("$title", ({ v }) => {
      expect(validateSettings({ port: v }).hint.includes("1-65535")).toBeTruthy();
    });
  });

  describe("validateSettings 档位越界提示 0-3；旧档位 4..9 迁移后合法；全合法返回 null", () => {
    let bad;

    beforeAll(() => {
      bad = validateSettings({ httpCompressLevel: 10 });
    });

    it("非法档位返回非 null", () => {
      expect(bad !== null).toBeTruthy();
    });

    it("定位 key=httpCompressLevel", () => {
      expect(bad.key).toBe("httpCompressLevel");
    });

    it("hint 含档位范围", () => {
      expect(bad.hint.includes("0-3")).toBeTruthy();
    });

    it("旧档位 4..9 迁移为高档后合法", () => {
      expect(validateSettings({ httpCompressLevel: 6 })).toBe(null);
    });

    it("全合法配置返回 null", () => {
      expect(validateSettings({ enabled: false, port: 4099, httpsPort: 3443, printBanner: true, wsCompressPaths: ["/x"], httpCompressEnabled: true, httpCompressLevel: 2 })).toBe(null);
    });
  });

  it("validateSettings 非对象 payload 指明需配置对象", () => {
    const bad = validateSettings("nope");
    expect(bad !== null && bad.key === "(payload)").toBeTruthy();
  });
});

describe("unit: WebSocket 压缩桥接配置", () => {
  // 默认白名单为 api-gateway 的 Remote 流 mux 端点（dsh 0.1.2 起取代 events.mux/events.host）。
  it("默认压缩白名单为 remote.mux", () => {
    expect(DEFAULT_WSS_COMPRESS_PATHS).toEqual(["/api/remote.mux"]);
  });

  // compressWsPath：命中 / 未命中 / 查询串忽略 / 传入 undefined 拒绝。
  it("compressWsPath 命中默认 path 忽略查询串", () => {
    expect(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/remote.mux?x=1")).toBe(true);
  });

  describe("compressWsPath 命中非默认 path", () => {
    it("命中旧默认 events.host", () => {
      expect(compressWsPath(["/api/events.mux", "/api/events.host"], "/api/events.host")).toBe(true);
    });

    it("命中自定义 path", () => {
      expect(compressWsPath(["/custom/ws"], "/custom/ws")).toBe(true);
    });
  });

  describe("compressWsPath 未命中 / 空列表 / undefined", () => {
    it("未命中", () => {
      expect(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, "/api/other")).toBe(false);
    });

    it("空列表", () => {
      expect(compressWsPath([], "/api/remote.mux")).toBe(false);
    });

    it("undefined 列表", () => {
      expect(compressWsPath(undefined, "/api/remote.mux")).toBe(false);
    });

    it("undefined url", () => {
      expect(compressWsPath(DEFAULT_WSS_COMPRESS_PATHS, undefined)).toBe(false);
    });
  });

  // sanitize：接受 wsCompressEnabled / wsCompressPaths（字符串数组），非法整体拒绝。
  it("sanitize 接受 ws 压缩配置", () => {
    const out = sanitizeSettings({ wsCompressEnabled: false, wsCompressPaths: ["/api/remote.mux"] });
    expect(out).toEqual({ wsCompressEnabled: false, wsCompressPaths: ["/api/remote.mux"] });
  });

  // issue #552 解耦：wsBridgeEnabled（桥接总开关）为新配置键——sanitize 接受布尔，
  // 非法拒绝；与 wsCompressEnabled 正交独立保存。
  describe("sanitize 接受 wsBridgeEnabled 布尔", () => {
    it("false 保留", () => {
      expect(sanitizeSettings({ wsBridgeEnabled: false })).toEqual({ wsBridgeEnabled: false });
    });

    it("true 保留", () => {
      expect(sanitizeSettings({ wsBridgeEnabled: true })).toEqual({ wsBridgeEnabled: true });
    });
  });

  it("sanitize 拒绝非布尔 wsBridgeEnabled", () => {
    expect(sanitizeSettings({ wsBridgeEnabled: "yes" })).toBe(null);
  });

  it("validateSettings 接受 wsBridgeEnabled", () => {
    expect(validateSettings({ wsBridgeEnabled: false, wsCompressPaths: ["/x"] })).toBe(null);
  });

  it("sanitize 拒绝非字符串数组 paths", () => {
    expect(sanitizeSettings({ wsCompressPaths: [1, 2] })).toBe(null);
  });

  // normalizeLegacyWsCompressPaths（#395 M2）：旧默认乱序等价归一化，自定义不动。
  describe("normalizeLegacyWsCompressPaths 旧默认无序等价归一化到 remote.mux", () => {
    it("正序旧默认", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual(["/api/remote.mux"]);
    });

    it("顺序不同也等价", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.host", "/api/events.mux"])).toEqual(["/api/remote.mux"]);
    });

    it("与默认常量同源", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([...DEFAULT_WSS_COMPRESS_PATHS]);
    });
  });

  describe("normalizeLegacyWsCompressPaths 自定义/undefined/空数组原样", () => {
    it("自定义白名单原样", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/custom/ws"])).toEqual(["/api/custom/ws"]);
    });

    it("含废弃端点的自定义组合不改写", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/custom/ws"])).toEqual(["/api/events.mux", "/api/custom/ws"]);
    });

    it("undefined 原样", () => {
      expect(normalizeLegacyWsCompressPaths(undefined)).toBe(undefined);
    });

    it("空数组原样", () => {
      expect(normalizeLegacyWsCompressPaths([])).toEqual([]);
    });

    it("重复元素非等价", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.mux"])).toEqual(["/api/events.mux", "/api/events.mux"]);
    });
  });
});

// ── HTTP 响应压缩（转发层 compression 中间件）：纯函数 ────────────────────
describe("unit: HTTP 压缩纯函数（isCompressible / normalizeLevel）", () => {
  describe("isCompressible json/+json/text/SSE 豁免/zip 豁免", () => {
    it("application/json", () => {
      expect(isCompressible("application/json")).toBe(true);
    });

    it("application/json; charset=utf-8", () => {
      expect(isCompressible("application/json; charset=utf-8")).toBe(true);
    });

    it("application/vnd.test+json", () => {
      expect(isCompressible("application/vnd.test+json")).toBe(true);
    });

    it("text/html", () => {
      expect(isCompressible("text/html")).toBe(true);
    });

    it("SSE 豁免", () => {
      expect(isCompressible("text/event-stream")).toBe(false);
    });

    it("zip 豁免", () => {
      expect(isCompressible("application/zip")).toBe(false);
    });

    it("undefined 不压", () => {
      expect(isCompressible(undefined)).toBe(false);
    });
  });

  describe("resolveCompressionOptions：四档位对 gzip 与 Brotli 双生效 / 非法按默认", () => {
    const Q = zlibConstants.BROTLI_PARAM_QUALITY;
    // 0/缺省/非法 → 空选项（库默认：gzip Z_DEFAULT_COMPRESSION=6 / br 质量 4）
    const invalidPresets = [undefined, "x", NaN, 0, -3, 4.5, 99];

    it.each(invalidPresets.map((v) => ({ title: `preset=${String(v)} 按默认`, v })))("$title", ({ v }) => {
      expect(resolveCompressionOptions(v)).toEqual({});
    });

    it("1 低档 gzip level=1", () => {
      expect(resolveCompressionOptions(1).level).toBe(1);
    });

    it("1 低档 brotli 质量落 0..3", () => {
      const low = resolveCompressionOptions(1);
      expect(Number(low.brotli.params[Q]) >= 0 && Number(low.brotli.params[Q]) <= 3).toBeTruthy();
    });

    it("2 中档 gzip level=5", () => {
      expect(resolveCompressionOptions(2).level).toBe(5);
    });

    it("2 中档 brotli 质量 5", () => {
      expect(resolveCompressionOptions(2).brotli.params[Q]).toBe(5);
    });

    it("3 高档 gzip level=9", () => {
      expect(resolveCompressionOptions(3).level).toBe(9);
    });

    it("3 高档 brotli 质量 9", () => {
      expect(resolveCompressionOptions(3).brotli.params[Q]).toBe(9);
    });
  });
});

// ── 转发层 HTTP 压缩：真实 upstream × 真实 createLanProxy ─────────────────
// 原脚本把「正常完整请求 200」写在准备循环内，故按轮次展开为逐条可见用例；
// 案例表须在使用它的 describe 之前建立（it.each 表在收集期即求值）。
const normalRequestRounds = [0, 1, 2, 3, 4].map((round) => ({ round }));

describe("integration: 转发层 HTTP 压缩（compression 中间件）", () => {
  const bigBody = JSON.stringify({ data: "y".repeat(300_000) });
  let rBig;
  let rBigPlain;
  let rRange;
  let rSse;
  let rPregzip;
  let statsOn;
  let statsBefore403;
  let statsAfter403;
  let cut;
  let upstreamDestroyedDelta;
  let sseHoldActive;
  let sseHoldClosed;
  let normalRequestStatuses;
  let upstreamDestroyedAfterNormal;
  let rOff;

  beforeAll(async () => {
    // issue #528 反向回归：跟踪「上游长连接被销毁」次数（客户端断开后上游 close）。
    let upstreamSseHoldClosed = 0;
    let upstreamSseHoldActive = 0;
    const upstreamCompress = createServer((req, res) => {
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
      } else if (p === "/sse-hold") {
        // issue #528：模拟 SSE/长响应——发头 + 首帧后保持连接不 end；客户端断开时
        // 若代理不销毁上游，本路由 res 的 close 永不触发（残留）→ 计数不增。
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: x\n\n");
        upstreamSseHoldActive += 1;
        res.on("close", () => { upstreamSseHoldActive -= 1; upstreamSseHoldClosed += 1; });
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
    await new Promise((r) => upstreamCompress.listen(0, "127.0.0.1", r));
    const upPort = upstreamCompress.address().port;

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
      { host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort, httpCompress: { enabled: true, level: 1 } },
      console,
    );
    const { httpPort: pxPort } = await proxyOn.listen();

    rBig = await requestThrough(pxPort, "/big", { "accept-encoding": "gzip" });
    rBigPlain = await requestThrough(pxPort, "/big", {});
    rRange = await requestThrough(pxPort, "/range", { "accept-encoding": "gzip" });
    rSse = await requestThrough(pxPort, "/sse", { "accept-encoding": "gzip" });
    rPregzip = await requestThrough(pxPort, "/pregzip", { "accept-encoding": "gzip" });
    statsOn = proxyOn.httpCompressStats();

    // 计数防污染：本地生成的 403 围栏响应不得进入协商计数。
    statsBefore403 = proxyOn.httpCompressStats();
    await new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: pxPort, path: "/big", headers: { host: "evil.example.com" } }, (res) => {
        res.resume(); res.on("end", resolve);
      });
      req.on("error", () => resolve());
      req.end();
    });
    statsAfter403 = proxyOn.httpCompressStats();

    // 悬挂回归（评审增量发现）：上游中途断连时 pipe 不传播错误，若不监听
    // aborted/error 终止下游，客户端将无限悬挂。修复后必须在短时限内结束。
    cut = await new Promise((resolve) => {
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

    // issue #528 反向回归：客户端断开长响应（SSE 类）→ 代理必须销毁上游连接。
    // 修复前 proxyResReceived 闸拦截下游断开传播，上游 res close 永不触发
    // （notifier 连接顶格 16 的根因）；修复后 500ms 内上游收到 close、active 回落。
    const upDestroyBefore = proxyOn.connStats().httpUpstreamDestroyed;
    const openAndDrop = () => new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: pxPort, path: "/sse-hold", headers: { host: "127.0.0.1" } }, (res) => {
        res.once("data", () => { req.destroy(); resolve(); }); // 收首帧后客户端断开
      });
      req.on("error", () => resolve());
      req.end();
    });
    for (let i = 0; i < 3; i += 1) await openAndDrop();
    await sleep(500); // 等断连传播到上游（销毁在 ~3ms 内，500ms 富余防 flake）
    upstreamDestroyedDelta = proxyOn.connStats().httpUpstreamDestroyed - upDestroyBefore;
    sseHoldActive = upstreamSseHoldActive;
    sseHoldClosed = upstreamSseHoldClosed;

    // 防误杀回归：正常完整请求（非长连接）断开/完成后不得销毁上游。
    const upDestroyBefore2 = proxyOn.connStats().httpUpstreamDestroyed;
    normalRequestStatuses = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await requestThrough(pxPort, "/big", { "accept-encoding": "gzip" });
      normalRequestStatuses.push(r.status);
    }
    await sleep(100);
    upstreamDestroyedAfterNormal = proxyOn.connStats().httpUpstreamDestroyed - upDestroyBefore2;

    await proxyOn.close();

    const proxyOff = createLanProxy(
      { host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort, httpCompress: { enabled: false, level: 1 } },
      console,
    );
    const { httpPort: pxPortOff } = await proxyOff.listen();
    rOff = await requestThrough(pxPortOff, "/big", { "accept-encoding": "gzip" });
    await proxyOff.close();
    upstreamCompress.close();
  }, 120_000);

  describe("转发层：大 JSON 经代理被 gzip 且解压逐字节一致", () => {
    it("响应带 content-encoding: gzip", () => {
      expect(rBig.headers["content-encoding"]).toBe("gzip");
    });

    it("content-length 已删除", () => {
      expect(rBig.headers["content-length"]).toBe(undefined);
    });

    it("解压后逐字节一致", () => {
      expect(gunzipSync(rBig.body).toString()).toBe(bigBody);
    });
  });

  describe("转发层：无 Accept-Encoding 透传原文", () => {
    it("不压（无 content-encoding）", () => {
      expect(rBigPlain.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rBigPlain.body.toString()).toBe(bigBody);
    });
  });

  describe("转发层：Range/206 豁免不压", () => {
    it("status 206", () => {
      expect(rRange.status).toBe(206);
    });

    it("不压", () => {
      expect(rRange.headers["content-encoding"]).toBe(undefined);
    });

    it("content-range 透传", () => {
      expect(rRange.headers["content-range"]).toBe(`bytes 0-9/${bigBody.length}`);
    });
  });

  describe("转发层：SSE 豁免不压", () => {
    it("不压", () => {
      expect(rSse.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rSse.body.toString()).toBe("data: x\n\n");
    });
  });

  describe("转发层：上游已压缩让位（dsh-gzip 宿主端共存，仅单层）", () => {
    it("保留上游 content-encoding", () => {
      expect(rPregzip.headers["content-encoding"]).toBe("gzip");
    });

    it("gunzip 一次即原文（无双层）", () => {
      expect(gunzipSync(rPregzip.body).toString()).toBe(bigBody);
    });
  });

  describe("转发层：协商计数递增（协商口径：206 计入 compressed、无 AE 不进 filter）", () => {
    it("compressed 至少 3（/big + /range + /pregzip）", () => {
      expect(statsOn.compressed >= 3).toBeTruthy();
    });

    it("passthrough 至少 1（SSE）", () => {
      expect(statsOn.passthrough >= 1).toBeTruthy();
    });
  });

  it("转发层：本地 403 响应不污染协商计数", () => {
    expect(statsAfter403).toEqual(statsBefore403);
  });

  it("转发层：上游中途断连 → 客户端快速终止（不悬挂回归）", () => {
    expect(cut.ms < 4000).toBeTruthy();
  });

  describe("转发层：客户端断开 SSE → 上游连接被销毁（issue #528 反向回归）", () => {
    it("httpUpstreamDestroyed +3", () => {
      expect(upstreamDestroyedDelta).toBe(3);
    });

    it("上游 active SSE 回落 0", () => {
      expect(sseHoldActive).toBe(0);
    });

    it("上游 close 计数 3", () => {
      expect(sseHoldClosed).toBe(3);
    });
  });

  // 原脚本把「正常完整请求 200」写在准备循环内，故按轮次展开为逐条可见用例。
  it.each(normalRequestRounds)("转发层：完整短请求 #$round 返回 200", ({ round }) => {
    expect(normalRequestStatuses[round]).toBe(200);
  });

  it("转发层：完整短请求不触发上游销毁（防误杀）", () => {
    expect(upstreamDestroyedAfterNormal).toBe(0);
  });

  describe("转发层：enabled=false 全透传", () => {
    it("不压", () => {
      expect(rOff.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rOff.body.toString()).toBe(bigBody);
    });
  });
});

// ── sanitize 接受 httpCompress 新键 ──────────────────────────────────────
describe("unit: httpCompress 配置键", () => {
  it("sanitize 接受 httpCompressEnabled/httpCompressLevel 档位", () => {
    const out = sanitizeSettings({ httpCompressEnabled: false, httpCompressLevel: 2 });
    expect(out).toEqual({ httpCompressEnabled: false, httpCompressLevel: 2 });
  });

  describe("sanitize 档位越界/非整数整体拒绝；旧档位 4..9 迁移为高（3）；0=默认合法", () => {
    it("非整数 1.5 拒绝", () => {
      expect(sanitizeSettings({ httpCompressLevel: 1.5 })).toBe(null);
    });

    it("字符串 \"3\" 拒绝", () => {
      expect(sanitizeSettings({ httpCompressLevel: "3" })).toBe(null);
    });

    it("越界 10 拒绝", () => {
      expect(sanitizeSettings({ httpCompressLevel: 10 })).toBe(null);
    });

    it("0 合法保留", () => {
      expect(sanitizeSettings({ httpCompressLevel: 0 })).toEqual({ httpCompressLevel: 0 });
    });

    it("旧档位 6 迁移为 3（高）", () => {
      expect(sanitizeSettings({ httpCompressLevel: 6 })).toEqual({ httpCompressLevel: 3 });
    });

    it("旧档位 9 迁移为 3（高）", () => {
      expect(sanitizeSettings({ httpCompressLevel: 9 })).toEqual({ httpCompressLevel: 3 });
    });
  });
});

describe("unit: applyConfigPatch（PUT /config 主体：校验 → 官方存储写入）", () => {
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

  let hOk;
  let rOk;
  let hClear;
  let rClear;
  let badPort;
  let lone;
  let mixedClear;
  let mixedSet;
  let na;
  let clearCertOnly;
  let clearKeyOnly;
  let clearBoth;
  let clearConflict;
  let brokenUser;
  let inPair;
  let orphanPair;
  let orphanRes;
  let orphanLone;
  let broken;
  let brokenLogWarns;
  let conflict;

  beforeAll(async () => {
    // 合法 patch：validate/sanitize 后增量 update（expectedRevision 透传）。
    hOk = makeDeps({ tlsCertFile: "/x.pem" as unknown });
    rOk = await applyConfigPatch(hOk.deps, { patch: { port: 4099, printBanner: false }, expectedRevision: 7 });

    // 清除证书路径：raw 空字符串 → replace 整节（unset 语义），其余键保留。
    hClear = makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 });
    rClear = await applyConfigPatch(hClear.deps, { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } });

    // 校验失败：首个非法键定位 + 范围提示。
    badPort = await applyConfigPatch(makeDeps().deps, { patch: { port: 70000 } });
    // tls 成对约束。
    lone = await applyConfigPatch(makeDeps().deps, { patch: { tlsCertFile: "/x.pem" } });
    // P2-1：单边空串 + 单侧非空字符串 → raw 层直接拒绝（不再被 sanitize 剔除绕过）。
    mixedClear = await applyConfigPatch(makeDeps({ port: 4000 }).deps, { patch: { tlsCertFile: "", tlsKeyFile: "/keep.pem" } });
    mixedSet = await applyConfigPatch(makeDeps().deps, { patch: { tlsCertFile: "/new.pem", tlsKeyFile: "" } });
    // settings 服务不可用。
    const unavail = makeDeps();
    (unavail.deps as any).writable = () => false;
    na = await applyConfigPatch(unavail.deps, { patch: { port: 4000 } });
    // ── #467 验收：TLS 成对清除语义（只清 cert / 只清 key / 双清 / 清除遇 409 /
    //    user 层已不完整）。
    clearCertOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "" } },
    );
    clearKeyOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "" } },
    );
    clearBoth = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } },
    );
    clearConflict = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem" }, { conflict: true }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    brokenUser = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    inPair = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "/new-key.pem", printBanner: false } },
    );
    // 场景 5：user 层已不完整（历史孤儿 { tlsCertFile: "/x.pem" } 残留）时，
    // 双清仍整体剔除两键并走 replace 自愈；单侧清除请求仍被 raw 层拒绝（双清是唯一出口）。
    orphanPair = makeDeps({ tlsCertFile: "/x.pem", port: 4000 });
    orphanRes = await applyConfigPatch(orphanPair.deps, { patch: { tlsCertFile: "", tlsKeyFile: "" } });
    orphanLone = await applyConfigPatch(makeDeps({ tlsCertFile: "/x.pem", port: 4000 }).deps, { patch: { tlsCertFile: "" } });

    brokenLogWarns = [];
    const brokenDeps = makeDeps({}, { broken: true });
    (brokenDeps.deps as any).logWarn = (m: string) => brokenLogWarns.push(m);
    broken = await applyConfigPatch(brokenDeps.deps, { patch: { port: 4000 } });
    conflict = await applyConfigPatch(makeDeps({}, { conflict: true }).deps, { patch: { port: 4000 } });
  }, 120_000);

  describe("patch 合法提交走 update 增量合并且透传 expectedRevision", () => {
    it("ok 为 true", () => {
      expect(rOk.ok).toBe(true);
    });

    it("update 收到 patch 与 expectedRevision", () => {
      expect(hOk.state.updates).toEqual([{ patch: { port: 4099, printBanner: false }, expectedRevision: 7 }]);
    });

    it("未提交键保持原值", () => {
      expect(hOk.state.user).toEqual({ tlsCertFile: "/x.pem", port: 4099, printBanner: false });
    });

    it("回执 revision 透传", () => {
      expect((rOk as any).value.revision).toEqual(7);
    });
  });

  describe("tls 双空串触发 replace 整节替换并从用户层剔除两个键", () => {
    it("ok 为 true", () => {
      expect(rClear.ok).toBe(true);
    });

    it("走了 replace 路径", () => {
      expect(hClear.state.replaces.length).toBe(1);
    });

    it("不走 update", () => {
      expect(hClear.state.updates.length).toBe(0);
    });

    it("tls 键已剔除、其余键保留", () => {
      expect(hClear.state.user).toEqual({ port: 4000, printBanner: false });
    });
  });

  describe("patch 非法端口 400 且 details 含键名与范围", () => {
    it("ok 为 false", () => {
      expect(badPort.ok).toBe(false);
    });

    it("status 400 且 code=invalid", () => {
      expect((badPort as any).status === 400 && (badPort as any).code).toBe("invalid");
    });

    it("details 含键名与范围", () => {
      expect((badPort as any).details.includes("port") && (badPort as any).details.includes("1-65535")).toBeTruthy();
    });
  });

  it("patch 单边证书被拒（tls-pair）", () => {
    expect(lone.ok === false && (lone as any).code).toBe("tls-pair");
  });

  describe("patch 单边空串混非空值被拒（raw 层成对形态判定）", () => {
    it("空 cert + 非空 key → ok=false", () => {
      expect(mixedClear.ok).toBe(false);
    });

    it("空 cert + 非空 key → code=tls-pair", () => {
      expect((mixedClear as any).code).toBe("tls-pair");
    });

    it("空 cert + 非空 key → status=400", () => {
      expect((mixedClear as any).status).toBe(400);
    });

    it("非空 cert + 空 key → ok=false", () => {
      expect(mixedSet.ok).toBe(false);
    });

    it("非空 cert + 空 key → code=tls-pair", () => {
      expect((mixedSet as any).code).toBe("tls-pair");
    });
  });

  it("settings 服务不可用时写入 503 拒绝", () => {
    expect(na.ok === false && (na as any).status).toBe(503);
  });

  describe("#467 只清 cert（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
    it("ok 为 false", () => {
      expect(clearCertOnly.ok).toBe(false);
    });

    it("status 400", () => {
      expect((clearCertOnly as any).status).toBe(400);
    });

    it("code=tls-pair", () => {
      expect((clearCertOnly as any).code).toBe("tls-pair");
    });
  });

  describe("#467 只清 key（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
    it("ok 为 false", () => {
      expect(clearKeyOnly.ok).toBe(false);
    });

    it("status 400", () => {
      expect((clearKeyOnly as any).status).toBe(400);
    });

    it("code=tls-pair", () => {
      expect((clearKeyOnly as any).code).toBe("tls-pair");
    });
  });

  describe("#467 双清（同空）整套成对剔除，user 层不留任何 tls 键", () => {
    it("ok 为 true", () => {
      expect(clearBoth.ok).toBe(true);
    });

    it("tlsCertFile 已剔除", () => {
      expect((clearBoth as any).value.user.tlsCertFile).toBe(undefined);
    });

    it("tlsKeyFile 已剔除", () => {
      expect((clearBoth as any).value.user.tlsKeyFile).toBe(undefined);
    });

    it("其余键保留（port）", () => {
      expect((clearBoth as any).value.user.port).toBe(4000);
    });

    it("其余键保留（printBanner）", () => {
      expect((clearBoth as any).value.user.printBanner).toBe(false);
    });
  });

  describe("#467 清除遇 SETTINGS_CONFLICT 映射 409/conflict 固定文案", () => {
    it("ok 为 false", () => {
      expect(clearConflict.ok).toBe(false);
    });

    it("status 409", () => {
      expect((clearConflict as any).status).toBe(409);
    });

    it("code=conflict", () => {
      expect((clearConflict as any).code).toBe("conflict");
    });

    it("固定文案", () => {
      expect((clearConflict as any).details).toBe("设置已被其他窗口修改，请刷新后重试");
    });
  });

  it("#467 双清不会产生含 undefined 段的路径（user 层干净成对）", () => {
    const user = (brokenUser as any).value.user;
    const fsPath = join(user?.tlsCertFile ?? "", user?.tlsKeyFile ?? "");
    expect(!fsPath.includes("undefined")).toBeTruthy();
  });

  describe("#467 只设 key 亦被拒（任一单侧显式即 400，含未清除意图）", () => {
    it("ok 为 false", () => {
      expect(inPair.ok).toBe(false);
    });

    it("code=tls-pair", () => {
      expect((inPair as any).code).toBe("tls-pair");
    });
  });

  describe("#467 user 层已不完整（孤儿单侧残留）双清 replace 自愈，无孤儿留存", () => {
    it("ok 为 true", () => {
      expect(orphanRes.ok).toBe(true);
    });

    it("tlsCertFile 已剔除", () => {
      expect((orphanRes as any).value.user.tlsCertFile).toBe(undefined);
    });

    it("tlsKeyFile 已剔除", () => {
      expect((orphanRes as any).value.user.tlsKeyFile).toBe(undefined);
    });

    it("走 replace 整节替换", () => {
      expect(orphanPair.state.replaces.length).toBe(1);
    });
  });

  describe("#467 user 层已不完整时单侧清除仍被拒（不落盘半套）", () => {
    it("ok 为 false", () => {
      expect(orphanLone.ok).toBe(false);
    });

    it("code=tls-pair", () => {
      expect((orphanLone as any).code).toBe("tls-pair");
    });
  });

  describe("写入异常映射 500/error 且 details 不泄露底层错误原文", () => {
    it("status 500", () => {
      expect(broken.ok === false && (broken as any).status).toBe(500);
    });

    it("code=error", () => {
      expect((broken as any).code).toBe("error");
    });

    it("details 为固定文案", () => {
      expect((broken as any).details).toBe("保存失败，请查看服务端日志");
    });

    it("details 不含 err.message 原文", () => {
      expect(!((broken as any).details.includes("disk full"))).toBeTruthy();
    });

    it("err.message 走服务端日志", () => {
      expect(brokenLogWarns.some((m) => m.includes("disk full"))).toBeTruthy();
    });
  });

  describe("SETTINGS_CONFLICT 映射 409/conflict", () => {
    it("status 409", () => {
      expect(conflict.ok === false && (conflict as any).status).toBe(409);
    });

    it("code=conflict", () => {
      expect((conflict as any).code).toBe("conflict");
    });
  });
});

describe("unit: buildConfigRoutes（GET 快照 / PUT 写入 / 围栏）", () => {
  let putPayload: any = null;
  let forbidden;
  let notAllowed;
  let got;
  let gotPayload;
  let put;
  let putPayloadParsed;
  let putBad;
  let putBadPayload;

  beforeAll(async () => {
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

    forbidden = await callRoute("GET", { socket: { remoteAddress: "192.168.1.9" } });
    notAllowed = await callRoute("POST", {}, { patch: {} });
    got = await callRoute("GET");
    gotPayload = JSON.parse(got.body);
    put = await callRoute("PUT", {}, { patch: { port: 4099 }, expectedRevision: 3 });
    putPayloadParsed = JSON.parse(put.body);
    putBad = await callRoute("PUT", {}, { patch: { port: 70000 } });
    putBadPayload = JSON.parse(putBad.body);
  });

  describe("config 路由非回环 403", () => {
    it("status 403", () => {
      expect(forbidden.status).toBe(403);
    });

    // #473 批 1（B1-4）：403 body 围栏文案（守卫收敛后逐字节锁定）
    it("403 body 围栏文案", () => {
      expect(JSON.parse(forbidden.body).error).toBe("forbidden: loopback-only");
    });
  });

  describe("config 路由 POST 405（仅 GET/PUT）", () => {
    it("status 405", () => {
      expect(notAllowed.status).toBe(405);
    });

    // #473 批 1（B1-3）：405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(notAllowed.body).error).toBe("method not allowed: POST");
    });
  });

  describe("GET 返回 user 层 + effective 生效值 + 压缩快照 + revision（只读面不收缩）", () => {
    it("status 200", () => {
      expect(got.status).toBe(200);
    });

    it("user 层", () => {
      expect(gotPayload.user).toEqual({ port: 3082 });
    });

    it("effective 生效值可见", () => {
      expect(gotPayload.effective.port).toBe(3082);
    });

    it("压缩协商计数可见", () => {
      expect(gotPayload.compress.httpCompressStats.compressed).toBe(5);
    });

    it("revision", () => {
      expect(gotPayload.revision).toBe(3);
    });

    it("writable", () => {
      expect(gotPayload.writable).toBe(true);
    });
  });

  describe("PUT 合法 patch 转 scope.update 并回传新 user 层", () => {
    it("status 200", () => {
      expect(put.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(putPayloadParsed.ok).toBe(true);
    });

    it("回传 user 层", () => {
      expect(putPayloadParsed.user).toEqual({ port: 3082 });
    });

    it("走 update 路径", () => {
      expect(putPayload.kind).toBe("update");
    });

    it("expectedRevision 透传", () => {
      expect(putPayload.rev).toBe(3);
    });
  });

  describe("PUT 非法 patch 400 带 error.details", () => {
    it("status 400", () => {
      expect(putBad.status).toBe(400);
    });

    it("details 含字段名", () => {
      expect(putBadPayload.error.details.includes("port")).toBeTruthy();
    });
  });
});

// fake ctx + apply：转发器用一个高位随机端口（不碰 3081），DSH_HOME 隔离。
describe("apply: 注册、围栏与 settings 命名空间接线", () => {
  let rpcHandleCount;
  let healthRoute;
  let configRoute;
  let migratedBakExists;
  let settingsUpdates;
  let settingsUserPort;
  let settingsRegisteredNs;
  let settingsUserPrintBanner;
  let settingsWatchersLength;
  let settingsWatchDisposed;
  let snapshot;
  let snapshotPayload;
  let cfg403;
  let cfg405;
  let put;
  let putPayload;
  let res403Status;
  let res405Status;
  let res405Body;
  let res200Status;
  let res200Payload;

  beforeAll(async () => {
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
    apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false });
    const cleanup = () => { for (const d of disposers.reverse()) { try { d(); } catch {} } };

    rpcHandleCount = rpcHandles.length;
    healthRoute = routes.filter((r) => r.path === ROUTES.health)[0];
    configRoute = routes.filter((r) => r.path === ROUTES.config)[0];

    // 迁移是 async fire-and-forget：轮询等待（防 flake 纪律，不用固定 sleep）。
    const migratedDeadline = Date.now() + 5000;
    while (!existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME)) && Date.now() < migratedDeadline) await sleep(25);
    migratedBakExists = existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME));
    // 必须复制：后续 PUT 会继续往同一个 updates 数组里 push，存引用会让断言看到块尾状态
    settingsUpdates = settingsState.updates.map((u) => ({ ...u }));
    settingsUserPort = settingsState.user.port;
    settingsRegisteredNs = settingsState.registeredNs;

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
    snapshot = await callRoute("GET");
    snapshotPayload = JSON.parse(snapshot.body);
    cfg403 = await callRoute("GET", { socket: { remoteAddress: "192.168.100.9" } });
    cfg405 = await callRoute("DELETE");
    // PUT 写入：经路由 → deps.update（fake scope）→ watch 触发。
    put = await callRoute("PUT", {}, { patch: { printBanner: false }, expectedRevision: settingsState.revision });
    putPayload = JSON.parse(put.body);
    // 原断言读取的存储侧观测值在此点取快照（后续 cleanup 会释放 watch）
    settingsUserPrintBanner = settingsState.user.printBanner;
    settingsWatchersLength = settingsState.watchers.length;
    settingsWatchDisposed = settingsState.watchDisposed;

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
    res403Status = res403.status();
    const res405 = fakeRes();
    healthRoute.handler(fakeReq({ method: "POST" }), res405);
    res405Status = res405.status();
    res405Body = res405.body();
    const res200 = fakeRes();
    healthRoute.handler(fakeReq(), res200);
    res200Status = res200.status();
    res200Payload = JSON.parse(res200.body());

    cleanup();
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  it("RPC 配置通道不再注册（自建通道移除）", () => {
    expect(rpcHandleCount).toBe(0);
  });

  it("health route registered", () => {
    expect(healthRoute).toBeTruthy();
  });

  it("config route registered", () => {
    expect(configRoute).toBeTruthy();
  });

  describe("apply 后存量 config.json 自动迁移进官方存储（attach 即迁移）", () => {
    it(".bak 幂等标记存在", () => {
      expect(migratedBakExists).toBe(true);
    });

    it("写入 scope 的 patch 与 revision", () => {
      expect(settingsUpdates).toEqual([{ patch: { port: 19997 }, expectedRevision: undefined }]);
    });

    it("user 层已写入", () => {
      expect(settingsUserPort).toBe(19997);
    });

    it("settings 命名空间已注册", () => {
      expect(settingsRegisteredNs).toBe(SETTINGS_NS);
    });
  });

  describe("GET /config 快照含 effective 生效值 + 压缩快照 + user 层 + revision", () => {
    it("status 200", () => {
      expect(snapshot.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(snapshotPayload.ok).toBe(true);
    });

    it("迁移后的生效端口可见", () => {
      expect(snapshotPayload.effective.port).toBe(19997);
    });

    it("组合层 entry 兜底生效", () => {
      expect(snapshotPayload.effective.host).toBe("127.0.0.1");
    });

    it("转发器已监听 → 压缩已挂载", () => {
      expect(snapshotPayload.compress.httpCompressMounted).toBe(true);
    });

    it("压缩协商计数为 number", () => {
      expect(typeof snapshotPayload.compress.httpCompressStats.compressed).toBe("number");
    });

    it("user 层", () => {
      expect(snapshotPayload.user).toEqual({ port: 19997 });
    });

    it("revision 为 number", () => {
      expect(typeof snapshotPayload.revision).toBe("number");
    });

    it("writable", () => {
      expect(snapshotPayload.writable).toBe(true);
    });
  });

  describe("config 路由非回环 403", () => {
    it("status 403", () => {
      expect(cfg403.status).toBe(403);
    });

    // #473 批 1（B1-4）：403 body 围栏文案（守卫收敛后逐字节锁定）
    it("403 body 围栏文案", () => {
      expect(JSON.parse(cfg403.body).error).toBe("forbidden: loopback-only");
    });
  });

  describe("config 路由 DELETE 405", () => {
    it("status 405", () => {
      expect(cfg405.status).toBe(405);
    });

    // #473 批 1（B1-3）：405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(cfg405.body).error).toBe("method not allowed: DELETE");
    });
  });

  describe("PUT 经路由写入官方存储并触发 watch 回调", () => {
    it("status 200", () => {
      expect(put.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(putPayload.ok).toBe(true);
    });

    it("存储 user.printBanner 已写入", () => {
      expect(settingsUserPrintBanner).toBe(false);
    });

    it("watch 已挂接未释放", () => {
      expect(settingsWatchersLength >= 1 && settingsWatchDisposed).toBe(0);
    });
  });

  it("health 403 for non-loopback", () => {
    expect(res403Status).toBe(403);
  });

  describe("health 405 for non-GET", () => {
    it("status 405", () => {
      expect(res405Status).toBe(405);
    });

    // #473 批 1（B1-3）：health（GET 白名单）405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(res405Body).error).toBe("method not allowed: POST");
    });
  });

  describe("health 200 with status summary", () => {
    it("status 200", () => {
      expect(res200Status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(res200Payload.ok).toBe(true);
    });

    it("payload.plugin 为 dsh-lan-proxy", () => {
      expect(res200Payload.plugin).toBe("dsh-lan-proxy");
    });
  });
});

// apply：settings 服务缺失 → 降级（卡片可读不可写，主体不受影响）。
describe("apply: settings 服务缺失降级", () => {
  let healthRegistered;
  let configRoute;
  let degradedPort;
  let degradedStatus;
  let degradedPayload;

  beforeAll(async () => {
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
    const chosenPort = await freePort();
    degradedPort = chosenPort;
    apply(ctx, { host: "127.0.0.1", port: chosenPort, httpsEnabled: false });
    healthRegistered = Boolean(routes.find((r) => r.path === ROUTES.health));
    configRoute = routes.find((r) => r.path === ROUTES.config);
    const req = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } };
    const chunks: string[] = [];
    let status = 0;
    configRoute.handler(req as any, { writeHead: (c: number) => { status = c; }, end: (c?: any) => { if (c !== undefined) chunks.push(String(c)); }, getHeader: () => undefined, setHeader: () => {} } as any);
    degradedStatus = status;
    degradedPayload = JSON.parse(chunks.join(""));
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("降级态：health 与 config 路由仍注册（卡片可读）", () => {
    it("health 路由已注册", () => {
      expect(healthRegistered).toBeTruthy();
    });

    it("config 路由已注册", () => {
      expect(configRoute).toBeTruthy();
    });
  });

  describe("降级态 GET：writable=false 且 effective 为组合层兜底", () => {
    it("status 200", () => {
      expect(degradedStatus).toBe(200);
    });

    it("writable=false", () => {
      expect(degradedPayload.writable).toBe(false);
    });

    it("effective.port 为组合层传入端口", () => {
      expect(degradedPayload.effective.port).toBe(degradedPort);
    });
  });
});

// apply 集成：HTTP 压缩层安装 + 合并标记路由 + health 扩展字段。
describe("apply: HTTP 压缩集成（转发 + 压缩并存 / 标记路由 / health 扩展）", () => {
  let apiHandlerPreserved;
  let healthRegisteredBeforeCleanup;
  let healthPayload;
  let apiHandlerPreservedAfterCleanup;
  let healthRemovedAfterCleanup;

  beforeAll(async () => {
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
    apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false });

    const apiRoute = ws.prefixes.get("/api");
    apiHandlerPreserved = apiRoute.handler === apiHandler;

    const healthRoute = ws.exact.get(ROUTES.health);
    healthRegisteredBeforeCleanup = ws.exact.has(ROUTES.health);
    const hRes = new FakeRes();
    healthRoute.handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));

    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    apiHandlerPreservedAfterCleanup = ws.prefixes.get("/api").handler === apiHandler;
    healthRemovedAfterCleanup = ws.exact.has(ROUTES.health);
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  it("webServer handler 不被触碰（压缩在转发层，非宿主端 patch）", () => {
    expect(apiHandlerPreserved).toBe(true);
  });

  describe("health 扩展返回压缩配置与生效状态", () => {
    it("health 路由已注册", () => {
      expect(healthRegisteredBeforeCleanup).toBe(true);
    });

    it("httpCompressEnabled 为 true", () => {
      expect(healthPayload.httpCompressEnabled).toBe(true);
    });

    it("httpCompressLevel 为 1", () => {
      expect(healthPayload.httpCompressLevel).toBe(1);
    });

    it("httpCompressMounted 为 true", () => {
      expect(healthPayload.httpCompressMounted).toBe(true);
    });

    it("httpCompressStats.compressed 为 number", () => {
      expect(typeof healthPayload.httpCompressStats.compressed).toBe("number");
    });
  });

  describe("lifecycle 卸载撤下 health 路由且 webServer 原样", () => {
    it("/api handler 全程原样", () => {
      expect(apiHandlerPreservedAfterCleanup).toBe(true);
    });

    it("health 路由移除", () => {
      expect(healthRemovedAfterCleanup).toBe(false);
    });
  });
});

// apply：httpCompressEnabled=false 只关压缩，转发不受影响。
describe("apply: httpCompressEnabled=false 关闭压缩", () => {
  let apiHandlerPreserved;
  let healthRegistered;
  let healthPayload;

  beforeAll(async () => {
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
    apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false, httpCompressEnabled: false });
    apiHandlerPreserved = ws.prefixes.get("/api").handler === apiHandler;
    healthRegistered = ws.exact.has(ROUTES.health);
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("关闭压缩：health mounted=false", () => {
    it("webServer handler 原样", () => {
      expect(apiHandlerPreserved).toBe(true);
    });

    it("health 路由仍注册（转发功能不受影响）", () => {
      expect(healthRegistered).toBe(true);
    });

    it("httpCompressEnabled 为 false", () => {
      expect(healthPayload.httpCompressEnabled).toBe(false);
    });

    it("httpCompressMounted 为 false", () => {
      expect(healthPayload.httpCompressMounted).toBe(false);
    });
  });
});

// apply：运行中经设置保存热关闭——scope.watch 必须驱动压缩生效状态翻转。
describe("apply: 运行中热关闭（PUT /config → scope.watch → 压缩卸载）", () => {
  /**
   * 单次热关闭场景：起 fake ctx + settings service → apply → PUT /config → 等 watch 生效。
   * 原脚本以函数参数化两个场景，这里按场景展开为逐条可见用例。
   */
  const runHotOffCase = async (patch, expectProxyOff) => {
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
    apply(ctx, { host: "127.0.0.1", port: 0, httpsEnabled: false });
    const healthPayloadOf = () => {
      const hRes = new FakeRes();
      ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
      return JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    };
    const mountedBefore = healthPayloadOf().httpCompressMounted;

    const finish = () => {
      for (const d of [...disposers].reverse()) { try { d(); } catch {} }
      process.env.DSH_HOME = prevHome;
      rmSync(applyHome, { recursive: true, force: true });
    };
    if (!mountedBefore) {
      finish();
      return { mountedBefore, putStatus: undefined, payload: undefined, apiHandlerPreserved: undefined };
    }

    // 运行中经配置路由保存（客户端同链路）：PUT → scope.update → watch 触发
    // onChange=scheduleSync（3s 防抖）→ sync 重建。轮询等待生效，不用固定 sleep
    // （防 flake 纪律）；deadline 覆盖 3s 防抖窗口。
    const putBody = JSON.stringify({ patch });
    const putStatus = await new Promise((resolveRoute) => {
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

    let payload;
    if (expectProxyOff) {
      // 整插件关闭：listening 反映转发器实例存活，须等 watch 驱动 sync 重建才翻转。
      const deadline = Date.now() + 12000;
      while (healthPayloadOf().listening && Date.now() < deadline) await sleep(100);
      payload = healthPayloadOf();
    } else {
      // 只关压缩：生效值经 resolve() 立即可见（GET 快照不撒谎），转发器由
      // watch 防抖后按新配置重建（不影响 listening）。
      payload = healthPayloadOf();
    }
    const apiHandlerPreserved = ws.prefixes.get("/api").handler === apiHandler;
    finish();
    return { mountedBefore, putStatus, payload, apiHandlerPreserved };
  };

  const hotOffCases = [
    { label: "热关 httpCompressEnabled=false", patch: { httpCompressEnabled: false }, expectProxyOff: false, branchName: "保存成功且压缩生效状态随保存翻转" },
    { label: "热关 enabled=false（整插件）", patch: { enabled: false }, expectProxyOff: true, branchName: "保存成功且 watch 热更新停掉转发器" },
  ];

  describe.each(hotOffCases)("$label", (hotCase) => {
    let observed;

    beforeAll(async () => {
      observed = await runHotOffCase(hotCase.patch, hotCase.expectProxyOff);
    }, 120_000);

    // 前置条件用例化（qa 复核）：纳入统计且失败信息内联实际值。
    it("前置压缩已生效", () => {
      expect(observed.mountedBefore).toBe(true);
    });

    if (hotCase.expectProxyOff) {
      describe("保存成功且 watch 热更新停掉转发器", () => {
        it("PUT 保存回执成功", () => {
          expect(observed.putStatus).toBe(200);
        });

        it("转发器已停（scope.watch 热更新生效）", () => {
          expect(observed.payload.listening).toBe(false);
        });

        it("压缩已卸载", () => {
          expect(observed.payload.httpCompressMounted).toBe(false);
        });

        it("webServer handler 全程原样", () => {
          expect(observed.apiHandlerPreserved).toBe(true);
        });
      });
    } else {
      describe("保存成功且压缩生效状态随保存翻转", () => {
        it("PUT 保存回执成功", () => {
          expect(observed.putStatus).toBe(200);
        });

        it("health mounted=false（生效配置即时可见）", () => {
          expect(observed.payload.httpCompressMounted).toBe(false);
        });

        it("httpCompressEnabled=false", () => {
          expect(observed.payload.httpCompressEnabled).toBe(false);
        });

        it("webServer handler 全程原样", () => {
          expect(observed.apiHandlerPreserved).toBe(true);
        });
      });
    }
  });
});

// apply：enabled=false 启动态 → 转发器不启动，但路由与 settings 注册照常、
// 存量 config.json 迁移先行于 enabled 判定（issue #110 P0-2：禁用用户升级
// 同样迁移，重新启用不丢配置）。
describe("apply: enabled=false 启动态", () => {
  let migratedBakExists;
  let healthRegistered;
  let configRegistered;
  let healthPayload;

  beforeAll(async () => {
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
    migratedBakExists = existsSync(join(applyHome, "lan-proxy", MIGRATED_BAK_NAME));
    healthRegistered = ws.exact.has(ROUTES.health);
    configRegistered = ws.exact.has(ROUTES.config);
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health).handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    for (const d of [...disposers].reverse()) {
      try { d(); } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("enabled=false：迁移仍执行、health/config 路由注册、转发器不启动", () => {
    it("禁用态也完成存量迁移", () => {
      expect(migratedBakExists).toBe(true);
    });

    it("health 路由注册", () => {
      expect(healthRegistered).toBe(true);
    });

    it("config 路由注册", () => {
      expect(configRegistered).toBe(true);
    });

    it("转发器未启动", () => {
      expect(healthPayload.listening).toBe(false);
    });

    it("payload.enabled 为 false", () => {
      expect(healthPayload.enabled).toBe(false);
    });
  });
});

// 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）。
// 产物在收集期读取：accessibility 用例的 id 表由产物内容派生，需在建表前可用
// （仍是读 lib/client.js 产物，未改为直连 src）。
const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
const expectedLabelIds = [
  "lp-set-enabled", "lp-set-port", "lp-set-https-enabled", "lp-set-https-port",
  "lp-set-cert", "lp-set-key", "lp-set-banner", "lp-set-ws-bridge",
  "lp-set-ws-compress", "lp-set-ws-paths", "lp-set-http-compress", "lp-set-level",
  "lp-set-inject-token",
];
const htmlForIds = [...clientCode.matchAll(/htmlFor:\s*"([^"]+)"/g)].map((m: any) => m[1]);
const inputModeCount = [...clientCode.matchAll(/inputMode:\s*"numeric"/g)].length;

describe("client 契约（lib/client.js 产物字面量）", () => {
  it("client source contract（IIFE/use strict/load id/SymbolTag/factory/load once）", () => {
    assertClientSourceContract(pkgDir);
  });

  it("client product contract（执行断言：arrive 可解析/apply/inject）", () => {
    assertClientProductContract(pkgDir);
  });

  it("client shares CONFIG route with host", () => {
    expect(clientCode.includes(ROUTES.config)).toBeTruthy();
  });

  describe("client i18n 接线 + 设置卡字段字典覆盖（issue #348）", () => {
    // i18n 哨兵：NS / register / bind / slots locale 参数 / 双语字典进产物
    it("i18n 命名空间 NS 进产物", () => {
      expect(clientCode.includes('"settings.lanProxy"')).toBeTruthy();
    });

    it("locale.register（字典注册）进产物", () => {
      expect(clientCode.includes("locale.register")).toBeTruthy();
    });

    it("locale.bind（t 装配）进产物", () => {
      expect(clientCode.includes("locale.bind")).toBeTruthy();
    });

    it("slots.register locale 参数进产物", () => {
      expect(clientCode.includes("locale: NS")).toBeTruthy();
    });

    it("en/zh 双语字典进产物", () => {
      expect(clientCode.includes("Enabled") && clientCode.includes("enable")).toBeTruthy();
    });

    // zh 字典覆盖卡片全部字段（渲染正确性由 client-shim 执行断言 + 浏览器实测保证）
    it("LAN 端口文案进产物", () => {
      expect(clientCode.includes("LAN 端口")).toBeTruthy();
    });

    it("HTTPS 端口文案进产物", () => {
      expect(clientCode.includes("HTTPS 端口")).toBeTruthy();
    });

    it("证书文件文案进产物", () => {
      expect(clientCode.includes("证书文件")).toBeTruthy();
    });

    it("启动时打印访问地址文案进产物", () => {
      expect(clientCode.includes("启动时打印访问地址")).toBeTruthy();
    });

    it("HTTP 压缩开关已渲染", () => {
      expect(clientCode.includes("HTTP 响应压缩")).toBeTruthy();
    });

    it("压缩档位下拉框已渲染", () => {
      expect(clientCode.includes("压缩档位") && clientCode.includes("高（最高压缩比：gzip 9 / br 9）")).toBeTruthy();
    });
  });

  // issue #33 子项 1：客户端 save() 前本地校验，错误指明字段与范围。
  describe("client 本地校验文案指明字段与合法范围", () => {
    it("端口范围提示（i18n key）", () => {
      expect(clientCode.includes('t("portRangeFail")')).toBeTruthy();
    });

    it("HTTPS 端口范围提示（i18n key）", () => {
      expect(clientCode.includes('t("httpsPortRangeFail")')).toBeTruthy();
    });

    it("档位范围提示（i18n key）", () => {
      expect(clientCode.includes('t("levelRangeFail")')).toBeTruthy();
    });

    it("本地整数校验", () => {
      expect(clientCode.includes("Number.isInteger")).toBeTruthy();
    });
  });

  // issue #33 子项 2：effective 校准展示 + 增量 diff 提交。
  describe("client 以 effective 校准展示且增量提交", () => {
    it("state.effective 被消费", () => {
      expect(clientCode.includes("effective")).toBeTruthy();
    });

    it("加载基线快照（diff 基准）", () => {
      expect(clientCode.includes("baseline")).toBeTruthy();
    });

    it("增量 diff 键值比较", () => {
      expect(clientCode.includes("sameSetting")).toBeTruthy();
    });

    it("无改动不发起保存请求", () => {
      expect(clientCode.indexOf("Object.keys(payload).length === 0") >= 0).toBeTruthy();
    });
  });

  // issue #33 子项 3：压缩状态 GUI 可见（卡片底部轻量状态行）。
  describe("client 渲染压缩状态行", () => {
    it("状态行文案函数", () => {
      expect(clientCode.includes("compressStatusLine")).toBeTruthy();
    });

    it("已启用 + 协商计数文案（i18n key）", () => {
      expect(clientCode.includes('t("compressOn"')).toBeTruthy();
    });

    it("关闭态文案（i18n key）", () => {
      expect(clientCode.includes('t("compressOff"')).toBeTruthy();
    });

    it("状态行样式类", () => {
      expect(clientCode.includes("lp-set-status")).toBeTruthy();
    });
  });

  // issue #33 子项 4：可达性——label/input 经 htmlFor+id 全关联，数字输入带 inputMode。
  describe("client 全部 label 经 htmlFor/id 关联且 number 输入带 inputMode", () => {
    it("13 行全部 htmlFor 关联", () => {
      expect([...htmlForIds].sort()).toEqual([...expectedLabelIds].sort());
    });

    // 原脚本把控件侧 id 断言写在 forIds 循环内，故按 id 展开为逐条可见用例。
    it.each(htmlForIds.map((id) => ({ title: `控件侧存在同名 id「${id}」`, id })))("$title", ({ id }) => {
      expect(new RegExp(`id:\\s*"${id}"`).test(clientCode)).toBeTruthy();
    });

    it("port/httpsPort 两个 number 输入均带 inputMode=numeric", () => {
      expect(inputModeCount).toBe(2);
    });
  });

  // issue #380：injectToken 开关渲染 + 开启态常驻安全警示（评审要求：横幅一次性警示不足）。
  describe("client 渲染 injectToken 开关与开启态警示", () => {
    it("开关 label（i18n key）", () => {
      expect(clientCode.includes('t("injectToken")')).toBeTruthy();
    });

    it("开启态警示文案（i18n key）", () => {
      expect(clientCode.includes('t("injectTokenOnHint")')).toBeTruthy();
    });

    it("警示样式类", () => {
      expect(clientCode.includes("lp-set-warn")).toBeTruthy();
    });

    it("DEFAULTS 缺省开启（前向兼容：存量用户升级即生效）", () => {
      expect(clientCode.includes("injectToken: true")).toBeTruthy();
    });
  });
});

// 原脚本把「正常完整请求 200」的轮次展开表已在压缩集成段之前建立。

// Node 24 全局 agent 默认 keep-alive，销毁它让事件循环干净退出。
afterAll(async () => {
  const { globalAgent } = await import("node:http");
  globalAgent.destroy();
});
