// @ts-nocheck
/**
 * dsh-lan-proxy — 转发核心（src/proxy.ts）结构化单测。
 *
 * 覆盖本批未覆盖热点：
 * - bridgeCompressedWs：WebSocket 压缩桥接（真实 WS 连接，全 localhost，无外网）
 * - createLanProxy 转发错误处理（不可达上游 → 502，proxy error 分支）
 * - createLanProxy HTTPS 降级（HTTPS 端口被占 → HTTP-only）
 * - createLanProxy 围栏与参数校验（非回环 targetHost / 非法 targetPort）
 * - 纯函数边界用例（hostnameAllowed / isLoopbackTarget / formatAuthority /
 *   rewriteHeaders / compressWsPath / isCompressible / resolveCompressionOptions）
 *
 * 本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）：原每条 assert 对应一个
 * it，判定口径与断言集合均未改动。真实端口相关块以 beforeAll 包住原有 setup/观测
 * 序列、afterAll 回收句柄——每个 it 只做断言，操作顺序与原脚本逐行一致；端口一律
 * 沿用原动态分配（listen(0) / 占位服务器取端口），未引入任何固定端口。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket as WsClient, WebSocketServer } from "ws";

import {
  hostnameAllowed, formatAuthority, rewriteHeaders, bridgeUpstreamHeaders, createLanProxy, isLoopbackTarget,
  DEFAULT_OPTIONS, compressWsPath, isCompressible, resolveCompressionOptions,
  ensureSelfSignedTls,
} from "../../src/index.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（防 flake 纪律：替代固定 sleep 猜时序）；超时返回 false。 */
async function waitFor(predicate, deadlineMs = 5000, stepMs = 20) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) return false;
    await sleep(stepMs);
  }
  return true;
}

/** RFC6455 握手应答行（Sec-WebSocket-Accept 计算；供 raw 假对端完成升级）。 */
const wsHandshakeResponse = (key) =>
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  `Sec-WebSocket-Accept: ${createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`;

/** 起一个 WS 回显上游（wsBridge 三态用例共用）。 */
async function mkUpstream() {
  const upServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  upServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
  const upPort = upServer.address().port;
  return { upPort, upServer, wss };
}

/** 经代理建一条 WS 连接、等 open、重试发送帧至回显（上游段 open 竞态：桥接的
 *  浏览器段 message 监听在 upstreamWs open 后才挂载，过早帧会被丢——重试规避），
 *  关闭连接返回收到的帧。 */
async function openAndEcho(port, path) {
  const ws = new WsClient(`ws://127.0.0.1:${port}${path}`);
  const received = [];
  ws.on("message", (data) => received.push(data.toString()));
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  for (let i = 0; i < 6; i++) {
    ws.send(`ping-${path}-${i}`);
    if (await waitFor(() => received.length > 0, 800)) break;
  }
  ws.close();
  await sleep(100);
  return received;
}

// ===== 纯函数边界用例 =====

