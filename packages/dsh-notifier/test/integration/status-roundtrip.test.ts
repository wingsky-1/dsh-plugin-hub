/**
 * dsh-notifier — #912 症状2端到端：dispatch 到 stores 到 GET /status 到 statusText，
 * 以及 POST /test fire-and-forget 时序。
 *
 * 真裁决管线 + 真 stores（隔离 DSH_HOME 落盘）+ 真 journal 端点 + 真客户端 statusText。
 * 前两组投递出口是假件（秒回 failed/skipped，不起子进程、不联网）；「真实警告链」一组走
 * 真实 deliver（含真实 sendSystem，OS 进程事实由手写端口假件给出，同样不起真实子进程）
 * 落盘进隔离临时目录。不改 skipped 值域（ok/failed 锁死）：skipped 那条走历史直达到 statusText。
 */
import { readFileSync, rmSync } from "node:fs";
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
const { dryRunTarget, deliver: realDeliver } =
  await import("../../src/server/channels/interface.ts");
const { installSystemDeps, releaseSystemDeps } =
  await import("../../src/server/channels/impl/system/deps.ts");
const { deliveryViewOf } = await import("../../src/client/reason-text.ts");
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

/** 装配真管线 + 真 stores，投递出口由调用方注入（假件，不联网）。
 * config 缺省即默认表；调用方要换配置必须传一份新对象——禁止就地改 DEFAULT_CONFIG
 *（channels 数组是共享引用，就地改会串到其他用例）。 */
