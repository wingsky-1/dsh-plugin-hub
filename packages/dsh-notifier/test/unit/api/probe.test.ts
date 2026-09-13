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

/** POST 一次测试通知（给定请求对象）。 */
async function postWith(req: IncomingMessage) {
  const pipeline = fakePipeline();
  const { res, rec, json } = makeRes();
  await new ProbeEndpoints(pipeline.port).test(req, res);
  return { rec, json, pipeline };
}

/** POST 一次测试通知。 */
function post(request: { body?: unknown; rawBody?: string }) {
  return postWith(makeReq(request));
}

/** 块是字符串的请求（流被 `setEncoding` 过这类形态）：共享读取器承诺**不抛错**。 */
function makeStringChunkReq(): IncomingMessage {
  return {
    method: "POST",
    url: "/api/dsh-notifier/test",
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield '{"channelId":"bark:main"}';
    },
  } as unknown as IncomingMessage;
}

/** 读流中途出错的路由请求：客户端半途断开、socket 报错都长这样。 */
function makeBrokenReq(): IncomingMessage {
  return {
    method: "POST",
    url: "/api/dsh-notifier/test",
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      throw new Error("socket hang up");
    },
  } as unknown as IncomingMessage;
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

/**
 * 这个端点有副作用，所以「body 读不出来」不能退化成「没给 body」——后者会真的发一条通知出去。
 * 四类成因各自的文案都要落到响应里，客户端才能说清是体太大还是写错了。
 */
describe("POST /test：body 读不出来时 fail-closed（不许当成「没给 body」）", () => {
  it.each<[string, string, string]>([
    ["JSON 语法错", "{ not json", "请求体不是合法 JSON"],
    ["JSON 合法但是数字", "42", "请求体必须是 JSON 对象"],
    ["JSON 合法但是 null", "null", "请求体必须是 JSON 对象"],
  ])("%s → 400 invalid-json，一条都不提交", async (_label, rawBody, details) => {
    const { rec, json, pipeline } = await post({ rawBody });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({ ok: false, error: { code: "invalid-json", details } });
    expect(pipeline.submitted).toEqual([]);
  });

  it("超限体 → 400 invalid-json 且不提交：JSON 本身合法也不例外", async () => {
    const { rec, json, pipeline } = await post({ body: { channelId: "a".repeat(5000) } });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid-json", details: "请求体超出大小上限（4096 字节）" },
    });
    expect(pipeline.submitted).toEqual([]);
  });

  it("读流中断 → 400 invalid-json：半途断开不等于「没给 body」", async () => {
    const { rec, json, pipeline } = await postWith(makeBrokenReq());
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid-json", details: "请求体读取失败" },
    });
    expect(pipeline.submitted).toEqual([]);
  });

  it("块不是 Buffer 时也不抛错：按「读不出来」落 400，异常不许打到调用方", async () => {
    const { rec, json, pipeline } = await postWith(makeStringChunkReq());
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid-json", details: "请求体读取失败" },
    });
    expect(pipeline.submitted).toEqual([]);
  });

  it("纯空白 body 仍是「没给 body」：按全频道测试受理，不判畸形", async () => {
    const { rec, pipeline } = await post({ rawBody: "   \n\t " });
    expect(rec.status).toBe(200);
    expect(pipeline.submitted).toEqual([
      { kind: "test", title: "DSH：测试通知", body: "通知链路工作正常（此通知来自测试按钮）" },
    ]);
  });
});

describe("GET /health：报宿主平台与连接回收计数", () => {
  it("platform 取宿主进程的真实平台值（客户端据此写系统通道提示，不能拿浏览器 OS 猜），sseEvicts 形状与真实枢纽逐键一致", () => {
    const { res, rec, json } = makeRes();
    new ProbeEndpoints(fakePipeline().port).health(makeReq({ method: "GET" }), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({
      ok: true,
      plugin: "dsh-notifier",
      platform: process.platform,
      // 未装配占位：形状（键集）必须与真实枢纽一致，否则「未装配」与「装好但没淘汰过」在 /health 上长得不一样
      sseEvicts: {
        close: 0,
        error: 0,
        limit: 0,
        stalled: 0,
        maxage: 0,
        destroyed: 0,
        dispose: 0,
      },
    });
  });
});
