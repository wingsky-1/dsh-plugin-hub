/**
 * dispatch 节奏：system 出口节流与同频道在途门。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { releasePipeline, submit } from "../../../src/server/pipeline/interface.ts";
import { pollUntil, settleMicrotasks } from "../../helpers.ts";
import { assemble, barkChannel, builtinsOff, requestOf, systemOnly } from "./dispatch-harness.ts";
import type { Harness } from "./dispatch-harness.ts";

afterEach(() => {
  releasePipeline();
  vi.useRealTimers();
});

/** 三个请求打同一个 bark 频道（maxInflight=2）：前两条占满门，第三条必然在队列里。 */
function threeQueued(harness: Harness) {
  const pending: Array<() => void> = [];
  let attempts = 0;
  harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
  harness.onDeliver(async (_message, targets) => {
    attempts += targets.length;
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    return targets.map(() => ({ status: "ok", stage: "delivered" }));
  });
  return {
    pending,
    attempts: () => attempts,
    /** 放行全部在途投递（模拟它们终于跑完）。 */
    finishInFlight: () => {
      for (const release of pending.splice(0)) release();
    },
  };
}

function registerQueuedCancellation(): void {
  it("队列项结算成 skipped 而不是继续开投：attempts 停在 2，归档如实记一条取消", async () => {
    const harness = assemble();
    const gate = threeQueued(harness);
    submit(requestOf({ title: "第一条" }));
    submit(requestOf({ title: "第二条" }));
    submit(requestOf({ title: "第三条" }));
    await pollUntil(() => gate.attempts() === 2, "前两条占满在途门");

    releasePipeline();
    await settleMicrotasks();

    // 结算出来的是「没投递」：理由必须是取消，不能是失败（没有出口被调用过），
    // 也不能是节流（那会把「插件卸了」说成「这一条太密」）。
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]!.title).toBe("第三条");
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "bark:a", status: "skipped", reason: { code: "reasonDispatchCanceled" } },
    ]);
    // 槽位后来空出来也不会轮到它。
    gate.finishInFlight();
    await pollUntil(() => harness.history.length === 3, "在途两条跑完各自归档");
    expect(gate.attempts()).toBe(2);
  });

  it("卸载后不写频道状态：在途跑完也只是归档，状态写面一次都不碰", async () => {
    const harness = assemble();
    const gate = threeQueued(harness);
    submit(requestOf({ title: "第一条" }));
    submit(requestOf({ title: "第二条" }));
    submit(requestOf({ title: "第三条" }));
    await pollUntil(() => gate.attempts() === 2, "前两条占满在途门");

    releasePipeline();
    gate.finishInFlight();
    await pollUntil(() => harness.history.length === 3, "三条各自归档");

    // 频道状态是给还在用的界面看的观测面：插件卸了就没有读者，写下去只是往磁盘里留僵尸行。
    expect(harness.statuses).toEqual([]);
  });
}

function registerInFlightObservations(): void {
  // 第二条写状态的路：出口在卸载**之后**才违约（网络层抛错常落在这类时刻）。归档明细照常
  // 如实记 failed，但状态写面一次都不许碰。
  it("卸载后出口才违约：归档留 failed 明细，频道状态仍不写", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    const inflight: Array<{ fail: () => void }> = [];
    harness.onDeliver(async () => {
      await new Promise<void>((_resolve, reject) => {
        inflight.push({ fail: () => reject(new Error("出口实现违约")) });
      });
      return [{ status: "ok", stage: "delivered" }];
    });

    submit(requestOf());
    await pollUntil(() => inflight.length === 1, "投递已在途");
    releasePipeline();
    inflight.shift()?.fail();
    await pollUntil(() => harness.history.length === 1, "违约明细落史");

    expect(harness.history[0]!.channels).toEqual([
      {
        channelId: "bark:a",
        status: "failed",
        reason: { code: "reasonChannelThrew", detail: "出口实现违约" },
      },
    ]);
    expect(harness.statuses).toEqual([]);
  });

  it("队列项的 promise 不再挂着：卸载即结算，调用方的 await 有着落", async () => {
    const harness = assemble();
    const gate = threeQueued(harness);
    submit(requestOf({ title: "第一条" }));
    submit(requestOf({ title: "第二条" }));
    submit(requestOf({ title: "第三条" }));
    await pollUntil(() => gate.attempts() === 2, "前两条占满在途门");

    releasePipeline();

    // 在途两条还捏在测试手里，所以「第三条归档了」这件事只可能是它自己的 promise 落了地。
    // 探针带真实超时：永久 pending 的实现会走到 timeout 那一支。
    const outcome = await Promise.race([
      pollUntil(() => harness.history.length === 1, "队列项结算落史", 500).then(
        () => "settled" as const,
        () => "pending" as const,
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
    ]);
    expect(outcome).toBe("settled");
    gate.finishInFlight();
    await pollUntil(() => harness.history.length === 3, "在途两条跑完各自归档");
  });
}

