/**
 * dsh-notifier — #912 症状2端到端：dispatch 到 stores 到 GET /status 到 statusText，
 * 以及 POST /test fire-and-forget 时序。
 *
 * 真裁决管线 + 真 stores（隔离 DSH_HOME 落盘）+ 真 journal 端点 + 真客户端 statusText。
 * 投递出口是假件（秒回 failed/skipped，不起子进程、不联网）；落盘进隔离临时目录。
 * 不改 skipped 值域（ok/failed 锁死）：skipped 那条走历史直达到 statusText。
 */
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../src/server/config/impl/model/type.ts";
import {
  HISTORY_FILE_NAME,
  STATUS_FILE_NAME,
  notifierFile,
} from "../../src/server/shared/interface.ts";
import type { NotifyMessage } from "../../src/server/pipeline/deps.ts";
import type { PipelineDeps } from "../../src/server/pipeline/deps.ts";
import type { DeliveryTarget } from "../../src/server/channels/interface.ts";
import type { DeliverResult } from "../../src/server/channels/impl/deliver/type.ts";
import { JournalEndpoints } from "../../src/server/api/impl/journal/index.ts";
import { ProbeEndpoints } from "../../src/server/api/impl/probe/index.ts";
import type { ChannelPort } from "../../src/server/api/deps.ts";
import { zh } from "../../src/client/locales.ts";
import { statusText } from "../../src/client/settings/parts/status.tsx";
import type { ChannelStatusMap } from "../../src/client/settings/parts/status.tsx";
import { jsonReq, makeLogger, makeRes, tempDshHome } from "../helpers.ts";
import { translateWithZh } from "../client-helpers.ts";

// 导入顺序纪律（同 stores/status.test.ts）：单例落盘路径在构造时定下，静态 import 会在
// 任何语句之前求值——顺序反了，落盘就写进真实 DSH home。impl 单例走 await import，且必须
// 在 tempDshHome() 之后。
const home = tempDshHome();
const historyFile = notifierFile(HISTORY_FILE_NAME);
const statusFile = notifierFile(STATUS_FILE_NAME);
const storeApi = await import("../../src/server/stores/interface.ts");
const pipelineApi = await import("../../src/server/pipeline/interface.ts");
// probe 构造要的 dry-run 出站与 config 纯函数（动态导入与上同纪）。
const { dryRunTarget } = await import("../../src/server/channels/interface.ts");
const { finalizeRequest, barkTarget, browserTarget, systemTarget, webhookTarget } =
  await import("../../src/server/pipeline/interface.ts");
const { resolveDraftChannels, normalizeConfig } =
  await import("../../src/server/config/interface.ts");

const installStores = storeApi.installStores;
const releaseStores = storeApi.releaseStores;
const appendHistory = storeApi.appendHistory;
const recordStatus = storeApi.recordStatus;
const readHistory = storeApi.readHistory;
const readStatus = storeApi.readStatus;
const clearHistory = storeApi.clearHistory;
const installPipeline = pipelineApi.installPipeline;
const releasePipeline = pipelineApi.releasePipeline;
const submit = pipelineApi.submit;

/** 装配真管线 + 真 stores，投递出口由调用方注入（假件，不联网）。 */
function assemble(
  deliver: (message: NotifyMessage, targets: DeliveryTarget[]) => Promise<DeliverResult[]>,
) {
  const logger = makeLogger();
  const config: NotifyConfig = { ...DEFAULT_CONFIG };
  installStores({ logger, config: { readConfig: () => ({ ...config }) } });
  const deps: PipelineDeps = {
    enabled: true,
    frames: { emit: () => {} },
    logger,
    config: { readConfig: () => ({ ...config }) },
    stores: { appendHistory, recordStatus },
    channels: { deliver },
  };
  installPipeline(deps);
  return new JournalEndpoints({ readHistory, clearHistory, readStatus });
}

beforeEach(() => {
  rmSync(historyFile, { force: true });
  rmSync(statusFile, { recursive: true, force: true });
});

afterEach(() => {
  releasePipeline();
  releaseStores();
});

afterAll(() => {
  home.dispose();
});

/** 等到历史出现 test 记录（落盘队列是异步的，等可见而不是等固定时长）。 */
async function pollTestHistory() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const records = await readHistory();
    const found = records.filter((record) => record.kind === "test");
    if (found.length > 0) return found;
    if (Date.now() > deadline) throw new Error("测试通知在 10s 内未落史");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等到某频道的状态条目出现（内存镜像即时，等的是异步投递走完）。 */
