/** dsh-provider-usage — unit: 目录归并与 rollup。 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_ROW_VERSION, TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import {
  TrendAggregator,
  TrendStore,
  mergeDirRows,
} from "../../../src/server/aggregate/interface.ts";
import {
  TrendCollector,
  type TrendAggRow,
  type TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import { type TrendDirRow } from "../../../src/server/shared/interface.ts";
import { DAY0, HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { cellTotals, counterOf, HOUR } from "./aggregator-test-support.ts";
import { tmpdir } from "node:os";

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function loadRollupFixture() {
  // A3(a)：内存态归并（tracker 全链路）——apply 平行累加后压实产物 dir 行：
  // 双 session 同 cwd → 恰 1 条 calls 为和；不同 cwd 独立行；resolveCwd 缺失 →
  // 未识别桶独立成行。dir 行位于 agg 行之后（writeAggDay 写入顺序约定）。
  const root = createRoot("dou-trend-a3-merge-");
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
  const shardKinds = snapshot(shard.map((r) => r.kind));
  const shardHours = snapshot(shard.filter((r): r is TrendHourRow => r.kind === "hour"));
  const shardDirs = snapshot(shard.filter((r): r is TrendDirRow => r.kind === "dir"));
  const shardAggCells = snapshot(
    shard
      .filter((r): r is TrendAggRow => r.kind === "agg")
      .map((r) => ({ input: r.input, output: r.output, calls: r.calls, turns: r.turns })),
  );
  const detailShardDeleted = existsSync(join(root, "details", `${DAY0}.jsonl`));
  await tracker.dispose();

  return { shardKinds, shardHours, shardDirs, shardAggCells, detailShardDeleted };
}

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
    ({ shardKinds, shardHours, shardDirs, shardAggCells, detailShardDeleted } =
      await loadRollupFixture());
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

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
