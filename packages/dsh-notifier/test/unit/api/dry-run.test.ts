/**
 * dsh-notifier api 域 probe 块 —— POST /test 的 dry-run 分支（提案 PR-B，症状1）。
 *
 * 判据面（B1/B2/B3/B5/B7）：draft 只认 channels（他键与 revision 忽略）；channelId 必填且须命中
 * 草稿条目；掩码按 id 还原（新频道/改名/跨 type 残留三路 400）；结果 B3 schema 且禁写面零调用
 * （submit / logger.warn 全程零次）；并发帽 2 超限 429 且 finally 释放；15s 总预算超时 408。
 * 出站一律经可注入的 dryRunTarget 桩或真实 browser 路径——无网络、无真实凭据（掩码即还原因子，
 * 真凭据只活在内存夹具里），无落盘（stores 入参结构上不存在，见禁写面用例）。
 */
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelPort, ConfigPort, PipelinePort } from "../../../src/server/api/deps.ts";
import { ProbeEndpoints } from "../../../src/server/api/impl/probe/index.ts";
import * as channelsApi from "../../../src/server/channels/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import * as configApi from "../../../src/server/config/interface.ts";
import type { NotifyConfig, RawSettingValue } from "../../../src/server/config/impl/model/type.ts";
import * as pipelineApi from "../../../src/server/pipeline/interface.ts";
import type { DeliverResult } from "../../../src/server/channels/impl/deliver/type.ts";
import { DRY_RUN_BUDGET_MS } from "../../../src/server/api/impl/probe/dry-run/type.ts";
import { jsonReq, makeLogger, makeRes, settleMicrotasks } from "../../helpers.ts";

/** 掩码占位：独立抄写的跨端契约字面量（见 redact.test.ts 模块头）。 */
const MASK = "********";

/** 已存 bark 频道（含真凭据，只活在内存里）。 */
const STORED_BARK = {
  type: "bark",
  id: "bark-1",
  baseUrl: "https://api.day.app",
  deviceKey: "real-key",
  enabled: true,
};

/** 草稿 browser 频道（真实出站路径可达：browser 不走网络）。 */
const DRAFT_BROWSER = {
  type: "browser",
  id: "browser",
  enabled: true,
  popup: true,
  sound: false,
  whenVisible: false,
};

function channelsOf(...channels: unknown[]): NotifyConfig {
  return { ...DEFAULT_CONFIG, channels: channels as NotifyConfig["channels"] };
}

function fakeConfig(channels: unknown[]): ConfigPort {
  return {
    readConfig: () => channelsOf(...channels),
    readSettingsView: () => {
      throw new Error("dry-run 不读视图");
    },
    writeConfig: () => Promise.reject(new Error("dry-run 不写配置")),
    resolveDraftChannels: configApi.resolveDraftChannels,
    normalizeConfig: configApi.normalizeConfig,
  };
}

function fakePipeline(): PipelinePort & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  return {
    submitted,
    submit: (request) => {
      submitted.push(request);
    },
    finalizeRequest: pipelineApi.finalizeRequest,
    barkTarget: pipelineApi.barkTarget,
    browserTarget: pipelineApi.browserTarget,
    systemTarget: pipelineApi.systemTarget,
    webhookTarget: pipelineApi.webhookTarget,
  };
}

function fakeChannels(over: Partial<ChannelPort> = {}): ChannelPort {
  return {
    probeCapabilities: () => Promise.reject(new Error("dry-run 不探测")),
    hostPlatform: () => "linux",
    undeterminedCapabilities: () => {
      throw new Error("dry-run 不兜底");
    },
    dryRunTarget: channelsApi.dryRunTarget,
    ...over,
  };
}

/** 常驻成功的出站桩（browser 真实路径之外，bark/webhook 必须走桩——无网络）。 */
function okRun(): ChannelPort["dryRunTarget"] {
  return () => Promise.resolve({ status: "ok", stage: "delivered" });
}

