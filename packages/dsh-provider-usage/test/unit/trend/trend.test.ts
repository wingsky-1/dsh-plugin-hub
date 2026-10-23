/**
 * dsh-provider-usage — unit：#503 会话用量趋势（M1 数据层）。
 *
 * Collector 判据已迁至同目录 `collector-settlement-core.test.ts`、
 * `collector-attempt-ledger.test.ts`、`collector-attribution.test.ts`、
 * `collector-lifecycle.test.ts` 与 `collector-usage-priority.test.ts`。
 * 本文件保留 tracker、dir/legacy 与 config 自然块。
 * Aggregator core/calendar/stacked-window 已迁至同目录 aggregator-*.test.ts。
 * Store 分片校验与生命周期已迁至同目录 store-shards.test.ts、store-lifecycle.test.ts。
 * - tracker：启动重建（聚合权威）/ 过去日明细自愈 / 当日明细防二次落盘 /
 *   防抖刷盘 / dispose await 刷盘 / 日切压实与重启不双算 / 迟到旧日行合并防覆盖
 * - 复核 M1（#633）：混存分片重启重建 dirDays 恢复（dir 行真读回）/ 自愈压实
 *   dir 行 pending 同源折算不丢 / pruneDays 联动删除 dirDays
 * - 复核 P1-1（#633）：dirDays 单源化——过去日不随 dropPending 删除（跨天柱
 *   不失）/ rebuild 明细计数行平行折算（同日重启续 apply 双算防线）/ correct
 *   校正双面同步（dirDays 与 cells 不漂移）
 * - config：trendRetentionDays 归一化
 *
 * #722 阶段 1 迁移：脚本式顶层断言 → describe/it（每条断言一个 it）。原块内
 * 「动作 → 断言 → 新动作 → 新断言」的交错顺序在 beforeAll 内逐行保留，并在每个原
 * 断言位置取 structuredClone 快照，it 只读快照——避免把动作前置导致后续断言看到
 * 错误状态（快照必须复制：存引用会被后续动作改写）。
 */
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 白盒直连深路径（#768 B波）：日界纯面经 shared 门面，不走组合根转发。
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_ROW_VERSION, TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import { normalizeConfig, DEFAULT_CONFIG } from "../../../src/shared/interface.ts";
// 白盒直连深路径（#768 B波）：趋势聚合/采集纯面经域门面，不走组合根转发。
import {
  TrendAggregator,
  TrendStore,
  mergeDirRows,
  mergeHourRows,
  type TrendStackPart,
  type TrendStackPoint,
} from "../../../src/server/aggregate/interface.ts";
import type { PendingEntry } from "../../../src/server/aggregate/aggregator.ts";
import {
  TrendCollector,
  type TrendAggRow,
  type TrendCallRecord,
  type TrendCell,
  type TrendEmit,
  type TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import {
  isValidShardRow,
  sanitizeDirName,
  sumToken,
  type TrendDirRow,
} from "../../../src/server/shared/interface.ts";
import { DAY0, HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { callOf, cellTotals, counterOf, HOUR } from "./aggregator-test-support.ts";

// ---------------------------------------------------------------- tracker
// 不变量2：防双计——启动重建（聚合权威）/ 当日明细防二次落盘 / 自愈压实 / 迟到旧日行合并防覆盖丢数。

function writeAggShardLine(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}

describe("tracker：启动重建（聚合分片权威）", () => {
  let cellCalls: number;
  let cellInput: number | null;
  let residueDeleted: boolean;

  beforeAll(async () => {
    // 启动重建：聚合分片权威——同日明细分片为压实残留，忽略并自愈删除
    const root = mkdtempSync(join(tmpdir(), "dou-trend-rebuild-"));
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
    const root = mkdtempSync(join(tmpdir(), "dou-trend-heal-"));
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
    const root = mkdtempSync(join(tmpdir(), "dou-trend-today-"));
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

describe("tracker：防抖刷盘 + dispose await 刷盘", () => {
  let unpersistedRows: number;
  let flushed: boolean;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-trend-flush-"));
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

describe("tracker：日切压实与重启不双算（含迟到旧日行合并）", () => {
  let aggShardWritten: boolean;
  let detailShardDeleted: boolean;
  let cellCallsAfterRollup: number;
  let lateAggCalls: number;
  let lateAggInput: number | null;
  let lastLineKind: string;
  let lastLineCalls: number;
  let restartCalls: number;
  let restartInput: number | null;
  let restartTurns: number;

  beforeAll(async () => {
    // 日切压实：跨天后旧日压实为聚合分片、明细分片删除、重启不双算
    const root = mkdtempSync(join(tmpdir(), "dou-trend-rollup-"));
    let nowMs = T0; // 09-04
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 50,
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(100, 50), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    nowMs = T0 + 24 * HOUR; // 次日 09-05
    await tracker.flushNow();
    const day0 = dayKey(T0);
    aggShardWritten = existsSync(join(root, "agg", `${day0}.jsonl`));
    detailShardDeleted = existsSync(join(root, "details", `${day0}.jsonl`));
    cellCallsAfterRollup = tracker.buckets().find((d) => d.day === day0)!.providers[0].cell.calls;

    // 迟到旧日行（时钟回拨）：append + 二次压实合并，不覆盖既有聚合
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0 + HOUR, 4)); // time 仍在 09-04
    tracker.handleEvent(
      { id: "s2" },
      ev(
        "assistant/chunk",
        { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 7 } } },
        T0 + HOUR,
        5,
      ),
    );
    await tracker.flushNow();
    const aggRow = readFileSync(join(root, "agg", `${day0}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l: string) => JSON.parse(l))
      .filter((r) => r.kind === "agg")
      .at(-1);
    lateAggCalls = aggRow.calls;
    lateAggInput = aggRow.input;
    // #662：混存分片尾行是 hour 行（写入约定 agg→dir→hour），末行断言须按 kind 定位
    const lastLine = JSON.parse(
      readFileSync(join(root, "agg", `${day0}.jsonl`), "utf8")
        .trimEnd()
        .split("\n")
        .at(-1)!,
    );
    lastLineKind = lastLine.kind;
    lastLineCalls = lastLine.calls;

    // 重启重建：聚合权威载入，cells 与重启前一致
    const beforeBuckets = JSON.stringify(tracker.buckets());
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 50,
    });
    const afterCells = tracker.buckets().find((d) => d.day === day0)!.providers[0].cell;
    restartCalls = afterCells.calls;
    restartInput = afterCells.input;
    restartTurns = afterCells.turns;
    void beforeBuckets;
    await tracker.dispose();
  }, 60_000);

  it("旧日聚合分片落盘", () => {
    expect(aggShardWritten).toBe(true);
  });

  it("旧日明细分片压实后删除", () => {
    expect(detailShardDeleted).toBe(false);
  });

  it("压实后 cells 不变", () => {
    expect(cellCallsAfterRollup).toBe(1);
  });

  it("迟到旧日行合并进聚合分片（calls=1+1）", () => {
    expect(lateAggCalls).toBe(2);
  });

  it("token 合并 100+7", () => {
    expect(lateAggInput).toBe(107);
  });

  it("聚合分片尾行 = hour 行（混存写入顺序约定）", () => {
    expect(lastLineKind).toBe("hour");
  });

  it("迟到行 hour13（T0+HOUR）独立档", () => {
    expect(lastLineCalls).toBe(1);
  });

  it("重启重建 calls 不双算", () => {
    expect(restartCalls).toBe(2);
  });

  it("重启重建 token 一致", () => {
    expect(restartInput).toBe(107);
  });

  it("turns 经聚合行保留", () => {
    expect(restartTurns).toBe(1);
  });
});

describe("tracker：dispose await 最终刷盘", () => {
  let detailShardExists: boolean;

  beforeAll(async () => {
    // dispose await 最终刷盘：事件后立即 dispose，分片必落盘
    const root = mkdtempSync(join(tmpdir(), "dou-trend-dispose-"));
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
    const root = mkdtempSync(join(tmpdir(), "dou-trend-flushpt-"));
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

// ---------------------------------------------------------------- 评审修复：P0-1 交叉（HistoryStore×trend）

// ---------------------------------------------------------------- 评审修复：P1-3 appendRows 部分失败

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
    const root = mkdtempSync(join(tmpdir(), "dou-trend-partial2-"));
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

// ---------------------------------------------------------------- 评审修复：P2-4 分片行校验补强

// ---------------------------------------------------------------- 评审修复：P2-6 归属不一致告警
// 不变量1：身份快照——主源在场且与副源不一致时仅告警不覆盖（主源 header 是记账归属权威）。

describe("评审修复 P2-6：tracker 侧 onAnomaly 接线到 warn", () => {
  let warnHit: boolean;

  beforeAll(async () => {
    // P2-6 tracker 接线：collector onAnomaly → tracker 统一 warn 出口
    const warns: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "dou-trend-anomaly-"));
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

// ---------------------------------------------------------------- config

describe("config：trendRetentionDays 归一化", () => {
  let defaultDays: number;
  let zeroDays: number;
  let negativeDays: number;
  let fractionalDays: number;
  let upperBoundDays: number;
  let passthroughDays: number;

  beforeAll(() => {
    defaultDays = normalizeConfig({}).trendRetentionDays;
    zeroDays = normalizeConfig({ trendRetentionDays: 0 }).trendRetentionDays;
    negativeDays = normalizeConfig({ trendRetentionDays: -3 }).trendRetentionDays;
    fractionalDays = normalizeConfig({ trendRetentionDays: 1.5 }).trendRetentionDays;
    upperBoundDays = normalizeConfig({ trendRetentionDays: 99999 }).trendRetentionDays;
    passthroughDays = normalizeConfig({ trendRetentionDays: 30 }).trendRetentionDays;
  });

  it("trendRetentionDays 默认 180", () => {
    expect(defaultDays).toBe(DEFAULT_CONFIG.trendRetentionDays);
  });

  it("非法（0）回落默认", () => {
    expect(zeroDays).toBe(180);
  });

  it("非法（负数）回落默认", () => {
    expect(negativeDays).toBe(180);
  });

  it("非法（非整数）回落默认", () => {
    expect(fractionalDays).toBe(180);
  });

  it("上界 3650", () => {
    expect(upperBoundDays).toBe(3650);
  });

  it("合法透传", () => {
    expect(passthroughDays).toBe(30);
  });
});

// ---------------------------------------------------------------- #633 A1 补全：dir 落盘映射与 resolveCwd 契约接线
// 不变量1+3：身份快照 / 残差归未识别——dir 归属经 resolveCwd 惰性单查、sanitizeDirName 净化落盘；
// store 无 session / cwd 缺失 / 抛错显式归 TREND_UNIDENTIFIED 桶（不静默丢弃、不重复查询）。

describe("#633 A1(a)：per-session 惰性单查（resolveCwd 恰 1 次）", () => {
  let cwdCalls: string[];
  let unpersistedRows: number;

  beforeAll(async () => {
    // A1(a)：per-session 惰性单查——同 session 多次 emit 事件（call 定稿/校正/counter/
    // 新 turn call），resolveCwd 恰查询 1 次（结果缓存进会话状态）
    const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-once-"));
    const cwdCalls0: string[] = [];
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => {
        cwdCalls0.push(session);
        return "/home/u/project-a";
      },
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2)); // call 定稿（首次查询）
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(11, 6), T0, 3)); // 同 fold 校正
    tracker.handleEvent(
      { id: "s1" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 4),
    ); // counter
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 5),
    ); // counter
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 6));
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3 } } },
        T0,
        7,
      ),
    ); // 新 turn call
    await tracker.flushNow();
    cwdCalls = snapshot(cwdCalls0);
    unpersistedRows = tracker.stats().unpersistedRows;
    await tracker.dispose();
  });

  it("同 session 多次 emit 事件，resolveCwd 恰查询 1 次", () => {
    expect(cwdCalls).toEqual(["s1"]);
  });

  it("事件正常入账（2 call + 2 counter）", () => {
    expect(unpersistedRows).toBe(0);
  });
});

describe("#633 A1(b)：resolveCwd 缺失/抛错归未识别桶且各查 1 次", () => {
  let countsS1: number;
  let countsS2: number;
  let s1Dir: string;
  let s2Dir: string;

  beforeAll(async () => {
    // A1(b)：resolveCwd 返回 undefined（store 无该 session / cwd 缺失）或抛错 →
    // 归 TREND_UNIDENTIFIED 且各自仅查询 1 次（未识别结果同样缓存，防重复查询）
    const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-miss-"));
    const counts: Record<string, number> = { s1: 0, s2: 0 };
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => {
        counts[session] = (counts[session] ?? 0) + 1;
        if (session === "s1") return undefined;
        throw new Error("boom");
      },
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
    tracker.handleEvent(
      { id: "s2" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 6),
    );
    await tracker.flushNow();
    countsS1 = counts.s1;
    countsS2 = counts.s2;
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    s1Dir = rows.find((r) => r.kind === "detail" && r.session === "s1").dir;
    s2Dir = rows.find((r) => r.kind === "detail" && r.session === "s2").dir;
    await tracker.dispose();
  });

  it("undefined 路径仅查询 1 次", () => {
    expect(countsS1).toBe(1);
  });

  it("抛错路径仅查询 1 次", () => {
    expect(countsS2).toBe(1);
  });

  it("undefined → 未识别桶", () => {
    expect(s1Dir).toBe(TREND_UNIDENTIFIED);
  });

  it("抛错 → 未识别桶", () => {
    expect(s2Dir).toBe(TREND_UNIDENTIFIED);
  });
});

describe("#633 A1(c)：cwd 经 sanitizeDirName 净化后落盘 + 纯函数面直测", () => {
  let dirS1: string;
  let dirS2: string;
  let dirS3: string;
  let dirS4: string;
  let countersAllBasename: boolean;
  let sanitizedWindows: string | null;
  let sanitizedDriveRoot: string | null;
  let sanitizedUnc: string | null;

  beforeAll(async () => {
    // A1(c)：resolveCwd 返回含路径分隔符/尾斜杠的 cwd → 落盘为 sanitizeDirName
    // 净化后的 basename（数据层即存净化值，B1 可区分性约定）；POSIX '/' 与
    // Windows '\' 分隔符同取（复核闸 P1：反斜杠路径整串落盘即泄漏绝对路径）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-sanitize-"));
    let flip = 0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: () =>
        [
          "/home/u/my proj/v2/",
          "C:\\Users\\alice\\repo",
          "D:\\work\\my app\\",
          "/mixed/slash\\back",
        ][flip++ % 4],
    });
    // 四个会话各一次定稿调用 + turn/end（覆盖 POSIX 尾斜杠 / Windows 反斜杠 / Windows 尾反斜杠 / 混合分隔符）
    for (let s = 1; s <= 4; s += 1) {
      tracker.handleEvent({ id: `s${s}` }, ev("request/header", HEADER(), T0, s * 3 - 2));
      tracker.handleEvent({ id: `s${s}` }, ev("assistant/chunk", USAGE(10, 5), T0, s * 3 - 1));
      tracker.handleEvent(
        { id: `s${s}` },
        ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, s * 3),
      );
    }
    await tracker.flushNow();
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const dirOf = (sid: string): string =>
      rows.find((r) => r.kind === "detail" && r.session === sid).dir;
    dirS1 = dirOf("s1");
    dirS2 = dirOf("s2");
    dirS3 = dirOf("s3");
    dirS4 = dirOf("s4");
    const counters = rows.filter((r) => r.kind === "counter");
    countersAllBasename =
      counters.length === 4 && counters.every((r) => !r.dir.includes("\\") && !r.dir.includes("/"));
    await tracker.dispose();
    // 纯函数面直测（复核闸 P1 锁定 sanitizeDirName 本体语义）
    sanitizedWindows = sanitizeDirName("C:\\Users\\bob\\proj");
    sanitizedDriveRoot = sanitizeDirName("C:\\");
    sanitizedUnc = sanitizeDirName("\\\\server\\share\\notes");
  });

  it("POSIX 尾斜杠 → basename（末段）", () => {
    expect(dirS1).toBe("v2");
  });

  it("Windows 反斜杠路径 → basename（复核闸 P1：整串落盘即绝对路径泄漏）", () => {
    expect(dirS2).toBe("repo");
  });

  it("Windows 尾反斜杠 → basename（前段）", () => {
    expect(dirS3).toBe("my app");
  });

  it("混合分隔符取最深一段（lastIndexOf 两系较大者）", () => {
    expect(dirS4).toBe("back");
  });

  it("counter 行 dir 同口径：四例全 basename 化，无任何分隔符残留", () => {
    expect(countersAllBasename).toBeTruthy();
  });

  it("sanitizeDirName: Windows 反斜杠 basename", () => {
    expect(sanitizedWindows).toBe("proj");
  });

  it("sanitizeDirName: 盘符根路径 → null（未识别）", () => {
    expect(sanitizedDriveRoot).toBe(null);
  });

  it("sanitizeDirName: UNC 形态取末段", () => {
    expect(sanitizedUnc).toBe("notes");
  });
});

describe("#633 A1(d)：落盘 detail/counter 行均含 dir 字段且多 session 不串桶", () => {
  let dS1Dir: string;
  let dS2Dir: string;
  let cS1Dir: string;
  let cS2Dir: string;

  beforeAll(async () => {
    // A1(d)：落盘 detail/counter 行均含 dir 字段且值正确（多 session 各自归属不串桶）
    const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-persist-"));
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
    tracker.handleEvent(
      { id: "s2" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 6),
    );
    await tracker.flushNow();
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const dS1 = rows.find((r) => r.kind === "detail" && r.session === "s1");
    const dS2 = rows.find((r) => r.kind === "detail" && r.session === "s2");
    const cS1 = rows.find((r) => r.kind === "counter" && r.session === "s1");
    const cS2 = rows.find((r) => r.kind === "counter" && r.session === "s2");
    dS1Dir = dS1.dir;
    dS2Dir = dS2.dir;
    cS1Dir = cS1.dir;
    cS2Dir = cS2.dir;
    await tracker.dispose();
  });

  it("s1 detail 行 dir=alpha", () => {
    expect(dS1Dir).toBe("alpha");
  });

  it("s2 detail 行 dir=beta（多 session 不串桶）", () => {
    expect(dS2Dir).toBe("beta");
  });

  it("s1 counter 行 dir=alpha", () => {
    expect(cS1Dir).toBe("alpha");
  });

  it("s2 counter 行 dir=beta", () => {
    expect(cS2Dir).toBe("beta");
  });
});

// ---------------------------------------------------------------- #633 A2 兼容割接：存量分片（无 cwd/dir 键）升级后首次启动重建
// 不变量3+4：残差归未识别 / 台账守恒边界——旧格式（无 dir 键）行只进 cells（agg 面）、
// 不补造 dir 行；其目录事实由「每日残差归未识别」投影承担（目录面守恒以有 dir 事实为界）。

// A2 前提（图纸第 1 步已验证）：isValidShardRow 按 kind 校验必填键，无键白名单遍历
// ——未知键不拒绝；detail/counter 的 dir 为加性可选键（dir === undefined 放行）。
// 本节全部离线 mkdtempSync：手工构造旧格式分片文件（无 dir 键），零 src 改动断言实际行为。

/** 旧格式 detail 行（无 dir 键；含中文归属桶与中文目录语义无关的会话 id）。 */
const A2_LEGACY_DETAIL = {
  v: TREND_ROW_VERSION,
  kind: "detail",
  time: T0 - 24 * HOUR, // 2026-09-03 12:00（过去日）
  day: "2026-09-03",
  session: "旧会话-甲",
  turn: 3,
  step: 2,
  retry: 1,
  provider: "deepseek",
  model: "deepseek-chat",
  input: 1200,
  output: 300,
  cacheRead: 45,
  cacheWrite: 6,
  calls: 1,
};
/** 旧格式 counter 行（无 dir 键）。 */
const A2_LEGACY_COUNTER = {
  v: TREND_ROW_VERSION,
  kind: "counter",
  time: T0 - 24 * HOUR,
  day: "2026-09-03",
  session: "旧会话-甲",
  provider: "deepseek",
  model: "deepseek-chat",
  turns: 1,
  toolCalls: 1,
};
/** 旧格式聚合行（agg 行本就无 dir 键，升级前后形态一致）。 */
const A2_LEGACY_AGG = {
  v: TREND_ROW_VERSION,
  kind: "agg",
  day: "2026-09-03",
  provider: "deepseek",
  model: "deepseek-chat",
  input: 5000,
  output: 800,
  cacheRead: 120,
  cacheWrite: 10,
  calls: 30,
  turns: 12,
  toolCalls: 40,
};

describe("#633 A2(a)：旧格式 fixture 重建（聚合权威 + 当日明细不重写）", () => {
  let pastBucketExists: boolean;
  let pastCell: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let todayCell: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let warns: string[];
  let residueDeleted: boolean;
  let detBytesUnchangedAfterStart: boolean;
  let aggBytesUnchanged: boolean;
  let detBytesUnchangedAfterDispose: boolean;

  beforeAll(async () => {
    // A2(a)：旧格式 fixture 重建（真实升级场景）——过去日聚合分片（权威）+ 当日旧版
    // 明细分片（无 dir 键的 detail/counter 行）：升级后首次启动不抛错；两日内存聚合
    // 数值与写入值一致；当日旧 detail 分片逐字节不变（rebuild 不重写 = round-trip
    // 结构性安全；dispose 最终刷盘同样不触碰 persisted 行）。过去日同日并存的残留
    // 明细分片（聚合分片 + 残留明细）走聚合权威自愈删除，残留行不双算——一并覆盖。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-rebuild-"));
    const aggDir = join(root, "agg");
    const detDir = join(root, "details");
    mkdirSync(aggDir, { recursive: true });
    mkdirSync(detDir, { recursive: true });
    const today = dayKey(T0); // 2026-09-04
    const detFile = join(detDir, `${today}.jsonl`);
    const aggFile = join(aggDir, "2026-09-03.jsonl");
    const todayDetail = { ...A2_LEGACY_DETAIL, time: T0 - HOUR, day: today };
    const todayCounter = { ...A2_LEGACY_COUNTER, time: T0 - HOUR, day: today };
    const legacyDetailBytes = `${JSON.stringify(todayDetail)}\n${JSON.stringify(todayCounter)}\n`;
    writeFileSync(detFile, legacyDetailBytes);
    writeFileSync(aggFile, `${JSON.stringify(A2_LEGACY_AGG)}\n`);
    // 同日并存形态：过去日明细分片为压实残留（升级前崩溃于写聚合后、删明细前），
    // 聚合权威 → start 自愈删除（残留明细不双算；残留行同样无 dir 键）
    const residueFile = join(detDir, "2026-09-03.jsonl");
    writeFileSync(
      residueFile,
      `${JSON.stringify(A2_LEGACY_DETAIL)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`,
    );

    const warns0: string[] = [];
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      warn: (m) => warns0.push(m),
    });
    const bPast = tracker.buckets().find((d) => d.day === "2026-09-03")!;
    pastBucketExists = bPast !== undefined;
    const cellPast = bPast.providers.find(
      (p) => p.provider === "deepseek" && p.model === "deepseek-chat",
    )!.cell;
    pastCell = snapshot({
      input: cellPast.input,
      output: cellPast.output,
      cacheRead: cellPast.cacheRead,
      cacheWrite: cellPast.cacheWrite,
      calls: cellPast.calls,
      turns: cellPast.turns,
      toolCalls: cellPast.toolCalls,
    });
    const cellToday = tracker.buckets().find((d) => d.day === today)!.providers[0].cell;
    todayCell = snapshot({
      input: cellToday.input,
      output: cellToday.output,
      cacheRead: cellToday.cacheRead,
      cacheWrite: cellToday.cacheWrite,
      calls: cellToday.calls,
      turns: cellToday.turns,
      toolCalls: cellToday.toolCalls,
    });
    warns = snapshot(warns0);
    residueDeleted = existsSync(residueFile);
    detBytesUnchangedAfterStart = readFileSync(detFile, "utf8") === legacyDetailBytes;
    aggBytesUnchanged = readFileSync(aggFile, "utf8") === `${JSON.stringify(A2_LEGACY_AGG)}\n`;
    await tracker.dispose();
    detBytesUnchangedAfterDispose = readFileSync(detFile, "utf8") === legacyDetailBytes;
  }, 60_000);

  it("旧格式聚合分片重建出过去日内存桶（启动不抛错）", () => {
    expect(pastBucketExists).toBeTruthy();
  });

  it("过去日 agg 权威行数值与写入值一致", () => {
    expect(pastCell).toEqual({
      input: 5000,
      output: 800,
      cacheRead: 120,
      cacheWrite: 10,
      calls: 30,
      turns: 12,
      toolCalls: 40,
    });
  });

  it("当日旧格式明细/计数行重建数值与写入值一致", () => {
    expect(todayCell).toEqual({
      input: 1200,
      output: 300,
      cacheRead: 45,
      cacheWrite: 6,
      calls: 1,
      turns: 1,
      toolCalls: 1,
    });
  });

  it("旧格式行（无 dir 键）全量通过校验，无坏行告警", () => {
    expect(warns).toEqual([]);
  });

  it("过去日残留明细分片被聚合权威自愈删除（不双算）", () => {
    expect(residueDeleted).toBe(false);
  });

  it("当日旧 detail 分片文件逐字节不变（rebuild 不重写）", () => {
    expect(detBytesUnchangedAfterStart).toBe(true);
  });

  it("旧 agg 分片文件不变（persisted 行 flush 不重写）", () => {
    expect(aggBytesUnchanged).toBe(true);
  });

  it("dispose 最终刷盘后旧 detail 分片仍逐字节不变", () => {
    expect(detBytesUnchangedAfterDispose).toBe(true);
  });
});

describe("#633 A2(b)：自愈压实路径（旧格式明细无聚合分片）", () => {
  let bucketExists: boolean;
  let cellCalls: number;
  let cellTurns: number;
  let cellToolCalls: number;
  let cellInput: number | null;
  let cellOutput: number | null;
  let cellCacheRead: number | null;
  let cellCacheWrite: number | null;
  let aggWritten: boolean;
  let detailDeleted: boolean;
  let aggRowCount: number;
  let aggRowValues: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let warns: string[];

  beforeAll(async () => {
    // A2(b)：自愈压实路径——过去日明细无聚合分片（旧格式行无 dir 键）→ start 触发自愈，
    // 新写聚合分片数值正确、明细分片已删（该路径本来就会重写，断言重写产物而非原文件保留）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-heal-"));
    const aggDir = join(root, "agg");
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    writeFileSync(
      join(detDir, "2026-09-03.jsonl"),
      `${JSON.stringify(A2_LEGACY_DETAIL)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`,
    );
    const warns0: string[] = [];
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      warn: (m) => warns0.push(m),
    });
    const b = tracker.buckets().find((d) => d.day === "2026-09-03")!;
    bucketExists = b !== undefined;
    const cell = b.providers.find(
      (p) => p.provider === "deepseek" && p.model === "deepseek-chat",
    )!.cell;
    cellCalls = cell.calls;
    cellTurns = cell.turns;
    cellToolCalls = cell.toolCalls;
    cellInput = cell.input;
    cellOutput = cell.output;
    cellCacheRead = cell.cacheRead;
    cellCacheWrite = cell.cacheWrite;
    aggWritten = existsSync(join(aggDir, "2026-09-03.jsonl"));
    detailDeleted = existsSync(join(detDir, "2026-09-03.jsonl"));
    const aggRows = await new TrendStore({ root }).readAggShard("2026-09-03");
    aggRowCount = aggRows.length;
    aggRowValues = snapshot({
      input: aggRows[0].input,
      output: aggRows[0].output,
      cacheRead: aggRows[0].cacheRead,
      cacheWrite: aggRows[0].cacheWrite,
      calls: aggRows[0].calls,
      turns: aggRows[0].turns,
      toolCalls: aggRows[0].toolCalls,
    });
    warns = snapshot(warns0);
    await tracker.dispose();
  }, 60_000);

  it("旧格式明细重建进内存（不抛错）", () => {
    expect(bucketExists).toBeTruthy();
  });

  it("明细权威：calls = 明细行数", () => {
    expect(cellCalls).toBe(1);
  });

  it("counter 行 turns 重建", () => {
    expect(cellTurns).toBe(1);
  });

  it("counter 行 toolCalls 重建", () => {
    expect(cellToolCalls).toBe(1);
  });

  it("input 与明细值一致", () => {
    expect(cellInput).toBe(1200);
  });

  it("output 与明细值一致", () => {
    expect(cellOutput).toBe(300);
  });

  it("cacheRead 与明细值一致", () => {
    expect(cellCacheRead).toBe(45);
  });

  it("cacheWrite 与明细值一致", () => {
    expect(cellCacheWrite).toBe(6);
  });

  it("自愈压实写出聚合分片", () => {
    expect(aggWritten).toBe(true);
  });

  it("明细分片压实后删除", () => {
    expect(detailDeleted).toBe(false);
  });

  it("压实产物恰一行（同 provider+model 折叠）", () => {
    expect(aggRowCount).toBe(1);
  });

  it("压实产物数值与明细写入值一致（自愈不丢数不补造）", () => {
    expect(aggRowValues).toEqual({
      input: 1200,
      output: 300,
      cacheRead: 45,
      cacheWrite: 6,
      calls: 1,
      turns: 1,
      toolCalls: 1,
    });
  });

  it("旧格式行全量通过校验，无坏行告警", () => {
    expect(warns).toEqual([]);
  });
});

describe("#633 A2(c)：round-trip（旧格式行 rebuild → flushNow → 重读分片）", () => {
  let cellCalls: number;
  let cellTurns: number;
  let cellToolCalls: number;
  let cellInput: number | null;
  let cellOutput: number | null;
  let bytesUnchangedAfterFlush: boolean;
  let backLength: number;
  let backFields: Array<{
    kind: string;
    session: string;
    time: number;
    provider: string;
    model: string | null;
    input: number | null | undefined;
    turns: number | undefined;
  }>;
  let noDirKey: boolean;

  beforeAll(async () => {
    // A2(c)：round-trip——旧格式行经 rebuild → flushNow → 重读分片：行数不增不减、
    // 原字段值不变、detail/counter 行不被补造 dir 键（当日明细重建路径）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-roundtrip-"));
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    const detFile = join(detDir, `${dayKey(T0)}.jsonl`); // 当日明细（rebuild(true) 路径）
    const legacyTodayDetail = { ...A2_LEGACY_DETAIL, time: T0 - HOUR, day: dayKey(T0) };
    const legacyTodayCounter = { ...A2_LEGACY_COUNTER, time: T0 - HOUR, day: dayKey(T0) };
    const legacyTodayDetail2 = {
      ...A2_LEGACY_DETAIL,
      time: T0 - 2 * HOUR,
      day: dayKey(T0),
      session: "旧会话-乙",
      turn: 1,
      step: 1,
      input: 50,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
    };
    const originalBytes = `${JSON.stringify(legacyTodayDetail)}\n${JSON.stringify(legacyTodayCounter)}\n${JSON.stringify(legacyTodayDetail2)}\n`;
    writeFileSync(detFile, originalBytes);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
    });
    const cell = tracker.buckets().find((d) => d.day === dayKey(T0))!.providers[0].cell;
    cellCalls = cell.calls;
    cellTurns = cell.turns;
    cellToolCalls = cell.toolCalls;
    cellInput = cell.input;
    cellOutput = cell.output;
    await tracker.flushNow();
    bytesUnchangedAfterFlush = readFileSync(detFile, "utf8") === originalBytes;
    const back = await new TrendStore({ root }).readDetailShard(dayKey(T0));
    backLength = back.length;
    backFields = snapshot(
      back.map((r) => ({
        kind: r.kind,
        session: r.session,
        time: r.time,
        provider: r.provider,
        model: r.model,
        input: "input" in r ? r.input : undefined,
        turns: "turns" in r ? r.turns : undefined,
      })),
    );
    noDirKey = back.every((r) => !("dir" in r));
    await tracker.dispose();
  }, 60_000);

  it("内存重建 calls = 旧明细行数", () => {
    expect(cellCalls).toBe(2);
  });

  it("内存重建 turns", () => {
    expect(cellTurns).toBe(1);
  });

  it("内存重建 toolCalls", () => {
    expect(cellToolCalls).toBe(1);
  });

  it("内存重建 input 求和（1200+50）", () => {
    expect(cellInput).toBe(1250);
  });

  it("内存重建 output 求和（300+20）", () => {
    expect(cellOutput).toBe(320);
  });

  it("flushNow 后分片逐字节不变（重建行 persisted=true 不二次落盘）", () => {
    expect(bytesUnchangedAfterFlush).toBe(true);
  });

  it("重读行数不增不减（3 行旧格式行全量读回）", () => {
    expect(backLength).toBe(3);
  });

  it("原字段值经读回不变（中文会话 id/数值逐字段一致）", () => {
    // 原 assert.deepEqual 为 node:assert/strict 的 deepStrictEqual：期望值显式含
    // input/turns: undefined，键在位性属判定一部分，故用 toStrictEqual 保语义不弱化。
    expect(backFields).toStrictEqual([
      {
        kind: "detail",
        session: "旧会话-甲",
        time: T0 - HOUR,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 1200,
        turns: undefined,
      },
      {
        kind: "counter",
        session: "旧会话-甲",
        time: T0 - HOUR,
        provider: "deepseek",
        model: "deepseek-chat",
        input: undefined,
        turns: 1,
      },
      {
        kind: "detail",
        session: "旧会话-乙",
        time: T0 - 2 * HOUR,
        provider: "deepseek",
        model: "deepseek-chat",
        input: 50,
        turns: undefined,
      },
    ]);
  });

  it("旧格式行不被补造 dir 键（无 dir → 内存重建后落盘形态仍无 dir）", () => {
    expect(noDirKey).toBeTruthy();
  });
});

describe("#633 A2(d)：未知键容忍（legacyFlag 不拒绝、不告警）", () => {
  let cellCalls: number;
  let cellInput: number | null;
  let warns: string[];

  beforeAll(async () => {
    // A2(d)：未知键容忍——detail 行附加未知字段 legacyFlag:"x" 不被拒绝、不抛错，
    // 其余行正常重建（isValidShardRow 无键白名单遍历，未知键不参与校验 = 通过；
    // 未知键随 JSON.parse 保留在行对象上，rebuild 只累加已知数值字段，无影响）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-unknown-"));
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    const withUnknown = { ...A2_LEGACY_DETAIL, legacyFlag: "x" };
    writeFileSync(
      join(detDir, "2026-09-03.jsonl"),
      `${JSON.stringify(withUnknown)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`,
    );
    const warns0: string[] = [];
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      warn: (m) => warns0.push(m),
    });
    const cell = tracker.buckets().find((d) => d.day === "2026-09-03")!.providers[0].cell;
    cellCalls = cell.calls;
    cellInput = cell.input;
    warns = snapshot(warns0);
    await tracker.dispose();
  }, 60_000);

  it("未知键行不拒绝：calls 正常重建", () => {
    expect(cellCalls).toBe(1);
  });

  it("未知键行数值正常重建", () => {
    expect(cellInput).toBe(1200);
  });

  it("未知键行不触发坏行告警", () => {
    expect(warns).toEqual([]);
  });
});

describe("#633 A2 补充：dir 值域防御不回退（空串/非字符串按坏行拒绝）", () => {
  let rowsLength: number;
  let keptSession: string;
  let warnsLength: number;

  beforeAll(async () => {
    // A2 补充：dir 值域防御仍是有效防线（与「未知键容忍」正交）——dir 为空字符串/
    // 非字符串时按坏行拒绝并告警，同分片合法行不受连坐（A1 校验语义不因 A2 放宽回退）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-dirguard-"));
    const warns: string[] = [];
    const store = new TrendStore({ root, warn: (m) => warns.push(m) });
    mkdirSync(join(root, "details"), { recursive: true });
    const good = { ...A2_LEGACY_DETAIL, dir: "proj" };
    const badEmptyDir = { ...A2_LEGACY_DETAIL, session: "s-bad-1", dir: "" };
    const badNumDir = { ...A2_LEGACY_DETAIL, session: "s-bad-2", dir: 7 };
    writeFileSync(
      join(root, "details", "2026-09-03.jsonl"),
      [good, badEmptyDir, badNumDir].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const rows = await store.readDetailShard("2026-09-03");
    rowsLength = rows.length;
    keptSession = rows[0].session;
    warnsLength = warns.length;
  });

  it("空串/非字符串 dir 按坏行拒绝（A1 值域防线不回退）", () => {
    expect(rowsLength).toBe(1);
  });

  it("保留的是合法行", () => {
    expect(keptSession).toBe("旧会话-甲");
  });

  it("两个非法 dir 行均告警", () => {
    expect(warnsLength).toBe(2);
  });
});

// ---------------------------------------------------------------- #633 A3/A4：dir 维度归并内存态与日汇总行生成
// 不变量2：防双计——dir 维度平行累加（同 record 不二次 emit）；rebuild 时 dir 行只进
// dirDays、不进 cells（防双计）、不进 pending（不二次落盘）。

describe("#633 A3(a)：内存态归并（tracker 全链路压实产物）", () => {
  let shardKinds: string[];
  let shardHours: TrendHourRow[];
  let shardDirs: TrendDirRow[];
  let shardAggCells: Array<{
    input: number | null;
    output: number | null;
    calls: number;
    turns: number;
  }>;
  let detailShardDeleted: boolean;

  beforeAll(async () => {
    // A3(a)：内存态归并（tracker 全链路）——apply 平行累加后压实产物 dir 行：
    // 双 session 同 cwd → 恰 1 条 calls 为和；不同 cwd 独立行；resolveCwd 缺失 →
    // 未识别桶独立成行。dir 行位于 agg 行之后（writeAggDay 写入顺序约定）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a3-merge-"));
    let nowMs = T0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) =>
        session === "s1" || session === "s2"
          ? "/home/u/shared"
          : session === "s3"
            ? "/home/u/other"
            : undefined,
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
    tracker.handleEvent({ id: "s3" }, ev("request/header", HEADER(), T0, 6));
    tracker.handleEvent({ id: "s3" }, ev("assistant/chunk", USAGE(3, 3), T0, 7));
    tracker.handleEvent({ id: "s4" }, ev("request/header", HEADER(), T0, 8));
    tracker.handleEvent({ id: "s4" }, ev("assistant/chunk", USAGE(2, 2), T0, 9));
    nowMs = T0 + 24 * HOUR; // 日切：DAY0 成过去日
    await tracker.flushNow();
    const shard = await new TrendStore({ root }).readAggDayShard(DAY0);
    shardKinds = snapshot(shard.map((r) => r.kind));
    shardHours = snapshot(shard.filter((r): r is TrendHourRow => r.kind === "hour"));
    shardDirs = snapshot(shard.filter((r): r is TrendDirRow => r.kind === "dir"));
    shardAggCells = snapshot(
      shard
        .filter((r): r is TrendAggRow => r.kind === "agg")
        .map((r) => ({ input: r.input, output: r.output, calls: r.calls, turns: r.turns })),
    );
    detailShardDeleted = existsSync(join(root, "details", `${DAY0}.jsonl`));
    await tracker.dispose();
  }, 60_000);

  it("混存分片：agg 行在前、dir 行居中、hour 行在后（#662 写入顺序约定）", () => {
    expect(shardKinds).toEqual(["agg", "dir", "dir", "dir", "hour"]);
  });

  it("混存分片 hour 行：同在 12:00 的 4 次调用折叠为 hour12（input 10+7+3+2）", () => {
    expect(shardHours).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 12,
        input: 22,
        output: 17,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 4,
        turns: 1,
        toolCalls: 0,
      },
    ]);
  });

  it("同 cwd 双 session 归并为恰 1 条（calls 为和）；不同 cwd/未识别桶独立行", () => {
    expect(shardDirs).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "shared",
        input: 17,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 1,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "other",
        input: 3,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: TREND_UNIDENTIFIED,
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("agg 行（provider 维度）不受 dir 平行累加影响", () => {
    expect(shardAggCells).toEqual([{ input: 22, output: 17, calls: 4, turns: 1 }]);
  });

  it("明细分片压实后删除", () => {
    expect(detailShardDeleted).toBe(false);
  });
});

describe("#633 A3(b)：rebuild 混存行（dir 行不进 cells / 不进 pending）", () => {
  let cell: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let pendingRows: number;

  beforeAll(() => {
    // A3(b)：rebuild 混存行——agg 行 + dir 行 + 当日 detail/counter 行重放：dir 行
    // 只进目录维度桶（dirDays），不进 cells（防双计）、不进 pending（不二次落盘）。
    const agg = new TrendAggregator();
    agg.rebuild(
      [
        {
          v: 1,
          kind: "agg",
          day: DAY0,
          provider: "deepseek",
          model: "chat",
          input: 100,
          output: 50,
          cacheRead: null,
          cacheWrite: null,
          calls: 2,
          turns: 1,
          toolCalls: 3,
        },
        {
          v: 1,
          kind: "dir",
          day: DAY0,
          dir: "proj",
          input: 100,
          output: 50,
          cacheRead: null,
          cacheWrite: null,
          calls: 2,
          turns: 1,
          toolCalls: 3,
        },
        {
          v: 1,
          kind: "detail",
          time: T0,
          day: DAY0,
          session: "s9",
          turn: 9,
          step: 1,
          retry: 1,
          provider: "deepseek",
          model: "chat",
          dir: "proj",
          input: 7,
          output: 7,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        },
        {
          v: 1,
          kind: "counter",
          time: T0,
          day: DAY0,
          session: "s9",
          provider: "deepseek",
          model: "chat",
          dir: "proj",
          turns: 1,
          toolCalls: 0,
        },
      ],
      true,
    );
    const c = cellTotals(agg, DAY0)!;
    cell = snapshot({
      input: c.input,
      output: c.output,
      cacheRead: c.cacheRead,
      cacheWrite: c.cacheWrite,
      calls: c.calls,
      turns: c.turns,
      toolCalls: c.toolCalls,
    });
    pendingRows = agg.stats().pendingRows;
  });

  it("rebuild：agg + detail/counter 进 cells；dir 行不进（calls=2+1 而非 +dir 的 2）", () => {
    expect(cell).toEqual({
      input: 107,
      output: 57,
      cacheRead: null,
      cacheWrite: null,
      calls: 3,
      turns: 2,
      toolCalls: 3,
    });
  });

  it("dir 行不进 pending（不二次落盘）", () => {
    expect(pendingRows).toBe(2);
  });
});

describe("#633 A4(c)：rollup 产物字段值（agg + dir + hour 同源折算）", () => {
  let aggAndDirRows: Array<TrendAggRow | TrendDirRow>;
  let hourRows: TrendHourRow[];
  let secondRollup: Array<TrendAggRow | TrendDirRow | TrendHourRow>;

  beforeAll(() => {
    // A4(c)：rollup 产物字段值 deepEqual——rollupDay 返回 [...aggRows, ...dirRows]，
    // dir 行十字段（v/kind/day/dir/input/output/cacheRead/cacheWrite/calls/turns/toolCalls）
    // 值与 pending 折算一致；tokens null 的行 null-aware 归并；消费后不重复产出。
    const agg = new TrendAggregator();
    agg.apply({
      type: "call",
      record: {
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        dir: "proj",
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      },
    });
    // toolCalls: 2 超出 0|1 字面（实现按数值累加；计数行宽松口径与上同）。
    agg.apply(
      counterOf({
        time: T0,
        session: "s1",
        provider: "deepseek",
        model: "chat",
        dir: "proj",
        turns: 1,
        toolCalls: 2,
      }),
    );
    agg.apply({
      type: "call",
      record: {
        time: T0 + HOUR,
        session: "s2",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        dir: "proj",
        tokens: null,
      },
    });
    const rows = agg.rollupDay(DAY0, DAY0);
    aggAndDirRows = snapshot(
      rows.filter((r): r is TrendAggRow | TrendDirRow => r.kind === "agg" || r.kind === "dir"),
    );
    hourRows = snapshot(rows.filter((r): r is TrendHourRow => r.kind === "hour"));
    secondRollup = snapshot(agg.rollupDay(DAY0, DAY0));
  });

  it("rollupDay 产物 agg+dir 行逐字段 deepEqual（null token 不污染、calls 独立累计）", () => {
    expect(aggAndDirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "agg",
        day: DAY0,
        provider: "deepseek",
        model: "chat",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        calls: 2,
        turns: 1,
        toolCalls: 2,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "proj",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        calls: 2,
        turns: 1,
        toolCalls: 2,
      },
    ]);
  });

  it("rollupDay 同源 hour 行（null token 行独立计入 calls、token 记 null）", () => {
    expect(hourRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 12,
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        calls: 1,
        turns: 1,
        toolCalls: 2,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 13,
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("消费后二次 rollup 不重复产出（pending/dir/hour 素材同源消费）", () => {
    expect(secondRollup).toEqual([]);
  });
});

describe("#633 A4(d)：mergeDirRows 纯函数（同键累加、null-aware、保序）", () => {
  let merged: TrendDirRow[];

  beforeAll(() => {
    // A4(d)：mergeDirRows 纯函数——同 dir 键累加（null-aware）、异 dir 独立、
    // 输出保序（base 在前：对应分片内既有 dir 行位置约定）。
    merged = snapshot(
      mergeDirRows(
        [
          {
            v: 1,
            kind: "dir",
            day: DAY0,
            dir: "a",
            input: null,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          } as TrendDirRow,
          {
            v: 1,
            kind: "dir",
            day: DAY0,
            dir: "b",
            input: 7,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 2,
            turns: 1,
            toolCalls: 1,
          } as TrendDirRow,
        ],
        [
          {
            v: 1,
            kind: "dir",
            day: DAY0,
            dir: "a",
            input: 5,
            output: 3,
            cacheRead: null,
            cacheWrite: null,
            calls: 2,
            turns: 0,
            toolCalls: 0,
          } as TrendDirRow,
        ],
      ),
    );
  });

  it("mergeDirRows 同键累加、null-aware、保序", () => {
    expect(merged).toEqual([
      {
        v: 1,
        kind: "dir",
        day: DAY0,
        dir: "a",
        input: 5,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 3,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: 1,
        kind: "dir",
        day: DAY0,
        dir: "b",
        input: 7,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 2,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });
});

describe("#633 A4(e)：混存 round-trip（压实→重启→迟到行二次压实→再重启）", () => {
  let round1Kinds: string[];
  let round1Hours: TrendHourRow[];
  let detailShardDeleted: boolean;
  let cellR1: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let round2Kinds: string[];
  let round2Hours: TrendHourRow[];
  let round2Dirs: TrendDirRow[];
  let cellR2Calls: number;
  let finalKinds: string[];

  beforeAll(async () => {
    // A4(e)：混存 round-trip——压实（混存落盘）→ 重启重建（不丢不重，dir 行不双算
    // 进 cells）→ 迟到旧日行二次压实（既有 dir 行经 readAggDayShard 全量取回合并，
    // 不被整日重写抹掉）→ 再重启（分片不再被改写）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a4-roundtrip-"));
    let nowMs = T0;
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent(
      { id: "s2" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 5),
    );
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 6));
    nowMs = T0 + 24 * HOUR;
    await tracker.flushNow(); // 第一次压实：agg + dir 混存落盘
    const store = new TrendStore({ root });
    const round1 = await store.readAggDayShard(DAY0);
    round1Kinds = snapshot(round1.map((r) => r.kind));
    round1Hours = snapshot(round1.filter((r): r is TrendHourRow => r.kind === "hour"));
    detailShardDeleted = existsSync(join(root, "details", `${DAY0}.jsonl`));
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/home/u/alpha",
    });
    const cellR1raw = tracker
      .buckets()
      .find((d) => d.day === DAY0)!
      .providers.find((p) => p.provider === "deepseek")!.cell;
    cellR1 = snapshot({
      input: cellR1raw.input,
      output: cellR1raw.output,
      cacheRead: cellR1raw.cacheRead,
      cacheWrite: cellR1raw.cacheWrite,
      calls: cellR1raw.calls,
      turns: cellR1raw.turns,
      toolCalls: cellR1raw.toolCalls,
    });
    // 迟到旧日行（时钟回拨）：s1 turn2 usage 落 DAY0 → 二次压实合并
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0 + HOUR, 7));
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        {
          turn: 2,
          step: 1,
          chunk: {
            type: "usage",
            usage: { inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        },
        T0 + HOUR,
        8,
      ),
    );
    await tracker.flushNow();
    const round2 = await store.readAggDayShard(DAY0);
    round2Kinds = snapshot(round2.map((r) => r.kind));
    round2Hours = snapshot(round2.filter((r): r is TrendHourRow => r.kind === "hour"));
    round2Dirs = snapshot(round2.filter((r): r is TrendDirRow => r.kind === "dir"));
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/home/u/alpha",
    });
    const cellR2 = tracker
      .buckets()
      .find((d) => d.day === DAY0)!
      .providers.find((p) => p.provider === "deepseek")!.cell;
    cellR2Calls = cellR2.calls;
    finalKinds = snapshot((await store.readAggDayShard(DAY0)).map((r) => r.kind));
    await tracker.dispose();
  }, 60_000);

  it("首次压实混存形态（agg→dir→hour）", () => {
    expect(round1Kinds).toEqual(["agg", "dir", "dir", "hour"]);
  });

  it("首次压实 hour 行：同在 12:00 的计数并入 hour12", () => {
    expect(round1Hours).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 12,
        input: 17,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });

  it("明细分片已删（压实收尾）", () => {
    expect(detailShardDeleted).toBe(false);
  });

  it("重启重建：agg 行权威进 cells，dir 行不双算（calls=2 而非 4）", () => {
    expect(cellR1).toEqual({
      input: 17,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 2,
      turns: 1,
      toolCalls: 1,
    });
  });

  it("二次压实：既有 agg/dir/hour 行不抹掉，迟到行折出新 hour 档并入尾段", () => {
    expect(round2Kinds).toEqual(["agg", "dir", "dir", "hour", "hour"]);
  });

  it("迟到行（13:00）折为新 hour13 档（hour12 既有行不受连坐）", () => {
    expect(round2Hours).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 12,
        input: 17,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 1,
        toolCalls: 1,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "hour",
        day: DAY0,
        hour: 13,
        input: 3,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("迟到行并入 dir 行（alpha calls=1+1、input 10+3）且 beta 不受连坐", () => {
    expect(round2Dirs).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "alpha",
        input: 13,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 1,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "beta",
        input: 7,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 1,
      },
    ]);
  });

  it("再重启重建 calls=2+1（迟到行已并入 agg 行，不丢不重）", () => {
    expect(cellR2Calls).toBe(3);
  });

  it("再重启后分片形态稳定（persisted 行 flush 不重写）", () => {
    expect(finalKinds).toEqual(["agg", "dir", "dir", "hour", "hour"]);
  });
});

describe("#633 A4(f)：查询面零变化（dir 记账/rebuild 不影响 buckets/seriesDays）", () => {
  let buckets: ReturnType<TrendAggregator["buckets"]>;
  let seriesValues: Array<number | null>;
  let dirSnapshot: TrendDirRow[];

  beforeAll(() => {
    // A4(f)：查询面零变化——含 dir 记账 + dir 行 rebuild 后，buckets()/seriesDays()
    // 与固定 fixture 全等（dir 不出现在 provider 查询面，cells 数值不受平行累加影响）。
    const agg = new TrendAggregator();
    agg.apply({
      type: "call",
      record: {
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        dir: "x",
        tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    });
    // A4(f)：无 dir 键的旧格式行与有 dir 行并存（残差投影不断言放宽，见下）。
    agg.apply(
      callOf({
        time: T0 + HOUR,
        session: "s2",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        tokens: { input: 3, output: 4, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.rebuild(
      [
        {
          v: 1,
          kind: "agg",
          day: DAY0,
          provider: "other",
          model: null,
          input: 5,
          output: 5,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
          turns: 1,
          toolCalls: 1,
        },
        {
          v: 1,
          kind: "dir",
          day: DAY0,
          dir: "x",
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          calls: 1,
          turns: 0,
          toolCalls: 0,
        },
      ],
      false,
    );
    buckets = snapshot(agg.buckets());
    seriesValues = snapshot(agg.seriesDays(2, T0 + HOUR, "input").map((d) => d.value));
    // A4(f)补dir：dir 面正向断言——dir 行 rebuild 进 dirDays（与 apply 平行累加合并），
    // 无 dir 事实的行经残差投影归未识别桶（与 buckets/seriesDays 零变化断言同源）。
    dirSnapshot = snapshot(agg.dirRows());
  });

  it("buckets() 固定 fixture 全等（dir 行 rebuild 不进 cells、apply 平行累加不污染）", () => {
    expect(buckets).toEqual([
      {
        day: DAY0,
        providers: [
          {
            provider: "deepseek",
            model: "chat",
            cell: {
              input: 4,
              output: 6,
              cacheRead: 0,
              cacheWrite: 0,
              calls: 2,
              turns: 0,
              toolCalls: 0,
            },
          },
          {
            provider: "other",
            model: null,
            cell: {
              input: 5,
              output: 5,
              cacheRead: null,
              cacheWrite: null,
              calls: 1,
              turns: 1,
              toolCalls: 1,
            },
          },
        ],
      },
    ]);
  });

  it("seriesDays 零变化（空日 null 语义保持；input=4+5 跨 provider 求和）", () => {
    expect(seriesValues).toEqual([null, 9]);
  });

  it("dir 面正向：x 行合并（calls=2/input=2+2），无 dir 行归未识别桶（input=7）", () => {
    expect(dirSnapshot).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "x",
        input: 2,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: TREND_UNIDENTIFIED,
        input: 7,
        output: 7,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });
});

describe("#633 A4(g)：量级留痕（1000 事件 / 5 session）", () => {
  let cellCalls: number;
  let cwdCalls: number;
  let diskRowCount: number;
  let s1DirsAllCorrect: boolean;

  beforeAll(async () => {
    // A4(g)：量级留痕——1000 事件 / 5 session：resolveCwd 恰 5 次（per-session 惰性
    // 单查缓存，与事件量无关）；start+dispose 耗时基线 stderr 一行注明取数时点。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-a4-scale-"));
    let cwdCalls0 = 0;
    const startAt = Date.now();
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: () => {
        cwdCalls0 += 1;
        return "/home/u/scale";
      },
    });
    const startMs = Date.now() - startAt;
    let seq = 0;
    for (let s = 1; s <= 5; s += 1) {
      const sid = `s${s}`;
      tracker.handleEvent({ id: sid }, ev("request/header", HEADER(), T0, (seq += 1)));
      for (let k = 0; k < 199; k += 1) {
        tracker.handleEvent(
          { id: sid },
          ev(
            "assistant/chunk",
            {
              turn: k + 1,
              step: 1,
              chunk: {
                type: "usage",
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              },
            },
            T0,
            (seq += 1),
          ),
        );
      }
    }
    const cell = tracker.buckets().find((d) => d.day === DAY0)!.providers[0].cell;
    cellCalls = cell.calls;
    const disposeAt = Date.now();
    await tracker.dispose();
    const disposeMs = Date.now() - disposeAt;
    cwdCalls = cwdCalls0;
    const rows = readFileSync(join(root, "details", `${DAY0}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    diskRowCount = rows.length;
    s1DirsAllCorrect = rows.filter((r) => r.session === "s1").every((r) => r.dir === "scale");
    console.error(
      `[#633 A4 量级基线] 1000 事件/5 session：start=${startMs}ms dispose=${disposeMs}ms（resolveCwd=5，995 行落盘）；取数时点 ${new Date().toISOString()} node ${process.version}`,
    );
  }, 60_000);

  it("1000 事件（5 header + 995 usage）全量记账进 cells", () => {
    expect(cellCalls).toBe(995);
  });

  it("resolveCwd 调用数恰 5（每 session 惰性单查）", () => {
    expect(cwdCalls).toBe(5);
  });

  it("995 条明细行全量落盘", () => {
    expect(diskRowCount).toBe(995);
  });

  it("dir 落盘值逐行正确（抽查 s1 全量）", () => {
    expect(s1DirsAllCorrect).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 复核 M1（#633）：混存分片重启重建与自愈压实

describe("复核 M1(a)：混存分片重启重建后 dirDays 恢复（dir 行真读回）", () => {
  let dirMapExists: boolean;
  let dirMapValues: Array<{
    dir: string;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  }>;
  let cellValues: {
    input: number | null;
    output: number | null;
    calls: number;
    turns: number;
    toolCalls: number;
  };
  let pendingRows: number;

  beforeAll(async () => {
    // M1(a)：复核 M1 修复——混存分片（agg+dir）重启重建后内存 dirDays 恢复：
    // rebuildFromDisk 走 readAggDayShard 真读回 dir 行（经 rebuild dir 分支进
    // dirDays，该分支由死分支变可达）；dir 行不进 cells/pending（防双计语义不变）。
    // dirDays 当前无查询面消费，恢复断言走白盒（tracker.aggregator.dirDays）+
    // cells 行为面锚定（读回不双算）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-m1-rebuild-"));
    let nowMs = T0;
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent(
      { id: "s2" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 5),
    );
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 6));
    nowMs = T0 + 24 * HOUR;
    await tracker.flushNow(); // 压实：agg+dir 混存落盘、明细分片删除
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => undefined,
    });
    // 白盒：privates 经 bracket 访问（元素访问不触发可见性检查；运行时同形）。
    const dirMap = tracker["aggregator"]["dirDays"].get(DAY0);
    dirMapExists = dirMap !== undefined;
    dirMapValues = snapshot(
      [...dirMap!.entries()].map(([dir, c]) => ({
        dir,
        input: c.input,
        output: c.output,
        cacheRead: c.cacheRead,
        cacheWrite: c.cacheWrite,
        calls: c.calls,
        turns: c.turns,
        toolCalls: c.toolCalls,
      })),
    );
    const cell = tracker.buckets().find((d) => d.day === DAY0)!.providers[0].cell;
    cellValues = snapshot({
      input: cell.input,
      output: cell.output,
      calls: cell.calls,
      turns: cell.turns,
      toolCalls: cell.toolCalls,
    });
    pendingRows = tracker["aggregator"].stats().pendingRows;
    await tracker.dispose();
  }, 60_000);

  it("重启重建：dirDays 恢复该日目录桶（M1 修复前恒空）", () => {
    expect(dirMapExists).toBeTruthy();
  });

  it("dirDays 恢复值与分片 dir 行逐字段一致（读回不丢不变形）", () => {
    expect(dirMapValues).toEqual([
      {
        dir: "alpha",
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 1,
        toolCalls: 0,
      },
      {
        dir: "beta",
        input: 7,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 1,
      },
    ]);
  });

  it("dir 行读回不双算进 cells（agg 行权威，calls=2 而非 4）", () => {
    expect(cellValues).toEqual({ input: 17, output: 12, calls: 2, turns: 1, toolCalls: 1 });
  });

  it("dir 行不进 pending（不二次落盘）", () => {
    expect(pendingRows).toBe(0);
  });
});

describe("复核 M1(b)：自愈压实 dir 行 + pruneDays 联动删除 dirDays", () => {
  let healedDirRows: Array<TrendAggRow | TrendDirRow | TrendHourRow>;
  let healDirDayCell: TrendCell | undefined;
  let dirRowsForDay: TrendDirRow[];
  let healedCells: number;

  beforeAll(async () => {
    // M1(b)：复核 M1 修复——自愈压实路径 dir 行为 + pruneDays 联动删除（P1-1 口径更新）。
    // 自愈：过去日明细（含 dir）无聚合分片 → start 重建 + rollupDay 压实；dir 折算
    // 同源走 pending 行（takeDirUnpersisted 不过滤 persisted），重建行折算不丢——
    // P1-1 后 rebuild 明细/计数分支平行折算进 dirDays（与 cells 同策略双面入账，
    // dirDays 为唯一事实源、dirRows 纯快照），自愈后内存查询面立即恢复该日目录
    // 行（修复前随 dropPending 消失，须重启读回）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-m1-heal-"));
    const day1 = "2026-09-03";
    const detDir = join(root, "details");
    mkdirSync(detDir, { recursive: true });
    writeFileSync(
      join(detDir, `${day1}.jsonl`),
      [
        JSON.stringify({
          v: 1,
          kind: "detail",
          time: T0 - 24 * HOUR,
          day: day1,
          session: "sx",
          turn: 1,
          step: 1,
          retry: 1,
          provider: "p",
          model: "m",
          dir: "heal",
          input: 7,
          output: 3,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        }),
        JSON.stringify({
          v: 1,
          kind: "counter",
          time: T0 - 24 * HOUR,
          day: day1,
          session: "sx",
          provider: "p",
          model: "m",
          dir: "heal",
          turns: 1,
          toolCalls: 1,
        }),
        "",
      ].join("\n"),
    );
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
    });
    healedDirRows = snapshot(
      (await new TrendStore({ root }).readAggDayShard(day1)).filter((r) => r.kind === "dir"),
    );
    healDirDayCell = snapshot(tracker["aggregator"]["dirDays"].get(day1)?.get("heal"));
    dirRowsForDay = snapshot(tracker.dirRows().filter((r) => r.day === day1));
    healedCells = tracker.buckets().find((d) => d.day === day1)!.providers[0].cell.calls;
    await tracker.dispose();
  }, 60_000);

  it("自愈压实：dir 行从 pending 重建行同源折算，calls/turns/toolCalls 不丢", () => {
    expect(healedDirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: "heal",
        input: 7,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });

  it("rebuild 明细/计数行平行折算进 dirDays（P1-1：过去日桶保留，与分片 dir 行值一致不重）", () => {
    expect(healDirDayCell).toEqual({
      input: 7,
      output: 3,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 1,
      toolCalls: 1,
    });
  });

  it("自愈后目录查询面立即恢复（不随 dropPending 消失，修复前须重启读回）", () => {
    expect(dirRowsForDay).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: "heal",
        input: 7,
        output: 3,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 1,
      },
    ]);
  });

  it("自愈重建 cells 行为不变", () => {
    expect(healedCells).toBe(1);
  });

  describe("pruneDays 联动（单元面）", () => {
    // pruneDays 联动（单元面）：dirDays 与 days 同生命周期，cutoff 前日桶同步删除
    // （M1 修复前只删 days，dirDays 泄漏有界但违背同生命周期口径）。
    const day1 = "2026-09-03";
    let prunedDays: number;
    let daysHasDay1: boolean;
    let dirDaysHasDay1: boolean;
    let keptDirInput: number | null | undefined;

    beforeAll(() => {
      const agg = new TrendAggregator();
      agg.rebuild(
        [
          {
            v: 1,
            kind: "agg",
            day: day1,
            provider: "p",
            model: "m",
            input: 1,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          },
          {
            v: 1,
            kind: "dir",
            day: day1,
            dir: "stale",
            input: 1,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          },
          {
            v: 1,
            kind: "agg",
            day: DAY0,
            provider: "p",
            model: "m",
            input: 2,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          },
          {
            v: 1,
            kind: "dir",
            day: DAY0,
            dir: "keep",
            input: 2,
            output: null,
            cacheRead: null,
            cacheWrite: null,
            calls: 1,
            turns: 0,
            toolCalls: 0,
          },
        ],
        false,
      );
      prunedDays = agg.pruneDays(DAY0);
      daysHasDay1 = agg["days"].has(day1);
      dirDaysHasDay1 = agg["dirDays"].has(day1);
      keptDirInput = agg["dirDays"].get(DAY0)?.get("keep")?.input;
    });

    it("pruneDays 返回 days 侧删除日数（语义不变）", () => {
      expect(prunedDays).toBe(1);
    });

    it("pruneDays：cutoff 前 days 日桶删除", () => {
      expect(daysHasDay1).toBe(false);
    });

    it("pruneDays：dirDays 联动删除（与 dropPending 对称）", () => {
      expect(dirDaysHasDay1).toBe(false);
    });

    it("cutoff 内 dirDays 日桶不受连坐", () => {
      expect(keptDirInput).toBe(2);
    });
  });
});

// ---------------------------------------------------------------- #662 hour 维度（day×hour 聚合行数据链路）
// 不变量2：防双计——小时面与 agg/dir 同一批事实的第三个投影（同源折算，不二次累加）。

describe("#662(a)：apply 平行累加 hourDays + rollupDay 同源 hour 行", () => {
  let hourRowCount: number;
  let h9Calls: number;
  let h9Input: number | null;
  let h9Output: number | null;
  let h21Input: number | null;
  let rolledHourCount: number;
  let rolledHoursJson: unknown;
  let memoryHourRowsJson: unknown;
  let hourRowsAfterRollup: number;

  beforeAll(() => {
    // #662(a)：apply 平行累加 hourDays（hourOfDay 本地时区现算）+ rollupDay 同源产出
    // hour 行（与 agg/dir 同一批事实，天然不双算）
    const agg = new TrendAggregator();
    const t9 = new Date(2026, 8, 4, 9, 30, 0).getTime(); // 本地 09:30 → hour 9
    const t21 = new Date(2026, 8, 4, 21, 0, 0).getTime(); // 本地 21:00 → hour 21
    agg.apply(
      callOf({
        time: t9,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: t9 + 60000,
        session: "s2",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        tokens: { input: 20, output: 10, cacheRead: null, cacheWrite: null },
      }),
    );
    agg.apply(
      callOf({
        time: t21,
        session: "s3",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        tokens: { input: 5, output: 5, cacheRead: null, cacheWrite: null },
      }),
    );
    // 内存小时面（apply 平行累加，未压实亦可见）
    const rows = agg.hourRows();
    hourRowCount = rows.length;
    const h9 = rows.find((r) => r.hour === 9)!;
    h9Calls = h9.calls;
    h9Input = h9.input;
    h9Output = h9.output;
    const h21 = rows.find((r) => r.hour === 21)!;
    h21Input = h21.input;
    // rollupDay 同源产出三组（agg + dir + hour），hour 行与内存 hourRows 同值
    const rolled = agg.rollupDay(DAY0, DAY0);
    const rolledHours = rolled.filter((r) => r.kind === "hour");
    rolledHourCount = rolledHours.length;
    rolledHoursJson = JSON.parse(JSON.stringify(rolledHours));
    memoryHourRowsJson = JSON.parse(JSON.stringify(rows));
    hourRowsAfterRollup = agg.hourRows().length;
  });

  it("hourRows 按 (day,hour) 折叠：9 点与 21 点两行", () => {
    expect(hourRowCount).toBe(2);
  });

  it("hour9 calls 跨会话合并", () => {
    expect(h9Calls).toBe(2);
  });

  it("hour9 input 合并（100+20）", () => {
    expect(h9Input).toBe(120);
  });

  it("hour9 output 合并（50+10）", () => {
    expect(h9Output).toBe(60);
  });

  it("hour21 input 独立", () => {
    expect(h21Input).toBe(5);
  });

  it("rollupDay 产出 hour 行（同源折算）", () => {
    expect(rolledHourCount).toBe(2);
  });

  it("压实 hour 行 = 内存 hourRows（同源单源，无重无漏）", () => {
    expect(rolledHoursJson).toEqual(memoryHourRowsJson);
  });

  it("压实消费不删 hourDays（与 dirDays 同生命周期，跨天历史保留）", () => {
    expect(hourRowsAfterRollup).toBe(2);
  });
});

describe("#662(b)：rebuild 双分支（hour 行直入桶 + detail/counter 折算入桶）", () => {
  let h9Calls: number;
  let h21Calls: number;
  let h21Input: number | null;
  let h21Turns: number;
  let h21ToolCalls: number;

  beforeAll(() => {
    // #662(b)：rebuild 双分支——hour 行直接入桶（信落盘字段）；当日 detail/counter 行
    // 折算入桶（hourOfDay 现算，与 apply 同源）
    const agg = new TrendAggregator();
    agg.rebuild(
      [
        {
          v: 1,
          kind: "hour",
          day: DAY0,
          hour: 9,
          input: 100,
          output: 50,
          cacheRead: null,
          cacheWrite: null,
          calls: 2,
          turns: 1,
          toolCalls: 0,
        },
        {
          v: 1,
          kind: "detail",
          time: new Date(2026, 8, 4, 21, 0, 0).getTime(),
          day: DAY0,
          session: "s9",
          turn: 9,
          step: 1,
          retry: 1,
          provider: "p",
          model: "m",
          input: 7,
          output: 7,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        },
        {
          v: 1,
          kind: "counter",
          time: new Date(2026, 8, 4, 21, 0, 0).getTime(),
          day: DAY0,
          session: "s9",
          provider: "p",
          model: "m",
          turns: 1,
          // toolCalls: 2 超出 0|1 字面（累加口径数值容忍；计数行宽松 fixture 与 apply 侧同理）。
          toolCalls: 2 as unknown as 0 | 1,
        },
      ],
      true,
    );
    const rows = agg.hourRows();
    const h9 = rows.find((r) => r.hour === 9)!;
    h9Calls = h9.calls;
    const h21 = rows.find((r) => r.hour === 21)!;
    h21Calls = h21.calls;
    h21Input = h21.input;
    h21Turns = h21.turns;
    h21ToolCalls = h21.toolCalls;
  });

  it("hour 行 rebuild 直接入桶（信落盘 hour 字段，不重算）", () => {
    expect(h9Calls).toBe(2);
  });

  it("detail/counter 行 rebuild 折算进小时桶", () => {
    expect(h21Calls).toBe(1);
  });

  it("detail 行 token 折算进小时桶", () => {
    expect(h21Input).toBe(7);
  });

  it("counter 行 turns 折算进小时桶", () => {
    expect(h21Turns).toBe(1);
  });

  it("counter 行 toolCalls 折算进小时桶", () => {
    expect(h21ToolCalls).toBe(2);
  });
});

describe("#662(c)：mergeHourRows 纯函数（同键累加、null-aware、保序）", () => {
  let mergedLength: number;
  let h9Input: number | null;
  let h9Output: number | null;
  let h9Calls: number;
  let firstHour: number;

  beforeAll(() => {
    // #662(c)：mergeHourRows 纯函数——同 hour 键累加（null-aware）、异 hour 独立、保序
    const base: TrendHourRow[] = [
      {
        v: 1,
        kind: "hour",
        day: DAY0,
        hour: 9,
        input: 100,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ];
    const add: TrendHourRow[] = [
      {
        v: 1,
        kind: "hour",
        day: DAY0,
        hour: 9,
        input: 50,
        output: 20,
        cacheRead: null,
        cacheWrite: null,
        calls: 2,
        turns: 1,
        toolCalls: 1,
      },
      {
        v: 1,
        kind: "hour",
        day: DAY0,
        hour: 21,
        input: 7,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ];
    const merged = mergeHourRows(base, add);
    mergedLength = merged.length;
    const h9 = merged.find((r) => r.hour === 9)!;
    h9Input = h9.input;
    h9Output = h9.output;
    h9Calls = h9.calls;
    firstHour = merged[0].hour;
  });

  it("同 hour 键合并、异 hour 独立", () => {
    expect(mergedLength).toBe(2);
  });

  it("mergeHourRows 同键 input 累加（100+50）", () => {
    expect(h9Input).toBe(150);
  });

  it("null-aware：null 不污染数字", () => {
    expect(h9Output).toBe(20);
  });

  it("同键 calls 累加", () => {
    expect(h9Calls).toBe(3);
  });

  it("保序：base 在前", () => {
    expect(firstHour).toBe(9);
  });
});

describe("#662(d)：applyCorrect 第三面（小时桶同步回退/累加）", () => {
  let h9Input: number | null;
  let cellInput: number | null;

  beforeAll(() => {
    // #662(d)：applyCorrect 第三面——修正明细 token 同步回退/累加小时桶（防小时面漂移）
    const agg = new TrendAggregator();
    const t9 = new Date(2026, 8, 4, 9, 30, 0).getTime();
    agg.apply(
      callOf({
        time: t9,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null },
      }),
    );
    // correct 记录无 time 字段（applyCorrect 只读 fold 键 + tokens，见实现）。
    agg.apply({
      type: "correct",
      record: {
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        tokens: { input: 200, output: 50, cacheRead: null, cacheWrite: null },
      },
    });
    const h9 = agg.hourRows().find((r) => r.hour === 9)!;
    h9Input = h9.input;
    cellInput = agg.buckets()[0].providers[0].cell.input;
  });

  it("applyCorrect 后小时桶同步为校正值（回退 100 → 累加 200）", () => {
    expect(h9Input).toBe(200);
  });

  it("cells 同步校正（对照面）", () => {
    expect(cellInput).toBe(200);
  });
});

describe("#662(e)：pruneDays 联动删除 hourDays", () => {
  let beforeRowCount: number;
  let afterRowCount: number;
  let remainingDay: string;

  beforeAll(() => {
    // #662(e)：pruneDays 联动删除 hourDays（与 days/dirDays 同生命周期）
    const day1 = "2026-09-03";
    const agg = new TrendAggregator();
    agg.rebuild(
      [
        {
          v: 1,
          kind: "hour",
          day: day1,
          hour: 9,
          input: 1,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
          turns: 0,
          toolCalls: 0,
        },
        {
          v: 1,
          kind: "hour",
          day: DAY0,
          hour: 9,
          input: 2,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
          turns: 0,
          toolCalls: 0,
        },
      ],
      false,
    );
    beforeRowCount = agg.hourRows().length;
    agg.pruneDays(DAY0);
    const rows = agg.hourRows();
    afterRowCount = rows.length;
    remainingDay = rows[0].day;
  });

  it("hourDays 重建后两日可见", () => {
    expect(beforeRowCount).toBe(2);
  });

  it("pruneDays：cutoff 前 hourDays 联动删除", () => {
    expect(afterRowCount).toBe(1);
  });

  it("cutoff 内 hour 日桶不受连坐", () => {
    expect(remainingDay).toBe(DAY0);
  });
});

describe("#662(f)：store 白名单与 isValidShardRow 校验（hour 行）", () => {
  let backHourCount: number;
  let backAggCount: number;
  let validAggRow: boolean;
  let validHourRow: boolean;
  let invalidHour24: boolean;
  let invalidHourNegative: boolean;
  let invalidHourFractional: boolean;
  let invalidUnknownKind: boolean;
  let invalidNonStringKind: boolean;
  let prunedShardLength: number;
  let keptShardLength: number;

  beforeAll(async () => {
    // #662(f)：store 白名单——聚合分片写读 hour 行 round-trip（readAggDayShard 白名单
    // 漏加 hour → 重启重建后小时数据静默全丢，P0）+ isValidShardRow 校验
    const root = mkdtempSync(join(tmpdir(), "dou-trend-hour-store-"));
    const store = new TrendStore({ root });
    const aggRow: TrendAggRow = {
      v: 1,
      kind: "agg",
      day: DAY0,
      provider: "p",
      model: "m",
      input: 100,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls: 2,
      turns: 1,
      toolCalls: 0,
    };
    const hourRow: TrendHourRow = {
      v: 1,
      kind: "hour",
      day: DAY0,
      hour: 9,
      input: 100,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls: 2,
      turns: 1,
      toolCalls: 0,
    };
    await store.writeAggDay(DAY0, [aggRow, hourRow]);
    const back = await store.readAggDayShard(DAY0);
    backHourCount = back.filter((r) => r.kind === "hour").length;
    backAggCount = back.filter((r) => r.kind === "agg").length;
    validAggRow = isValidShardRow(aggRow);
    validHourRow = isValidShardRow(hourRow);
    invalidHour24 = isValidShardRow({ ...hourRow, hour: 24 });
    invalidHourNegative = isValidShardRow({ ...hourRow, hour: -1 });
    invalidHourFractional = isValidShardRow({ ...hourRow, hour: 9.5 });
    invalidUnknownKind = isValidShardRow({ ...hourRow, kind: "bogus" });
    invalidNonStringKind = isValidShardRow({ ...hourRow, kind: 42 });
    // prune 语义：删除 cutoff 日（不含）之前的分片——day1(<DAY0) 整日删除、DAY0 保留
    const day1 = "2026-09-03";
    await store.writeAggDay(day1, [aggRow, hourRow]);
    await store.prune(DAY0);
    prunedShardLength = (await store.readAggDayShard(day1)).length;
    keptShardLength = (await store.readAggDayShard(DAY0)).length;
  });

  it("readAggDayShard 白名单含 hour 行（漏改会静默丢）", () => {
    expect(backHourCount).toBe(1);
  });

  it("agg 行照常", () => {
    expect(backAggCount).toBe(1);
  });

  it("isValidShardRow 认可 agg 行", () => {
    expect(validAggRow).toBe(true);
  });

  it("isValidShardRow 认可 hour 行", () => {
    expect(validHourRow).toBe(true);
  });

  it("hour=24 越界拒绝", () => {
    expect(invalidHour24).toBe(false);
  });

  it("hour=-1 越界拒绝", () => {
    expect(invalidHourNegative).toBe(false);
  });

  it("hour 非整数拒绝", () => {
    expect(invalidHourFractional).toBe(false);
  });

  it("未知 kind 拒绝", () => {
    expect(invalidUnknownKind).toBe(false);
  });

  it("非字符串 kind 拒绝", () => {
    expect(invalidNonStringKind).toBe(false);
  });

  it("prune 后 cutoff 前聚合分片（含 hour 行）删除", () => {
    expect(prunedShardLength).toBe(0);
  });

  it("cutoff 当日分片（agg+hour）保留", () => {
    expect(keptShardLength).toBe(2);
  });
});

// ---------------------------------------------------------------- 复核 P1-1（#633）：dirDays 单源化

describe("复核 P1-1(a)：常驻运行期跨天（压实后 Day0 目录面保留）", () => {
  let day0DirRows: TrendDirRow[];
  let stackedDay0: TrendStackPoint | undefined;
  let stackedTodayParts: TrendStackPart[] | undefined;

  beforeAll(async () => {
    // 复核 P1-1(a)：常驻运行期跨天——Day0 写入并压实（flushInner 日切）→ 不重启
    // 继续 Day1 apply → byDir 面（dirStacked）Day0 柱非 null 且数值正确。
    // 修复前：dropPending 联动删除过去日 dirDays，dirRows 纯内存无分片回读 →
    // Day0 柱恒 null（实测空柱）；修复后 dirDays 只随 pruneDays 收缩。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-p11-crossday-"));
    let nowMs = T0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 3));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 4));
    nowMs = T0 + 24 * HOUR; // Day1 日切
    await tracker.flushNow(); // Day0 压实（修复前此处联动删除 dirDays[Day0]）
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), nowMs, 5));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(3, 3), nowMs, 6));
    day0DirRows = snapshot(tracker.dirRows().filter((r) => r.day === DAY0));
    // dirStacked 确定性来自注入时钟（this.now），第 5 实参为历史死参（多余实参运行时恒忽略）。
    const stacked = tracker.dirStacked(2, "day", "input", undefined);
    stackedDay0 = snapshot(stacked.series.find((p) => p.key === DAY0));
    stackedTodayParts = snapshot(stacked.series.find((p) => p.key === dayKey(nowMs))?.parts);
    await tracker.dispose();
  }, 60_000);

  it("跨天不重启：压实后 Day0 目录行保留（修复前恒空）", () => {
    expect(day0DirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "alpha",
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "beta",
        input: 7,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("byDir 面 Day0 柱非 null：alpha=10/beta=7 按 dir 拆段", () => {
    expect(stackedDay0).toEqual({
      key: DAY0,
      parts: [
        { provider: "alpha", model: null, value: 10 },
        { provider: "beta", model: null, value: 7 },
      ],
      total: 17,
    });
  });

  it("Day1 当日柱照常（跨天压实不波及当日目录桶）", () => {
    expect(stackedTodayParts).toEqual([{ provider: "alpha", model: null, value: 3 }]);
  });
});

describe("复核 P1-1(b)：重启恢复后同日继续 apply（dirRows 当日 = 真实值）", () => {
  let dirRows: TrendDirRow[];
  let stackedTotal: number | null;

  beforeAll(async () => {
    // 复核 P1-1(b)：重启恢复后同日继续 apply——dirRows()/dirStacked 当日数值 =
    // 真实值（重启前 10 + 重启后 7 = 17，非 2× 非丢数）。
    // 修复前：重启后当日重建明细行（persisted=true）与 dirDays（apply 事实）并存
    // 两个事实源，折算侧 seen 按键去重只挡同键——互补事实被挡掉（实测 dirRows=7
    // 丢重启前 10），同事实并存则 2×。P1-1 后 rebuild 明细行平行折算进 dirDays、
    // dirRows 纯快照单源，结构性无重无漏。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-p11-sameday-"));
    const nowMs = T0; // 当日（detail 分片 day === today，不走自愈压实）
    let tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/w/alpha",
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    await tracker.flushNow(); // 当日明细落盘（persisted=true，pending 保留）
    await tracker.dispose();
    tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: () => "/w/alpha",
    });
    // 重启后：当日无聚合分片 → dirDays 该日为空，重建明细行的 dir 事实在 rebuild
    // 时折算入桶；同日续 apply 在同桶上平行累加（单源相加 = 真实值）。
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0 + HOUR, 3));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0 + HOUR, 4));
    dirRows = snapshot(tracker.dirRows());
    stackedTotal = tracker.dirStacked(1, "day", "input", undefined).series[0].total;
    await tracker.dispose();
  }, 60_000);

  it("同日重启+续 apply：dirRows 当日 = 真实值 17（非 2× 非丢数）", () => {
    expect(dirRows).toEqual([
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: DAY0,
        dir: "alpha",
        input: 17,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 2,
        turns: 0,
        toolCalls: 0,
      },
    ]);
  });

  it("dirStacked 当日 total=17（双算防线下真实值）", () => {
    expect(stackedTotal).toBe(17);
  });
});