describe("纯函数边界用例", () => {
  describe("hostnameAllowed", () => {
    it("bare IPv4", () => expect(hostnameAllowed("127.0.0.1")).toBe(true));
    it("bracketed IPv6", () => expect(hostnameAllowed("[::1]")).toBe(true));
    it("empty string", () => expect(hostnameAllowed("")).toBe(false));
    it("非字符串（undefined）→ 拒绝", () => expect(hostnameAllowed(undefined)).toBe(false));
    it("any IPv4", () => expect(hostnameAllowed("0.0.0.0")).toBe(true));
    it("LAN IPv4", () => expect(hostnameAllowed("192.168.1.1")).toBe(true));
    it("端口越界 → URL 解析失败 → 拒绝", () => expect(hostnameAllowed("127.0.0.1:99999")).toBe(false));
    it("localhost 字面量放行", () => expect(hostnameAllowed("localhost")).toBe(true));
    it("localhost 带端口放行", () => expect(hostnameAllowed("localhost:3080")).toBe(true));
    it("bracketed IPv6 带端口放行", () => expect(hostnameAllowed("[::1]:443")).toBe(true));
    it("DNS 域名拒绝（重绑定防护核心语义）", () => expect(hostnameAllowed("example.com")).toBe(false));
    it("多级 DNS 域名拒绝", () => expect(hostnameAllowed("sub.example.org")).toBe(false));
    it("裸 IPv6 冒号 authority → URL 解析失败 → 拒绝", () => expect(hostnameAllowed("::1")).toBe(false));
  });

  describe("isLoopbackTarget", () => {
    it("loopback IPv4", () => expect(isLoopbackTarget("127.0.0.1")).toBe(true));
    it("loopback IPv6", () => expect(isLoopbackTarget("::1")).toBe(true));
    it("IPv4-mapped IPv6 loopback", () => expect(isLoopbackTarget("::ffff:127.0.0.1")).toBe(true));
    it("localhost", () => expect(isLoopbackTarget("localhost")).toBe(true));
    it("bracketed IPv6 loopback", () => expect(isLoopbackTarget("[::1]")).toBe(true));
    it("bracketed IPv4 loopback", () => expect(isLoopbackTarget("[127.0.0.1]")).toBe(true));
    it("bracketed mapped loopback", () => expect(isLoopbackTarget("[::ffff:127.0.0.1]")).toBe(true));
    it("非回环拒绝", () => expect(isLoopbackTarget("192.168.1.1")).toBe(false));
    it("DNS 名拒绝", () => expect(isLoopbackTarget("evil.com")).toBe(false));
    it("空串拒绝", () => expect(isLoopbackTarget("")).toBe(false));
    it("非 .1 回环段仍按字面匹配语义拒绝", () => expect(isLoopbackTarget("127.0.0.2")).toBe(false));
  });

  describe("formatAuthority", () => {
    it('formatAuthority("0.0.0.0", 3081) → "0.0.0.0:3081"', () => {
      expect(formatAuthority("0.0.0.0", 3081)).toBe("0.0.0.0:3081");
    });

    it('formatAuthority("::1", 3080) → "[::1]:3080"', () => {
      expect(formatAuthority("::1", 3080)).toBe("[::1]:3080");
    });

    it('formatAuthority("::ffff:10.0.0.1", 9090) → "[::ffff:10.0.0.1]:9090"', () => {
      expect(formatAuthority("::ffff:10.0.0.1", 9090)).toBe("[::ffff:10.0.0.1]:9090");
    });
  });

  describe("rewriteHeaders", () => {
    it("多键重写", () => {
      expect(rewriteHeaders({ host: "x:1", origin: "http://x:1", "x-custom": "v" }, "127.0.0.1:3080")).toEqual({
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
        "x-custom": "v",
      });
    });

    it("Origin https→http", () => {
      expect(rewriteHeaders({ host: "x:1", origin: "https://x:1" }, "127.0.0.1:3080")).toEqual({
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
      });
    });

    it("空头只加 host", () => {
      expect(rewriteHeaders({}, "127.0.0.1:3080")).toEqual({ host: "127.0.0.1:3080" });
    });

    it("多值头（string[]）同样整体覆盖为单值 authority", () => {
      expect(rewriteHeaders({ host: ["a", "b"], origin: ["http://a"] }, "127.0.0.1:9")).toEqual({
        host: "127.0.0.1:9",
        origin: "http://127.0.0.1:9",
      });
    });

    // 原对象不被修改（浅拷贝语义）
    it("入参 headers 不被就地修改", () => {
      const src = { host: "old:1" };
      rewriteHeaders(src, "127.0.0.1:2");
      expect(src.host).toBe("old:1");
    });
  });

  describe("bridgeUpstreamHeaders（issue #379：压缩桥接上游连接入站头透传）", () => {
    it("透传认证/自定义头，重写 Host/Origin，剥离 hop-by-hop 与 WS 握手专有头", () => {
      expect(bridgeUpstreamHeaders({
        host: "192.168.1.50:3081",
        origin: "http://192.168.1.50:3081",
        cookie: "dsh-auth-x=v1.aaa",
        "x-custom": "v",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "AAA=",
        "sec-websocket-version": "13",
        "sec-websocket-extensions": "permessage-deflate",
      }, "127.0.0.1:3080")).toEqual({
        cookie: "dsh-auth-x=v1.aaa",
        "x-custom": "v",
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
      });
    });

    it("空头仍产出回环 Host/Origin（无条件带 origin 与桥接既有行为一致）", () => {
      expect(bridgeUpstreamHeaders({}, "127.0.0.1:3080")).toEqual({
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
      });
    });

    it("多值头（string[]）合并为逗号串", () => {
      expect(bridgeUpstreamHeaders({ cookie: ["a=1", "b=2"] }, "127.0.0.1:1")).toEqual({
        cookie: "a=1, b=2",
        host: "127.0.0.1:1",
        origin: "http://127.0.0.1:1",
      });
    });

    it("入参 headers 不被就地修改", () => {
      const src = { cookie: "c=1" };
      bridgeUpstreamHeaders(src, "127.0.0.1:2");
      expect(src).toEqual({ cookie: "c=1" });
    });

    // 分支补充：大写键名归一化小写、undefined 值跳过、hop-by-hop 全集与 WS 握手头剥离
    it("大写键名归一化、undefined 跳过、Proxy-Authorization/te/trailer/transfer-encoding/sec-websocket-protocol 剥离", () => {
      expect(bridgeUpstreamHeaders({
        Cookie: "c=1",
        "X-Undefined": undefined,
        "Proxy-Authorization": "Basic x",
        te: "trailers",
        trailer: "x-foo",
        "transfer-encoding": "chunked",
        "sec-websocket-protocol": "chat",
      }, "127.0.0.1:3080")).toEqual({
        cookie: "c=1",
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
      });
    });

    // L2（#395）：sec-websocket-accept 是响应头、请求侧不可达，不在剥离集——入站若
    // 恰好携带该头则原样透传（deny 集仅针对请求侧可达头，防回归误加回剥离集）。
    it("sec-websocket-accept 不再被剥离（响应头请求侧不可达）", () => {
      expect(bridgeUpstreamHeaders({ "sec-websocket-accept": "ABC=", cookie: "c=1" }, "127.0.0.1:3080")).toEqual({
        "sec-websocket-accept": "ABC=",
        cookie: "c=1",
        host: "127.0.0.1:3080",
        origin: "http://127.0.0.1:3080",
      });
    });
  });

  describe("compressWsPath", () => {
    it("带查询串命中", () => expect(compressWsPath(["/a", "/b"], "/a?query=1")).toBe(true));
    it("未命中", () => expect(compressWsPath(["/a", "/b"], "/c")).toBe(false));
    it("空列表", () => expect(compressWsPath([], "/a")).toBe(false));
    it("undefined 列表", () => expect(compressWsPath(undefined, "/a")).toBe(false));
    it("空 url", () => expect(compressWsPath(["/a"], "")).toBe(false));
  });

  describe("isCompressible", () => {
    it("problem+json", () => expect(isCompressible("application/problem+json")).toBe(true));
    it("带 charset 的 text", () => expect(isCompressible("text/plain; charset=utf-8")).toBe(true));
    it("SSE 豁免", () => expect(isCompressible("text/event-stream")).toBe(false));
    it("图片不压", () => expect(isCompressible("image/png")).toBe(false));
    it("非字符串不压", () => expect(isCompressible(123)).toBe(false));
  });

  describe("resolveCompressionOptions", () => {
    it("0 → 默认", () => expect(resolveCompressionOptions(0)).toEqual({}));
    it("undefined → 默认", () => expect(resolveCompressionOptions(undefined)).toEqual({}));
    it("字符串 → 默认", () => expect(resolveCompressionOptions("high")).toEqual({}));
    it("null → 默认", () => expect(resolveCompressionOptions(null)).toEqual({}));
  });

  describe("DEFAULT_OPTIONS 常量", () => {
    it('DEFAULT_OPTIONS.host === "0.0.0.0"', () => expect(DEFAULT_OPTIONS.host).toBe("0.0.0.0"));
    it("DEFAULT_OPTIONS.port === 3081", () => expect(DEFAULT_OPTIONS.port).toBe(3081));
    it('DEFAULT_OPTIONS.targetHost === "127.0.0.1"', () => expect(DEFAULT_OPTIONS.targetHost).toBe("127.0.0.1"));
  });
});