async function postTest(
  options: {
    pipeline?: PipelinePort & { submitted: unknown[] };
    channels?: ChannelPort;
    config?: ConfigPort;
    logger?: ReturnType<typeof makeLogger>;
    body?: unknown;
  } = {},
): Promise<{
  rec: { status: number };
  json: () => Record<string, unknown>;
  pipeline: { submitted: unknown[] };
  logger: { warns: string[] };
}> {
  const pipeline = options.pipeline ?? fakePipeline();
  const logger = options.logger ?? makeLogger();
  const config = options.config ?? fakeConfig([STORED_BARK]);
  const endpoints = new ProbeEndpoints(
    pipeline,
    options.channels ?? fakeChannels(),
    logger,
    config,
  );
  const req: IncomingMessage = jsonReq({
    method: "POST",
    url: "/api/dsh-notifier/test",
    body: options.body ?? {},
  });
  const { res, rec, json } = makeRes();
  // RouteHandler 回的是 void | Promise<void>：await 吃掉两种形态（本文件不断言返回体）。
  await endpoints.test(req, res);
  return { rec, json, pipeline, logger };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("POST /test dry-run：只认 channels（B1）", () => {
  it("顶层其它键与 revision 忽略：channels 合法即 200", async () => {
    const { rec, json } = await postTest({
      body: {
        channelId: "browser",
        draft: { channels: [DRAFT_BROWSER], revision: 99, kindRoutes: { x: ["y"] } },
      },
    });
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, channelId: "browser", status: "ok" });
  });

  it("draft 非对象 / channels 非数组 → 400（分支各钉 hint，非 any(String)）", async () => {
    for (const [draft, hint] of [
      [null, "draft 需要对象"],
      [{}, "draft.channels 需要数组"],
      [{ channels: "bark-1" }, "draft.channels 需要数组"],
    ] as const) {
      const { rec, json } = await postTest({ body: { channelId: "bark-1", draft } });
      expect(rec.status).toBe(400);
      expect(json()).toEqual({
        ok: false,
        error: { error: "草稿测试参数非法", details: expect.stringContaining(hint) },
      });
    }
  });

  it("单条非法即 400（bark 缺 deviceKey）", async () => {
    const bad = { type: "bark", id: "bark-1", baseUrl: "https://api.day.app", enabled: true };
    const { rec, json } = await postTest({
      body: { channelId: "bark-1", draft: { channels: [bad] } },
    });
    expect(rec.status).toBe(400);
    expect((json().error as { details: string }).details).toContain("缺少 deviceKey");
  });

  it("无 channelId 即 400（dry-run 只测单个频道）", async () => {
    const { rec } = await postTest({ body: { draft: { channels: [DRAFT_BROWSER] } } });
    expect(rec.status).toBe(400);
  });

  it("channelId 不在草稿里即 400", async () => {
    const { rec, json } = await postTest({
      body: { channelId: "bark:nope", draft: { channels: [DRAFT_BROWSER] } },
    });
    expect(rec.status).toBe(400);
    expect((json().error as { details: string }).details).toContain(
      "没有 channelId 对应的完整条目",
    );
  });

  it("单条实例草稿不带内置也放行（跳过 requireBuiltinsPresent）", async () => {
    const seen: string[] = [];
    const channels = fakeChannels({
      dryRunTarget: (target, message) => {
        seen.push(target.type + " " + JSON.stringify(message).length);
        return okRun()(target, message);
      },
    });
    const { rec, json } = await postTest({
      channels,
      body: { channelId: "bark:bark-1", draft: { channels: [STORED_BARK] } },
    });
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, channelId: "bark:bark-1", status: "ok" });
    expect(seen).toHaveLength(1);
  });
});

describe("POST /test dry-run：掩码往返（B2）", () => {
  it("掩码按 id 还原：出站拿到的是真凭据", async () => {
    const seen: unknown[] = [];
    const channels = fakeChannels({
      dryRunTarget: (target) => {
        seen.push(target);
        return okRun()(target, { title: "t", body: "b", kind: "test", ts: 1 });
      },
    });
    const draft = { ...STORED_BARK, deviceKey: MASK };
    const { rec } = await postTest({
      channels,
      body: { channelId: "bark:bark-1", draft: { channels: [draft] } },
    });
    expect(rec.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "bark", deviceKey: "real-key" });
  });

  it("新频道无源带掩码 → 400", async () => {
    const draft = {
      type: "bark",
      id: "bark-new",
      baseUrl: "https://api.day.app",
      deviceKey: MASK,
      enabled: false,
    };
    const { rec, json } = await postTest({
      body: { channelId: "bark:bark-new", draft: { channels: [draft] } },
    });
    expect(rec.status).toBe(400);
    expect((json().error as { details: string }).details).toContain("新增频道不能提交掩码占位");
  });

  it("id 改名带掩码 → 400（原值按 id 对齐，改名即无源）", async () => {
    const draft = { ...STORED_BARK, id: "bark-renamed", deviceKey: MASK };
    const { rec, json } = await postTest({
      body: { channelId: "bark:bark-renamed", draft: { channels: [draft] } },
    });
    expect(rec.status).toBe(400);
    expect((json().error as { details: string }).details).toContain("新增频道不能提交掩码占位");
  });

  it("跨 type 残留掩码 → 400（bark→webhook 残留 deviceKey）", async () => {
    const stored = {
      type: "webhook",
      id: "webhook-1",
      url: "https://example.test/hook",
      auth: "none",
      enabled: true,
    };
    const draft = { ...stored, deviceKey: MASK };
    const { rec, json } = await postTest({
      config: fakeConfig([stored]),
      body: { channelId: "webhook:webhook-1", draft: { channels: [draft] } },
    });
    expect(rec.status).toBe(400);
    expect((json().error as { details: string }).details).toContain("未还原的掩码占位");
  });
});

