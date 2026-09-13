/**
 * dsh-notifier pipeline 域 dispatch 块 —— 重试、退避、节流、在途门与逐频道归位。
 *
 * 判据为什么是这些：
 *  - 重试次数与退避时刻是**出口不可见**的承诺：出口只说「可不可重试」，把 4xx 重投三次或把
 *    网络失败丢掉，用户看到的都是「通知有时来有时不来」；
 *  - system 出口的 1 秒节流挡的是连点测试按钮刷屏，跳过时要把上一次结论透传，否则会在历史里
 *    凭空多出一条「失败」；
 *  - 在途门与逐频道归位决定「慢出口会不会被并发踩」以及「失败记到谁头上」。
 *
 * 时间纪律：重试用例用假时钟推进（真等是 3 秒/例），节流用例只用 `vi.setSystemTime` 钉住
 * 「现在」——它单独用只换掉 `globalThis.Date`，不碰事件循环。时钟被钉住时不能用 `pollUntil`
 * （它的截止时间读 `Date.now()`，谓词不成立就永不超时），故那两处用 `settleMicrotasks`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import type {
  ChannelsPort,
  HistoryEntry,
  NotifyMessage,
  OutgoingFrame,
  PipelineDeps,
} from "../../../src/server/pipeline/deps.ts";
import {
  installPipeline,
  releasePipeline,
  submit,
} from "../../../src/server/pipeline/interface.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/interface.ts";
import { makeLogger, pollUntil } from "../../helpers.ts";

/** 出站频道配置：经设置模型可达，不必请别的块再导出一个名字。 */
type ChannelConfig = NotifyConfig["channels"][number];
type BarkConfig = Extract<ChannelConfig, { type: "bark" }>;
type WebhookConfig = Extract<ChannelConfig, { type: "webhook" }>;

/** 投递目标的形状经端口签名可达。 */
type DeliveryTarget = Parameters<ChannelsPort["deliver"]>[1][number];

/** 关掉两条内置出口：本块要数的是出站频道的投递次数与节奏。 */
const BUILTINS_OFF: Partial<NotifyConfig> = {
  browserNotify: false,
  browserSound: false,
  systemNotify: false,
  systemSound: false,
};

/** 装配面夹具：只伪 `pipeline/deps.ts` 声明的那几个端口，顺手记下四件观测物。 */
interface Harness {
  readonly history: HistoryEntry[];
  readonly statuses: Array<{
    channelId: string;
    status: "ok" | "failed";
    error: string | undefined;
  }>;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly useConfig: (patch?: Partial<NotifyConfig>) => void;
  readonly onDeliver: (deliver: ChannelsPort["deliver"]) => void;
}

function requestOf(over: Partial<NotifyRequest> = {}): NotifyRequest {
  return { kind: "done", title: "标题", body: "正文", ...over };
}

function barkChannel(over: Partial<BarkConfig> = {}): BarkConfig {
  return {
    type: "bark",
    id: "a",
    enabled: true,
    baseUrl: "http://127.0.0.1:40281/bark",
    deviceKey: "dk",
    ...over,
  };
}

function webhookChannel(over: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    type: "webhook",
    id: "w",
    enabled: true,
    url: "http://127.0.0.1:40281/hook",
    auth: "none",
    ...over,
  };
}

/** 只留 system 出口的设置：节流用例要「唯一目标」才数得清投递次数。 */
function systemOnly(): Partial<NotifyConfig> {
  return { ...BUILTINS_OFF, systemNotify: true, systemSound: false, channels: [] };
}

/** 把纯微任务链推到终态（理由见文件头：钉住时钟后 `pollUntil` 的截止时间不再前进）。 */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function assemble(): Harness {
  const history: HistoryEntry[] = [];
  const statuses: Harness["statuses"][number][] = [];
  const frames: OutgoingFrame[] = [];
  const logger = makeLogger();
  const state: { config: NotifyConfig; deliver: ChannelsPort["deliver"] } = {
    config: DEFAULT_CONFIG,
    deliver: async (_message: NotifyMessage, targets: DeliveryTarget[]) =>
      targets.map(() => ({ status: "ok", stage: "delivered" })),
  };
  const deps: PipelineDeps = {
    enabled: true,
    frames: {
      emit: (payload) => {
        frames.push(payload);
      },
    },
    logger,
    config: { readConfig: () => state.config },
    stores: {
      appendHistory: (entry) => {
        history.push(entry);
      },
      recordStatus: (channelId, status, error) => {
        statuses.push({ channelId, status, error });
      },
    },
    channels: { deliver: (message, targets) => state.deliver(message, targets) },
  };
  installPipeline(deps);
  return {
    history,
    statuses,
    logger,
    useConfig: (patch = {}) => {
      state.config = { ...DEFAULT_CONFIG, ...patch };
    },
    onDeliver: (deliver) => {
      state.deliver = deliver;
    },
  };
}

afterEach(() => {
  releasePipeline();
  vi.useRealTimers();
});

