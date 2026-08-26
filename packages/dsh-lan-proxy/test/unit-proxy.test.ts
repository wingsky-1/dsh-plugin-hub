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
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { constants as zlibConstants } from "node:zlib";

import {
  hostnameAllowed, formatAuthority, rewriteHeaders, createLanProxy, isLoopbackTarget,
  DEFAULT_OPTIONS, compressWsPath, isCompressible, resolveCompressionOptions,
  ensureSelfSignedTls,
} from "../src/index.ts";
import {
  toSanEntry, certStillValid, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT,
} from "../src/index.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 纯函数边界用例 =====

// hostnameAllowed
assert.equal(hostnameAllowed("127.0.0.1"), true, "bare IPv4");
assert.equal(hostnameAllowed("[::1]"), true, "bracketed IPv6");
assert.equal(hostnameAllowed(""), false, "empty string");
assert.equal(hostnameAllowed(undefined), false, "非字符串（undefined）→ 拒绝");
assert.equal(hostnameAllowed("0.0.0.0"), true, "any IPv4");
assert.equal(hostnameAllowed("192.168.1.1"), true, "LAN IPv4");
assert.equal(hostnameAllowed("127.0.0.1:99999"), false, "端口越界 → URL 解析失败 → 拒绝");
assert.equal(hostnameAllowed("localhost"), true, "localhost 字面量放行");
assert.equal(hostnameAllowed("localhost:3080"), true, "localhost 带端口放行");
assert.equal(hostnameAllowed("[::1]:443"), true, "bracketed IPv6 带端口放行");
assert.equal(hostnameAllowed("example.com"), false, "DNS 域名拒绝（重绑定防护核心语义）");
assert.equal(hostnameAllowed("sub.example.org"), false, "多级 DNS 域名拒绝");
assert.equal(hostnameAllowed("::1"), false, "裸 IPv6 冒号 authority → URL 解析失败 → 拒绝");

// isLoopbackTarget
assert.equal(isLoopbackTarget("127.0.0.1"), true, "loopback IPv4");
assert.equal(isLoopbackTarget("::1"), true, "loopback IPv6");
assert.equal(isLoopbackTarget("::ffff:127.0.0.1"), true, "IPv4-mapped IPv6 loopback");
assert.equal(isLoopbackTarget("localhost"), true, "localhost");
assert.equal(isLoopbackTarget("[::1]"), true, "bracketed IPv6 loopback");
assert.equal(isLoopbackTarget("[127.0.0.1]"), true, "bracketed IPv4 loopback");
assert.equal(isLoopbackTarget("[::ffff:127.0.0.1]"), true, "bracketed mapped loopback");
assert.equal(isLoopbackTarget("192.168.1.1"), false, "非回环拒绝");
assert.equal(isLoopbackTarget("evil.com"), false, "DNS 名拒绝");
assert.equal(isLoopbackTarget(""), false, "空串拒绝");
assert.equal(isLoopbackTarget("127.0.0.2"), false, "非 .1 回环段仍按字面匹配语义拒绝");

// formatAuthority
assert.equal(formatAuthority("0.0.0.0", 3081), "0.0.0.0:3081");
assert.equal(formatAuthority("::1", 3080), "[::1]:3080");
assert.equal(formatAuthority("::ffff:10.0.0.1", 9090), "[::ffff:10.0.0.1]:9090");

// rewriteHeaders
assert.deepEqual(rewriteHeaders({ host: "x:1", origin: "http://x:1", "x-custom": "v" }, "127.0.0.1:3080"), {
  host: "127.0.0.1:3080",
  origin: "http://127.0.0.1:3080",
  "x-custom": "v",
}, "多键重写");
assert.deepEqual(rewriteHeaders({ host: "x:1", origin: "https://x:1" }, "127.0.0.1:3080"), {
  host: "127.0.0.1:3080",
  origin: "http://127.0.0.1:3080",
}, "Origin https→http");
assert.deepEqual(rewriteHeaders({}, "127.0.0.1:3080"), { host: "127.0.0.1:3080" }, "空头只加 host");
assert.deepEqual(rewriteHeaders({ host: ["a", "b"], origin: ["http://a"] }, "127.0.0.1:9"), {
  host: "127.0.0.1:9",
  origin: "http://127.0.0.1:9",
}, "多值头（string[]）同样整体覆盖为单值 authority");
// 原对象不被修改（浅拷贝语义）
{
  const src = { host: "old:1" };
  rewriteHeaders(src, "127.0.0.1:2");
  assert.equal(src.host, "old:1", "入参 headers 不被就地修改");
}