describe("POST /test dry-run：结果 schema 与禁写面（B3）", () => {
  it("ok 结果恰为 {ok, channelId, status}（无 reason、无 sseConnections）", async () => {
    const writes: unknown[] = [];
    const config = fakeConfig([STORED_BARK]);
    const writeConfig = config.writeConfig;
    const spyConfig: ConfigPort = {
      ...config,
      writeConfig: ((patch: unknown, revision: unknown) => {
        writes.push([patch, revision]);
        return writeConfig(patch as never, revision as never);
      }) as ConfigPort["writeConfig"],
    };
    const { rec, json, pipeline, logger } = await postTest({
      config: spyConfig,
      body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
    });
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, channelId: "browser", status: "ok" });
    expect(pipeline.submitted).toEqual([]);
    expect(logger.warns).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("failed 结果原样收窄：code / params / detail 三段齐落（截断是出站契约，见 channels 层用例）", async () => {
    const channels = fakeChannels({
      dryRunTarget: () =>
        Promise.resolve({
          status: "failed",
          stage: "delivered",
          reason: { code: "reasonBarkHttp", params: { status: 500 }, detail: "short" },
          retryable: false,
        } as DeliverResult),
    });
    const logger = makeLogger();
    const { rec, json } = await postTest({
      channels,
      logger,
      body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
    });
    expect(rec.status).toBe(200);
    expect(json()).toEqual({
      ok: true,
      channelId: "browser",
      status: "failed",
      reason: { code: "reasonBarkHttp", params: { status: 500 }, detail: "short" },
    });
    expect(logger.warns).toEqual([]);
  });

  it("skipped 结果同样同步返回（browser 双关经真实路径）", async () => {
    const off = { ...DRAFT_BROWSER, popup: false } as Record<string, RawSettingValue>;
    const { rec, json } = await postTest({
      body: { channelId: "browser", draft: { channels: [off] } },
    });
    expect(rec.status).toBe(200);
    expect(json()).toEqual({
      ok: true,
      channelId: "browser",
      status: "skipped",
      reason: { code: "reasonSkipConfig" },
    });
  });

  it("出站抛错即 500 固定文案且不记日志（禁写面含异常收口）", async () => {
    const channels = fakeChannels({
      dryRunTarget: () => Promise.reject(new Error("boom")),
    });
    const logger = makeLogger();
    const { rec, json, pipeline } = await postTest({
      channels,
      logger,
      body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
    });
    expect(rec.status).toBe(500);
    expect(json()).toEqual({ ok: false, error: { error: "草稿测试内部错误" } });
    expect(pipeline.submitted).toEqual([]);
    expect(logger.warns).toEqual([]);
  });
});

describe("POST /test dry-run：BODY_LIMIT 16K（B5，与 settings 对齐）", () => {
  it("超限体 → 400 invalid-json（draft 再大也一样被挡在解析前）", async () => {
    const big = {
      channelId: "browser",
      draft: { channels: [DRAFT_BROWSER], pad: "p".repeat(20000) },
    };
    const { rec, json, pipeline } = await postTest({ body: big });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid-json", details: "请求体超出大小上限（16384 字节）" },
    });
    expect(pipeline.submitted).toEqual([]);
  });
});