describe("重试与退避（假时钟推进，不真等 3 秒）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  // 退避时刻写错（例如固定 0ms）会把可重试失败变成对上游的连打。
  it("bark 重试 2 次、退避 1000/2000ms：次数与时刻都由管线说了算", async () => {
    const harness = assemble();
    harness.useConfig({ ...BUILTINS_OFF, channels: [barkChannel()] });
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return targets.map(() => ({
        status: "failed",
        stage: "delivered",
        reason: "上游 5xx",
        retryable: true,
      }));
    });

    submit(requestOf());
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    // 上限之外不再重投：maxRetries=2 是硬上限，不是「至少两次」。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(3);
  });

  // 出口说不可重试却重投，等于让对端把同一条通知处理多遍。
  it("出口标 retryable=false 时一次也不多投：分类是出口的责任，管线照办", async () => {
    const harness = assemble();
    harness.useConfig({ ...BUILTINS_OFF, channels: [barkChannel()] });
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return targets.map(() => ({
        status: "failed",
        stage: "delivered",
        reason: "设备未注册",
        retryable: false,
      }));
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });

  // webhook 不幂等，策略表漏了 maxRetries=0 就会重投。
  it("webhook 零重试：即便出口标了 retryable 也不重投（策略表 maxRetries=0）", async () => {
    const harness = assemble();
    harness.useConfig({ ...BUILTINS_OFF, channels: [webhookChannel()] });
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return targets.map(() => ({
        status: "failed",
        stage: "delivered",
        reason: "上游 502",
        retryable: true,
      }));
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });
});

describe("逐频道归位", () => {
  // 失败记到别的频道头上，用户会去查一个根本没问题的频道。
  it("终态写频道状态并按频道归位进历史明细：失败原因只在失败那一支上", async () => {
    const harness = assemble();
    harness.useConfig({
      ...BUILTINS_OFF,
      channels: [barkChannel({ id: "a" }), webhookChannel({ id: "w" })],
    });
    harness.onDeliver(async (_message, targets) =>
      targets.map((target) =>
        target.type === "webhook"
          ? {
              status: "failed" as const,
              stage: "delivered" as const,
              reason: "webhook HTTP 401",
              retryable: false,
            }
          : { status: "ok" as const, stage: "delivered" as const },
      ),
    );

    submit(requestOf());
    await pollUntil(() => harness.history.length === 1, "发出归档落史");

    // 频道状态按**完成顺序**落（两个出口并发），故只按频道身份查证结论；顺序判据在归档明细上。
    const statusOf = (channelId: string) =>
      harness.statuses.find((entry) => entry.channelId === channelId);
    expect(harness.statuses).toHaveLength(2);
    expect(statusOf("bark:a")?.status).toBe("ok");
    expect(statusOf("bark:a")?.error).toBeUndefined();
    expect(statusOf("webhook:w")?.status).toBe("failed");
    expect(statusOf("webhook:w")?.error).toBe("webhook HTTP 401");
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "bark:a", status: "ok" },
      { channelId: "webhook:w", status: "failed", reason: "webhook HTTP 401" },
    ]);
  });

  // 一次违约让整批归档消失，健康频道的投递记录也跟着丢。
  it("出口违约不牵连同批：另一频道照常投递并写状态，违约只记一条 warn（宿主事件链不能断）", async () => {
    const harness = assemble();
    harness.useConfig({
      ...BUILTINS_OFF,
      channels: [
        barkChannel({ id: "a", deviceKey: "dk-a" }),
        barkChannel({ id: "b", deviceKey: "dk-b" }),
      ],
    });
    harness.onDeliver(async (_message, targets) => {
      const target = targets[0]!;
      if (target.type === "bark" && target.deviceKey === "dk-a") {
        throw new Error("出口实现违约");
      }
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    });

    submit(requestOf());
    await pollUntil(() => harness.logger.warns.length === 1, "违约要出声");
    await pollUntil(() => harness.statuses.length === 1, "健康频道要写状态");
    expect(harness.logger.warns[0]).toContain("投递失败");
    expect(harness.statuses.map((entry) => `${entry.channelId}:${entry.status}`)).toEqual([
      "bark:b:ok",
    ]);
  });
});

describe("节奏：节流与在途门", () => {
  // 节流跳过时凭空造一条失败，用户会在状态页看到不存在的故障。
  it("system 出口 1 秒节流：窗口内跳过投递并把上一次结论透传给本次（不产生假故障）", async () => {
    const harness = assemble();
    harness.useConfig(systemOnly());
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    });

    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    submit(requestOf());
    await settleMicrotasks();
    expect(attempts).toBe(1);

    submit(requestOf());
    await settleMicrotasks();
    expect(attempts).toBe(1);
    // 跳过也要归档，且结论沿用上一次的 ok——凭空多一条失败记录会让用户以为通知坏了。
    expect(harness.history[1]!.channels).toEqual([{ channelId: "system", status: "ok" }]);

    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 1));
    submit(requestOf());
    await settleMicrotasks();
    expect(attempts).toBe(2);
  });

  // 无上限并发会把同一频道打爆；门形同虚设则慢出口会被并发踩。
  it("在途门：同频道并发上限 2，第 3 条排队到有槽位才开投（慢出口不该被无限并发踩）", async () => {
    const harness = assemble();
    harness.useConfig({ ...BUILTINS_OFF, channels: [barkChannel()] });
    const pending: Array<() => void> = [];
    let started = 0;
    harness.onDeliver(async (_message, targets) => {
      started += targets.length;
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    });

    submit(requestOf());
    submit(requestOf());
    submit(requestOf());
    await pollUntil(() => started === 2, "前两条应立刻开投");
    expect(pending).toHaveLength(2);

    pending.shift()?.();
    await pollUntil(() => started === 3, "槽位释放后队首才开投");
    for (const release of pending.splice(0)) release();
    await pollUntil(() => harness.history.length === 3, "三条都要归档");
  });
});
