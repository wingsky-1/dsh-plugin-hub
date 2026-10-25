/**
 * dispatch 重试与退避：假时钟推进，不真等 3 秒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { releasePipeline, submit } from "../../../src/server/pipeline/interface.ts";
import { settleMicrotasks } from "../../helpers.ts";
import {
  assemble,
  barkChannel,
  builtinsOff,
  requestOf,
  webhookChannel,
} from "./dispatch-harness.ts";

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
        reason: { code: "reasonBarkHttp", params: { status: 503 } },
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
              reason: { code: "reasonBarkHttp", params: { status: 503 } },
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
        reason: { code: "reasonBarkRejected", params: { code: "400" }, detail: "设备未注册" },
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
        reason: { code: "reasonWebhookHttp", params: { status: 502 } },
        retryable: true,
      }));
    });

    submit(requestOf());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });
});