function assemble(
  deliver: (message: NotifyMessage, targets: DeliveryTarget[]) => Promise<DeliverResult[]>,
  config: NotifyConfig = { ...DEFAULT_CONFIG },
) {
  const logger = makeLogger();
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

/** 等到 test 记录数达标（多轮投递的顺序判据；轮询读真实 Date，不钉时钟）。 */
async function pollTestHistoryCount(count: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const records = await readHistory();
    const found = records.filter((record) => record.kind === "test");
    if (found.length >= count) return found;
    if (Date.now() > deadline) throw new Error(`测试通知在 10s 内未落史 ${count} 条`);
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

/** 等到状态文件落盘含某频道（落盘是 debounce 合并写，内存可见不等于已落盘）。 */
async function pollStatusFile(channelId: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const stored = JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>;
      if (stored[channelId] !== undefined) return stored;
    } catch {
      // 文件尚不存在或半截：继续等。
    }
    if (Date.now() > deadline) throw new Error("频道状态在 10s 内未落盘");
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

/** 最小系统端口假件：只给原始平台/进程事实，不复刻警告决策（判据全在真实 sendSystem 里）。
 * 探测命中 notify-send 与 paplay；主题文件宣称存在（假 spawn 从不读它，无需真实音频文件）；
 * 弹窗与播放的退出码由调用方给定，全程无真实子进程、不宣称听音。 */
function installFakeSystemPort(popupExit = 0, playerExit = 0, playerStderr = ""): void {
  const DING = "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga";
  installSystemDeps({
    platform: "linux",
    spawn: (command: readonly string[]) => ({
      onStderr: (handler: (chunk: Buffer) => void) => {
        if (command[0] === "paplay" && playerStderr !== "") {
          queueMicrotask(() => handler(Buffer.from(playerStderr, "utf8")));
        }
      },
      onExit: (handler: (exit: { exited: true; code: number }) => void) => {
        const code = command[0] === "notify-send" ? popupExit : playerExit;
        queueMicrotask(() => handler({ exited: true, code }));
      },
      onError: () => {},
      kill: () => {},
      unref: () => {},
    }),
    execFile: (
      bin: string,
      _args: readonly string[],
      _options: { readonly timeout: number },
      done: (failed: boolean) => void,
    ) => void done(bin !== "notify-send" && bin !== "paplay"),
    existsSync: (path: string) => path === DING,
    probeNotificationName: () => Promise.resolve({ kind: "absent" as const }),
    readOsRelease: () => ({ ok: false as const }),
    stageToneAudio: () => ({ ok: true as const, path: "/tmp/dsh-notifier-fake/tone-1.wav" }),
    unstageToneAudio: () => {},
    releaseToneTemps: () => {},
  });
}

/** 主路径警告：paplay 非零退出的成因摘要（单候选，回退链 breakdown 即它本身）。 */
const SOUND_FAILED_WARNING = {
  code: "reasonSystemSoundFailed",
  params: { bin: "paplay" },
  detail: "paplay 退出码 3：no audio device",
} as const;

/** 历史里取 system 明细：缺席即判空（调用方断言存在性，查找本身不猜）。 */
function systemItemOf(
  record:
    | { channels?: Array<{ channelId: string; status?: string; soundWarning?: unknown }> }
    | undefined,
): { channelId: string; status?: string; soundWarning?: unknown } | undefined {
  return record?.channels?.find((item) => item.channelId === "system");
}

/** ok + 主路径警告的断言（历史明细）：终态与警告同形，判据只写一次。 */
function expectWarningDelivery(
  item: { status?: string; soundWarning?: unknown } | undefined,
): void {
  expect(item?.status).toBe("ok");
  expect(item?.soundWarning).toEqual(SOUND_FAILED_WARNING);
}

/** ok + 主路径警告的断言（状态条目）：终态 ok、计数清零、警告随行、无失败残留。 */
function expectWarningStatus(
  map: Record<
    string,
    | { lastStatus?: string; failStreak?: number; lastSoundWarning?: unknown; lastError?: unknown }
    | undefined
  >,
): void {
  expect(map.system?.lastStatus).toBe("ok");
  expect(map.system?.failStreak).toBe(0);
  expect(map.system?.lastSoundWarning).toEqual(SOUND_FAILED_WARNING);
  expect(map.system && "lastError" in map.system).toBe(false);
}

/** 无警告的明细断言：终态照断，警告字段不得残留。 */
function expectCleanDelivery(item: { status?: string } | undefined, status: string): void {
  expect(item?.status).toBe(status);
  expect(item && "soundWarning" in item).toBe(false);
}

/** 无警告的状态断言：终态与计数照断，警告字段不得残留。 */
function expectCleanStatus(
  map: Record<string, { lastStatus?: string; failStreak?: number } | undefined>,
  status: string,
  streak: number,
): void {
  expect(map.system?.lastStatus).toBe(status);
  expect(map.system?.failStreak).toBe(streak);
  expect(map.system && "lastSoundWarning" in map.system).toBe(false);
}

describe("真实警告链：sendSystem → dispatch → stores → journal → client", () => {
  it("弹窗成功但自播失败：历史与状态读回 ok + 警告，failStreak 为 0，客户端两处可见", async () => {
    installFakeSystemPort(0, 3, "no audio device");
    try {
      // 真出站：dispatch 经真实 deliverImpl 打到真实 sendSystem（默认配置 system 弹窗 + 声音全开）。
      const journal = assemble((message, targets) => realDeliver(message, targets));
      submit({ kind: "test", title: "标题", body: "正文" });

      const historyFound = await pollTestHistory();
      expectWarningDelivery(systemItemOf(historyFound[0]));

      const map = await pollStatusEntry("system");
      expectWarningStatus(map);

      const made = makeRes();
      await journal.readStatus(
        jsonReq({ method: "GET", url: "/api/dsh-notifier/status" }),
        made.res,
      );
      expect(made.rec.status).toBe(200);
      const channels = made.json().channels as Record<string, Record<string, unknown>>;
      expect(channels.system?.lastStatus).toBe("ok");
      expect(channels.system?.lastSoundWarning).toEqual(SOUND_FAILED_WARNING);

      const text = statusText("system", channels as ChannelStatusMap, translateWithZh);
      expect(text).toContain(zh.chLastOk);
      expect(text).toContain(zh.soundWarnPlaybackFailed.replace("{bin}", "paplay"));
      const view = deliveryViewOf(systemItemOf(historyFound[0]), translateWithZh);
      expect(view?.statusText).toBe(zh.chStatusOk);
      expect(view?.soundWarning).toBe(zh.soundWarnPlaybackFailed.replace("{bin}", "paplay"));
      expect(view?.soundWarningDetail).toBe("paplay 退出码 3：no audio device");
    } finally {
      releaseSystemDeps();
    }
  });

  it("警告随盘持久、正常投递清警告、失败不挂旧警告：三轮真实链路无残留", async () => {
    installFakeSystemPort(0, 3, "no audio device");
    try {
      // —— 第 1 轮：默认配置（system 弹窗 + 声音），paplay 非零退出 ⇒ ok + 主路径警告。
      assemble((message, targets) => realDeliver(message, targets));
      submit({ kind: "test", title: "标题", body: "正文" });
      await pollStatusEntry("system");
      // 先等 debounce 落盘：内存可见时文件可能还没写，此时重装会把警告丢掉（非产品语义）。
      expect((await pollStatusFile("system")).system).toMatchObject({
        lastStatus: "ok",
        lastSoundWarning: SOUND_FAILED_WARNING,
      });

      // —— 冷启动读回：只重装 stores（文件保留），磁盘上的警告仍在。
      releaseStores();
      installStores({
        logger: makeLogger(),
        config: { readConfig: () => ({ ...DEFAULT_CONFIG }) },
      });
      expect((await readStatus()).system?.lastSoundWarning).toEqual(SOUND_FAILED_WARNING);

      // —— 第 2 轮：同配置、同一窄端口把播放退出码改 0（链成功）⇒ 正常 ok，清掉旧警告。
      // 重装 pipeline 即清掉 dispatch 节奏（1 秒节流不跨装配期），无需固定等待；
      // stores 重装仅为配对装配计数，文件保留、镜像从盘重载。
      // 配置对象每次新建（只读引用，不改 DEFAULT_CONFIG 共享数组）。
      installFakeSystemPort(0, 0);
      releasePipeline();
      releaseStores();
      assemble((message, targets) => realDeliver(message, targets));
      submit({ kind: "test", title: "标题", body: "正文" });
      const second = await pollTestHistoryCount(2);
      expectCleanDelivery(systemItemOf(second[1]), "ok");
      expectCleanStatus(await readStatus(), "ok", 0);

      // —— 第 3 轮：弹窗退出码非 0 ⇒ failed，只带自己的 lastError，不挂旧警告。
      installFakeSystemPort(3, 3, "no audio device");
      releasePipeline();
      releaseStores();
      assemble((message, targets) => realDeliver(message, targets));
      submit({ kind: "test", title: "标题", body: "正文" });
      const third = await pollTestHistoryCount(3);
      expectCleanDelivery(systemItemOf(third[2]), "failed");
      expectCleanStatus(await readStatus(), "failed", 1);
    } finally {
      releaseSystemDeps();
    }
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
