// @ts-nocheck
/**
 * dsh-lan-proxy — 转发核心（src/proxy.ts）结构化单测。
 *
 * 覆盖本批未覆盖热点：
 * - bridgeCompressedWs：WebSocket 压缩桥接（真实 WS 连接，全 localhost，无外网）
 * - createLanProxy 转发错误处理（不可达上游 → 502，proxy error 分支）
 * - createLanProxy HTTPS 降级（HTTPS 端口被占 → HTTP-only）
 * - createLanProxy 围栏与参数校验（非回环 targetHost / 非法 targetPort）
 * - injectToken（issue #380）：token 注入判定纯函数 + 端到端注入与 401 重放自愈
 * - 纯函数边界用例（hostnameAllowed / isLoopbackTarget / formatAuthority /
 *   rewriteHeaders / compressWsPath / isCompressible / resolveCompressionOptions）
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { constants as zlibConstants } from "node:zlib";

import {
  hostnameAllowed, formatAuthority, rewriteHeaders, bridgeUpstreamHeaders, createLanProxy, isLoopbackTarget,
  DEFAULT_OPTIONS, compressWsPath, isCompressible, resolveCompressionOptions,
  ensureSelfSignedTls, deflateAllowedByPolicy, DEFAULT_DEFLATE_POLICY,
  hasDshAuthCookie, isTokenMintCandidate, withLaunchToken,
} from "../src/index.ts";
import {
  toSanEntry, certStillValid, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT,
} from "../src/index.ts";

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

// bridgeUpstreamHeaders（issue #379：压缩桥接上游连接入站头透传）
assert.deepEqual(bridgeUpstreamHeaders({
  host: "192.168.1.50:3081",
  origin: "http://192.168.1.50:3081",
  cookie: "dsh-auth-x=v1.aaa",
  "x-custom": "v",
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "AAA=",
  "sec-websocket-version": "13",
  "sec-websocket-extensions": "permessage-deflate",
}, "127.0.0.1:3080"), {
  cookie: "dsh-auth-x=v1.aaa",
  "x-custom": "v",
  host: "127.0.0.1:3080",
  origin: "http://127.0.0.1:3080",
}, "透传认证/自定义头，重写 Host/Origin，剥离 hop-by-hop 与 WS 握手专有头");
assert.deepEqual(bridgeUpstreamHeaders({}, "127.0.0.1:3080"), {
  host: "127.0.0.1:3080",
  origin: "http://127.0.0.1:3080",
}, "空头仍产出回环 Host/Origin（无条件带 origin 与桥接既有行为一致）");
assert.deepEqual(bridgeUpstreamHeaders({ cookie: ["a=1", "b=2"] }, "127.0.0.1:1"), {
  cookie: "a=1, b=2",
  host: "127.0.0.1:1",
  origin: "http://127.0.0.1:1",
}, "多值头（string[]）合并为逗号串");
{
  const src = { cookie: "c=1" };
  bridgeUpstreamHeaders(src, "127.0.0.1:2");
  assert.deepEqual(src, { cookie: "c=1" }, "入参 headers 不被就地修改");
}
// 分支补充：大写键名归一化小写、undefined 值跳过、hop-by-hop 全集与 WS 握手头剥离
assert.deepEqual(bridgeUpstreamHeaders({
  Cookie: "c=1",
  "X-Undefined": undefined,
  "Proxy-Authorization": "Basic x",
  te: "trailers",
  trailer: "x-foo",
  "transfer-encoding": "chunked",
  "sec-websocket-protocol": "chat",
}, "127.0.0.1:3080"), {
  cookie: "c=1",
  host: "127.0.0.1:3080",
  origin: "http://127.0.0.1:3080",
}, "大写键名归一化、undefined 跳过、Proxy-Authorization/te/trailer/transfer-encoding/sec-websocket-protocol 剥离");

// compressWsPath
assert.equal(compressWsPath(["/a", "/b"], "/a?query=1"), true, "带查询串命中");
assert.equal(compressWsPath(["/a", "/b"], "/c"), false, "未命中");
assert.equal(compressWsPath([], "/a"), false, "空列表");
assert.equal(compressWsPath(undefined, "/a"), false, "undefined 列表");
assert.equal(compressWsPath(["/a"], ""), false, "空 url");

// ===== injectToken 纯函数（issue #380） =====
// hasDshAuthCookie：按 RFC 6265 名字精确分段（禁整头子串匹配）
assert.equal(hasDshAuthCookie(undefined), false, "无 Cookie 头 → false");
assert.equal(hasDshAuthCookie(""), false, "空 Cookie 头 → false");
assert.equal(hasDshAuthCookie("dsh-auth-abc=1"), true, "单 cookie 前缀命中");
assert.equal(hasDshAuthCookie("a=1; dsh-auth-abc=1; b=2"), true, "多 cookie 中段命中");
assert.equal(hasDshAuthCookie("a=1;dsh-auth-abc=1"), true, "无空格分段命中");
assert.equal(hasDshAuthCookie(" x = 1 ; dsh-auth-x=y "), true, "名字两侧空格 trim 后命中");
assert.equal(hasDshAuthCookie("theme=dsh-auth-x"), false, "值含前缀但名字不含 → 不命中（防 includes 误判）");
assert.equal(hasDshAuthCookie("Xdsh-auth-a=1"), false, "名字仅后缀含前缀 → 不命中");
assert.equal(hasDshAuthCookie("dsh-auth-=novalue"), true, "空值 cookie 名前缀仍命中");
assert.equal(hasDshAuthCookie("nodalue"), false, "无 = 段跳过");
assert.equal(hasDshAuthCookie(["a=1", "dsh-auth-b=2"]), true, "string[] 多值头命中");

// isTokenMintCandidate：GET 且路径恰为 / 且无 token 参数
assert.equal(isTokenMintCandidate("GET", "/"), true, "GET / → 候选");
assert.equal(isTokenMintCandidate("GET", "/?foo=bar"), true, "GET / 带其他 query → 候选");
assert.equal(isTokenMintCandidate("GET", "/?token=own"), false, "已带 token → 非候选");
assert.equal(isTokenMintCandidate("GET", "/foo"), false, "非根路径 → 非候选");
assert.equal(isTokenMintCandidate("POST", "/"), false, "POST → 非候选");
assert.equal(isTokenMintCandidate("HEAD", "/"), false, "HEAD → 非候选（上游只认 GET 铸造）");
assert.equal(isTokenMintCandidate(undefined, "/"), false, "method 缺失 → 非候选");
assert.equal(isTokenMintCandidate("GET", undefined), false, "url 缺失 → 非候选");

// withLaunchToken：token 并入 query（保留原 query；解析失败 undefined）
assert.equal(withLaunchToken("/", "T1"), "/?token=T1", "根路径注入");
assert.equal(withLaunchToken("/?a=1", "T1"), "/?a=1&token=T1", "保留原 query");
assert.equal(withLaunchToken("/?token=old", "T1"), "/?token=T1", "已带 token 时覆盖");
assert.equal(withLaunchToken(undefined, "T1"), undefined, "url 缺失 → undefined");

// ===== injectToken 端到端（issue #380）：注入 + 401 重放自愈 =====
// mock 上游语义（对齐 dsh-client-connection.authorizeIndex 行为契约）：
//   带 token=T0K3N 的 GET / → 303 + Set-Cookie（铸造）；无 token →
//   有效 cookie（dsh-auth-good）→ 200；否则 401。seen 记录上游实际收到的
//   url / sec-fetch-site / cookie，作为注入与透传断言的单一事实源。
{
  const seen = [];
  const upPort = 21000 + Math.floor(Math.random() * 100);
  const upServer = createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push({ url, secFetchSite: req.headers["sec-fetch-site"], cookie: req.headers.cookie ?? "" });
    const token = new URL(url, "http://upstream.invalid").searchParams.get("token");
    if (token === "T0K3N") {
      res.writeHead(303, { location: "/", "set-cookie": "dsh-auth-minted=1; Path=/; Max-Age=3600" });
      res.end();
      return;
    }
    if (req.headers.cookie?.includes("dsh-auth-good")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>ok</html>");
      return;
    }
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  await new Promise((r) => upServer.listen(upPort, "127.0.0.1", r));

  // 可变闭包 provider：覆盖「provider 后到」时序（转发器先起、token 后就绪）。
  let token: string | undefined = "T0K3N";
  const proxy = createLanProxy({
    host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: upPort,
    injectToken: { getToken: () => token },
  });
  const { httpPort } = await proxy.listen();
  const get = (path, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port: httpPort, path, method, headers: { host: "127.0.0.1", ...headers } },
        (res2) => {
          let body = "";
          res2.on("data", (c) => (body += c));
          res2.on("end", () => resolve({ status: res2.statusCode, headers: res2.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const last = () => seen[seen.length - 1];

  // 1. 铸造候选（无 cookie GET /）→ 注入 token，上游收 ?token=T0K3N，客户端得 303
  {
    const r = await get("/");
    assert.equal(last().url, "/?token=T0K3N", `铸造候选应注入当前 token（实际 ${last().url}）`);
    assert.equal(r.status, 303, "铸造候选最终得到上游 303（Set-Cookie 透传）");
    assert.ok(String(r.headers["set-cookie"] ?? "").includes("dsh-auth-minted"), "303 响应携带铸造 Set-Cookie");
  }
  // 2. 有效 cookie → 绝不注入（否则无限 303），200 原样透传（selfHandle 手动管道）
  {
    const r = await get("/", { cookie: "dsh-auth-good=1" });
    assert.equal(last().url, "/", "有效 cookie 请求不得注入（打破 303 循环的正确性必需）");
    assert.equal(r.status, 200, "有效 cookie → 上游 200 透传");
    assert.equal(r.body, "<html>ok</html>", "selfHandle 管道 body 完整");
    assert.equal(r.headers["content-type"], "text/html", "selfHandle 管道响应头保留");
  }
  // 3. 失效 cookie → 上游 401 → 重放一次（带 token）→ 客户端得 303 自愈
  {
    const r = await get("/", { cookie: "dsh-auth-stale=1" });
    assert.equal(seen[seen.length - 2].url, "/", "失效 cookie 首跳不注入（候选排除）");
    assert.equal(last().url, "/?token=T0K3N", "401 后应带 token 重放一次");
    assert.equal(r.status, 303, "重放后客户端得到 303（重铸 cookie 自愈）");
    assert.ok(String(r.headers["set-cookie"] ?? "").includes("dsh-auth-minted"), "重放 303 携带新铸造 Set-Cookie");
  }
  // 4. 已带 token → 不重复注入（保留用户 token，候选条件排除）
  {
    const r = await get("/?token=MINE", { cookie: "dsh-auth-good=1" });
    assert.equal(last().url, "/?token=MINE", "已带 token 的请求不被覆盖");
    assert.equal(r.status, 200, "已带 token + 有效 cookie → 正常 200");
  }
  // 5. POST / → 不注入
  {
    const r = await get("/", {}, "POST");
    assert.equal(last().url, "/", "POST 不注入");
    assert.equal(r.status, 401, "POST 无 cookie → 上游 401 原样透传");
  }
  // 6. 非根路径 → 不注入
  {
    const r = await get("/foo");
    assert.equal(last().url, "/foo", "非根路径不注入");
    assert.equal(r.status, 401, "非根路径无 cookie → 401 原样透传");
  }
  // 7. provider 未就绪（返回 undefined）→ 降级不注入（行为与未开启一致）
  {
    token = undefined;
    const r = await get("/");
    assert.equal(last().url, "/", "provider 未就绪 → 不注入");
    assert.equal(r.status, 401, "降级路径 401 原样透传");
    token = "T0K3N";
  }
  // 8. sec-fetch-site 头透传不被注入逻辑破坏
  {
    await get("/", { "sec-fetch-site": "same-origin" });
    assert.equal(last().secFetchSite, "same-origin", "sec-fetch-site 原样透传");
  }
  // 9. 值含 dsh-auth- 前缀的其它 cookie → 名字精确解析不误判，仍注入
  {
    const r = await get("/", { cookie: "theme=dsh-auth-x" });
    assert.equal(last().url, "/?token=T0K3N", "值含前缀的无关 cookie 不阻断注入");
    assert.equal(r.status, 303, "注入链路正常完成");
  }

  await proxy.close();
  upServer.close();
}

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

// ===== deflateAllowedByPolicy（issue #308：WS 压缩协商策略；纯函数） =====
{
  // 无策略（缺省宽松）：放行
  assert.equal(deflateAllowedByPolicy(undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), true, "无策略 → 放行");
  assert.equal(deflateAllowedByPolicy({}, undefined), true, "空策略 + 无 UA → 放行");
  // browser=false 全局关
  assert.equal(deflateAllowedByPolicy({ browser: false }, "Chrome/120"), false, "browser=false → 全局拒绝");
  // uaDeny 命中（默认 iOS 三件套）
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), false, "默认策略拦截 iPhone");
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), false, "默认策略拦截 iPad");
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)"), false, "默认策略拦截 iPod");
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"), true, "桌面 Chrome 放行");
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15"), true, "桌面 Safari 放行");
  // uaDeny 空数组 → 放行
  assert.equal(deflateAllowedByPolicy({ uaDeny: [] }, "iPhone"), true, "uaDeny 空数组 → 放行");
  // UA 缺失
  assert.equal(deflateAllowedByPolicy(DEFAULT_DEFLATE_POLICY, undefined), true, "UA 缺失 → 放行");
  // 自定义 deny 片段
  assert.equal(deflateAllowedByPolicy({ uaDeny: ["Android"] }, "Mozilla/5.0 (Linux; Android 14)"), false, "自定义 deny 命中 Android");
}

// ===== ConnStats 结构（issue #308：断连计数快照兼容性） =====
{
  const proxy = createLanProxy({
    host: "127.0.0.1",
    port: 0,
    targetHost: "127.0.0.1",
    targetPort: 65534, // 不可达上游：仅用于拿实例结构，不实际转发
  });
  const c = proxy.connStats();
  for (const key of ["wsBridgeClosed", "wsBridgeHalfOpen", "wsBridgeErrors", "wsPassthroughDestroyed", "wsPassthroughErrors", "httpClientAborted", "httpProxyErrors"] as const) {
    assert.equal(typeof c[key], "number", `connStats.${key} 为数字`);
    assert.equal(c[key], 0, `connStats.${key} 初始为 0`);
  }
  proxy.close();
}

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
    wsCompress: { enabled: true, paths: ["/api/remote.mux"] },
  });
  const { httpPort } = await proxy.listen();

  const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/remote.mux`);
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

// ===== 桥接上游连接入站头透传（issue #379 端到端） =====
// dsh 0.1.2 起 /api/remote.mux 升级处理需 Cookie 认证（connection.requestRejection
// → isAuthenticated），桥接若丢弃入站头即 401 拒绝升级、表现为连不上。
// 上游记录 upgrade 请求头；浏览器端模拟真实浏览器（带 cookie + 自定义头 +
// 协商 permessage-deflate）连压缩路径，断言：cookie/自定义头原样透传、
// Host/Origin 重写为回环目标、浏览器段 WS 握手头不透传（无重复头）、
// 浏览器段压缩帧经桥接解压后上游回显可达（压缩与认证互不干扰）。
{
  const { WebSocketServer, WebSocket: WsClient } = await import("ws");

  const upPort = 19850 + Math.floor(Math.random() * 100);
  const upServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upgradeHeaders = null;
  upServer.on("upgrade", (req, socket, head) => {
    upgradeHeaders = req.headers;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  await new Promise((r) => upServer.listen(upPort, "127.0.0.1", r));

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
  assert.equal(await echoed, "headers-probe", "带认证头的桥接连接双向可达（压缩帧解压后转发）");
  browserWs.close();

  assert.ok(upgradeHeaders, "上游已收到桥接的升级请求");
  assert.equal(upgradeHeaders.cookie, "dsh-auth-test=v1.issue379",
    "cookie 原样透传到上游（认证凭据不丢，issue #379 核心语义）");
  assert.equal(upgradeHeaders["x-lan-proxy-probe"], "issue-379", "自定义头同样透传");
  assert.equal(upgradeHeaders.host, `127.0.0.1:${upPort}`, "host 重写为回环目标 authority");
  assert.equal(upgradeHeaders.origin, `http://127.0.0.1:${upPort}`, "origin 重写为回环 http 目标");
  assert.equal(typeof upgradeHeaders["sec-websocket-key"], "string",
    "sec-websocket-key 为 ws 库自生成的单一字符串（浏览器段握手头已剥离、无重复头）");
  assert.equal(upgradeHeaders["sec-websocket-extensions"], undefined,
    "浏览器段 permessage-deflate 协商头不透传（DSH 段固定明文，避免双重压缩）");

  await proxy.close();
  wss.close();
  upServer.close();
}

// ===== WS 桥接半开探活（issue #268 P0-1） =====
// 移动端切后台系统静默掐断 TCP 形成半开连接，close/error 永不触发 → 桥接僵死。
// 桥接对两端各自独立探活：interval 发 ping、一个宽限窗内未获 pong 即 terminate
// （terminate 使 close 语义成立 → 既有互断逻辑级联收口另一端）。三条断言：
//   1. ping 帧按间隔发出；2. pong 缺失触发 terminate（两端各测）；3. pong 正常时连接保持。
// 全 localhost 无外网；小间隔经 wsCompress.probeIntervalMs 注入（生产默认 30s）。

// —— 断言 1 + 3：真 echo 上游（ws 库自动回 pong）→ ping 按间隔到达、连接不被误杀 ——
{
  const { WebSocketServer, WebSocket: WsClient } = await import("ws");
  const upPort = 19950 + Math.floor(Math.random() * 40);
  const upServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upstreamPings = 0; // 真 echo 上游收到的 ping 帧数 = 上游段探活按间隔发出
  upServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("ping", () => { upstreamPings += 1; });
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  await new Promise((r) => upServer.listen(upPort, "127.0.0.1", r));

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
  assert.ok(await waitFor(() => pings.length >= 2, 4000),
    `探活 ping 应按间隔到达浏览器端（4s 内仅收到 ${pings.length} 帧）`);
  assert.ok(pings[1] - pings[0] >= 60 && pings[1] - pings[0] <= 800,
    `相邻 ping 间隔应贴近 interval=80ms（实际 ${pings[1] - pings[0]}ms，过密非周期探活、过疏非按间隔发出）`);
  // 断言 3：pong 正常（两端 ws 库自动回 pong）→ 多周期后不误杀且消息双向可达
  assert.ok(await waitFor(() => upstreamPings >= 2, 4000),
    `上游段探活也应按间隔发 ping（4s 内上游仅收到 ${upstreamPings} 帧）`);
  assert.equal(browserWs.readyState, WsClient.OPEN, "pong 正常时连接保持 OPEN 不被误杀");
  const echoed = new Promise((resolve) => browserWs.once("message", (d) => resolve(d.toString())));
  browserWs.send("probe-alive-check");
  assert.equal(await echoed, "probe-alive-check", "多探活周期后消息双向仍通");

  browserWs.close();
  await proxy.close();
  wss.close();
  upServer.close();
}

// —— 断言 2a：上游段 pong 缺失 → terminate 上游 → 级联关闭浏览器端 ——
// raw 假上游完成 RFC6455 握手后保持打开但对一切帧沉默（无 ws 库不会自动回
// pong）→ 上游段探活超时 terminate → close 互断逻辑关闭浏览器端（1006）。
{
  const { WebSocket: WsClient } = await import("ws");
  const silentPort = 20000 + Math.floor(Math.random() * 40);
  const silentServer = createServer((req, res) => res.destroy());
  silentServer.on("upgrade", (req, socket) => {
    socket.write(wsHandshakeResponse(req.headers["sec-websocket-key"]));
  });
  await new Promise((r) => silentServer.listen(silentPort, "127.0.0.1", r));

  const proxy = createLanProxy({
    host: "127.0.0.1", port: 0, targetHost: "127.0.0.1", targetPort: silentPort,
    wsCompress: { enabled: true, paths: ["/api/events.mux"], probeIntervalMs: 80 },
  });
  const { httpPort } = await proxy.listen();

  let closeCode = null;
  const browserWs = new WsClient(`ws://127.0.0.1:${httpPort}/api/events.mux`);
  browserWs.on("close", (code) => { closeCode = code; });
  await new Promise((r, j) => { browserWs.on("open", r); browserWs.on("error", j); });

  assert.ok(await waitFor(() => closeCode !== null, 5000),
    "上游 pong 缺失应在一个宽限窗后触发 terminate 并级联关闭浏览器端（5s 未收到 close）");
  assert.equal(closeCode, 1006, `terminate 应表现为异常关闭 1006（实际 ${closeCode}）`);

  await proxy.close();
  silentServer.close();
}

// —— 断言 2b：浏览器段 pong 缺失 → terminate 浏览器端 → 互断逻辑级联关闭上游 ——
// raw 假客户端经 node:http upgrade 拿裸 socket（不回 pong）连压缩白名单路径。
{
  const { WebSocketServer } = await import("ws");
  const upPort = 20050 + Math.floor(Math.random() * 40);
  const upServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let upstreamClosed = false;
  upServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on("close", () => { upstreamClosed = true; });
    });
  });
  await new Promise((r) => upServer.listen(upPort, "127.0.0.1", r));

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
  assert.ok(rawSocket.readable && !rawSocket.destroyed, "raw 客户端已完成 101 握手（桥接已建立）");

  // 断言 2b：浏览器段 pong 缺失 → 探活超时 terminate 浏览器端 → 既有互断逻辑
  // 级联关闭上游。upstream close 即 terminate 成立的下游证据（raw client 自身
  // 不发 close 帧、不主动断开，上游被关只能经由 browserWs close → upstreamWs.close；
  // 不以 rawSocket 属性为断言——半关闭 TCP 状态下其 destroyed/readable 翻转不可靠）。
  assert.ok(await waitFor(() => upstreamClosed, 5000),
    "浏览器段 pong 缺失应触发探活 terminate 并级联关闭上游连接");

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