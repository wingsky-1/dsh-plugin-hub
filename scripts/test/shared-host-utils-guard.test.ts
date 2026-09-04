// @ts-check
/**
 * shared/host-utils.js — guardLoopbackMethod 守卫单测（issue #473 批 1）。
 *
 * 载体：CI `pnpm test:scripts`（.github/workflows/ci.yml test:scripts 步骤；
 * 本地门禁同命令）。命名与 #472 的 shared-host-utils.test.ts 错开（S1），
 * 各测各的函数互不覆盖。
 *
 * 覆盖（#473 方案 v2 G4①/R6）：
 * - 403 文案逐字节：非 loopback → `{"error":"forbidden: loopback-only"}` + false；
 * - 405 文案逐字节：方法不在白名单 → `{"error":"method not allowed: <METHOD>"}`
 *   + false（多方法插值全覆盖）；
 * - 无 method 字段（fakeReq 缺省覆盖）→ 405 + `method not allowed: undefined`
 *   ——锚定 fail-closed（R6：防未来实现加回 `?? "GET"` 宽松归一化）；
 * - 放行正例：loopback + 白名单内方法 → true 且不写响应。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { guardLoopbackMethod } from "../../shared/host-utils.js";

/** loopback 合法请求桩；overrides 逐键覆盖顶层字段。 */
function fakeReq(overrides = {}) {
  return {
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    ...overrides,
  };
}

/** 响应收集桩：rec.status / rec.body（writeJson 经 writeHead+end 落字）。 */
function fakeRes() {
  const rec = { status: 0, body: "" };
  return {
    rec,
    res: {
      writeHead(status) {
        rec.status = status;
      },
      end(payload) {
        if (payload !== undefined) rec.body += String(payload);
      },
    },
  };
}

test("非 loopback → 403 + 逐字节文案 + false", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res, ["GET"]);
  assert.equal(allow, false, "非 loopback 返回 false");
  assert.equal(rec.status, 403);
  assert.equal(rec.body, '{"error":"forbidden: loopback-only"}', "403 body 逐字节");
});

test("loopback Host 不合法 → 403 + 逐字节文案 + false", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(fakeReq({ headers: { host: "evil.example:3080" } }), res, ["GET"]);
  assert.equal(allow, false);
  assert.equal(rec.status, 403);
  assert.equal(rec.body, '{"error":"forbidden: loopback-only"}', "403 body 逐字节");
});

test("loopback + 方法不在白名单 → 405 + 逐字节文案 + false", () => {
  for (const [method, whitelist] of [
    ["POST", ["GET"]],
    ["DELETE", ["GET", "PUT"]],
    ["PATCH", ["GET", "POST"]],
    ["PUT", ["GET", "POST"]],
    ["OPTIONS", ["GET"]],
  ]) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(fakeReq({ method }), res, whitelist);
    assert.equal(allow, false, `${method} 不在 [${whitelist}] 返回 false`);
    assert.equal(rec.status, 405, `${method} → 405`);
    assert.equal(rec.body, `{"error":"method not allowed: ${method}"}`, `${method} 405 body 逐字节`);
  }
});

test("无 method 字段 → 405 + method not allowed: undefined（fail-closed，R6）", () => {
  const { rec, res } = fakeRes();
  const { method, ...noMethod } = fakeReq();
  assert.equal(method, "GET", "前置：桩本有 method，此处刻意删除");
  const allow = guardLoopbackMethod(noMethod, res, ["GET"]);
  assert.equal(allow, false, "无 method 字段不放行（fail-closed）");
  assert.equal(rec.status, 405);
  assert.equal(rec.body, '{"error":"method not allowed: undefined"}', "405 body 逐字节锚定 undefined 插值");
});

test("loopback + 白名单内方法 → true 放行且不写响应", () => {
  for (const [method, whitelist] of [
    ["GET", ["GET"]],
    ["GET", ["GET", "PUT"]],
    ["PUT", ["GET", "PUT"]],
    ["POST", ["GET", "POST"]],
    ["DELETE", ["GET", "DELETE"]],
  ]) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(fakeReq({ method }), res, whitelist);
    assert.equal(allow, true, `${method} ∈ [${whitelist}] 放行`);
    assert.equal(rec.status, 0, "放行时不写任何响应");
    assert.equal(rec.body, "", "放行时不写任何 body");
  }
});
