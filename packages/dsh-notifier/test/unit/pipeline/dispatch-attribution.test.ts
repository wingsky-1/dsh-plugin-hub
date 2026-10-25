/**
 * dispatch 逐频道归位：终态、警告与观测面违约各归各频道。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { releasePipeline, submit } from "../../../src/server/pipeline/interface.ts";
import { pollUntil, settleMicrotasks } from "../../helpers.ts";
import {
  assemble,
  barkChannel,
  builtinsOff,
  requestOf,
  systemOnly,
  webhookChannel,
} from "./dispatch-harness.ts";

afterEach(() => {
  releasePipeline();
  vi.useRealTimers();
});

function registerPerChannelOutcomes(): void {
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
              reason: { code: "reasonWebhookHttp", params: { status: 401 } },
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
    expect(statusOf("webhook:w")?.error).toEqual({
      code: "reasonWebhookHttp",
      params: { status: 401 },
    });
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "bark:a", status: "ok" },
      {
        channelId: "webhook:w",
        status: "failed",
        reason: { code: "reasonWebhookHttp", params: { status: 401 } },
      },
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
      {
        channelId: "bark:a",
        status: "failed",
        reason: { code: "reasonChannelThrew", detail: "出口实现违约" },
      },
      { channelId: "bark:b", status: "ok" },
    ]);
    // 频道状态按完成顺序落（两个出口并发），故只按频道身份查证结论。
    const statusOf = (channelId: string) =>
      harness.statuses.find((entry) => entry.channelId === channelId);
    expect(statusOf("bark:a")?.status).toBe("failed");
    expect(statusOf("bark:a")?.error).toEqual({
      code: "reasonChannelThrew",
      detail: "出口实现违约",
    });
    expect(statusOf("bark:b")?.status).toBe("ok");
    // 整批没有拒绝：调用方那条「投递失败」的兜底 warn 不该被触发（它一响，说明明细已经丢了）。
    expect(harness.logger.warns).toEqual([]);
  });
}

function registerStatusObservationIsolation(): void {
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
      {
        channelId: "bark:a",
        status: "failed",
        reason: { code: "reasonChannelThrew", detail: "出口实现违约" },
      },
      { channelId: "bark:b", status: "ok" },
    ]);
    expect(harness.statuses.map((entry) => `${entry.channelId}:${entry.status}`)).toEqual([
      "bark:b:ok",
    ]);
    expect(harness.logger.warns).toEqual([]);
  });
}

function registerSkippedAndWarningOutcomes(): void {
  // 出口按配置判定「这次没有可发的内容」时，结果既不是成功也不是失败：状态面不该因此多出一条
  // 「最后一次投递结论」（写 ok 等于替出口宣称投递成功），而历史必须如实留下这次跳过。
  it("出口报 skipped：历史如实记一条跳过与原因，频道状态不被写（没有结论可言）", async () => {
    const harness = assemble();
    const reason = { code: "reasonSkipConfig" } as const;
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

  // ok 随行的声音警告是投递事实的一部分：归档与状态两处都随行，终态仍是 ok（不计失败）。
  it("ok + soundWarning：历史明细带警告，状态记 ok + 警告（总体仍成功）", async () => {
    const harness = assemble();
    harness.useConfig(systemOnly());
    const warning = { code: "reasonSystemSoundFailed", params: { bin: "pw-play" } } as const;
    harness.onDeliver(async (_message, targets) =>
      targets.map(() => ({
        status: "ok" as const,
        stage: "delivered" as const,
        soundWarning: warning,
      })),
    );

    submit(requestOf());
    await pollUntil(() => harness.history.length === 1, "带警告的 ok 落史");
    expect(harness.history[0]!.channels).toEqual([
      { channelId: "system", status: "ok", soundWarning: warning },
    ]);
    expect(harness.statuses).toEqual([
      { channelId: "system", status: "ok", error: undefined, soundWarning: warning },
    ]);
  });

  // 下一次正常成功不再带警告：状态写面收到的是无警告的 ok（存储层据此清掉旧警告）。
  it("下一次正常 ok 不带警告：状态写面收到无警告的 ok，旧警告不挂到新记录", async () => {
    const harness = assemble();
    harness.useConfig(systemOnly());
    const warning = { code: "reasonSkipEnvironment" } as const;
    let calls = 0;
    harness.onDeliver(async (_message, targets) => {
      calls += 1;
      return calls === 1
        ? targets.map(() => ({
            status: "ok" as const,
            stage: "delivered" as const,
            soundWarning: warning,
          }))
        : targets.map(() => ({ status: "ok" as const, stage: "delivered" as const }));
    });

    submit(requestOf());
    await pollUntil(() => harness.history.length === 1, "第一次落史");
    // system 出口有 1 秒节流：时钟向前拨过窗口（相对现在，不钉固定过去时刻），第二条才开投。
    vi.setSystemTime(new Date(Date.now() + 1200));
    submit(requestOf());
    await pollUntil(() => harness.history.length === 2, "第二次落史");

    expect(harness.history[0]!.channels).toEqual([
      { channelId: "system", status: "ok", soundWarning: warning },
    ]);
    expect(harness.history[1]!.channels).toEqual([{ channelId: "system", status: "ok" }]);
    expect(harness.statuses[1]).toEqual({
      channelId: "system",
      status: "ok",
      error: undefined,
      soundWarning: undefined,
    });
  });
}

describe("逐频道归位", () => {
  registerPerChannelOutcomes();
  registerStatusObservationIsolation();
  registerSkippedAndWarningOutcomes();
});
