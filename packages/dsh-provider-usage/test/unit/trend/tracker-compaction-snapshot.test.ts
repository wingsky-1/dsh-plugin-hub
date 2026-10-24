/**
 * dsh-provider-usage - unit: Tracker 日切压实、await 窗口与删除失败快照。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import type { PendingEntry } from "../../../src/server/aggregate/aggregator.ts";
import { TrendAggregator } from "../../../src/server/aggregate/interface.ts";
import { TrendCollector, type TrendEmit } from "../../../src/server/collect/interface.ts";
import { HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { callOf, HOUR } from "./aggregator-test-support.ts";

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
    const root = createTrackerRoot("dou-trend-rollup-");
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
    const root = createTrackerRoot("dou-trend-654-");
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
    const root = createTrackerRoot("dou-trend-654-del-");
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

afterAll(() => cleanupTrackerRoots());
