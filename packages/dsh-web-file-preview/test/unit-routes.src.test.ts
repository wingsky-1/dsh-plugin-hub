// @ts-nocheck
/**
 * dsh-web-file-preview — unit：路由、apply 扩散函数、readErrorCode/readErrorText
 * 纯函数分支。
 *
 * 覆盖：readErrorCode（EACCES → 500 间接覆盖）、readErrorText（同）、
 * diffRoute 围栏（403/405/400/200）、apply（启用/禁用/异常/清理）。
 *
 * readErrorCode/readErrorText 未从 lib 导出，通过 chmod 000 使 stat 之后
 * readFile 失败（EACCES）触发 serveFileRoute 的 catch 分支间接覆盖。
 */
import { assert } from "./helpers.ts";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES, makeRoutes, serveFileRoute, apply, createTokenStore, resetServeTokenStore, DEFAULT_TOKEN_TTL_MS, DEFAULT_TOKEN_MAX, allocServeToken, serveTokenRoute, releaseServeToken, serveContentTypeOf } from "../src/index.ts";

// ---------------------------------------------------------------- 帮助函数

function fakeReq(method, url, remoteAddress, host = "127.0.0.1") {
  return { method, url, headers: { host }, socket: { remoteAddress } };
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
  };
}
function rawReqForFiles(headers = {}) {
  return { headers };
}

