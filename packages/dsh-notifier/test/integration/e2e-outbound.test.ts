// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：outbound 真 resolver 全链投递基线（红测先行）。
 *
 * 现状 outbound.ts 有效分支（enabled:true bark 实例化 + barkGates 限流门复用）
 * 零覆盖（resolver 在 apply 链上「空跑」，所有测试 channels 恒空/disabled）。
 * 本文件经完整 apply 链（index.ts → createOutboundChannelResolver → createBarkChannel
 * → fetch）锁定基线；重试/并发门上移框架时是行为对等的判别网。
 *
 * 假网络纪律：fetch mock 白名单外一律拒绝（throw），绝不
 * fail-open 转真实网络——白名单外请求即测试 bug（与 unit-webhook/service-contract
 * 的「白名单+白名单外 fail-open」旧形态区分；旧形态低危面在本文件内不再复用）。
 *
 * 内置 browser/system 全关：只让 bark 进入投递集合（避免真实系统 spawn；
 * spawn 链直测由 system-notifier 单测文件处理）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
let seq = 0;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-outbound-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const BARK_BASE = "https://fake-bark-1.local";
const BARK_PUSH = `${BARK_BASE}/push`;

/** 白名单 fetch mock：仅拦本测试 bark URL，白名单外 throw（不 fail-open）。 */
function installFetchMock(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (typeof url === "string" && (url === BARK_PUSH || url === `${BARK_BASE}/push`)) {
      calls.push({ url, init });
      return handler(url, init, calls);
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

/** HTTP 5xx 可重试响应（框架重试链用）。 */
function res503() {
  return { ok: false, status: 503, async text() { return "unavailable"; } };
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

/**
 * 单用例夹具：装 fetch 白名单桩 + 建 bark-only notifier + 取 test/status 路由。
 * 每次调用用全新 tag（独立 history/status 文件）——终态断言不读到上一用例的陈旧条目。
 */
async function withBark(handler, fn) {
  const tag = `t${seq += 1}`;
  const mock = installFetchMock(handler);
  try {
    const { routes } = await makeBarkOnlyNotifier([
      { id: "phone", type: "bark", baseUrl: BARK_BASE, deviceKey: "device-key-9x8z", enabled: true },
    ], tag);
    const testRoute = routes.find((r) => r.path === ROUTES.test);
    const statusRoute = routes.find((r) => r.path === ROUTES.status);
    return await fn({ mock, testRoute, statusRoute });
  } finally {
    mock.restore();
  }
}

/** POST /test 并回收响应体。 */
async function postTest(testRoute) {
  const { rec, res } = makeRes();
  await testRoute.handler(fakeReq({ method: "POST" }), res);
  return JSON.parse(rec.text);
}

describe("E-OUT-1 enabled:true bark 经 apply 全链投递成功（HTTP 2xx + code 200 双查）", () => {
  it("test 路由存在", async () => {
    await withBark((_url, init) => resOk(init), async ({ testRoute }) => {
      expect(testRoute).toBeTruthy();
    });
  });

  it("test 路由受理", async () => {
    await withBark((_url, init) => resOk(init), async ({ testRoute }) => {
      expect((await postTest(testRoute)).ok).toBe(true);
    });
  });

  it("bark:phone 受理 ok", async () => {
    await withBark((_url, init) => resOk(init), async ({ testRoute }) => {
      const body = await postTest(testRoute);
      expect(body.results.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
    });
  });

  it("bark POST 恰好 1 次（无重试路径）", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      expect(mock.calls.length).toBe(1);
    });
  });

  it("POST 目标 = baseUrl + /push（device_key 走 body 不落 URL）", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      expect(mock.calls[0].url).toBe(BARK_PUSH);
    });
  });

  it("POST 方法", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      expect(mock.calls[0].init.method).toBe("POST");
    });
  });

  it("device_key 在 body", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      expect(JSON.parse(mock.calls[0].init.body).device_key).toBe("device-key-9x8z");
    });
  });

  it("title/body 入 payload", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      const payload = JSON.parse(mock.calls[0].init.body);
      expect(payload.title && payload.body).toBeTruthy();
    });
  });

  it("test 模板文案", async () => {
    await withBark((_url, init) => resOk(init), async ({ mock, testRoute }) => {
      await postTest(testRoute);
      expect(JSON.parse(mock.calls[0].init.body).body).toBe("通知链路工作正常（此通知来自测试按钮）");
    });
  });
});

describe("E-OUT-2 4xx 确定失败 → 不重试（1 次 fetch）+ 异步终态 failed 落 status", () => {
  it("4xx 受理仍 ok（铁律 1）", async () => {
    await withBark(() => res4xx(), async ({ testRoute }) => {
      const body = await postTest(testRoute);
      expect(body.results.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
    });
  });

  it("4xx → 终态 failed 落 status", async () => {
    await withBark(() => res4xx(), async ({ testRoute, statusRoute }) => {
      await postTest(testRoute);
      const entry = await pollStatus(statusRoute, "bark:phone");
      expect(entry && entry.lastStatus === "failed").toBeTruthy();
    });
  });

  it("失败错误经脱敏（不含 device key 原文）", async () => {
    await withBark(() => res4xx(), async ({ testRoute, statusRoute }) => {
      await postTest(testRoute);
      const entry = await pollStatus(statusRoute, "bark:phone");
      expect(entry.lastError && !entry.lastError.includes("device-key-9x8z")).toBeTruthy();
    });
  });

  it("4xx 不重试（仅 1 次 fetch）", async () => {
    await withBark(() => res4xx(), async ({ mock, testRoute, statusRoute }) => {
      await postTest(testRoute);
      await pollStatus(statusRoute, "bark:phone");
      expect(mock.calls.length).toBe(1);
    });
  });
});

// 5xx 重试链（框架重试，对等现状 bark sendWithRetry ×2）——
// 503×2 后 200 → 总尝试 3 次 + 终态 ok；退避 1s/2s 真实发生（行为验证非 sleep hack）
describe("E-OUT-3 5xx 重试链（3 次 fetch + 终态 ok）", () => {
  const retryHandler = (_url, init, calls) => (calls.length < 3 ? res503() : resOk(init));

  it("5xx 链受理仍 ok（铁律 1）", async () => {
    await withBark(retryHandler, async ({ testRoute, statusRoute }) => {
      const body = await postTest(testRoute);
      expect(body.results.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
      // 排水（非断言）：让重试链在桩存活期内跑完，避免恢复真 fetch 后外发
      await pollStatus(statusRoute, "bark:phone", 8000);
    });
  });

  it("5xx 重试后成功 → 终态 ok 落 status", async () => {
    await withBark(retryHandler, async ({ testRoute, statusRoute }) => {
      await postTest(testRoute);
      const entry = await pollStatus(statusRoute, "bark:phone", 8000);
      expect(entry && entry.lastStatus === "ok").toBeTruthy();
    });
  });

  it("5xx 重试 ×2（1+2=3 次 fetch）", async () => {
    await withBark(retryHandler, async ({ mock, testRoute, statusRoute }) => {
      await postTest(testRoute);
      await pollStatus(statusRoute, "bark:phone", 8000);
      expect(mock.calls.length).toBe(3);
    });
  });
});
