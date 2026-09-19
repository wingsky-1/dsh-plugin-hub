/**
 * dsh-notifier — 测试投递状态收敛轮询的首个单测（#912 症状2次因）。
 *
 * sendTest/loadStatus 本体住在 index.tsx（import react 与 style.css，node 无法导入），
 * 此前没有任何行为判据；收敛判定与有限轮询收进 settings/status-poll.ts 后第一次可直测。
 * 时间全部经注入的 sleep 假件推进，不真等；离线、无凭据。
 */
import { describe, expect, it } from "vitest";

import {
  TEST_STATUS_ATTEMPTS,
  TEST_STATUS_INTERVAL_MS,
  pollChannelStatus,
  statusConverged,
  type StatusMapView,
} from "../../src/client/settings/status-poll.ts";

/** 睡眠假件：只记下间隔，不真等（轮询的时间语义由调用次数与间隔值断言）。 */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe("statusConverged：以条目出现/lastTs 推进为收敛", () => {
  it("无条目时不收敛", () => {
    expect(statusConverged({}, "system", undefined)).toBe(false);
  });

  it("prevTs 缺席时出现的任何条目都是新证据", () => {
    expect(
      statusConverged({ system: { lastTs: 100, lastStatus: "ok" } }, "system", undefined),
    ).toBe(true);
  });

  it("prevTs 存在时以严格变新为准（同毫秒不等旧结论冒充新结论）", () => {
    const map: StatusMapView = { system: { lastTs: 100, lastStatus: "ok" } };
    expect(statusConverged(map, "system", 100)).toBe(false);
    expect(statusConverged(map, "system", 99)).toBe(true);
    expect(statusConverged({ system: { lastTs: 101 } }, "system", 100)).toBe(true);
  });

  it("lastTs 非数字不收敛（脏数据不算证据）", () => {
    expect(statusConverged({ system: { lastTs: "100" } }, "system", undefined)).toBe(false);
    expect(statusConverged({ system: { lastStatus: "failed" } }, "system", undefined)).toBe(false);
  });

  it("只看目标频道（别频道的终态不算收敛）", () => {
    expect(
      statusConverged({ browser: { lastTs: 200, lastStatus: "ok" } }, "system", undefined),
    ).toBe(false);
  });

  it("条目为 null 不收敛（防御性分支：不断言即有存活变异体）", () => {
    const map = { system: null } as unknown as StatusMapView;
    expect(statusConverged(map, "system", undefined)).toBe(false);
    expect(statusConverged(map, "system", 100)).toBe(false);
  });
});

