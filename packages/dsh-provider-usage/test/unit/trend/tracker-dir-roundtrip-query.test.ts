/** dsh-provider-usage — unit: 目录 round-trip 与查询。 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_ROW_VERSION, TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import { TrendAggregator, TrendStore } from "../../../src/server/aggregate/interface.ts";
import { TrendCollector, type TrendHourRow } from "../../../src/server/collect/interface.ts";
import { type TrendDirRow } from "../../../src/server/shared/interface.ts";
import { DAY0, HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { callOf, HOUR } from "./aggregator-test-support.ts";
import { tmpdir } from "node:os";

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function loadRoundtripFixture() {
  // A4(e)：混存 round-trip——压实（混存落盘）→ 重启重建（不丢不重，dir 行不双算
  // 进 cells）→ 迟到旧日行二次压实（既有 dir 行经 readAggDayShard 全量取回合并，
  // 不被整日重写抹掉）→ 再重启（分片不再被改写）。
  const root = createRoot("dou-trend-a4-roundtrip-");
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
  const round1Kinds = snapshot(round1.map((r) => r.kind));
  const round1Hours = snapshot(round1.filter((r): r is TrendHourRow => r.kind === "hour"));
  const detailShardDeleted = existsSync(join(root, "details", `${DAY0}.jsonl`));
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
  const cellR1 = snapshot({
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
  const round2Kinds = snapshot(round2.map((r) => r.kind));
  const round2Hours = snapshot(round2.filter((r): r is TrendHourRow => r.kind === "hour"));
  const round2Dirs = snapshot(round2.filter((r): r is TrendDirRow => r.kind === "dir"));
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
  const cellR2Calls = cellR2.calls;
  const finalKinds = snapshot((await store.readAggDayShard(DAY0)).map((r) => r.kind));
  await tracker.dispose();

  return {
    round1Kinds,
    round1Hours,
    detailShardDeleted,
    cellR1,
    round2Kinds,
    round2Hours,
    round2Dirs,
    cellR2Calls,
    finalKinds,
  };
}

function loadQueryFixture() {
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
  const buckets = snapshot(agg.buckets());
  const seriesValues = snapshot(agg.seriesDays(2, T0 + HOUR, "input").map((d) => d.value));
  // A4(f)补dir：dir 面正向断言——dir 行 rebuild 进 dirDays（与 apply 平行累加合并），
  // 无 dir 事实的行经残差投影归未识别桶（与 buckets/seriesDays 零变化断言同源）。
  const dirSnapshot = snapshot(agg.dirRows());

  return { buckets, seriesValues, dirSnapshot };
}

// 快照由本块 beforeAll 填充，原 it 只读；声明本身不执行生命周期动作。
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

describe("#633 A4(e)：混存 round-trip（压实→重启→迟到行二次压实→再重启）", () => {
  beforeAll(async () => {
    ({
      round1Kinds,
      round1Hours,
      detailShardDeleted,
      cellR1,
      round2Kinds,
      round2Hours,
      round2Dirs,
      cellR2Calls,
      finalKinds,
    } = await loadRoundtripFixture());
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
    ({ buckets, seriesValues, dirSnapshot } = loadQueryFixture());
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
    const root = createRoot("dou-trend-a4-scale-");
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

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
