/**
 * dsh-provider-usage - unit: Tracker 启动重建、自愈压实与当日明细重建。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TrendCollector } from "../../../src/server/collect/interface.ts";
import { T0, ev } from "./collector-test-support.ts";
import { HOUR } from "./aggregator-test-support.ts";

function writeAggShardLine(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}

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

describe("tracker：启动重建（聚合分片权威）", () => {
  let cellCalls: number;
  let cellInput: number | null;
  let residueDeleted: boolean;

  beforeAll(async () => {
    // 启动重建：聚合分片权威——同日明细分片为压实残留，忽略并自愈删除
    const root = createTrackerRoot("dou-trend-rebuild-");
    const day1 = "2026-09-03";
    const aggDir = join(root, "agg");
    const detDir = join(root, "details");
    mkdirSync(aggDir, { recursive: true });
    mkdirSync(detDir, { recursive: true });
    writeFileSync(
      join(aggDir, `${day1}.jsonl`),
      writeAggShardLine({
        v: 1,
        kind: "agg",
        day: day1,
        provider: "p",
        model: "m",
        input: 10,
        output: 5,
        cacheRead: null,
        cacheWrite: null,
        calls: 2,
        turns: 1,
        toolCalls: 0,
      }),
    );
    writeFileSync(
      join(detDir, `${day1}.jsonl`),
      `${JSON.stringify({ v: 1, kind: "detail", time: T0, day: day1, session: "sx", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 999, output: 999, cacheRead: null, cacheWrite: null, calls: 1 })}\n`,
    );
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 50,
    });
    // buckets() 按请求日键必有桶（数据刚写入），find 命中是前置语义。
    const b = tracker.buckets().find((d) => d.day === day1)!;
    cellCalls = b.providers[0].cell.calls;
    cellInput = b.providers[0].cell.input;
    residueDeleted = existsSync(join(detDir, `${day1}.jsonl`));
    await tracker.dispose();
  });

  it("聚合权威：残留明细不计入（不双算）", () => {
    expect(cellCalls).toBe(2);
  });

  it("聚合权威 token", () => {
    expect(cellInput).toBe(10);
  });

  it("残留明细分片自愈删除", () => {
    expect(residueDeleted).toBe(false);
  });
});

describe("tracker：自愈压实（过去日明细无聚合分片）", () => {
  let cellCalls: number;
  let aggWritten: boolean;
  let detailDeleted: boolean;

  beforeAll(async () => {
    // 自愈压实：过去日明细分片无聚合分片 → 重建后立即压实
    const root = createTrackerRoot("dou-trend-heal-");
    const day1 = "2026-09-03";
    const aggDir = join(root, "agg");
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    writeFileSync(
      join(detDir, `${day1}.jsonl`),
      [
        JSON.stringify({
          v: 1,
          kind: "detail",
          time: T0,
          day: day1,
          session: "sx",
          turn: 1,
          step: 1,
          retry: 1,
          provider: "p",
          model: "m",
          input: 7,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        }),
        JSON.stringify({
          v: 1,
          kind: "counter",
          time: T0,
          day: day1,
          session: "sx",
          provider: "p",
          model: "m",
          turns: 1,
          toolCalls: 1,
        }),
        "", // 尾空行容忍
      ].join("\n"),
    );
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 50,
    });
    const b = tracker.buckets().find((d) => d.day === day1)!;
    cellCalls = b.providers[0].cell.calls;
    aggWritten = existsSync(join(aggDir, `${day1}.jsonl`));
    detailDeleted = existsSync(join(detDir, `${day1}.jsonl`));
    await tracker.dispose();
  });

  it("明细权威：重建进 cells", () => {
    expect(cellCalls).toBe(1);
  });

  it("自愈压实写出聚合分片", () => {
    expect(aggWritten).toBe(true);
  });

  it("明细分片压实后删除", () => {
    expect(detailDeleted).toBe(false);
  });
});

describe("tracker：当日明细重建 + 新事件 flush（既有行不二次落盘）", () => {
  let lineCount: number;
  let s0Count: number;
  let s1Count: number;
  let cellCalls: number;

  beforeAll(async () => {
    const root = createTrackerRoot("dou-trend-today-");
    const today = dayKey(T0);
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    const preRow = {
      v: 1,
      kind: "detail",
      time: T0 - HOUR,
      day: today,
      session: "s0",
      turn: 0,
      step: 1,
      retry: 1,
      provider: "p",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
    };
    writeFileSync(join(detDir, `${today}.jsonl`), `${JSON.stringify(preRow)}\n`);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 50,
    });
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "request/header",
        { header: { config: { provider: "p", model: "m" } }, reason: "initial" },
        T0,
        1,
      ),
    );
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 2 } } },
        T0,
        2,
      ),
    );
    await tracker.flushNow();
    const lines = readFileSync(join(detDir, `${today}.jsonl`), "utf8")
      .trimEnd()
      .split("\n");
    lineCount = lines.length;
    const parsed = lines.map((l) => JSON.parse(l));
    s0Count = parsed.filter((r) => r.session === "s0").length;
    s1Count = parsed.filter((r) => r.session === "s1").length;
    cellCalls = tracker.buckets().find((d) => d.day === today)!.providers[0].cell.calls;
    await tracker.dispose();
  });

  it("当日分片 = 既有 1 行 + 新增 1 行（重建行不二次 append）", () => {
    expect(lineCount).toBe(2);
  });

  it("既有行仅一份", () => {
    expect(s0Count).toBe(1);
  });

  it("新行落盘", () => {
    expect(s1Count).toBe(1);
  });

  it("cells 含重建 + 新事件", () => {
    expect(cellCalls).toBe(2);
  });
});

afterAll(() => cleanupTrackerRoots());
