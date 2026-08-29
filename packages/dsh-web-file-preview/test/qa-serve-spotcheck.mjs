/**
 * qa 独立抽查脚本（验收 #73 / PR #328，qa 与 coder 上下文隔离，独立复跑断言）。
 * 直接加载 lib/index.js（已 build 产物）真实调用 alloc / serve / release 路由：
 *  - 正常 200 + Content-Length/字节一致（D1/E3）
 *  - 未知 token 404（A3）
 *  - 越界（../ 到 root 外真实文件）404（C4）
 *  - 符号链接逃逸 404（C1，POSIX）
 *  - 超限 413 + truncated + no-store（D2）
 *  - 围栏：非回环 403 / 非 GET 405（A2，serve/alloc/release 三路）
 *  - 多 root 隔离（B1）
 *  - 目录请求 404（C3）
 *  - 编码攻击面（C2）
 *  - 零落盘（B2）
 * 不依赖包内 smoke，独立断言。退出码 0 = 全过。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const libUrl = new URL("../lib/index.js", import.meta.url);
const {
  ROUTES, makeRoutes, serveTokenRoute, allocServeToken, releaseServeToken,
  resetServeTokenStore, serveContentTypeOf,
} = await import(libUrl.href);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${detail}`); }
}

function fakeReq(method, url, remoteAddress = "127.0.0.1") {
  return { method, url, headers: { host: "127.0.0.1" }, socket: { remoteAddress } };
}
function fakeRes() {
  const calls = { status: 0, headers: {}, data: null };
  const listeners = {};
  return {
    _calls: calls,
    writeHead(status, headers) { calls.status = status; calls.headers = headers || {}; return this; },
    end(data) { if (data !== undefined) calls.data = data; },
    write(chunk) { calls.data = calls.data === null ? Buffer.from(chunk) : Buffer.concat([Buffer.from(calls.data), Buffer.from(chunk)]); return true; },
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return this; },
    emit(evt, ...args) { for (const fn of listeners[evt] || []) fn(...args); return this; },
  };
}
const routes = makeRoutes({});
const allocRoute = routes.find((r) => r.path === ROUTES.alloc).handler;
const serveRoute = routes.find((r) => r.path === ROUTES.serve).handler;
const releaseRoute = routes.find((r) => r.path === ROUTES.release).handler;

const parent = mkdtempSync(join(tmpdir(), "qa-fwp-serve-"));
const root = join(parent, "webroot");
mkdirSync(root, { recursive: true });
const HTML = "<!doctype html><h1>qa</h1>\n";
writeFileSync(join(root, "index.html"), HTML, "utf8");
const outside = join(parent, "outside.txt");
writeFileSync(outside, "SECRET", "utf8");
const outsideName = basename(outside);
const before = new Set(readdirSync(parent));

const allocOf = (p, cwd = root) => `${ROUTES.alloc}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}`;
const serveOf = (token, rest) => `${ROUTES.serve}/${token}/${rest}`;

console.log("== A2 围栏（serve/alloc/release：非回环 403 / 非 GET 405）==");
{
  let res = fakeRes(); await serveRoute(fakeReq("GET", serveOf("tok", "x.html"), "8.8.8.8"), res);
  check("serve 非回环 403", res._calls.status === 403, `got ${res._calls.status}`);
  res = fakeRes(); await serveRoute(fakeReq("POST", serveOf("tok", "x.html")), res);
  check("serve POST 405", res._calls.status === 405, `got ${res._calls.status}`);
  res = fakeRes(); await allocRoute(fakeReq("GET", allocOf("a.html"), "8.8.8.8"), res);
  check("alloc 非回环 403", res._calls.status === 403, `got ${res._calls.status}`);
  res = fakeRes(); await allocRoute(fakeReq("POST", allocOf("a.html")), res);
  check("alloc POST 405", res._calls.status === 405, `got ${res._calls.status}`);
  res = fakeRes(); releaseRoute(fakeReq("GET", `${ROUTES.release}?token=x`, "8.8.8.8"), res);
  check("release 非回环 403", res._calls.status === 403, `got ${res._calls.status}`);
  res = fakeRes(); releaseRoute(fakeReq("POST", `${ROUTES.release}?token=x`), res);
  check("release POST 405", res._calls.status === 405, `got ${res._calls.status}`);
}

console.log("== alloc / serve 正常链路 ==");
let token = "";
{
  const res = fakeRes();
  await allocRoute(fakeReq("GET", allocOf("index.html")), res);
  check("alloc 200", res._calls.status === 200, `got ${res._calls.status}`);
  const p = JSON.parse(res._calls.data);
  check("token 128-bit hex", /^[0-9a-f]{32}$/.test(p.token), p.token);
  check("rest 为 index.html", p.rest === "index.html", p.rest);
  check("root 为文件目录", p.root === root, p.root);
  token = p.token;

  const r2 = fakeRes();
  await serveRoute(fakeReq("GET", serveOf(token, "index.html")), r2);
  check("serve 200", r2._calls.status === 200, `got ${r2._calls.status}`);
  check("Content-Type text/html", /^text\/html/.test(String(r2._calls.headers["content-type"])), r2._calls.headers["content-type"]);
  check("nosniff", r2._calls.headers["x-content-type-options"] === "nosniff", r2._calls.headers["x-content-type-options"]);
  check("no-referrer", r2._calls.headers["referrer-policy"] === "no-referrer", r2._calls.headers["referrer-policy"]);
  check("Content-Length 正确", Number(r2._calls.headers["content-length"]) === Buffer.byteLength(HTML), r2._calls.headers["content-length"]);
  check("字节直出不改写（E3）", Buffer.from(r2._calls.data).toString("utf8") === HTML, String(r2._calls.data));
}

console.log("== A3 未知 token 404 / C3 目录 404 / C4 越界 404 ==");
{
  let res = fakeRes();
  await serveRoute(fakeReq("GET", serveOf("deadbeefdeadbeefdeadbeefdeadbeef", "index.html")), res);
  check("未知 token 404", res._calls.status === 404, `got ${res._calls.status}`);

  res = fakeRes();
  await serveRoute(fakeReq("GET", `${ROUTES.serve}/${token}/`), res);
  check("根目录 404", res._calls.status === 404, `got ${res._calls.status}`);

  res = fakeRes();
  await serveRoute(fakeReq("GET", serveOf(token, `../${outsideName}`)), res);
  check("越界 ../ 404", res._calls.status === 404, `got ${res._calls.status}`);

  for (const rest of [`/etc/passwd`, `a%2f..%2f${outsideName}`, `..%2f${outsideName}`, `a\\b.html`, `index.html%00`]) {
    res = fakeRes();
    await serveRoute(fakeReq("GET", serveOf(token, rest)), res);
    check(`编码攻击面 ${JSON.stringify(rest)} 非 2xx/非 5xx`, res._calls.status === 404 || res._calls.status === 400, `got ${res._calls.status}`);
  }
}

console.log("== C1 符号链接逃逸 404 ==");
{
  let linked = false;
  try { symlinkSync(outside, join(root, "escape-link")); linked = true; } catch { /* 跳过 */ }
  if (linked) {
    const res = fakeRes();
    await serveRoute(fakeReq("GET", serveOf(token, "escape-link")), res);
    check("root/link -> 外部文件 404", res._calls.status === 404, `got ${res._calls.status}`);
    rmSync(join(root, "escape-link"), { force: true });
  } else console.log("  SKIP 符号链接不可用（Windows）");
}