// 检查是否以 root 运行（chmod 000 无效）
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const root = mkdtempSync(join(tmpdir(), "fwp-ut-"));
try {
  writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(root, "doc.txt"), "hello", "utf8");

  // ================================================================
  // readErrorCode / readErrorText（通过 chmod 000 触发 readFile 失败）
  // ================================================================

  if (!isRoot) {
    chmodSync(join(root, "pic.png"), 0o000);
    const url = `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(root)}&path=pic.png`;
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(url), {});
    assert.equal(res._calls.status, 500, "chmod 000 图片 → 500（readErrorCode EACCES）");
    assert.equal(JSON.parse(res._calls.data).error, "read failed", "readErrorText EACCES → 'read failed'");
    chmodSync(join(root, "pic.png"), 0o644);

    chmodSync(join(root, "doc.txt"), 0o000);
    const url2 = `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(root)}&path=doc.txt`;
    const res2 = fakeRes();
    await serveFileRoute(res2, rawReqForFiles(), new URL(url2), {});
    assert.equal(res2._calls.status, 500, "chmod 000 文本 → 500（readErrorCode 文本分支）");
    assert.equal(JSON.parse(res2._calls.data).error, "read failed", "文本 readErrorText");
    chmodSync(join(root, "doc.txt"), 0o644);
  } else {
    console.log("  (跳过 readErrorCode EACCES 测试：以 root 运行，chmod 000 无效)");
  }

  // ================================================================
  // diffRoute 围栏与响应
  // ================================================================

  const routes = makeRoutes({});
  const diffHandler = routes[1].handler;

  // 非回环 → 403
  {
    const res = fakeRes();
    await diffHandler(fakeReq("GET", ROUTES.diff + "?cwd=/tmp&path=a", "8.8.8.8"), res);
    assert.equal(res._calls.status, 403, "diff 非回环 403");
  }
  // 方法非 GET → 405
  {
    const res = fakeRes();
    await diffHandler(fakeReq("POST", ROUTES.diff + "?cwd=/tmp&path=a", "127.0.0.1"), res);
    assert.equal(res._calls.status, 405, "diff 非 GET 405");
  }
  // 缺 cwd → 400
  {
    const res = fakeRes();
    await diffHandler(fakeReq("GET", ROUTES.diff + "?path=a", "127.0.0.1"), res);
    assert.equal(res._calls.status, 400, "diff 缺 cwd 400");
  }
  // 缺 path → 400
  {
    const res = fakeRes();
    await diffHandler(fakeReq("GET", ROUTES.diff + "?cwd=/tmp", "127.0.0.1"), res);
    assert.equal(res._calls.status, 400, "diff 缺 path 400");
  }
  // 正常请求（非 git 目录 → not-git → 200）
  {
    const res = fakeRes();
    await diffHandler(
      fakeReq("GET", `${ROUTES.diff}?cwd=${encodeURIComponent(root)}&path=doc.txt`, "127.0.0.1"),
      res,
    );
    assert.equal(res._calls.status, 200, "diff 非 git 目录 → 200");
    const payload = JSON.parse(res._calls.data);
    assert.equal(payload.ok, true, "diff 响应含 ok:true");
    assert.equal(payload.reason, "not-git", "diff 非 git 目录 → not-git");
  }

  // ================================================================
  // apply
  // ================================================================

  // apply 启用 → effect 回调执行，7 条路由注册（file/diff/health/mermaid/alloc/serve/release），清理正常
  {
    const disposerCalls = [];
    const fakeCtx = {
      effect: (cb) => {
        const dispose = cb();
        disposerCalls.push(dispose);
      },
      webServer: {
        register: (route) => {
          disposerCalls.push(route.path);
          return () => { disposerCalls.push("disposed"); };
        },
      },
      logger: { error: () => {} },
    };
    apply(fakeCtx, {});
    // 验证 effect 回调已执行、路由已注册
    const routePaths = disposerCalls.filter((x) => typeof x === "string");
    assert.equal(routePaths.length, 7, "apply 启用 → 7 条路由注册（#104 mermaid + #73 serve 三件套）");
    assert.ok(routePaths.includes(ROUTES.file), "file 路由已注册");
    assert.ok(routePaths.includes(ROUTES.diff), "diff 路由已注册");
    assert.ok(routePaths.includes(ROUTES.health), "health 路由已注册");
    assert.ok(routePaths.includes(ROUTES.mermaid), "#104 mermaid 路由已注册");
    assert.ok(routePaths.includes(ROUTES.serve), "#73 serve 路由已注册");
    assert.ok(routePaths.includes(ROUTES.alloc), "#73 alloc 路由已注册");
    assert.ok(routePaths.includes(ROUTES.release), "#73 release 路由已注册");
    // 触发清理
    const cleanup = disposerCalls.find((x) => typeof x === "function");
    if (cleanup) cleanup();
    const disposedCount = disposerCalls.filter((x) => x === "disposed").length;
    assert.equal(disposedCount, 7, "disposer 清理 7 条路由");
  }

  // apply 禁用 → 不注册任何路由，effect 不被调用
  {
    let effectCalled = false;
    const fakeCtx = {
      effect: () => { effectCalled = true; },
      webServer: { register: () => () => {} },
      logger: { error: () => {} },
    };
    apply(fakeCtx, { enabled: false });
    assert.equal(effectCalled, false, "apply 禁用 → effect 不被调用");
  }

  // 注册路由失败 → logger.error 被调用（catch 分支）
  {
    let loggerError = null;
    let disposeFn = null;
    const fakeCtx = {
      effect: (cb) => { disposeFn = cb(); },
      webServer: { register: () => { throw new Error("register failed"); } },
      logger: { error: (...args) => { loggerError = args; } },
    };
    apply(fakeCtx, {});
    assert.ok(loggerError !== null, "apply 异常 → logger.error 被调用");
    assert.match(loggerError[0], /注册路由失败/, "logger.error 消息含失败提示");
    // 异常后清理仍可被调用（空数组迭代）
    if (disposeFn) disposeFn();
  }

  // ================================================================
  // issue #73：serve token store 生命周期（B 组，src 直测供变异覆盖）
  // ================================================================
  {
    // 默认值声明（B3b/B4b 实现层可调项，README 记录）
    assert.equal(DEFAULT_TOKEN_TTL_MS, 30 * 60 * 1000, "#73 默认 TTL 30min");
    assert.equal(DEFAULT_TOKEN_MAX, 64, "#73 默认上限 64");
    // 可注入时钟：分配 / 命中刷新 / TTL 回收 / release / 幂等
    let fakeNow = 1000;
    const store = createTokenStore({ now: () => fakeNow, ttlMs: 10_000, maxTokens: 2, activeWindowMs: 200 });
    resetServeTokenStore(store);
    try {
      const t1 = store.alloc(root);
      assert.ok(t1 !== null && /^[0-9a-f]{32}$/.test(t1), "#73 token 为 32 位 hex");
      assert.equal(store.size(), 1, "#73 分配后 size=1");
      // 命中刷新：get 后 9s（< TTL）仍存活
      fakeNow += 9_000;
      assert.ok(store.get(t1) !== undefined, "#73 TTL 内命中存活");
      // 过期回收：再拨 10.1s（自上次命中闲置 > 10s TTL）→ undefined
      fakeNow += 10_100;
      assert.equal(store.get(t1), undefined, "#73 闲置超 TTL 回收");
      // release 幂等
      const t2 = store.alloc(root);
      assert.equal(store.release(t2), true, "#73 release 存在返回 true");
      assert.equal(store.release(t2), false, "#73 重复 release 返回 false（幂等）");
      // LRU：达上限淘汰非活跃最旧、保留活跃
      // 时序：a 分配 → 命中 → 再命中（保持活跃窗口）；b 分配后闲置滑出窗口
      const a = store.alloc(root);        // a.lastHit=20100
      fakeNow += 30;
      store.get(a);                        // a.lastHit=20130
      fakeNow += 180;
      const b = store.alloc(root);         // b.lastHit=20310（a 距 20130=180 ≤ 200 仍活跃）
      fakeNow += 30;
      store.get(a);                        // a.lastHit=20340
      fakeNow += 180;
      const c = store.alloc(root);         // 达上限 → a 活跃（20340→20520 距 180 ≤ 200）、b 非活跃（20310→20520 距 210 > 200）
      assert.ok(c !== null, "#73 达上限腾出空位");
      assert.ok(store.get(a) !== undefined, "#73 活跃 a 保留");
      assert.equal(store.get(b), undefined, "#73 非活跃最旧 b 淘汰");
    } finally {
      resetServeTokenStore();
    }
  }

  // ================================================================
  // issue #73：serve 路由行为（alloc/serve/release 直测，供变异覆盖）
  // ================================================================
  {
    resetServeTokenStore();
    writeFileSync(join(root, "page.html"), "<!doctype html><p>u</p>\n", "utf8");
    const mkUrl = (u) => new URL(`http://127.0.0.1${u}`);
    // alloc：200 + token/rest；非 html 400
    const ar = fakeRes();
    await allocServeToken(ar, mkUrl(`${ROUTES.alloc}?cwd=${encodeURIComponent(root)}&path=page.html`), {});
    assert.equal(ar._calls.status, 200, "#73 alloc 200");
    const pa = JSON.parse(ar._calls.data);
    assert.equal(pa.rest, "page.html", "#73 alloc rest 相对路径");
    const bad = fakeRes();
    await allocServeToken(bad, mkUrl(`${ROUTES.alloc}?cwd=${encodeURIComponent(root)}&path=doc.txt`), {});
    assert.equal(bad._calls.status, 400, "#73 alloc 非 html 400");
    // serve：正常 200 + Content-Type text/html；越界 ../ 404；未知 token 404
    const ok = fakeRes();
    await serveTokenRoute(ok, { headers: {} }, mkUrl(`${ROUTES.serve}/${pa.token}/page.html`), {});
    assert.equal(ok._calls.status, 200, "#73 serve 200");
    assert.match(String(ok._calls.headers["content-type"]), /^text\/html/, "#73 serve Content-Type text/html");
    const esc = fakeRes();
    await serveTokenRoute(esc, { headers: {} }, mkUrl(`${ROUTES.serve}/${pa.token}/../doc.txt`), {});
    assert.equal(esc._calls.status, 404, "#73 serve 越界 404");
    const unk = fakeRes();
    await serveTokenRoute(unk, { headers: {} }, mkUrl(`${ROUTES.serve}/ffffffffffffffffffffffffffffffff/page.html`), {});
    assert.equal(unk._calls.status, 404, "#73 serve 未知 token 404");
    // release 后同 token → 404
    const rr = fakeRes();
    releaseServeToken(rr, mkUrl(`${ROUTES.release}?token=${pa.token}`));
    assert.equal(rr._calls.status, 200, "#73 release 200");
    const after = fakeRes();
    await serveTokenRoute(after, { headers: {} }, mkUrl(`${ROUTES.serve}/${pa.token}/page.html`), {});
    assert.equal(after._calls.status, 404, "#73 release 后 404");
    // serveContentTypeOf：html→text/html、css→text/css、未知→octet-stream
    assert.match(serveContentTypeOf("a.html"), /^text\/html/, "#73 MIME html");
    assert.match(serveContentTypeOf("a.css"), /^text\/css/, "#73 MIME css");
    assert.match(serveContentTypeOf("a.q7x9z"), /^application\/octet-stream/, "#73 MIME 未知");
  }

  console.log("PASS unit-routes");
} finally {
  rmSync(root, { recursive: true, force: true });
}