// compressWsPath
assert.equal(compressWsPath(["/a", "/b"], "/a?query=1"), true, "带查询串命中");
assert.equal(compressWsPath(["/a", "/b"], "/c"), false, "未命中");
assert.equal(compressWsPath([], "/a"), false, "空列表");
assert.equal(compressWsPath(undefined, "/a"), false, "undefined 列表");
assert.equal(compressWsPath(["/a"], ""), false, "空 url");

// isCompressible
assert.equal(isCompressible("application/problem+json"), true, "problem+json");
assert.equal(isCompressible("text/plain; charset=utf-8"), true, "带 charset 的 text");
assert.equal(isCompressible("text/event-stream"), false, "SSE 豁免");
assert.equal(isCompressible("image/png"), false, "图片不压");
assert.equal(isCompressible(123), false, "非字符串不压");

// resolveCompressionOptions
assert.deepEqual(resolveCompressionOptions(0), {}, "0 → 默认");
assert.deepEqual(resolveCompressionOptions(undefined), {}, "undefined → 默认");
assert.deepEqual(resolveCompressionOptions("high"), {}, "字符串 → 默认");
assert.deepEqual(resolveCompressionOptions(null), {}, "null → 默认");

// DEFAULT_OPTIONS 常量
assert.equal(DEFAULT_OPTIONS.host, "0.0.0.0");
assert.equal(DEFAULT_OPTIONS.port, 3081);
assert.equal(DEFAULT_OPTIONS.targetHost, "127.0.0.1");

// ===== bridgeCompressedWs（WebSocket 压缩桥接）：经真实 LAN 代理间接测试 =====
// 起一个 WS 回显上游 → 创建 LAN 代理（wsCompress 启用，路径命中）→
// 浏览器 WS 客户端经代理连接压缩路径 → 验证双向帧转发。
// bridgeCompressedWs 不可从 index.ts 直接导入（未 re-export），
// 只能经 createLanProxy 的 wsCompress 启用路径间接触发。
{
  const { WebSocketServer, WebSocket: WsClient } = await import("ws");

  const upPort = 19790 + Math.floor(Math.random() * 100);
  const upServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  upServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  await new Promise((r) => upServer.listen(upPort, "127.0.0.1", r));

  const proxy = createLanProxy({
    host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
    wsCompress: { enabled: true, paths: ["/api/events.mux", "/api/events.host"] },
  });
  const { httpPort } = await proxy.listen();

  const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/events.mux`);
  const received = [];
  browserWs.on("message", (data) => { received.push(data.toString()); });
  await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });
  browserWs.send("hello-via-ws-bridge");
  await sleep(300);
  browserWs.close();

  assert.ok(received.includes("hello-via-ws-bridge"),
    `WS 压缩桥接双向转发：上游回显到浏览器端（收到 ${JSON.stringify(received)}）`);

  await proxy.close();
  wss.close();
  upServer.close();
}

// ===== createLanProxy 转发错误处理（proxy error → 502） =====
{
  const proxy = createLanProxy({
    host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 1, // 1 端口不可达
  });
  const { httpPort } = await proxy.listen();
  const res = await new Promise((resolve) => {
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
  assert.equal(res.status, 502, `不可达上游应 502，实际 ${res.status} ${res.body}`);
  await proxy.close();
}

// ===== createLanProxy 围栏：非回环 targetHost =====
{
  assert.throws(
    () => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "evil.com", targetPort: 3080 }),
    /仅允许回环/,
    "非回环 targetHost 拒绝启动（防开放转发）",
  );
}

// ===== createLanProxy 非法 targetPort =====
{
  assert.throws(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 0 }), /valid port/);
  assert.throws(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: 70000 }), /valid port/);
  assert.throws(() => createLanProxy({ host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: -1 }), /valid port/);
}

// ===== createLanProxy HTTPS 降级 =====
// 占用一个端口 → HTTPS 绑定失败 → 降级 HTTP-only（httpPort 返回、httpsPort 不返回）
{
  const occupied = createServer();
  await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
  const occupiedPort = occupied.address().port;

  const certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-httpsfail-"));
  const tls = ensureSelfSignedTls({ dir: certDir, extraSans: [] });
  const proxy = createLanProxy({
    host: "127.0.0.1", port: 0, httpsPort: occupiedPort, tls, targetHost: "127.0.0.1", targetPort: 1,
  });
  const result = await proxy.listen();
  assert.equal(result.httpsPort, undefined, "HTTPS 绑定失败 → 结果无 httpsPort");
  assert.ok(result.httpPort > 0, "HTTP 仍可用");
  assert.ok(proxy.server.listening, "HTTP 服务器仍在监听");
  await proxy.close();
  occupied.close();
  rmSync(certDir, { recursive: true, force: true });
}

console.log("[unit-proxy] all passed ✓");