// ===== bridgeCompressedWs（WebSocket 压缩桥接）：经真实 LAN 代理间接测试 =====
// 起一个 WS 回显上游 → 创建 LAN 代理（wsCompress 启用，路径命中）→
// 浏览器 WS 客户端经代理连接压缩路径 → 验证双向帧转发。
// bridgeCompressedWs 不可从 index.ts 直接导入（未 re-export），
// 只能经 createLanProxy 的 wsCompress 启用路径间接触发。
describe("bridgeCompressedWs（WebSocket 压缩桥接）", () => {
  let received = [];

  beforeAll(async () => {
    const upServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    upServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
    const upPort = upServer.address().port;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
      wsCompress: { enabled: true, paths: ["/api/remote.mux"] },
    });
    const { httpPort } = await proxy.listen();

    const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/remote.mux`);
    const got = [];
    browserWs.on("message", (data) => { got.push(data.toString()); });
    await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });
    browserWs.send("hello-via-ws-bridge");
    await sleep(300);
    browserWs.close();
    received = got;

    await proxy.close();
    wss.close();
    upServer.close();
  }, 30000);

  it("WS 压缩桥接双向转发：上游回显到浏览器端", () => {
    expect(received).toContain("hello-via-ws-bridge");
  });
});

// ===== 桥接上游连接入站头透传（issue #379 端到端） =====
// dsh 0.1.2 起 /api/remote.mux 升级处理需 Cookie 认证（connection.requestRejection
// → isAuthenticated），桥接若丢弃入站头即 401 拒绝升级、表现为连不上。
// 上游记录 upgrade 请求头；浏览器端模拟真实浏览器（带 cookie + 自定义头 +
// 协商 permessage-deflate）连压缩路径，断言：cookie/自定义头原样透传、
// Host/Origin 重写为回环目标、浏览器段 WS 握手头不透传（无重复头）、
// 浏览器段压缩帧经桥接解压后上游回显可达（压缩与认证互不干扰）。
describe("#379 桥接上游连接入站头透传", () => {
  let echoedValue;
  let upgradeHeaders = null;
  let upPortValue;

  beforeAll(async () => {
    const upServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    upServer.on("upgrade", (req, socket, head) => {
      upgradeHeaders = req.headers;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
    const upPort = upServer.address().port;
    upPortValue = upPort;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
      wsCompress: { enabled: true, paths: ["/api/remote.mux"], probeIntervalMs: 0 },
    });
    const { httpPort } = await proxy.listen();

    const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/remote.mux`, {
      perMessageDeflate: { threshold: 0 }, // 真实浏览器默认协商压缩：强制每一帧都走压缩路径
      headers: {
        cookie: "dsh-auth-test=v1.issue379",
        "x-lan-proxy-probe": "issue-379",
      },
    });
    const echoed = new Promise((resolve) => browserWs.once("message", (d) => resolve(d.toString())));
    await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });
    browserWs.send("headers-probe");
    echoedValue = await echoed;
    browserWs.close();

    await proxy.close();
    wss.close();
    upServer.close();
  }, 30000);

  it("带认证头的桥接连接双向可达（压缩帧解压后转发）", () => {
    expect(echoedValue).toBe("headers-probe");
  });

  it("上游已收到桥接的升级请求", () => {
    expect(upgradeHeaders).toBeTruthy();
  });

  it("cookie 原样透传到上游（认证凭据不丢，issue #379 核心语义）", () => {
    expect(upgradeHeaders.cookie).toBe("dsh-auth-test=v1.issue379");
  });

  it("自定义头同样透传", () => {
    expect(upgradeHeaders["x-lan-proxy-probe"]).toBe("issue-379");
  });

  it("host 重写为回环目标 authority", () => {
    expect(upgradeHeaders.host).toBe(`127.0.0.1:${upPortValue}`);
  });

  it("origin 重写为回环 http 目标", () => {
    expect(upgradeHeaders.origin).toBe(`http://127.0.0.1:${upPortValue}`);
  });

  it("sec-websocket-key 为 ws 库自生成的单一字符串（浏览器段握手头已剥离、无重复头）", () => {
    expect(typeof upgradeHeaders["sec-websocket-key"]).toBe("string");
  });

  it("浏览器段 permessage-deflate 协商头不透传（DSH 段固定明文，避免双重压缩）", () => {
    expect(upgradeHeaders["sec-websocket-extensions"]).toBe(undefined);
  });
});

