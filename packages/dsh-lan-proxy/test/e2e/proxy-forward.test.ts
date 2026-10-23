// dsh-lan-proxy e2e：真实转发面（HTTP / HTTPS / WebSocket / wss + DNS 重绑定围栏）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留；端口一律
// bind(0) 动态分配（#690 S2c：写死端口在并发或残留进程下会 EADDRINUSE 假阳性）。
// 共享夹具（fake upstream + 请求 helper）在 ./forward-upstream.ts。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLanProxy, ensureSelfSignedTls } from "../../lib/index.js";
import {
  LAN_HOST,
  closeUpstreamServer,
  createUpstreamServer,
  getViaHttpsProxy as getViaHttpsProxyOn,
  getViaProxy as getViaProxyOn,
  rawRequest as rawRequestOn,
  upgradeViaHttpsProxy as upgradeViaHttpsProxyOn,
  upgradeViaProxy as upgradeViaProxyOn,
  type UpstreamEcho,
} from "./forward-upstream.ts";

// 端口一律 bind(0) 之后回填：写死端口在并发运行或残留进程下会 EADDRINUSE 假阳性。
let UPSTREAM_PORT = 0;
let PROXY_PORT = 0;
let PROXY_HTTPS_PORT = 0;
let certDir = "";
let tls!: ReturnType<typeof ensureSelfSignedTls>;
let httpsListening = false;

// ── upstream fake dsh web server ────────────────────────────────────────────
const upstream = createUpstreamServer();

// proxy 在 beforeAll 里创建：targetPort 必须等 upstream 绑定到具体端口后才确定。
let proxy!: ReturnType<typeof createLanProxy>;

// 端口回填后按名引用：用例体逐字保留原 helper 形态（语义名与调用点不变）。
function getViaProxy(headers: Record<string, string>): ReturnType<typeof getViaProxyOn> {
  return getViaProxyOn(PROXY_PORT, "/hello", headers);
}
function getViaHttpsProxy(headers: Record<string, string>): ReturnType<typeof getViaHttpsProxyOn> {
  return getViaHttpsProxyOn(PROXY_HTTPS_PORT, "/hello", headers);
}
function upgradeViaProxy(): ReturnType<typeof upgradeViaProxyOn> {
  return upgradeViaProxyOn(PROXY_PORT);
}
function upgradeViaHttpsProxy(): ReturnType<typeof upgradeViaHttpsProxyOn> {
  return upgradeViaHttpsProxyOn(PROXY_HTTPS_PORT);
}
function rawRequest(requestText: string): ReturnType<typeof rawRequestOn> {
  return rawRequestOn(PROXY_PORT, requestText);
}

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-test-"));
  tls = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  UPSTREAM_PORT = (upstream.address() as import("node:net").AddressInfo).port;
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
  PROXY_HTTPS_PORT = listening.httpsPort ?? 0;
});

afterAll(async () => {
  await proxy.close();
  await closeUpstreamServer(upstream);
  rmSync(certDir, { recursive: true, force: true });
});
// 场景族按传输面注册（#1174 A1）：HTTP 明文族与 TLS/WS 族各自成函数，避免外壳
// describe 回调超过 max-lines-per-function 阈值。describe 名与嵌套顺序逐字保留，
// 故拆分前后完整名称路径相同。
function registerHttpScenarios() {
  it("HTTPS 应成功监听（端口动态分配）", () => {
    expect(httpsListening).toBe(true);
  });

  describe("http: browser-style request (Host + Origin, same-origin)", () => {
    let browser!: { status: number; body: string };
    let facts!: UpstreamEcho;

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
    let plain!: { status: number; body: string };
    let plainFacts!: UpstreamEcho;

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
    let evil!: { status: number; body: string };
    let h11!: { statusLine: string; body: string };
    let h10!: { statusLine: string; body: string };

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
}

function registerTlsAndWsScenarios() {
  describe("websocket: upgrade forwarding", () => {
    let ws!: Awaited<ReturnType<typeof upgradeViaProxy>>;

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
    let secure!: { status: number; body: string };
    let secureFacts!: UpstreamEcho;

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
    let secureEvil!: { status: number; body: string };

    beforeAll(async () => {
      secureEvil = await getViaHttpsProxy({ host: "evil.com:3443" });
    });

    it("DNS-name Host refused with 403", () => {
      expect(secureEvil.status).toBe(403);
    });
  });

  describe("wss: upgrade forwarding", () => {
    let wss!: Awaited<ReturnType<typeof upgradeViaHttpsProxy>>;

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
}

// ============================ 真实转发（HTTP / HTTPS / WS） ============================
// 这一段对应原 main() 从起服务到 close() 的区间：所有用例都依赖真实端口，
// 故 proxy / upstream 的生命周期由本文件的 beforeAll / afterAll 持有。
describe("e2e: 真实转发（HTTP / HTTPS / WebSocket，端口 bind(0) 动态分配）", () => {
  registerHttpScenarios();
  registerTlsAndWsScenarios();
});