function registerRetryCancellation(): void {
  // 退避循环里的每一次 sleep 都是一次「下次还要对外发请求」的承诺，卸载后这个承诺必须作废。
  // 本例自己钉假时钟（真等 3 秒）：退避是本块唯一的定时器来源。
  it("卸载后不再重试：退避循环停在卸载那一刻，attempts 不再往上走", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      return targets.map(() => ({
        status: "failed" as const,
        stage: "delivered" as const,
        reason: { code: "reasonBarkHttp" as const, params: { status: 503 } },
        retryable: true,
      }));
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // 此刻正卡在第一次退避（1000ms）里。
    releasePipeline();
    await vi.advanceTimersByTimeAsync(5000);
    // 退避 1000 + 2000 两次都还在钟上：卸载后它们不许再变成对外请求。
    expect(attempts).toBe(1);
  });

  // 另一个时间窗：卸载发生在**这次投递还在途**时。失败结果回来后不该再进退避循环——那等于
  // 插件已经卸了还要空等 1s + 2s 才把归档写出来（调用方那边就一直等着）。
  it("卸载发生在失败投递在途时：连退避都不进，归档立刻落定", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    const inflight: Array<() => void> = [];
    let attempts = 0;
    harness.onDeliver(async (_message, targets) => {
      attempts += targets.length;
      await new Promise<void>((resolve) => {
        inflight.push(resolve);
      });
      return targets.map(() => ({
        status: "failed" as const,
        stage: "delivered" as const,
        reason: { code: "reasonBarkHttp" as const, params: { status: 503 } },
        retryable: true,
      }));
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // 失败结果还没回来就卸载，然后才让这一次跑完。
    releasePipeline();
    inflight.shift()?.();
    await vi.advanceTimersByTimeAsync(0);

    // 进了退避循环的话，归档要再等 1000ms 才写得出来。
    expect(harness.history).toHaveLength(1);
    expect(attempts).toBe(1);
  });
}

describe("节奏：节流与在途门", () => {
  registerPacing();

  describe("卸载：队列里的投递结算为取消", () => {
    registerQueuedCancellation();
    registerInFlightObservations();
    registerRetryCancellation();
  });
});

function registerPacing(): void {
  // 跳过时凭空造一条失败，用户会在状态页看到不存在的故障；照抄上一次的结论，则是替一次没发生的
  // 投递背书。两者都不行：唯一诚实的那条记录是「本次没投递，因为节流」。
  it("system 出口 1 秒节流：窗口内不投递并如实记一条 skipped（不照抄上一次的结论）", async () => {
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
    expect(harness.history[1]!.channels).toEqual([
      { channelId: "system", status: "skipped", reason: { code: "reasonThrottled" } },
    ]);
    // 上一次那一条不能被改写：它的结论属于它自己那一次投递。
    expect(harness.history[0]!.channels).toEqual([{ channelId: "system", status: "ok" }]);

    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 1));
    submit(requestOf());
    await settleMicrotasks();
    expect(attempts).toBe(2);
  });

  // 首投递还在途时没有任何失败证据：跳过若把「还没结论」写成失败，用户连点测试按钮就会在状态页
  // 看到一条不存在的故障。该路径要求第一次投递仍挂在未决 promise 上，故钉住「现在」让两条提交
  // 落在同一节流窗内，等待一律走微任务排水。
  it("首投递尚未完成时的节流跳过：不产生第二次投递，也不替首条预支结论", async () => {
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
        reason: { code: "reasonSystemPopupFailed", params: { bin: "notify-send" } },
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

    // 跳过就是跳过：首条此刻还没有结论，这一条既不能宣称成功（假定成功）也不能宣称失败。
    expect(attempts).toBe(1);
    expect(harness.history[0]!.title).toBe("第二条");
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "system", status: "skipped", reason: { code: "reasonThrottled" } },
    ]);
    // 没有投递就没有结论可写：跳过不该在频道状态里补一条。
    expect(harness.statuses).toEqual([]);

    inFlight.shift()?.();
    await settleMicrotasks();
    expect(harness.history).toHaveLength(2);
    expect(harness.history[1]!.title).toBe("第一条");
    expect(harness.history[1]!.channels).toEqual([
      {
        channelId: "system",
        status: "failed",
        reason: { code: "reasonSystemPopupFailed", params: { bin: "notify-send" } },
      },
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
}
