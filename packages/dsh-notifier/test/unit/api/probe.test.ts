/**
 * dsh-notifier api 域 probe 块 —— POST /test 与 GET /health。
 *
 * 判据面：测试通知必须走**同一条**裁决管线（不另开旁路），否则「测试能响、真实事件不响」这类问题
 * 会被测试本身掩盖；响应里的 `sseConnections` 进的是客户端「已发送至 N 个页面」的提示，报假数就是
 * 骗用户；`/health` 报的是**宿主平台**，客户端据此写系统通道的平台提示，拿浏览器 OS 猜
 * 会让 Windows 用户看到 Linux 的安装引导。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChannelPort,
  ConfigPort,
  HostCapabilities,
  NotifyRequest,
  PipelinePort,
} from "../../../src/server/api/deps.ts";
import * as channelsApi from "../../../src/server/channels/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import * as configApi from "../../../src/server/config/interface.ts";
import * as pipelineApi from "../../../src/server/pipeline/interface.ts";
import { ProbeEndpoints } from "../../../src/server/api/impl/probe/index.ts";
import { streamHub } from "../../../src/server/api/impl/stream/index.ts";
import { jsonReq, makeLogger, makeRes, wire } from "../../helpers.ts";

/** 假能力面：调用次数要能被数（缓存判据靠它），平台值可注入（三平台格靠它），探测结论可注入失败。 */
function fakeChannels(
  options: { hostPlatform?: () => string; probe?: () => Promise<HostCapabilities> } = {},
) {
  let calls = 0;
  const port: ChannelPort = {
    probeCapabilities: () => {
      calls += 1;
      return options.probe === undefined ? Promise.resolve(CAPABILITIES) : options.probe();
    },
    hostPlatform: options.hostPlatform ?? (() => "linux"),
    undeterminedCapabilities: () => UNDETERMINED,
    // dry-run 出站走真实实现（本文件不断言它，端口类型要求齐成员）。
    dryRunTarget: channelsApi.dryRunTarget,
  };
  return { port, probeCalls: () => calls };
}

/** `/health` 上「无法判定」的**摘要**形状：能力面摘要是完整面的投影，不是同一个对象。 */
const UNDETERMINED_SUMMARY = {
  verdict: "unknown",
  unknownDimensions: ["popup", "sound"],
  popup: { state: "unknown" },
  sound: { state: "unknown" },
};

/** 「无法判定」的兜底形状（与服务端 `undeterminedCapabilities()` 同形，独立抄写才守得住漂移）。 */
const UNDETERMINED: HostCapabilities = {
  verdict: "unknown",
  unknownDimensions: ["popup", "sound"],
  popup: { state: "unknown", checked: [] },
  sound: { state: "unknown", players: [], toneFileAvailable: false, checked: [] },
  remediation: [],
};

/** 完整能力面夹具（含明细）：摘要与完整面的差异必须能被断言。 */
const CAPABILITIES: HostCapabilities = {
  verdict: "degraded",
  unknownDimensions: ["popup"],
  popup: {
    state: "unknown",
    checked: ["notify-send", "dbus-name-owner", "dbus-activatable", "session-bus"],
  },
  sound: {
    state: "degraded",
    players: ["pw-play"],
    toneFileAvailable: false,
    checked: ["players", "tone-file"],
  },
  remediation: [{ code: "host-no-tone-file" }],
};

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

/** 假裁决管线：只记下提交体（该不该发、发去哪都是管线的事）。
 * dry-run 直构件走真实实现（本文件不断言它们，端口类型要求齐成员）。 */
function fakePipeline() {
  const submitted: NotifyRequest[] = [];
  const port: PipelinePort = {
    submit: (request) => {
      submitted.push(request);
    },
    finalizeRequest: pipelineApi.finalizeRequest,
    barkTarget: pipelineApi.barkTarget,
    browserTarget: pipelineApi.browserTarget,
    systemTarget: pipelineApi.systemTarget,
    webhookTarget: pipelineApi.webhookTarget,
  };
  return { port, submitted };
}

/** dry-run 不用的配置面：读默认空配置，纯函数走真实实现（与 dry-run.test.ts 同源）。 */
function fakeConfig(): ConfigPort {
  return {
    readConfig: () => ({ ...DEFAULT_CONFIG }),
    readSettingsView: () => {
      throw new Error("本文件不读视图");
    },
    writeConfig: () => Promise.reject(new Error("本文件不写配置")),
    resolveDraftChannels: configApi.resolveDraftChannels,
    normalizeConfig: configApi.normalizeConfig,
  };
}

