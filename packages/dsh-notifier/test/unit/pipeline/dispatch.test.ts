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
 * 「首投递未完成」那条同样钉住「现在」（两条提交必须落在同一节流窗内），等终态一律用
 * `settleMicrotasks`——判据不能落在「两次调用之间真实耗时小于 1 秒」上：CI 与 Stryker 并发
 * 下的停顿会把确定性判据变成偶发假红。
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
import { makeLogger, pollUntil, settleMicrotasks } from "../../helpers.ts";

/** 出站频道配置：经设置模型可达，不必请别的块再导出一个名字。 */
type ChannelConfig = NotifyConfig["channels"][number];
type BarkConfig = Extract<ChannelConfig, { type: "bark" }>;
type WebhookConfig = Extract<ChannelConfig, { type: "webhook" }>;

/** 投递目标的形状经端口签名可达。 */
type DeliveryTarget = Parameters<ChannelsPort["deliver"]>[1][number];

/** 默认表里的内置频道：泛型只为把「按 type 找到的那条」收窄成对应型号——查找条件就是 type 相等。 */
function builtinOf<T extends "browser" | "system">(type: T): Extract<ChannelConfig, { type: T }> {
  const found = DEFAULT_CONFIG.channels.find((channel) => channel.type === type);
  if (found === undefined) throw new Error(`默认表里缺内置频道 ${type}`);
  return found as Extract<ChannelConfig, { type: T }>;
}

/**
 * 关掉两条内置出口：本块要数的是出站频道的投递次数与节奏。
 *
 * 停用只能写在 `channels` 的条目上：`browserNotify` 一类顶层键现在是读面派生出来的只读投影，
 * 改它们不会让内置出口少投一次，计数用例会凭空多出两次投递。
 */
function builtinsOff(): ChannelConfig[] {
  return [
    { ...builtinOf("browser"), enabled: false },
    { ...builtinOf("system"), enabled: false },
  ];
}

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
  /** 让某个频道的状态写面违约（状态文件不可写）：观测面自己坏掉时的行为另算一档。 */
  readonly breakStatusWrites: (channelId: string) => void;
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
  return {
    channels: [
      { ...builtinOf("browser"), enabled: false },
      { ...builtinOf("system"), enabled: true, popup: true, sound: false },
    ],
  };
}