// ===== 无 cookie 的 WS 桥接升级被上游 401 拒绝（issue #395 L4 组合链路） =====
// 背景：#380 的 token 注入只作用于 HTTP handleRequest，WS 桥接（bridgeCompressedWs）
// 仅透传入站头、本身不铸造 cookie；dsh 0.1.2 起 /api/remote.mux 升级需会话 Cookie
// 认证（connection.requestRejection → isAuthenticated），无 cookie 的上游回 401 且
// 不进入 upgrade 握手 → 桥接表现为连不上。本用例锁定「无 cookie 连压缩路径 → 浏览器
// 端最终 error/close 而非维持 open」防回归。对照：带 cookie 的升级仍成功（上方
// #379 端到端用例已断言双向可达，此处不再重复）。
describe("#395 L4 无 cookie 的 WS 桥接升级被上游 401 拒绝", () => {
  let failedInTime;
  let readyStateAfterFailure;
  let noCookieUpgrades = 0;

  beforeAll(async () => {
    const upServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    upServer.on("upgrade", (req, socket, head) => {
      // 模拟 dsh 行为：无 dsh-auth cookie → 不进入 upgrade 握手，写 HTTP 401 并销毁。
      if (!req.headers.cookie?.includes("dsh-auth-")) {
        noCookieUpgrades += 1;
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
    const upPort = upServer.address().port;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
      wsCompress: { enabled: true, paths: ["/api/remote.mux"], probeIntervalMs: 0 },
    });
    const { httpPort } = await proxy.listen();

    // 浏览器端无 cookie 连压缩路径：不期望成功 open，断言最终以 error/close 失败。
    const events = [];
    const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/remote.mux`);
    browserWs.on("open", () => events.push("open"));
    browserWs.on("error", () => events.push("error"));
    browserWs.on("close", (code) => events.push(`close:${code}`));
    failedInTime = await waitFor(() => events.some((e) => e === "error" || e.startsWith("close:")), 5000);
    readyStateAfterFailure = browserWs.readyState;

    browserWs.close();
    await proxy.close();
    wss.close();
    upServer.close();
  }, 30000);

  it("无 cookie 的桥接升级应在限时内失败（error/close 而非 open）", () => {
    expect(failedInTime).toBeTruthy();
  });

  it("失败后浏览器端不得保持 OPEN", () => {
    expect(readyStateAfterFailure).not.toBe(WsClient.OPEN);
  });

  it("上游确实收到并拒绝了无 cookie 的升级请求（401 拒绝路径触发）", () => {
    expect(noCookieUpgrades >= 1).toBeTruthy();
  });
});

// ===== WS 桥接半开探活（issue #268 P0-1） =====
// 移动端切后台系统静默掐断 TCP 形成半开连接，close/error 永不触发 → 桥接僵死。
// 桥接对两端各自独立探活：interval 发 ping、一个宽限窗内未获 pong 即 terminate
// （terminate 使 close 语义成立 → 既有互断逻辑级联收口另一端）。三条断言：
//   1. ping 帧按间隔发出；2. pong 缺失触发 terminate（两端各测）；3. pong 正常时连接保持。
// 全 localhost 无外网；小间隔经 wsCompress.probeIntervalMs 注入（生产默认 30s）。

// —— 断言 1 + 3：真 echo 上游（ws 库自动回 pong）→ ping 按间隔到达、连接不被误杀 ——
describe("#268 P0-1 探活断言 1+3：ping 按间隔发出、pong 正常不误杀", () => {
  let pingsReachedTwo;
  let pingGapInRange;
  let upstreamPingsReachedTwo;
  let readyStateAlive;
  let echoedAlive;

  beforeAll(async () => {
    const upServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    let upstreamPings = 0; // 真 echo 上游收到的 ping 帧数 = 上游段探活按间隔发出
    upServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("ping", () => { upstreamPings += 1; });
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
    const upPort = upServer.address().port;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
      wsCompress: { enabled: true, paths: ["/api/events.mux"], probeIntervalMs: 80 },
    });
    const { httpPort } = await proxy.listen();

    const pings = []; // 浏览器端收到 ping 的时刻 = 浏览器段探活按间隔发出
    const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/events.mux`);
    browserWs.on("ping", () => { pings.push(Date.now()); });
    await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });

    // 断言 1：ping 帧按间隔发出（浏览器段 ≥2 帧且相邻间距贴近 interval：
    // 下界 60ms 排除风暴式连发，上界 interval×10 宽松兜底慢机调度抖动防 flake）
    pingsReachedTwo = await waitFor(() => pings.length >= 2, 4000);
    pingGapInRange = pings[1] - pings[0] >= 60 && pings[1] - pings[0] <= 800;
    // 断言 3：pong 正常（两端 ws 库自动回 pong）→ 多周期后不误杀且消息双向可达
    upstreamPingsReachedTwo = await waitFor(() => upstreamPings >= 2, 4000);
    readyStateAlive = browserWs.readyState;
    const echoed = new Promise((resolve) => browserWs.once("message", (d) => resolve(d.toString())));
    browserWs.send("probe-alive-check");
    echoedAlive = await echoed;

    browserWs.close();
    await proxy.close();
    wss.close();
    upServer.close();
  }, 30000);

  it("探活 ping 应按间隔到达浏览器端（4s 内至少 2 帧）", () => {
    expect(pingsReachedTwo).toBeTruthy();
  });

  it("相邻 ping 间隔应贴近 interval=80ms", () => {
    expect(pingGapInRange).toBeTruthy();
  });

  it("上游段探活也应按间隔发 ping（4s 内上游至少 2 帧）", () => {
    expect(upstreamPingsReachedTwo).toBeTruthy();
  });

  it("pong 正常时连接保持 OPEN 不被误杀", () => {
    expect(readyStateAlive).toBe(WsClient.OPEN);
  });

  it("多探活周期后消息双向仍通", () => {
    expect(echoedAlive).toBe("probe-alive-check");
  });
});