console.log("== D2 超限 413 + truncated + no-store ==");
{
  const big = join(root, "big.html");
  writeFileSync(big, "<p>" + "x".repeat(200) + "</p>", "utf8");
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${serveOf(token, "big.html")}`);
  await serveTokenRoute(res, fakeReq("GET", url.pathname + url.search), url, { maxAssetBytes: 64 });
  check("超限 413", res._calls.status === 413, `got ${res._calls.status}`);
  check("no-store", res._calls.headers["cache-control"] === "no-store", res._calls.headers["cache-control"]);
  const payload = JSON.parse(res._calls.data);
  check("truncated 标记", payload.truncated === true, String(payload.truncated));
  rmSync(big, { force: true });
}

console.log("== B1 多 root 隔离 ==");
{
  const rootB = mkdtempSync(join(tmpdir(), "qa-fwp-rootb-"));
  writeFileSync(join(rootB, "index.html"), "<p>B</p>", "utf8");
  const ra = fakeRes(); await allocRoute(fakeReq("GET", allocOf("index.html", root)), ra);
  const rb = fakeRes(); await allocRoute(fakeReq("GET", allocOf("index.html", rootB)), rb);
  const pa = JSON.parse(ra._calls.data), pb = JSON.parse(rb._calls.data);
  check("两 root token 不同", pa.token !== pb.token);
  let res = fakeRes(); await serveRoute(fakeReq("GET", serveOf(pa.token, "index.html")), res);
  check("token A 服务 A", Buffer.from(res._calls.data).toString("utf8") === HTML);
  res = fakeRes(); await serveRoute(fakeReq("GET", serveOf(pa.token, "../b-index.html")), res);
  check("token A 无法读 root B", res._calls.status === 404, `got ${res._calls.status}`);
  rmSync(rootB, { recursive: true, force: true });
}

console.log("== B5 release 后 404（幂等）==");
{
  const res = fakeRes();
  releaseRoute(fakeReq("GET", `${ROUTES.release}?token=${token}`), res);
  check("release 200", res._calls.status === 200, `got ${res._calls.status}`);
  const res2 = fakeRes();
  await serveRoute(fakeReq("GET", serveOf(token, "index.html")), res2);
  check("release 后 serve 404", res2._calls.status === 404, `got ${res2._calls.status}`);
  const res3 = fakeRes();
  releaseRoute(fakeReq("GET", `${ROUTES.release}?token=${token}`), res3);
  check("重复 release 幂等 200", res3._calls.status === 200, `got ${res3._calls.status}`);
}

console.log("== B2 零落盘 ==");
{
  const after = new Set(readdirSync(parent));
  let polluted = false;
  for (const n of after) if (!before.has(n)) { polluted = true; console.log(`  FAIL 新增文件 ${n}`); }
  check("serve 后父目录无新增文件", !polluted);
}

console.log("== serveContentTypeOf 独立 MIME（E1）==");
{
  check("css → text/css", serveContentTypeOf("a.css") === "text/css", serveContentTypeOf("a.css"));
  check("未知 → octet-stream", serveContentTypeOf("a.q7x9z") === "application/octet-stream", serveContentTypeOf("a.q7x9z"));
}

rmSync(parent, { recursive: true, force: true });
resetServeTokenStore();
console.log(failures === 0 ? "\nALL QA SPOT-CHECK PASS" : `\n${failures} QA SPOT-CHECK FAILURES`);
process.exit(failures === 0 ? 0 : 1);