describe("pollChannelStatus：有限轮询、失败保留旧态", () => {
  it("首轮即收敛时不再睡、不再读（一次 fetch 即停）", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        return Promise.resolve({ system: { lastTs: 7, lastStatus: "failed" } });
      },
      "system",
      undefined,
      { sleep: clock.sleep },
    );
    expect(result).toEqual({
      converged: true,
      map: { system: { lastTs: 7, lastStatus: "failed" } },
    });
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it("第二轮才出现条目：睡一次间隔再读到即收敛（真 failed 的时序原型）", async () => {
    const clock = fakeSleep();
    const reads: StatusMapView[] = [{}, { system: { lastTs: 50, lastStatus: "failed" } }];
    const result = await pollChannelStatus(
      () => Promise.resolve(reads.shift() ?? {}),
      "system",
      undefined,
      { sleep: clock.sleep },
    );
    expect(result.converged).toBe(true);
    expect(result.map).toEqual({ system: { lastTs: 50, lastStatus: "failed" } });
    expect(clock.waits).toEqual([TEST_STATUS_INTERVAL_MS]);
  });

  it("耗尽仍未收敛：停在最大轮次，返回最后所见（调用方保留旧态+刷历史）", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        return Promise.resolve({});
      },
      "system",
      undefined,
      { attempts: 3, intervalMs: 10, sleep: clock.sleep },
    );
    expect(result).toEqual({ converged: false, map: {} });
    expect(calls).toBe(3);
    expect(clock.waits).toEqual([10, 10]);
  });

  it("单轮 fetch 抛错不抛给调用方：记为本轮无果继续下一轮", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("抖动"));
        return Promise.resolve({ system: { lastTs: 9, lastStatus: "ok" } });
      },
      "system",
      undefined,
      { sleep: clock.sleep },
    );
    expect(result.converged).toBe(true);
    expect(result.map).toEqual({ system: { lastTs: 9, lastStatus: "ok" } });
    expect(calls).toBe(2);
    // 抛错那轮不算“读到”，下一轮前仍睡一次默认间隔
    expect(clock.waits).toEqual([TEST_STATUS_INTERVAL_MS]);
  });

  it("全败时 map 为 null（调用方以此为号保留旧态，不清空状态行）", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        return Promise.reject(new Error("全挂"));
      },
      "system",
      undefined,
      { attempts: 2, sleep: clock.sleep },
    );
    expect(result).toEqual({ converged: false, map: null });
    // 有限轮：2 轮就是 2 次读、轮间睡 1 次（默认间隔）
    expect(calls).toBe(2);
    expect(clock.waits).toEqual([TEST_STATUS_INTERVAL_MS]);
  });

  it("携带 prevTs 时同毫秒不收敛、变新才收敛（旧结论不冒充新结论）", async () => {
    const clock = fakeSleep();
    const reads: StatusMapView[] = [
      { system: { lastTs: 100, lastStatus: "ok" } },
      { system: { lastTs: 100, lastStatus: "failed" } },
      { system: { lastTs: 101, lastStatus: "failed" } },
    ];
    const result = await pollChannelStatus(
      () => Promise.resolve(reads.shift() ?? {}),
      "system",
      100,
      { sleep: clock.sleep },
    );
    expect(result.converged).toBe(true);
    expect(result.map).toEqual({ system: { lastTs: 101, lastStatus: "failed" } });
    // 首轮同毫秒不等、次轮仍同毫秒不等，第三轮变新才停：睡 2 次默认间隔
    expect(clock.waits).toEqual([TEST_STATUS_INTERVAL_MS, TEST_STATUS_INTERVAL_MS]);
  });

  it("别频道的终态不触发收敛：耗尽返回最后所见", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        return Promise.resolve({ browser: { lastTs: 200, lastStatus: "ok" } });
      },
      "system",
      undefined,
      { attempts: 2, sleep: clock.sleep },
    );
    expect(result).toEqual({
      converged: false,
      map: { browser: { lastTs: 200, lastStatus: "ok" } },
    });
    expect(calls).toBe(2);
    expect(clock.waits).toEqual([TEST_STATUS_INTERVAL_MS]);
  });

  it("attempts 为 0 时一次也不读（显式关闭轮询的形态）", async () => {
    const clock = fakeSleep();
    let calls = 0;
    const result = await pollChannelStatus(
      () => {
        calls += 1;
        return Promise.resolve({});
      },
      "system",
      undefined,
      { attempts: 0, sleep: clock.sleep },
    );
    expect(result).toEqual({ converged: false, map: null });
    expect(calls).toBe(0);
    expect(clock.waits).toEqual([]);
  });

  it("默认预算覆盖 debounce 与子进程耗时（8 轮 x 1500ms，判据钉住常量）", () => {
    expect(TEST_STATUS_ATTEMPTS).toBe(8);
    expect(TEST_STATUS_INTERVAL_MS).toBe(1500);
    expect(TEST_STATUS_ATTEMPTS * TEST_STATUS_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    // 语义下界（与常量值解耦，调优预算时不断）：间隔必须躲开 system 1 秒节流窗，
    // 总预算必须覆盖“能力探测 3s + 子进程投递 8s + 落盘 debounce 500ms”约 11.5s
    expect(TEST_STATUS_INTERVAL_MS).toBeGreaterThan(1000);
    expect(TEST_STATUS_ATTEMPTS * TEST_STATUS_INTERVAL_MS).toBeGreaterThanOrEqual(11_500);
  });
});
