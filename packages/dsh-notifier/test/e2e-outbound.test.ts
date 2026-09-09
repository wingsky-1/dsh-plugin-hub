// @ts-nocheck
/**
 * dsh-notifier — e2e：outbound 真 resolver 全链投递基线（PR0 红测先行 3）。
 *
 * 现状 outbound.ts 有效分支（enabled:true bark 实例化 + barkGates 限流门复用）
 * 零覆盖（T3-9：resolver 在 apply 链上「空跑」，所有测试 channels 恒空/disabled）。
 * 本文件经完整 apply 链（index.ts → createOutboundChannelResolver → createBarkChannel
 * → fetch）锁定基线；PR2 重试/并发门上移框架时是行为对等的判别网。
 *
 * 假网络纪律（S3-23 加固姿态）：fetch mock 白名单外一律拒绝（throw），绝不
 * fail-open 转真实网络——白名单外请求即测试 bug（与 unit-webhook/service-contract
 * 的「白名单+白名单外 fail-open」旧形态区分；旧形态低危面在 PR0 本文件内不再复用）。
 *
 * 内置 browser/system 全关：只让 bark 进入投递集合（避免真实系统 spawn——T3-3；
 * spawn 链直测由红测先行 1 单独处理）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { makeNotifier, fakeReq, makeRes } from "./helpers.ts";
import { ROUTES } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-outbound-"));
const BARK_BASE = "https://fake-bark-1.local";
const BARK_PUSH = `${BARK_BASE}/push`;

/** 白名单 fetch mock：仅拦本测试 bark URL，白名单外 throw（不 fail-open）。 */
function installFetchMock(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === "string" && (url === BARK_PUSH || url === `${BARK_BASE}/push`)) {
      calls.push({ url, init });
      return handler(url, init);
    }
    throw new Error(`fetch mock 白名单外请求（测试 bug 或真实外发）: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** HTTP 2xx + body code 200 双查成功响应。 */
function resOk(init) {
  const body = JSON.parse(String(init.body ?? "{}"));
  return { ok: true, status: 200, async json() { return { code: body.code ?? 200 }; } };
}

/** HTTP 4xx 确定失败响应（BarkHttpError 路径；响应体可能回显 key → 服务端脱敏）。 */
function res4xx() {
  return { ok: false, status: 400, async text() { return "bad request"; } };
}

/** 轮询 /status 直到某频道终态出现（替代固定 sleep 等异步终态）。 */
async function pollStatus(statusRoute, channelId, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const { rec, res } = makeRes();
    await statusRoute.handler(fakeReq({}), res);
    let channels = {};
    try { channels = JSON.parse(rec.text).channels || {}; } catch { /* 下一轮 */ }
    const entry = channels[channelId];
    if (entry) return entry;
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeBarkOnlyNotifier(channels, tag) {
  return makeNotifier(work, {
    browserNotify: false, browserSound: false,
    systemNotify: false, systemSound: false,
    channels,
    // 每实例独立 history/status 文件（makeNotifier 默认同路径，防串写）
    historyFile: join(work, `out-${tag}-hist.jsonl`),
    statusFile: join(work, `out-${tag}-status.json`),
  });
}

try {
  // E-OUT-1：enabled:true bark 经 apply 全链投递成功（HTTP 2xx + code 200 双查）
  {
    const mock = installFetchMock((_url, init) => resOk(init));
    try {
      const { routes } = await makeBarkOnlyNotifier([
        { id: "phone", type: "bark", baseUrl: BARK_BASE, deviceKey: "device-key-9x8z", enabled: true },
      ], "1");
      const testRoute = routes.find((r) => r.path === ROUTES.test);
      assert.ok(testRoute, "test 路由存在");
      const { rec, res } = makeRes();
      await testRoute.handler(fakeReq({ method: "POST" }), res);
      const body = JSON.parse(rec.text);
      assert.equal(body.ok, true, "test 路由受理");
      assert.ok(body.results.some((x) => x.channelId === "bark:phone" && x.status === "ok"), "bark:phone 受理 ok");
      assert.equal(mock.calls.length, 1, "bark POST 恰好 1 次（无重试路径）");
      const call = mock.calls[0];
      assert.equal(call.url, BARK_PUSH, "POST 目标 = baseUrl + /push（device_key 走 body 不落 URL）");
      assert.equal(call.init.method, "POST", "POST 方法");
      const payload = JSON.parse(call.init.body);
      assert.equal(payload.device_key, "device-key-9x8z", "device_key 在 body");
      assert.ok(payload.title && payload.body, "title/body 入 payload");
      assert.equal(payload.body, "通知链路工作正常（此通知来自测试按钮）", "test 模板文案");
      console.log("E-OUT-1 bark 全链投递成功（双查）: OK");
    } finally {
      mock.restore();
    }
  }

  // E-OUT-2：4xx 确定失败 → 不重试（1 次 fetch）+ 异步终态 failed 落 status
  {
    const mock = installFetchMock(() => res4xx());
    try {
      const { routes } = await makeBarkOnlyNotifier([
        { id: "phone", type: "bark", baseUrl: BARK_BASE, deviceKey: "device-key-9x8z", enabled: true },
      ], "2");
      const testRoute = routes.find((r) => r.path === ROUTES.test);
      const statusRoute = routes.find((r) => r.path === ROUTES.status);
      const { rec, res } = makeRes();
      await testRoute.handler(fakeReq({ method: "POST" }), res);
      const body = JSON.parse(rec.text);
      assert.ok(body.results.some((x) => x.channelId === "bark:phone" && x.status === "ok"), "4xx 受理仍 ok（铁律 1）");
      const entry = await pollStatus(statusRoute, "bark:phone");
      assert.ok(entry && entry.lastStatus === "failed", "4xx → 终态 failed 落 status");
      assert.ok(entry.lastError && !entry.lastError.includes("device-key-9x8z"), "失败错误经脱敏（不含 device key 原文）");
      assert.equal(mock.calls.length, 1, "4xx 不重试（仅 1 次 fetch）");
      console.log("E-OUT-2 bark 4xx 不重试 + 终态 failed 脱敏: OK");
    } finally {
      mock.restore();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}