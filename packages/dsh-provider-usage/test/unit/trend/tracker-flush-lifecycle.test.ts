/**
 * dsh-provider-usage - unit: Tracker 防抖、flushNow、dispose 与异常接线生命周期。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TrendCollector } from "../../../src/server/collect/interface.ts";
import { HEADER, T0, USAGE, ev } from "./collector-test-support.ts";
import { HOUR } from "./aggregator-test-support.ts";

const trackerRoots: string[] = [];

function createTrackerRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  trackerRoots.push(root);
  return root;
}

function cleanupTrackerRoots(): void {
  for (const root of trackerRoots) {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("tracker：防抖刷盘 + dispose await 刷盘", () => {
  let unpersistedRows: number;
  let flushed: boolean;

  beforeAll(async () => {
    const root = createTrackerRoot("dou-trend-flush-");
    const today = dayKey(T0);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 30,
    });
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 5 } } },
        T0,
        1,
      ),
    );
    unpersistedRows = tracker.stats().unpersistedRows;
    const detailFile = join(root, "details", `${today}.jsonl`);
    flushed = existsSync(detailFile);
    const deadline = Date.now() + 3000;
    while (!flushed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      flushed = existsSync(detailFile);
    }
    await tracker.dispose();
  });

  it("未落盘行计数", () => {
    expect(unpersistedRows).toBe(1);
  });

  it("防抖窗口后自动刷盘", () => {
    expect(flushed).toBeTruthy();
  });
});

describe("tracker：dispose await 最终刷盘", () => {
  let detailShardExists: boolean;

  beforeAll(async () => {
    // dispose await 最终刷盘：事件后立即 dispose，分片必落盘
    const root = createTrackerRoot("dou-trend-dispose-");
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
    });
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 9, outputTokens: 9 } } },
        T0,
        1,
      ),
    );
    await tracker.dispose();
    detailShardExists = existsSync(join(root, "details", `${dayKey(T0)}.jsonl`));
  });

  it("dispose await 刷盘（防抖远未到期）", () => {
    expect(detailShardExists).toBeTruthy();
  });
});

describe("tracker：flushNow 语义与 handleDisposed 清理", () => {
  let unpersistedRows: number;

  beforeAll(async () => {
    // session/flush 语义在 tracker 层等价 flushNow；handleDisposed 清理不崩
    const root = createTrackerRoot("dou-trend-flushpt-");
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
    });
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3 } } },
        T0,
        1,
      ),
    );
    await tracker.flushNow();
    unpersistedRows = tracker.stats().unpersistedRows;
    tracker.handleDisposed({ id: "s1" });
    await tracker.dispose();
  });

  it("flushNow 排空后无未落盘行", () => {
    expect(unpersistedRows).toBe(0);
  });
});

describe("评审修复 P1-3（tracker 级）：flush 部分失败不重复 append、失败日待补", () => {
  let todayLinesAfterFirst: number;
  let unpersistedAfterFirst: number;
  let cellsAfterFirst: number;
  let todayLinesAfterSecond: number;
  let unpersistedAfterSecond: number;
  let pastAggHealed: boolean;

  beforeAll(async () => {
    // P1-3 tracker 级：flush 部分失败后成功日不重写（不重复 append → 崩溃重建不双算）、
    // 失败日行待下轮补上（时钟回拨过去日 + 分片目录障碍构造 EISDIR）。
    const root = createTrackerRoot("dou-trend-partial2-");
    const nowMs = T0; // 09-04 today
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
    });
    const H = { header: { config: { provider: "p", model: "m" } }, reason: "initial" };
    const today = dayKey(T0);
    const pastDay = dayKey(T0 - 24 * HOUR); // 09-03
    tracker.handleEvent({ id: "s1" }, ev("request/header", H, T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2)); // 今日行
    tracker.handleEvent({ id: "s2" }, ev("request/header", H, T0 - 24 * HOUR, 3));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0 - 24 * HOUR, 4)); // 过去日行
    mkdirSync(join(root, "details", `${pastDay}.jsonl`), { recursive: true }); // 失败日障碍
    await tracker.flushNow();
    todayLinesAfterFirst = readFileSync(join(root, "details", `${today}.jsonl`), "utf8")
      .trimEnd()
      .split("\n").length;
    unpersistedAfterFirst = tracker.stats().unpersistedRows;
    cellsAfterFirst = tracker.buckets().find((d) => d.day === today)!.providers[0].cell.calls;
    rmdirSync(join(root, "details", `${pastDay}.jsonl`)); // 移除障碍
    await tracker.flushNow();
    todayLinesAfterSecond = readFileSync(join(root, "details", `${today}.jsonl`), "utf8")
      .trimEnd()
      .split("\n").length;
    unpersistedAfterSecond = tracker.stats().unpersistedRows;
    pastAggHealed = existsSync(join(root, "agg", `${pastDay}.jsonl`));
    await tracker.dispose();
  }, 60_000);

  it("成功日分片有行", () => {
    expect(todayLinesAfterFirst).toBe(1);
  });

  it("unpersisted 只剩失败日行", () => {
    expect(unpersistedAfterFirst).toBe(1);
  });

  it("成功日 cells 不双算", () => {
    expect(cellsAfterFirst).toBe(1);
  });

  it("成功日分片行数不变（不重写）", () => {
    expect(todayLinesAfterSecond).toBe(1);
  });

  it("失败日行已补上排空", () => {
    expect(unpersistedAfterSecond).toBe(0);
  });

  it("过去日补盘后自愈压实", () => {
    expect(pastAggHealed).toBe(true);
  });
});

describe("评审修复 P2-6：tracker 侧 onAnomaly 接线到 warn", () => {
  let warnHit: boolean;

  beforeAll(async () => {
    // P2-6 tracker 接线：collector onAnomaly → tracker 统一 warn 出口
    const warns: string[] = [];
    const root = createTrackerRoot("dou-trend-anomaly-");
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      warn: (m) => warns.push(m),
    });
    tracker.handleEvent(
      { id: "s1" },
      ev("request/header", HEADER("deepseek", "deepseek-chat"), T0, 1),
    );
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            source: { kind: "model", provider: "opencode", model: "glm-4" },
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        T0,
        2,
      ),
    );
    warnHit = warns.some((m) => m.includes("归属"));
    await tracker.dispose();
  });

  it("tracker 侧 onAnomaly 接线到 warn", () => {
    expect(warnHit).toBeTruthy();
  });
});

afterAll(() => cleanupTrackerRoots());