// —— 断言 2a：上游段 pong 缺失 → terminate 上游 → 级联关闭浏览器端 ——
// raw 假上游完成 RFC6455 握手后保持打开但对一切帧沉默（无 ws 库不会自动回
// pong）→ 上游段探活超时 terminate → close 互断逻辑关闭浏览器端（1006）。
describe("#268 P0-1 探活断言 2a：上游段 pong 缺失 → terminate 上游", () => {
  let closeObserved;
  let closeCode = null;

  beforeAll(async () => {
    const silentServer = createServer((req, res) => res.destroy());
    silentServer.on("upgrade", (req, socket) => {
      socket.write(wsHandshakeResponse(req.headers["sec-websocket-key"]));
    });
    await new Promise((r) => silentServer.listen(0, "127.0.0.1", r));
    const silentPort = silentServer.address().port;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: silentPort,
      wsCompress: { enabled: true, paths: ["/api/events.mux"], probeIntervalMs: 80 },
    });
    const { httpPort } = await proxy.listen();

    const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/events.mux`);
    browserWs.on("close", (code) => { closeCode = code; });
    await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });

    closeObserved = await waitFor(() => closeCode !== null, 5000);

    await proxy.close();
    silentServer.close();
  }, 30000);

  it("上游 pong 缺失应在一个宽限窗后触发 terminate 并级联关闭浏览器端（5s 未收到 close）", () => {
    expect(closeObserved).toBeTruthy();
  });

  it("terminate 应表现为异常关闭 1006", () => {
    expect(closeCode).toBe(1006);
  });
});

// —— 断言 2b：浏览器段 pong 缺失 → terminate 浏览器端 → 互断逻辑级联关闭上游 ——
// raw 假客户端经 node:http upgrade 拿裸 socket（不回 pong）连压缩白名单路径。
describe("#268 P0-1 探活断言 2b：浏览器段 pong 缺失 → terminate 浏览器端", () => {
  let rawSocketHandshakeOk;
  let upstreamClosed;

  beforeAll(async () => {
    const upServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    let closed = false;
    upServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
        ws.on("close", () => { closed = true; });
      });
    });
    await new Promise((r) => upServer.listen(0, "127.0.0.1", r));
    const upPort = upServer.address().port;

    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
      wsCompress: { enabled: true, paths: ["/api/events.host"], probeIntervalMs: 80 },
    });
    const { httpPort } = await proxy.listen();

    const req = httpRequest({
      hostname: "127.0.0.1", port: httpPort, path: "/api/events.host",
      headers: {
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
        host: `127.0.0.1:${httpPort}`,
      },
    });
    req.end();
    const rawSocket = await new Promise((resolve, reject) => {
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
    });
    rawSocketHandshakeOk = rawSocket.readable && !rawSocket.destroyed;

    // 断言 2b：浏览器段 pong 缺失 → 探活超时 terminate 浏览器端 → 既有互断逻辑
    // 级联关闭上游。upstream close 即 terminate 成立的下游证据（raw client 自身
    // 不发 close 帧、不主动断开，上游被关只能经由 browserWs close → upstreamWs.close；
    // 不以 rawSocket 属性为断言——半关闭 TCP 状态下其 destroyed/readable 翻转不可靠）。
    upstreamClosed = await waitFor(() => closed, 5000);

    await proxy.close();
    wss.close();
    upServer.close();
  }, 30000);

  it("raw 客户端已完成 101 握手（桥接已建立）", () => {
    expect(rawSocketHandshakeOk).toBeTruthy();
  });

  it("浏览器段 pong 缺失应触发探活 terminate 并级联关闭上游连接", () => {
    expect(upstreamClosed).toBeTruthy();
  });
});

// ===== createLanProxy 转发错误处理（proxy error → 502） =====
describe("createLanProxy 转发错误处理（proxy error → 502）", () => {
  let res;

  beforeAll(async () => {
    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 1, // 1 端口不可达
    });
    const { httpPort } = await proxy.listen();
    res = await new Promise((resolve) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port: httpPort, path: "/any", method: "GET", headers: { host: "127.0.0.1" } },
        (res2) => {
          let body = "";
          res2.on("data", (c) => (body += c));
          res2.on("end", () => resolve({ status: res2.statusCode, body }));
        },
      );
      req.on("error", (e) => resolve({ status: 0, body: e.message }));
      req.end();
    });
    await proxy.close();
  }, 30000);

  it("不可达上游应 502", () => {
    expect(res.status).toBe(502);
  });
});

// ===== createLanProxy 围栏：非回环 targetHost =====
describe("createLanProxy 围栏：非回环 targetHost", () => {
  it("非回环 targetHost 拒绝启动（防开放转发）", () => {
    expect(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "evil.com", targetPort: 3080 }))
      .toThrow(/仅允许回环/);
  });
});

// ===== createLanProxy 非法 targetPort =====
describe("createLanProxy 非法 targetPort", () => {
  it("targetPort=0 越下界拒绝", () => {
    expect(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 0 })).toThrow(/valid port/);
  });

  it("targetPort=70000 越上界拒绝", () => {
    expect(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 70000 })).toThrow(/valid port/);
  });

  it("targetPort=-1 负数拒绝", () => {
    expect(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: -1 })).toThrow(/valid port/);
  });
});

// ===== createLanProxy HTTPS 降级 =====
// 占用一个端口 → HTTPS 绑定失败 → 降级 HTTP-only（httpPort 返回、httpsPort 不返回）
describe("createLanProxy HTTPS 降级", () => {
  let result;
  let httpListening;

  beforeAll(async () => {
    const occupied = createServer();
    await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
    const occupiedPort = occupied.address().port;

    const certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-httpsfail-"));
    const tls = ensureSelfSignedTls({ dir: certDir, extraSans: [] });
    const proxy = createLanProxy({
      host: "127.0.0.1", port: 0, httpsPort: occupiedPort, tls, targetHost: "127.0.0.1", targetPort: 1,
    });
    result = await proxy.listen();
    httpListening = proxy.server.listening;
    await proxy.close();
    occupied.close();
    rmSync(certDir, { recursive: true, force: true });
  }, 30000);

  it("HTTPS 绑定失败 → 结果无 httpsPort", () => {
    expect(result.httpsPort).toBe(undefined);
  });

  it("HTTP 仍可用", () => {
    expect(result.httpPort > 0).toBeTruthy();
  });

  it("HTTP 服务器仍在监听", () => {
    expect(httpListening).toBeTruthy();
  });
});

// ===== wsBridgeEnabled 三态路径选择（issue #552 解耦） =====
// 判别依据 connStats：桥接任一端 close → wsBridgeClosed+1；透传 socket 销毁 →
// wsPassthroughDestroyed+1。三种配置各建一条 WS 连接后关闭，断言走了预期路径：
//   a) wsBridge=false + 命中压缩白名单 → 透传（wsPassthroughDestroyed 增长）；
//   b) wsBridge=true + 未命中白名单 → 仍桥接（wsBridgeClosed 增长）；
//   c) wsBridge 缺省（旧行为兼容）→ 命中走桥接、未命中走透传。
describe("wsBridgeEnabled 三态路径选择（issue #552 解耦）", () => {
  // a) wsBridge=false：命中白名单路径也走透传
  describe("a) wsBridge=false", () => {
    let got = [];
    let cs;

    beforeAll(async () => {
      const u = await mkUpstream();
      const proxy = createLanProxy({
        host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: u.upPort,
        wsBridge: { enabled: false },
        wsCompress: { enabled: true, paths: ["/api/remote.mux"], probeIntervalMs: 0 },
      });
      const { httpPort } = await proxy.listen();
      got = await openAndEcho(httpPort, "/api/remote.mux");
      cs = proxy.connStats();
      await proxy.close(); u.wss.close(); u.upServer.close();
    }, 30000);

    it("wsBridge=false 命中白名单仍可转发（透传）", () => {
      expect(got.some((s) => s.startsWith("ping-/api/remote.mux"))).toBeTruthy();
    });

    it("wsBridge=false → 透传计数增长", () => {
      expect(cs.wsPassthroughDestroyed >= 1).toBeTruthy();
    });

    it("wsBridge=false → 不产生桥接连接", () => {
      expect(cs.wsBridgeClosed).toBe(0);
    });
  });

  // b) wsBridge=true：未命中白名单路径也走桥接（保活基座不依赖压缩白名单）
  describe("b) wsBridge=true", () => {
    let got = [];
    let cs;

    beforeAll(async () => {
      const u = await mkUpstream();
      const proxy = createLanProxy({
        host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: u.upPort,
        wsBridge: { enabled: true },
        wsCompress: { enabled: true, paths: ["/api/remote.mux"], probeIntervalMs: 0 },
      });
      const { httpPort } = await proxy.listen();
      got = await openAndEcho(httpPort, "/api/other");
      cs = proxy.connStats();
      await proxy.close(); u.wss.close(); u.upServer.close();
    }, 30000);

    it("wsBridge=true 未命中白名单仍可转发（桥接明文）", () => {
      expect(got.some((s) => s.startsWith("ping-/api/other"))).toBeTruthy();
    });

    it("wsBridge=true → 桥接计数增长", () => {
      expect(cs.wsBridgeClosed >= 1).toBeTruthy();
    });

    it("wsBridge=true → 不产生透传连接", () => {
      expect(cs.wsPassthroughDestroyed).toBe(0);
    });
  });

  // c) wsBridge 缺省（旧行为兼容）：命中白名单走桥接、未命中走透传
  describe("c) wsBridge 缺省（旧行为兼容）", () => {
    let cs;

    beforeAll(async () => {
      const u = await mkUpstream();
      const proxy = createLanProxy({
        host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: u.upPort,
        wsCompress: { enabled: true, paths: ["/api/remote.mux"], probeIntervalMs: 0 },
      });
      const { httpPort } = await proxy.listen();
      await openAndEcho(httpPort, "/api/remote.mux");   // 命中 → 桥接
      await openAndEcho(httpPort, "/api/other");        // 未命中 → 透传
      cs = proxy.connStats();
      await proxy.close(); u.wss.close(); u.upServer.close();
    }, 30000);

    it("缺省 wsBridge：命中白名单走桥接", () => {
      expect(cs.wsBridgeClosed >= 1).toBeTruthy();
    });

    it("缺省 wsBridge：未命中白名单走透传", () => {
      expect(cs.wsPassthroughDestroyed >= 1).toBeTruthy();
    });
  });
});