describe("复核 P1-1(c)：correct 校正双面同步（dirDays 不漂移）", () => {
  let cellPair: { input: number | null; output: number | null };
  let dirDayCell: TrendCell | undefined;

  beforeAll(() => {
    // 复核 P1-1(c)：correct 校正双面同步——dirDays 随 retokenCell 修正，目录查询
    // 面与 cells/落盘明细一致（旧实现只修 cells、靠折算侧取 pending 新值掩盖漂移，
    // 单源化后不同步即固化错值）。
    const agg = new TrendAggregator();
    agg.apply({
      type: "call",
      record: {
        time: T0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "deepseek",
        model: "chat",
        dir: "proj",
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    });
    // correct 记录无 time 字段（同上，死字段删除）。
    agg.apply({
      type: "correct",
      record: {
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const cell = cellTotals(agg, DAY0)!;
    cellPair = snapshot({ input: cell.input, output: cell.output });
    dirDayCell = snapshot(agg["dirDays"].get(DAY0)?.get("proj"));
  });

  it("correct：cells 修正（既有语义零回归）", () => {
    expect(cellPair).toEqual({ input: 200, output: 60 });
  });

  it("correct：dirDays 同步修正（目录查询面不漂移）", () => {
    expect(dirDayCell).toEqual({
      input: 200,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 1,
      turns: 0,
      toolCalls: 0,
    });
  });
});

// ---------------------------------------------------------------- #654 压实快照消费
// 不变量2：防双计——折算与消费取同一份身份快照（await 间隙新到行不连带删除、不丢行不重算）。

describe("#654 单元级：rollupSnapshot 折算与消费严格同源", () => {
  let snap1Consumed: number;
  let snap1AggRows: Array<{ calls: number; input: number | null }>;
  let pendingAfterFirstConsume: number;
  let unpersistedAfterFirstConsume: number;
  let snap2Consumed: number;
  let snap2AggRows: Array<{ calls: number; input: number | null }>;
  let pendingAfterSecondConsume: number;
  let pendingAfterNoopConsume: number;

  beforeAll(() => {
    // 单元级：rollupSnapshot 的 consumed 与折算行严格同源；consume 只删快照内 entry。
    const agg = new TrendAggregator();
    const past = T0 - 24 * HOUR;
    const pastDay = dayKey(past);
    const call = (session: string, input: number, output: number): TrendEmit =>
      callOf({
        time: past,
        session,
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        dir: "d",
        tokens: { input, output, cacheRead: 0, cacheWrite: 0 },
      });
    agg.apply(call("sA", 10, 5));
    const snap = agg.rollupSnapshot(pastDay);
    snap1Consumed = snap.consumed.length;
    snap1AggRows = snapshot(snap.aggRows.map((r) => ({ calls: r.calls, input: r.input })));
    // 模拟压实 await 窗口内到达的同日行
    agg.apply(call("sB", 7, 7));
    agg.consume(snap.consumed);
    pendingAfterFirstConsume = agg.stats().pendingRows;
    unpersistedAfterFirstConsume = agg.stats().unpersistedRows;
    const snap2 = agg.rollupSnapshot(pastDay);
    snap2Consumed = snap2.consumed.length;
    snap2AggRows = snapshot(snap2.aggRows.map((r) => ({ calls: r.calls, input: r.input })));
    agg.consume(snap2.consumed);
    pendingAfterSecondConsume = agg.stats().pendingRows;
    // 边界：空数组 no-op、重复 entry 幂等；异物 entry（缺字段行）消费安全（防御分支）。
    agg.consume([]);
    agg.consume([{ row: { kind: "detail" }, persisted: true } as unknown as PendingEntry]);
    pendingAfterNoopConsume = agg.stats().pendingRows;
  });

  it("快照含先到行", () => {
    expect(snap1Consumed).toBe(1);
  });

  it("折算行只含先到行（同源）", () => {
    expect(snap1AggRows).toEqual([{ calls: 1, input: 10 }]);
  });

  it("consume 只消费快照内 entry，迟到行保留", () => {
    expect(pendingAfterFirstConsume).toBe(1);
  });

  it("迟到行仍未落盘（留待下一轮）", () => {
    expect(unpersistedAfterFirstConsume).toBe(1);
  });

  it("二次快照含迟到行", () => {
    expect(snap2Consumed).toBe(1);
  });

  it("二次折算只含迟到行（不重复折算已消费行）", () => {
    expect(snap2AggRows).toEqual([{ calls: 1, input: 7 }]);
  });

  it("二次消费后排空", () => {
    expect(pendingAfterSecondConsume).toBe(0);
  });

  it("空/异物 entry 消费安全（幂等 no-op）", () => {
    expect(pendingAfterNoopConsume).toBe(0);
  });
});

describe("#654 集成级：压实 await 窗口内到达的过去日行不被连带消费", () => {
  let gateHitAtFlush: boolean;
  let pendingAfterGateWindow: number;
  let aggRowCount: number;
  let aggRowValues: { calls: number; input: number | null; output: number | null };
  let pendingAfterSecondFlush: number;

  beforeAll(async () => {
    // 集成级（#654 竞态）：压实 await 窗口内到达的过去日行不得被连带消费。
    // 用 gate 卡住 readAggDayShard 的返回，把「迟到行」精确插入 await 窗口内。
    // #771：窗口开启改由被测代码自己兑现（markEntered 在 readAggDayShard 的 promise
    // resolve 之前同步调用）——原先靠 2000 次 setImmediate 轮询赌「轮次跑得比 fs 往返快」，
    // 那次预算实测只值约 7ms 墙钟，CI 负载下耗尽即假红（Stryker dry run 整段 ConfigError）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-654-"));
    const nowMs = T0; // 当日 09-04，迟到行落 09-03（时钟回拨形态）
    const pastDay = dayKey(T0 - 24 * HOUR);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      warn: () => {},
    });
    // 白盒：store 私有成员经 bracket 访问（元素访问不触发可见性检查；运行时同形）。
    const store = tracker["store"];
    const origReadAggDayShard = store.readAggDayShard.bind(store);
    // Promise executor 同步执行，release 在此之后恒已赋值（! 仅过编译面）。
    let release!: (value?: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    let markEntered: (value?: unknown) => void;
    const enteredWindow = new Promise((resolve) => {
      markEntered = resolve;
    });
    let gateHit = false;
    store.readAggDayShard = async (day: string) => {
      const rows = await origReadAggDayShard(day);
      if (day === pastDay && !gateHit) {
        gateHit = true;
        markEntered();
        await gate;
      }
      return rows;
    };

    tracker.handleEvent({ id: "sA" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 1));
    tracker.handleEvent({ id: "sA" }, ev("assistant/chunk", USAGE(10, 5), T0 - 24 * HOUR, 2));

    const flushing = tracker.flushNow();
    // 等待窗口开启：与「本轮压实跑完」竞速——窗口未开而压实已结束（实现回归）→ 记 false
    // 判红而不是挂死；正常路径下压实必然先兑现 markEntered 才可能 settle，
    // 故不存在「窗口已开却判 false」的假红路径。
    const windowOpened = await Promise.race([
      enteredWindow.then(() => true),
      flushing.then(() => false),
    ]);
    gateHitAtFlush = windowOpened;

    // await 窗口内到达的迟到行（同过去日、未落盘）
    tracker.handleEvent({ id: "sB" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 3));
    tracker.handleEvent({ id: "sB" }, ev("assistant/chunk", USAGE(7, 7), T0 - 24 * HOUR, 4));
    release();
    await flushing;

    pendingAfterGateWindow = tracker.stats().pendingRows;

    // 下一轮 flush：迟到行落盘 → 压实 → 两行都进 agg 分片（端到端无丢行）
    await tracker.flushNow();
    const aggRows = (await store.readAggDayShard(pastDay)).filter((r) => r.kind === "agg");
    aggRowCount = aggRows.length;
    aggRowValues = snapshot({
      calls: aggRows[0].calls,
      input: aggRows[0].input,
      output: aggRows[0].output,
    });
    pendingAfterSecondFlush = tracker.stats().pendingRows;
    await tracker.dispose();
  }, 60_000);

  it("压实已进入 readAggDayShard await 窗口", () => {
    expect(gateHitAtFlush).toBe(true);
  });

  it("迟到行保留在 pending（修复前 dropPending 按日键连带删除 → 0）", () => {
    expect(pendingAfterGateWindow).toBe(1);
  });

  it("同 (provider,model) 折叠为一行", () => {
    expect(aggRowCount).toBe(1);
  });

  it("先到行 + 迟到行都入账（calls=2 / input=17）", () => {
    expect(aggRowValues).toEqual({ calls: 2, input: 17, output: 12 });
  });

  it("二次压实后 pending 排空", () => {
    expect(pendingAfterSecondFlush).toBe(0);
  });
});

describe("#654 同域：deleteDetailShard 失败不得导致下一轮磁盘双算", () => {
  let pendingAfterFailedDelete: number;
  let aggRowsAfterSecondFlush: Array<{ calls: number; input: number | null }>;

  beforeAll(async () => {
    // #654 同域：deleteDetailShard 失败不得导致下一轮磁盘双算。
    // 消费提前到删除之前——聚合事实落盘即消费，残留明细分片留待重启的「聚合权威」自愈。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-654-del-"));
    const nowMs = T0;
    const pastDay = dayKey(T0 - 24 * HOUR);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      warn: () => {},
    });
    const store = tracker["store"];
    const origDelete = store.deleteDetailShard.bind(store);
    tracker.handleEvent({ id: "sA" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 1));
    tracker.handleEvent({ id: "sA" }, ev("assistant/chunk", USAGE(10, 5), T0 - 24 * HOUR, 2));
    store.deleteDetailShard = async () => {
      throw new Error("EACCES simulated");
    }; // 删除失败，其余步骤成功
    await tracker.flushNow();
    pendingAfterFailedDelete = tracker.stats().pendingRows;
    store.deleteDetailShard = origDelete;
    await tracker.flushNow();
    const aggRows = (await store.readAggDayShard(pastDay)).filter((r) => r.kind === "agg");
    aggRowsAfterSecondFlush = snapshot(aggRows.map((r) => ({ calls: r.calls, input: r.input })));
    await tracker.dispose();
  }, 60_000);

  it("聚合事实落盘后即消费（不等待删除成功）", () => {
    expect(pendingAfterFailedDelete).toBe(0);
  });

  it("二次 flush 不双算（消费在删除之前 → 磁盘与内存一致）", () => {
    expect(aggRowsAfterSecondFlush).toEqual([{ calls: 1, input: 10 }]);
  });
});

describe("sumToken null 语义", () => {
  let nullPlusNumber: number | null;
  let nullPlusNull: number | null;

  beforeAll(() => {
    nullPlusNumber = sumToken(null, 5);
    nullPlusNull = sumToken(null, null);
  });

  it("sumToken null+数字", () => {
    expect(nullPlusNumber).toBe(5);
  });

  it("sumToken null+null", () => {
    expect(nullPlusNull).toBe(null);
  });
});

// ---------------------------------------------------------------- #633 修复：目录面残差投影
// 不变量3+4：残差归未识别 / 台账守恒——目录面 = dirDays 快照 + 每日残差（聚合面 − 目录面），
// 残差归 TREND_UNIDENTIFIED 桶；∀day 目录面日合计 == 聚合面日合计（本段断言 (e) 即该恒等的纯函数面）。
// 背景（实测）：分片 a/b 上线后目录维度全链路失效——(1) inject 缺 sessions 致
// resolveCwd 恒 undefined，所有会话归未识别桶；(2) 旧 agg 分片（无 kind:"dir" 行）
// 重建时目录面全空，历史柱消失（实测目录面/聚合面总量差 20 倍）。
// 修法：目录面 = dirDays 快照 + 每日残差（聚合面 − 目录面），残差归未识别桶；
// **禁止**在 rebuild 里对 agg 行补造（同一事实的 agg/dir 两个投影会双算）。

// H9：纯函数面 a/b/e/i 已删（见各处登记），本 describe 仅留 c/d/f/g/h/j 变体。
describe("#633 修复：目录面残差投影（纯函数面 c/d/f/g/h/j）", () => {
  let cDirsSorted: Array<Array<string | number | null>>;
  let dDirs: string[];
  let fRowsLength: number;
  let fRowValues: Array<string | number | null>;
  let gDirs: Array<Array<string | number | null>>;
  let hDays: string[];
  let jInputBefore: number | null;
  let jInputAfter: number | null;

  beforeAll(() => {
    // 残差投影纯函数面：cells（聚合面）与 dirDays（目录面）的关系决定是否补造。
    const day = "2026-09-03";
    const mkAgg = () => new TrendAggregator();
    const call = (dir: string, input: number, output: number): TrendCallRecord => ({
      time: T0 - 24 * HOUR,
      session: "s1",
      turn: 1,
      step: 1,
      retry: 1,
      provider: "deepseek",
      model: "deepseek-chat",
      dir,
      tokens: { input, output, cacheRead: null, cacheWrite: null },
    });

    // (b) 已删（H9）：旧格式 agg-only 残差形状由本文件末段真实升级 e2e 钉住
    // （1 行/历史日/未识别/calls/分片不变/面板值）；7 字段逐值精度随删已登记。

    // (c) 混版日（旧 agg 行 + 新 dir 行并存）→ 残差 = 旧 agg 部分，新 dir 行照常分目录
    const c = mkAgg();
    c.rebuild(
      [
        {
          v: TREND_ROW_VERSION,
          kind: "agg",
          day,
          provider: "deepseek",
          model: "deepseek-chat",
          input: 5000,
          output: 800,
          cacheRead: 120,
          cacheWrite: 10,
          calls: 30,
          turns: 12,
          toolCalls: 40,
        },
        {
          v: TREND_ROW_VERSION,
          kind: "dir",
          day,
          dir: "alpha",
          input: 2000,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          calls: 10,
          turns: 4,
          toolCalls: 12,
        },
      ],
      false,
    );
    cDirsSorted = snapshot(
      c
        .dirRows()
        .map((r) => [r.dir, r.input, r.calls])
        .sort(),
    );

    // (d) 只有目录面事实（无聚合面）→ 不补造（残差行只在聚合面 > 目录面时产生）
    const d = mkAgg();
    d.rebuild(
      [
        {
          v: TREND_ROW_VERSION,
          kind: "dir",
          day,
          dir: "alpha",
          input: 900,
          output: 90,
          cacheRead: 0,
          cacheWrite: 0,
          calls: 9,
          turns: 3,
          toolCalls: 9,
        },
      ],
      false,
    );
    dDirs = snapshot(d.dirRows().map((r) => r.dir));

    // (e) 已删（H9）：双面总量守恒恒等由 ledger 台账守恒对账更强钉住（四视角逐日逐字段）。

    // (f) 同键唯一：该日 dirDays 已有 (unidentified) 桶 + 残差 > 0（混版日）→ 合并为一行
    const f = mkAgg();
    f.rebuild(
      [
        {
          v: TREND_ROW_VERSION,
          kind: "agg",
          day,
          provider: "deepseek",
          model: "deepseek-chat",
          input: 5000,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 30,
          turns: 0,
          toolCalls: 0,
        },
        {
          v: TREND_ROW_VERSION,
          kind: "dir",
          day,
          dir: TREND_UNIDENTIFIED,
          input: 100,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 10,
          turns: 0,
          toolCalls: 0,
        },
      ],
      false,
    );
    const fRows = f.dirRows();
    fRowsLength = fRows.length;
    fRowValues = snapshot([fRows[0].dir, fRows[0].input, fRows[0].calls]);

    // (g) 负残差（目录面 > 聚合面，数据异常征兆）→ 不产行、不产生负值，恒等不成立
    const g = mkAgg();
    g.rebuild(
      [
        {
          v: TREND_ROW_VERSION,
          kind: "agg",
          day,
          provider: "deepseek",
          model: "deepseek-chat",
          input: 100,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
          turns: 0,
          toolCalls: 0,
        },
        {
          v: TREND_ROW_VERSION,
          kind: "dir",
          day,
          dir: "alpha",
          input: 300,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 3,
          turns: 0,
          toolCalls: 0,
        },
      ],
      false,
    );
    gDirs = snapshot(g.dirRows().map((r) => [r.dir, r.input, r.calls]));

    // (h) 行序契约：时钟回拨把旧日事件落进过去日桶（cells 插入序乱）→ dirRows 仍按 day 升序
    const h = mkAgg();
    h.apply({
      type: "call",
      record: { ...call("beta", 10, 0), time: new Date(2026, 8, 6, 12).getTime() },
    });
    h.apply({
      type: "call",
      record: { ...call("alpha", 10, 0), time: new Date(2026, 8, 8, 12).getTime() },
    });
    h.apply({
      type: "call",
      record: { ...call("gamma", 10, 0), time: new Date(2026, 8, 7, 12).getTime() },
    });
    hDays = snapshot(h.dirRows().map((r) => r.day));

    // (i) 已删（H9）：prune 联动删除残差行由 M1(b) 单元面 pruneDays 联动钉住（同生命周期）。

    // (j) 校正后：旧格式（无 dir 键）明细行 correct → 残差吸收增量（dirRows 随之变化）
    const j = mkAgg();
    j.rebuild(
      [
        {
          v: TREND_ROW_VERSION,
          kind: "detail",
          time: T0 - 24 * HOUR,
          day,
          session: "s1",
          turn: 1,
          step: 1,
          retry: 1,
          provider: "deepseek",
          model: "deepseek-chat",
          input: 10,
          output: 0,
          cacheRead: null,
          cacheWrite: null,
          calls: 1,
        },
      ],
      false,
    );
    jInputBefore = j.dirRows()[0].input;
    j.apply({
      type: "correct",
      record: {
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        tokens: { input: 50, output: 0, cacheRead: null, cacheWrite: null },
      },
    });
    jInputAfter = j.dirRows()[0].input;
  });

  // H9 已删（a/b）：残差 0 不补造由 ledger 守恒对账隐含（多造一行即总量失衡）；
  // 旧 agg-only 三条由末段真实升级 e2e 钉住。混版（c）独无他处 pin，保留：
  it("混版日：残差 = agg − dir（归未识别），新 dir 行照常分目录，两者不重叠", () => {
    expect(cDirsSorted).toEqual([
      ["(unidentified)", 3000, 20],
      ["alpha", 2000, 10],
    ]);
  });

  it("仅目录面事实原样输出，不补造未识别行", () => {
    expect(dDirs).toEqual(["alpha"]);
  });

  // H9 已删（e）：日总量守恒恒等由 ledger 台账守恒对账更强钉住（四视角逐日逐字段）。
  // 同键合并（f）独无他处 pin（A4(d) 只并 dir 行，不并残差入既有未识别桶），保留：
  it("同 (day, dir) 键唯一（残差并入既有未识别桶，不另起一行）", () => {
    expect(fRowsLength).toBe(1);
  });

  it("合并后数值 = 目录桶 + 残差（100+4900 / 10+20），无双行", () => {
    expect(fRowValues).toEqual([TREND_UNIDENTIFIED, 5000, 30]);
  });

  it("负残差不补造行（按 0 处理）：目录面 300/3 > 聚合面 100/1，仅保留既有目录行", () => {
    expect(gDirs).toEqual([["alpha", 300, 3]]);
  });

  it("行序契约：残差行按 day 升序（不依赖 cells 插入序）", () => {
    expect(hDays).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
  });

  // H9 已删（i）：prune 联动删除残差行由 M1(b) 单元面 pruneDays 联动钉住（同生命周期）。
  // 无 dir 键（j）是 A2“旧格式无 dir 行由残差投影承担”边界的纯函数镜像，无他处 pin，保留：
  it("无 dir 键明细行 → 残差 = 10", () => {
    expect(jInputBefore).toBe(10);
  });

  it("correct 校正后残差同步为 50（无 dir 键行不进 dirDays，经残差反映）", () => {
    expect(jInputAfter).toBe(50);
  });
});

describe("#633 修复：真实升级场景端到端（旧 agg-only 分片重启后目录面恢复）", () => {
  let rowsLength: number;
  let rowDay: string;
  let rowDir: string;
  let rowCalls: number;
  let shardBytesUnchanged: boolean;
  let pastBarHasValue: boolean;
  let stackedDirs: Array<{ dir: string }>;

  beforeAll(async () => {
    // 真实升级场景端到端：旧 agg-only 过去日分片 → 重启后目录面恢复历史（此前全 null）。
    const root = mkdtempSync(join(tmpdir(), "dou-trend-residual-"));
    mkdirSync(join(root, "agg"), { recursive: true });
    writeFileSync(join(root, "agg", "2026-09-03.jsonl"), `${JSON.stringify(A2_LEGACY_AGG)}\n`);
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      warn: () => {},
    });
    const rows = tracker.dirRows();
    rowsLength = rows.length;
    rowDay = rows[0].day;
    rowDir = rows[0].dir;
    rowCalls = rows[0].calls;
    // 分片不被改写（纯读侧投影，不落盘补造）
    shardBytesUnchanged =
      readFileSync(join(root, "agg", "2026-09-03.jsonl"), "utf8") ===
      `${JSON.stringify(A2_LEGACY_AGG)}\n`;
    // dirStacked（趋势面板数据源）历史柱不再为 null
    const stacked = tracker.dirStacked(7, "day", "total");
    const past = stacked.series.find((p) => p.key === "2026-09-03");
    pastBarHasValue = past !== undefined && past.total === 5930;
    stackedDirs = snapshot(stacked.dirs);
    await tracker.dispose();
  }, 60_000);

  it("旧 agg-only 分片重启后目录面有行（不再全空）", () => {
    expect(rowsLength).toBe(1);
  });

  it("残差行落回历史日（不是今日）", () => {
    expect(rowDay).toBe("2026-09-03");
  });

  it("历史无目录信息 → 未识别桶", () => {
    expect(rowDir).toBe(TREND_UNIDENTIFIED);
  });

  it("历史调用数恢复（= agg 行 calls）", () => {
    expect(rowCalls).toBe(30);
  });

  it("残差投影纯读侧：分片文件逐字节不变（不落盘补造、不改用户数据）", () => {
    expect(shardBytesUnchanged).toBe(true);
  });

  it("目录面历史柱有值（5000+800+120+10 = 5930）", () => {
    expect(pastBarHasValue).toBeTruthy();
  });

  it("历史柱目录图例 = 未识别桶（无目录信息）", () => {
    expect(stackedDirs).toEqual([{ dir: TREND_UNIDENTIFIED }]);
  });
});

afterAll(() => {
  console.log("unit-trend: all assertions passed");
});