async function pollStatusEntry(channelId: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const map = await readStatus();
    if (map[channelId] !== undefined) return map;
    if (Date.now() > deadline) throw new Error("频道状态在 10s 内未出现");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("dispatch 到 stores 到 GET /status 到 statusText（真 failed 翻页）", () => {
  it("失败投递经状态端点读回 failed，statusText 显示最近投递失败", async () => {
    const journal = assemble((_message, targets) =>
      Promise.resolve(
        targets.map(() => ({
          status: "failed",
          stage: "delivered",
          reason: { code: "reasonSystemPopupFailed", params: { bin: "notify-send" } },
          retryable: false,
        })),
      ),
    );
    submit({ kind: "test", title: "标题", body: "正文" });

    const historyFound = await pollTestHistory();
    // 三面一致其一：同一条 test 记录里 system 即失败（含投递原因码）
    const historyChannels = historyFound[0].channels ?? [];
    const failedItem = historyChannels.find((item) => item.channelId === "system");
    expect(failedItem?.status).toBe("failed");
    expect(failedItem?.reason?.code).toBe("reasonSystemPopupFailed");
    const map = await pollStatusEntry("system");
    const systemEntry = map.system;
    expect(systemEntry && systemEntry.lastStatus).toBe("failed");
    expect(systemEntry && typeof systemEntry.lastTs).toBe("number");

    const made = makeRes();
    await journal.readStatus(jsonReq({ method: "GET", url: "/api/dsh-notifier/status" }), made.res);
    expect(made.rec.status).toBe(200);
    const channels = made.json().channels as Record<string, { lastStatus: string; lastTs: number }>;
    const got = channels.system;
    expect(got && got.lastStatus).toBe("failed");
    expect(got && typeof got.lastTs).toBe("number");

    const text = statusText("system", channels as ChannelStatusMap, translateWithZh);
    expect(text).toContain(zh.chLastFail);
  });

  it("skipped 不写状态但落历史：状态端点无条目，statusText 经历史直达给解释", async () => {
    const journal = assemble((_message, targets) =>
      Promise.resolve(
        targets.map(() => ({ status: "skipped", reason: { code: "reasonSkipConfig" } })),
      ),
    );
    submit({ kind: "test", title: "标题", body: "正文" });

    const found = await pollTestHistory();
    const first = found[0];
    expect(first && first.channels).toContainEqual({
      channelId: "system",
      status: "skipped",
      reason: { code: "reasonSkipConfig" },
    });

    const made = makeRes();
    await journal.readStatus(jsonReq({ method: "GET", url: "/api/dsh-notifier/status" }), made.res);
    expect(made.rec.status).toBe(200);
    // skipped 没有“最后一次投递结论”：状态表里没有该频道的键（值域 ok/failed 锁死）。
    expect(made.json().channels).toEqual({});

    const records = await readHistory();
    const text = statusText("system", {}, translateWithZh, records);
    expect(text).toContain(zh.chNeverSent);
    expect(text).toContain(zh.reasonSkipConfig);
    expect(text).toContain(zh.chSkippedSeeHistory);
  });
});

describe("POST /test 时序：先 200 受理，投递终态随后才可见", () => {
  it("响应返回时历史为空；放行投递后历史与状态相继出现", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const logger = makeLogger();
    const config: NotifyConfig = { ...DEFAULT_CONFIG };
    installStores({ logger, config: { readConfig: () => ({ ...config }) } });
    installPipeline({
      enabled: true,
      frames: { emit: () => {} },
      logger,
      config: { readConfig: () => ({ ...config }) },
      stores: { appendHistory, recordStatus },
      channels: {
        deliver: (_message, targets) =>
          gate.then((): DeliverResult[] =>
            targets.map(() => ({ status: "ok", stage: "delivered" })),
          ),
      },
    });
    const channels: ChannelPort = {
      probeCapabilities: () => Promise.reject(new Error("本用例不探测")),
      hostPlatform: () => "linux",
      undeterminedCapabilities: () => {
        throw new Error("本用例不探测");
      },
      dryRunTarget,
    };
    const probe = new ProbeEndpoints(
      {
        submit,
        finalizeRequest,
        barkTarget,
        browserTarget,
        systemTarget,
        webhookTarget,
      },
      channels,
      makeLogger(),
      {
        readConfig: () => ({ ...config }),
        readSettingsView: () => {
          throw new Error("本用例不读视图");
        },
        writeConfig: () => Promise.reject(new Error("本用例不写配置")),
        resolveDraftChannels,
        normalizeConfig,
      },
    );

    const made = makeRes();
    await probe.test(
      jsonReq({ method: "POST", url: "/api/dsh-notifier/test", body: {} }),
      made.res,
    );
    expect(made.rec.status).toBe(200);
    expect(made.json()).toEqual({ ok: true, sseConnections: 0 });
    // fire-and-forget：响应只承诺已受理，投递还在门后——此刻历史必须仍是空的。
    expect(await readHistory()).toEqual([]);

    if (releaseGate !== undefined) releaseGate();
    const released = await pollTestHistory();
    const releasedChannels = released[0].channels ?? [];
    const okItem = releasedChannels.find((item) => item.channelId === "browser");
    expect(okItem?.status).toBe("ok");
    const map = await pollStatusEntry("browser");
    const browserEntry = map.browser;
    expect(browserEntry && browserEntry.lastStatus).toBe("ok");
  });
});