/** POST 一次测试通知（给定请求对象）。 */
async function postWith(req: IncomingMessage) {
  const pipeline = fakePipeline();
  const { res, rec, json } = makeRes();
  await new ProbeEndpoints(pipeline.port, fakeChannels().port, makeLogger(), fakeConfig()).test(
    req,
    res,
  );
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
    streamHub.install({ logger: makeLogger() });
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
    // 上限 16K（与 settings 端对齐，PR-B）：超限体必须大于 16K 才触发 too-large。
    const { rec, json, pipeline } = await post({ body: { channelId: "a".repeat(20000) } });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid-json", details: "请求体超出大小上限（16384 字节）" },
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

describe("GET /health：报宿主平台、连接回收计数与能力面摘要", () => {
  it("platform 取 channels 域的平台事实（客户端据此写系统通道提示，不能拿浏览器 OS 猜），sseEvicts 形状与真实枢纽逐键一致", async () => {
    const { res, rec, json } = makeRes();
    const channels = fakeChannels({ hostPlatform: () => "darwin" });
    await new ProbeEndpoints(fakePipeline().port, channels.port, makeLogger(), fakeConfig()).health(
      makeReq({ method: "GET" }),
      res,
    );
    expect(rec.status).toBe(200);
    expect(json()).toEqual({
      ok: true,
      plugin: "dsh-notifier",
      // 端口注入的值而不是 process.platform：api 域直读进程全局会让这一格在 CI 上永远只有 linux 可达
      platform: "darwin",
      // 未装配占位：形状（键集）必须与真实枢纽一致，否则「未装配」与「装好但没淘汰过」在 /health 上长得不一样
      sseEvicts: {
        close: 0,
        error: 0,
        stalled: 0,
        maxage: 0,
        destroyed: 0,
        dispose: 0,
      },
      // 摘要：只给结论与维度状态，明细（checked / players / remediation）归 /diagnostics
      capabilities: {
        host: {
          verdict: "degraded",
          unknownDimensions: ["popup"],
          popup: { state: "unknown" },
          sound: { state: "degraded" },
        },
      },
    });
  });

  it("能力自检只探一次：连续两次请求共用同一个 Promise（每请求各探一次就是拿用户机器当靶场）", async () => {
    const channels = fakeChannels();
    const endpoints = new ProbeEndpoints(
      fakePipeline().port,
      channels.port,
      makeLogger(),
      fakeConfig(),
    );

    await endpoints.health(makeReq({ method: "GET" }), makeRes().res);
    await endpoints.health(makeReq({ method: "GET" }), makeRes().res);

    expect(channels.probeCalls()).toBe(1);
    // 摘要不得泄漏明细：客户端要靠 /diagnostics 才拿得到“下一步该干什么”
    const summary = makeRes();
    await endpoints.health(makeReq({ method: "GET" }), summary.res);
    expect(JSON.stringify(summary.json())).not.toContain("host-no-tone-file");
  });
});

describe("能力自检的兜底：诊断附属面不许把探活面拖下水", () => {
  it("探测抛错时 /health 不 500：既有键全在，能力面按「无法判定」上报并留恰好一条 warn", async () => {
    const channels = fakeChannels({ probe: () => Promise.reject(new Error("探测炸了")) });
    const logger = makeLogger();
    const endpoints = new ProbeEndpoints(fakePipeline().port, channels.port, logger, fakeConfig());
    const { res, rec, json } = makeRes();
    await endpoints.health(makeReq({ method: "GET" }), res);

    expect(rec.status).toBe(200);
    const body = wire<{ ok: boolean; platform: string; capabilities: { host: HostCapabilities } }>(
      json(),
    );
    expect(body.ok).toBe(true);
    expect(body.platform).toBe("linux");
    expect(body.capabilities.host).toEqual(UNDETERMINED_SUMMARY);
    expect(logger.warns).toHaveLength(1);

    // 失败结论同样进缓存：不缓存会让每个请求都重新等一遍注定失败的探测
    await endpoints.health(makeReq({ method: "GET" }), makeRes().res);
    expect(channels.probeCalls()).toBe(1);
  });

  it("探测超过总预算即按「无法判定」上报（预算兜底必须真的会到点）", async () => {
    vi.useFakeTimers();
    try {
      const channels = fakeChannels({ probe: () => new Promise<HostCapabilities>(() => {}) });
      const endpoints = new ProbeEndpoints(
        fakePipeline().port,
        channels.port,
        makeLogger(),
        fakeConfig(),
      );
      const { res, json } = makeRes();
      const pending = endpoints.health(makeReq({ method: "GET" }), res);
      // 不引用具体预算值（引用它就等于把常量抄成第二份）：只要求它在 10s 内到点
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(wire<{ capabilities: { host: unknown } }>(json()).capabilities.host).toEqual(
        UNDETERMINED_SUMMARY,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /diagnostics：完整探测面", () => {
  it("给的是 channels 域那一份完整能力面（checked / players / remediation 都在）", async () => {
    const { res, rec, json } = makeRes();
    const channels = fakeChannels();
    await new ProbeEndpoints(
      fakePipeline().port,
      channels.port,
      makeLogger(),
      fakeConfig(),
    ).diagnostics(makeReq({ method: "GET" }), res);
    expect(rec.status).toBe(200);
    const body = wire<{ platform: string; capabilities: { host: HostCapabilities } }>(json());
    expect(body.platform).toBe("linux");
    expect(body.capabilities.host).toEqual(CAPABILITIES);
    // 「响应体零原文」不在这层判：这里注入的是模块常量，`expect(JSON).not.toContain(...)` 结构上永远
    // 成立（一次实现改动都打不红）。真正的判据在域层——`remediation.params` 只由数据表产生，
    // 注入敌意 os-release 时域层用例会红。
  });
});