function assemble(): Harness {
  const history: HistoryEntry[] = [];
  const statuses: Harness["statuses"][number][] = [];
  const frames: OutgoingFrame[] = [];
  const logger = makeLogger();
  const brokenStatus = new Set<string>();
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
        if (brokenStatus.has(channelId)) throw new Error("状态写面违约");
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
    breakStatusWrites: (channelId) => {
      brokenStatus.add(channelId);
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
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
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

  // 重试的停止条件有两个：不可重试与已成功。只测「一直失败」的话，重投循环丢掉「重新取结果」
  // 也全绿——而那样第二条已送达的通知会被再投两遍，并在归档里被记成失败。
  it("重试中途成功即停止：第二次成功不再重投，也不写失败", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return attempts === 1
        ? [
            {
              status: "failed" as const,
              stage: "delivered" as const,
              reason: "上游 5xx",
              retryable: true,
            },
          ]
        : [{ status: "ok" as const, stage: "delivered" as const }];
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);

    // 第二次已经成功：上限之内也不许再投，否则同一条通知会在对端出现两遍。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(2);

    await settleMicrotasks();
    expect(harness.history[0]!.channels).toEqual([{ channelId: "bark:a", status: "ok" }]);
    expect(harness.statuses).toEqual([{ channelId: "bark:a", status: "ok", error: undefined }]);
  });

  // 出口说不可重试却重投，等于让对端把同一条通知处理多遍。
  it("出口标 retryable=false 时一次也不多投：分类是出口的责任，管线照办", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
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
    harness.useConfig({ channels: [...builtinsOff(), webhookChannel()] });
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
      channels: [...builtinsOff(), barkChannel({ id: "a" }), webhookChannel({ id: "w" })],
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

  // 一次违约让整批一起拒绝，健康频道的明细与状态跟着消失——故障时最需要的那条证据正好没有。
  it("出口违约不牵连同批：违约频道出一条 failed 明细，健康频道照常投递并写状态，整批不拒绝", async () => {
    const harness = assemble();
    harness.useConfig({
      channels: [
        ...builtinsOff(),
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
    await settleMicrotasks();

    // 明细与 `targets` 同序：违约落在它自己的频道上，健康频道照常留痕。
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "bark:a", status: "failed", reason: "出口实现违约" },
      { channelId: "bark:b", status: "ok" },
    ]);
    // 频道状态按完成顺序落（两个出口并发），故只按频道身份查证结论。
    const statusOf = (channelId: string) =>
      harness.statuses.find((entry) => entry.channelId === channelId);
    expect(statusOf("bark:a")?.status).toBe("failed");
    expect(statusOf("bark:a")?.error).toBe("出口实现违约");
    expect(statusOf("bark:b")?.status).toBe("ok");
    // 整批没有拒绝：调用方那条「投递失败」的兜底 warn 不该被触发（它一响，说明明细已经丢了）。
    expect(harness.logger.warns).toEqual([]);
  });

  // 状态只是观测面：它自己违约若升级成抛出，明细已经拿到手也会被整批带走，等于观测面反过来吃掉事实。
  it("违约频道的状态写面再次违约也不抛出：failed 明细照常进归档，原因仍是出口那条", async () => {
    const harness = assemble();
    harness.useConfig({
      channels: [
        ...builtinsOff(),
        barkChannel({ id: "a", deviceKey: "dk-a" }),
        barkChannel({ id: "b", deviceKey: "dk-b" }),
      ],
    });
    harness.breakStatusWrites("bark:a");
    harness.onDeliver(async (_message, targets) => {
      const target = targets[0]!;
      if (target.type === "bark" && target.deviceKey === "dk-a") {
        throw new Error("出口实现违约");
      }
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    });

    submit(requestOf());
    await settleMicrotasks();

    // 状态写不进去只少一条观测记录，不被状态层的错盖掉、也不改变本次投递的结论。
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "bark:a", status: "failed", reason: "出口实现违约" },
      { channelId: "bark:b", status: "ok" },
    ]);
    expect(harness.statuses.map((entry) => `${entry.channelId}:${entry.status}`)).toEqual([
      "bark:b:ok",
    ]);
    expect(harness.logger.warns).toEqual([]);
  });

  // 出口按配置判定「这次没有可发的内容」时，结果既不是成功也不是失败：状态面不该因此多出一条
  // 「最后一次投递结论」（写 ok 等于替出口宣称投递成功），而历史必须如实留下这次跳过。
  it("出口报 skipped：历史如实记一条跳过与原因，频道状态不被写（没有结论可言）", async () => {
    const harness = assemble();
    const reason = "浏览器频道：弹窗与声音都已关闭";
    harness.onDeliver(async (_message, targets) =>
      targets.map(() => ({ status: "skipped" as const, reason })),
    );

    submit(requestOf());
    await pollUntil(() => harness.history.length === 1, "skipped 落史");
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "browser", status: "skipped", reason },
      { channelId: "system", status: "skipped", reason },
    ]);
    expect(harness.statuses).toEqual([]);
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

  // 首投递还在途时没有任何失败证据：跳过若把「还没结论」写成失败，用户连点测试按钮就会在状态页
  // 看到一条不存在的故障。该路径要求第一次投递仍挂在未决 promise 上，故钉住「现在」让两条提交
  // 落在同一节流窗内，等待一律走微任务排水。
  it("首投递尚未完成时的节流跳过按假定成功透传：不产生第二次投递，也不凭空写一条失败", async () => {
    const harness = assemble();
    harness.useConfig(systemOnly());
    const inFlight: Array<() => void> = [];
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      await new Promise<void>((resolve) => {
        inFlight.push(resolve);
      });
      return targets.map(() => ({
        status: "failed" as const,
        stage: "delivered" as const,
        reason: "系统出口不可用",
        retryable: false,
      }));
    });

    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    submit(requestOf({ title: "第一条" }));
    await settleMicrotasks();
    expect(attempts).toBe(1);
    expect(inFlight).toHaveLength(1);

    // 时钟没有前进：这条提交必然落在首条开启的 1 秒节流窗内，而首条仍未拿到结论。
    submit(requestOf({ title: "第二条" }));
    await settleMicrotasks();

    // 跳过没有产生第二次投递，结论按「假定成功」透传——首条稍后实际失败也不影响这条的结论。
    expect(attempts).toBe(1);
    expect(harness.history[0]!.title).toBe("第二条");
    expect(harness.history[0]!.channels).toEqual([{ channelId: "system", status: "ok" }]);
    // 没有投递就没有结论可写：跳过不该在频道状态里补一条。
    expect(harness.statuses).toEqual([]);

    inFlight.shift()?.();
    await settleMicrotasks();
    expect(harness.history).toHaveLength(2);
    expect(harness.history[1]!.title).toBe("第一条");
    expect(harness.history[1]!.channels).toEqual([
      { channelId: "system", status: "failed", reason: "系统出口不可用" },
    ]);
  });

  // 出口违约时槽位同样要放开：漏一次，该频道的在途计数就永久 +1，两次之后它的通知全部卡在队列里，
  // 表现为「这个频道从此再也不发通知」，而通道本身没有任何错误。
  it("出口违约会放开它在途槽位：两次违约之后第三条照常开投（漏释放即该频道永久卡死）", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    let calls = 0;
    harness.onDeliver(async (_message, targets) => {
      calls += targets.length;
      if (calls <= 2) throw new Error("出口实现违约");
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    });

    submit(requestOf());
    submit(requestOf());
    await pollUntil(() => harness.history.length === 2, "两条违约各自归档");
    expect(harness.logger.warns).toEqual([]);

    submit(requestOf());
    await pollUntil(() => harness.history.length === 3, "槽位释放后第三条开投");
    expect(harness.history[2]!.channels).toEqual([{ channelId: "bark:a", status: "ok" }]);
  });

  // 无上限并发会把同一频道打爆；门形同虚设则慢出口会被并发踩。
  it("在途门：同频道并发上限 2，第 3 条排队到有槽位才开投（慢出口不该被无限并发踩）", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
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
