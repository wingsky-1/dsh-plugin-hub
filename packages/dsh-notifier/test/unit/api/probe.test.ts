/**
 * dsh-notifier api 域 probe 块 —— POST /test 与 GET /health。
 *
 * 判据面：测试通知必须走**同一条**裁决管线（不另开旁路），否则「测试能响、真实事件不响」这类问题
 * 会被测试本身掩盖；响应里的 `sseConnections` 进的是客户端「已发送至 N 个页面」的提示，报假数就是
 * 骗用户；`/health` 报的是**宿主平台**，客户端据此写系统通道的平台提示，拿浏览器 OS 猜
 * 会让 Windows 用户看到 Linux 的安装引导。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { NotifyRequest, PipelinePort } from "../../../src/server/api/deps.ts";
import { ProbeEndpoints } from "../../../src/server/api/impl/probe/index.ts";
import { streamHub } from "../../../src/server/api/impl/stream/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { jsonReq, makeLogger, makeRes } from "../../helpers.ts";

/** 假请求：body 由 async 迭代器吐出（`readJsonBody` 走的就是这条路）。 */
function makeReq(
  options: { method?: string; body?: unknown; rawBody?: string } = {},
): IncomingMessage {
  return jsonReq({
    method: options.method ?? "POST",
    url: "/api/dsh-notifier/test",
    body: options.body,
    rawBody: options.rawBody,
  });
}

/** 假裁决管线：只记下提交体（该不该发、发去哪都是管线的事）。 */
function fakePipeline() {
  const submitted: NotifyRequest[] = [];
  const port: PipelinePort = {
    submit: (request) => {
      submitted.push(request);
    },
  };
  return { port, submitted };
}

/** POST 一次测试通知。 */
async function post(request: { body?: unknown; rawBody?: string }) {
  const pipeline = fakePipeline();
  const { res, rec, json } = makeRes();
  await new ProbeEndpoints(pipeline.port).test(makeReq(request), res);
  return { rec, json, pipeline };
}

/**
 * 假 SSE 响应：连接表注册要 `on` / `destroyed` / `write` / `destroy`，其余方法用不到。
 *
 * 为什么要它：`sseConnections` 报的是服务端未释放的句柄数，未装配的枢纽恒为 0——断言里的
 * 字面量 0 因此恒真。真占住一个句柄才能把「报的是真实连接数」证伪。
 */
function makeSseRes(): ServerResponse {
  const rec = { destroyed: false };
  const res = {
    get destroyed() {
      return rec.destroyed;
    },
    get writableEnded() {
      return false;
    },
    writeHead() {
      return res;
    },
    write() {
      return true;
    },
    on() {
      return res;
    },
    destroy() {
      rec.destroyed = true;
    },
  };
  return res as unknown as ServerResponse;
}

afterEach(() => {
  streamHub.release();
});

describe("POST /test：测试通知走同一条裁决管线", () => {
  it("没有 body 时按全频道测试：提交固定的 test 文案，并报出服务端真实的 SSE 句柄数", async () => {
    streamHub.install({ logger: makeLogger(), config: { readConfig: () => DEFAULT_CONFIG } });
    streamHub.handle(makeReq({ method: "GET" }), makeSseRes());

    const { rec, json, pipeline } = await post({});
    expect(rec.status).toBe(200);
    expect(pipeline.submitted).toEqual([
      { kind: "test", title: "DSH：测试通知", body: "通知链路工作正常（此通知来自测试按钮）" },
    ]);
    expect(json()).toEqual({ ok: true, sseConnections: 1 });
  });

  it("带 channelId 时只多一个 onlyChannel（指定出口不能变成另一条通知文案）", async () => {
    const { pipeline } = await post({ body: { channelId: "bark:main" } });
    expect(pipeline.submitted).toEqual([
      {
        kind: "test",
        title: "DSH：测试通知",
        body: "通知链路工作正常（此通知来自测试按钮）",
        onlyChannel: "bark:main",
      },
    ]);
  });

  it.each<[string, unknown]>([
    ["空串", ""],
    ["数字", 42],
  ])("channelId 非法（%s）→ 400 且不提交", async (_label, channelId) => {
    const { rec, json, pipeline } = await post({ body: { channelId } });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { error: "测试通知参数非法", details: "channelId 必须为非空字符串或省略" },
    });
    expect(pipeline.submitted).toEqual([]);
  });
});

describe("GET /health：报宿主平台", () => {
  it("platform 取宿主进程的真实平台值（客户端据此写系统通道提示，不能拿浏览器 OS 猜）", () => {
    const { res, rec, json } = makeRes();
    new ProbeEndpoints(fakePipeline().port).health(makeReq({ method: "GET" }), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({
      ok: true,
      plugin: "dsh-notifier",
      platform: process.platform,
    });
  });
});