describe("POST /test dry-run：并发帽与槽位释放（B5）", () => {
  it("同时 2 个在飞时第 3 个回 429 dry-run-busy；settle 后释放", async () => {
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const gate1 = new Promise<DeliverResult>((resolve) => {
      releaseFirst = () => resolve({ status: "ok", stage: "delivered" });
    });
    const gate2 = new Promise<DeliverResult>((resolve) => {
      releaseSecond = () => resolve({ status: "ok", stage: "delivered" });
    });
    const queue = [gate1, gate2];
    const channels = fakeChannels({ dryRunTarget: () => queue.shift() ?? gate1 });
    const pipeline = fakePipeline();
    const logger = makeLogger();
    const config = fakeConfig([DRAFT_BROWSER]);
    const endpoints = new ProbeEndpoints(pipeline, channels, logger, config);
    const call = async (draft: unknown) => {
      const req: IncomingMessage = jsonReq({
        method: "POST",
        url: "/api/dsh-notifier/test",
        body: { channelId: "browser", draft },
      });
      const slot = makeRes();
      await endpoints.test(req, slot.res);
      return slot;
    };
    const draft = { channels: [DRAFT_BROWSER] };
    const first = call(draft);
    const second = call(draft);
    // 前两次的占槽发生在 body 解析之后（多轮微任务）：排空队列而非只让出一拍，
    // 否则慢 runner 上第三次抢在占槽前，429 会误变成 200（时序假绿/假红）。
    await settleMicrotasks();
    await settleMicrotasks();
    const busy = await call(draft);
    expect(busy.rec.status).toBe(429);
    expect(busy.json()).toEqual({
      ok: false,
      error: {
        code: "dry-run-busy",
        error: "草稿测试并发已满，请稍后手动重试",
        details: "同时最多 2 个 dry-run（不排队）",
      },
    });
    releaseFirst();
    const settled = await first;
    expect(settled.rec.status).toBe(200);
    const retried = await call(draft);
    expect(retried.rec.status).toBe(200);
    releaseSecond();
    expect((await second).rec.status).toBe(200);
    expect(logger.warns).toEqual([]);
  });

  it("出站拒绝也释放槽位（finally 全路径）", async () => {
    const channels = fakeChannels({ dryRunTarget: () => Promise.reject(new Error("boom")) });
    const pipeline = fakePipeline();
    const config = fakeConfig([DRAFT_BROWSER]);
    const endpoints = new ProbeEndpoints(pipeline, channels, makeLogger(), config);
    const call = async () => {
      const req: IncomingMessage = jsonReq({
        method: "POST",
        url: "/api/dsh-notifier/test",
        body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
      });
      const slot = makeRes();
      await endpoints.test(req, slot.res);
      return slot.rec.status;
    };
    expect(await call()).toBe(500);
    expect(await call()).toBe(500);
  });
});

describe("POST /test dry-run：总预算 15s（B7）", () => {
  it("15s 未 settle 即 408 dry-run-timeout，且超时释放槽位", async () => {
    expect(DRY_RUN_BUDGET_MS).toBe(15_000);
    vi.useFakeTimers();
    try {
      let calls = 0;
      const channels = fakeChannels({
        dryRunTarget: () => {
          calls += 1;
          if (calls === 1) return new Promise<DeliverResult>(() => {});
          return Promise.resolve({ status: "ok", stage: "delivered" });
        },
      });
      const pipeline = fakePipeline();
      const logger = makeLogger();
      const endpoints = new ProbeEndpoints(pipeline, channels, logger, fakeConfig([DRAFT_BROWSER]));
      const req: IncomingMessage = jsonReq({
        method: "POST",
        url: "/api/dsh-notifier/test",
        body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
      });
      const slot = makeRes();
      const pending = endpoints.test(req, slot.res);
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(slot.rec.status).toBe(408);
      expect(slot.json()).toEqual({
        ok: false,
        error: {
          code: "dry-run-timeout",
          error: "草稿测试超时（15s），结果已丢弃",
          details: "在飞的投递无法撤回：若对方实际收到了，它不会出现在历史与状态里",
        },
      });
      expect(logger.warns).toEqual([]);
      // 超时同样走 finally：同一实例紧接着再打一次应直通（槽位已释放，不是 429）。
      // 第二次出站即时成功，无需再走 15s 预算（若槽位未释放，这里会是 429）。
      const retryReq: IncomingMessage = jsonReq({
        method: "POST",
        url: "/api/dsh-notifier/test",
        body: { channelId: "browser", draft: { channels: [DRAFT_BROWSER] } },
      });
      const retrySlot = makeRes();
      await endpoints.test(retryReq, retrySlot.res);
      expect(retrySlot.rec.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
