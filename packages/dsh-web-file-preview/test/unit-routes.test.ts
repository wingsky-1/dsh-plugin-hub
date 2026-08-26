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
import { ROUTES, makeRoutes, serveFileRoute, apply } from "../lib/index.js";

// ---------------------------------------------------------------- 帮助函数

function fakeReq(method, url, remoteAddress, host = "127.0.0.1") {
  return { method, url, headers: { host }, socket: { remoteAddress } };
}
function fakeRes() {
  const calls = { status: 0, headers: {}, data: null };
  return {
    _calls: calls,
    writeHead(status, headers) { calls.status = status; calls.headers = headers || {}; return this; },
    end(data) { calls.data = data; },
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

  // apply 启用 → effect 回调执行，4 条路由注册（file/diff/health/mermaid），清理正常
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
    assert.equal(routePaths.length, 4, "apply 启用 → 4 条路由注册（#104 + mermaid）");
    assert.ok(routePaths.includes(ROUTES.file), "file 路由已注册");
    assert.ok(routePaths.includes(ROUTES.diff), "diff 路由已注册");
    assert.ok(routePaths.includes(ROUTES.health), "health 路由已注册");
    assert.ok(routePaths.includes(ROUTES.mermaid), "#104 mermaid 路由已注册");
    // 触发清理
    const cleanup = disposerCalls.find((x) => typeof x === "function");
    if (cleanup) cleanup();
    const disposedCount = disposerCalls.filter((x) => x === "disposed").length;
    assert.equal(disposedCount, 4, "disposer 清理 4 条路由");
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

  console.log("PASS unit-routes");
} finally {
  rmSync(root, { recursive: true, force: true });
}