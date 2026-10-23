/** Store 留存、部分失败与原子写残留清理；#934 保留块内独立回收。 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrendStore } from "../../../src/server/aggregate/interface.ts";
import { HistoryStore } from "../../../src/server/history/interface.ts";
import type { TrendDetailRow } from "../../../src/server/shared/interface.ts";
import { DAY0, T0 } from "./collector-test-support.ts";

const storeRoots: string[] = [];

function createStoreRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  storeRoots.push(root);
  return root;
}

function cleanupStoreRoots(): void {
  for (const root of storeRoots) {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("评审修复 P0-1 交叉：HistoryStore.pruneAll 不误删 trend 分片", () => {
  let detExistsAfterPruneAll: boolean;
  let aggExistsAfterPruneAll: boolean;
  let usageExistsAfterPruneAll: boolean;
  let removed: number;
  let trendShardsGoneAfterPrune: boolean;

  beforeAll(async () => {
    // P0-1 交叉：HistoryStore.pruneAll（默认 30 天 retention）不得误删 trend 目录分片——
    // trend 留存由 TrendTracker.prune 按自身 cutoff 独立管理（分片名日期恰好命中
    // pruneAll 的日期启发，漏排会被 30 天 retention 静默误删）。
    const root = createStoreRoot("dou-trend-p0x-");
    const detFile = join(root, "trend", "details", "2026-01-01.jsonl");
    const aggFile = join(root, "trend", "agg", "2026-01-01.jsonl");
    const usageFile = join(root, "p1", "n1", "2026-01-01.jsonl");
    mkdirSync(join(root, "trend", "details"), { recursive: true });
    mkdirSync(join(root, "trend", "agg"), { recursive: true });
    mkdirSync(join(root, "p1", "n1"), { recursive: true });
    const detailLine = JSON.stringify({
      v: 1,
      kind: "detail",
      time: T0,
      day: "2026-01-01",
      session: "sx",
      turn: 1,
      step: 1,
      retry: 1,
      provider: "p",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
    });
    const aggLine = JSON.stringify({
      v: 1,
      kind: "agg",
      day: "2026-01-01",
      provider: "p",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 0,
      toolCalls: 0,
    });
    writeFileSync(detFile, `${detailLine}\n`);
    writeFileSync(aggFile, `${aggLine}\n`);
    writeFileSync(usageFile, '{"time":1,"data":{}}\n');
    // mtime 一律设 90 天前构造过期形态（历史实现若按 mtime 启发判过期同样视为过期）
    const old = new Date(Date.now() - 90 * 86400000);
    utimesSync(detFile, old, old);
    utimesSync(aggFile, old, old);
    utimesSync(usageFile, old, old);
    const hist = new HistoryStore({ root }); // 默认 maxAgeMs=30 天
    await hist.pruneAll();
    detExistsAfterPruneAll = existsSync(detFile);
    aggExistsAfterPruneAll = existsSync(aggFile);
    usageExistsAfterPruneAll = existsSync(usageFile);
    // TrendStore.prune 按自身 cutoff 正常清理 trend 分片
    const tstore = new TrendStore({ root: join(root, "trend") });
    removed = await tstore.prune("2026-02-01");
    trendShardsGoneAfterPrune = !existsSync(detFile) && !existsSync(aggFile);
  });

  it("pruneAll 不误删 trend/details 分片", () => {
    expect(detExistsAfterPruneAll).toBeTruthy();
  });

  it("pruneAll 不误删 trend/agg 分片", () => {
    expect(aggExistsAfterPruneAll).toBeTruthy();
  });

  it("普通 usage 过期分片被删（对照组有效）", () => {
    expect(!usageExistsAfterPruneAll).toBeTruthy();
  });

  it("TrendStore.prune 删除 cutoff 前的明细+聚合分片", () => {
    expect(removed).toBe(2);
  });

  it("trend 过期分片被自身 prune 清理", () => {
    expect(trendShardsGoneAfterPrune).toBeTruthy();
  });
});

describe("评审修复 P1-3（store 级）：部分失败日不进成功集、重试后补上", () => {
  let okDaysIsSet: boolean;
  let okDaysList: string[];
  let successDayLines: number;
  let failedDayLinesBefore: number;
  let okDays2List: string[];
  let failedDayLinesAfter: number;
  const pastDayKey = "2026-09-03";

  beforeAll(async () => {
    // P1-3 store 级：失败日 details/<day>.jsonl 预创建为目录 → appendFile 得 EISDIR，
    // appendRows 返回成功日集合只含成功日；移除障碍重试后失败日进入成功集。
    const root = createStoreRoot("dou-trend-partial-");
    const store = new TrendStore({ root, warn: () => {} });
    const dayB = "2026-09-03";
    mkdirSync(join(root, "details", `${dayB}.jsonl`), { recursive: true });
    const rowOf = (day: string, session: string): TrendDetailRow => ({
      v: 1,
      kind: "detail",
      time: T0,
      day,
      session,
      turn: 1,
      step: 1,
      retry: 1,
      provider: "p",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
    });
    const okDays = await store.appendRows([rowOf(DAY0, "sA"), rowOf(dayB, "sB")]);
    okDaysIsSet = okDays instanceof Set;
    okDaysList = [...okDays];
    successDayLines = (await store.readDetailShard(DAY0)).length;
    failedDayLinesBefore = (await store.readDetailShard(dayB)).length;
    rmdirSync(join(root, "details", `${dayB}.jsonl`)); // 移除障碍
    const okDays2 = await store.appendRows([rowOf(dayB, "sB")]);
    okDays2List = [...okDays2];
    failedDayLinesAfter = (await store.readDetailShard(dayB)).length;
  });

  it("appendRows 返回成功日集合", () => {
    expect(okDaysIsSet).toBeTruthy();
  });

  it("成功集只含成功日（失败日 EISDIR 不在集）", () => {
    expect(okDaysList).toEqual([DAY0]);
  });

  it("成功日已落盘", () => {
    expect(successDayLines).toBe(1);
  });

  it("失败日未落盘", () => {
    expect(failedDayLinesBefore).toBe(0);
  });

  it("移除障碍后失败日进入成功集", () => {
    expect(okDays2List).toEqual([pastDayKey]);
  });

  it("失败日行补上", () => {
    expect(failedDayLinesAfter).toBe(1);
  });
});

describe("评审修复 P2-7：writeAggDay 清理同日残留 tmp", () => {
  let sameDayTmpCleared: boolean;
  let otherDayTmpKept: boolean;
  let aggShardLength: number;

  beforeAll(async () => {
    // P2-7：writeAggDay 写 tmp 前清理同日 rename 前崩溃残留 tmp（前缀 `${day}.jsonl.` 且
    // 后缀 `.tmp`）；他日残留不受影响，主流程正常。
    const root = createStoreRoot("dou-trend-tmp-");
    const store = new TrendStore({ root, warn: () => {} });
    mkdirSync(join(root, "agg"), { recursive: true });
    writeFileSync(join(root, "agg", `${DAY0}.jsonl.1700000000000.tmp`), "stale\n"); // 同日残留
    writeFileSync(join(root, "agg", `2026-09-05.jsonl.1700000000000.tmp`), "other-day\n"); // 他日残留
    await store.writeAggDay(DAY0, [
      {
        v: 1,
        kind: "agg",
        day: DAY0,
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
    ]);
    sameDayTmpCleared = existsSync(join(root, "agg", `${DAY0}.jsonl.1700000000000.tmp`));
    otherDayTmpKept = existsSync(join(root, "agg", `2026-09-05.jsonl.1700000000000.tmp`));
    aggShardLength = (await store.readAggShard(DAY0)).length;
  });

  it("同日残留 tmp 已清", () => {
    expect(sameDayTmpCleared).toBe(false);
  });

  it("他日残留不受影响", () => {
    expect(otherDayTmpKept).toBe(true);
  });

  it("主流程不受清理影响", () => {
    expect(aggShardLength).toBe(1);
  });
});

describe("评审 #934：writeAggDay 多残留清理失败全量 warn", () => {
  let warns: string[] = [];
  let leakRoot = "";
  let aggShardLength934 = 0;

  beforeAll(async () => {
    // #934：多个同日残留 tmp 删除失败时，一条 warn 列出全部失败文件 basename＋原因，
    // 主写照常推进。rm（无 recursive）删非空目录必 reject——以此构造确定性多失败。
    warns = [];
    const root = mkdtempSync(join(tmpdir(), "dou-trend-warn934-"));
    leakRoot = root;
    const store = new TrendStore({ root, warn: (m: string) => warns.push(m) });
    mkdirSync(join(root, "agg"), { recursive: true });
    for (const name of [`${DAY0}.jsonl.1700000000001.tmp`, `${DAY0}.jsonl.1700000000002.tmp`]) {
      const dir = join(root, "agg", name);
      mkdirSync(dir);
      writeFileSync(join(dir, "keep"), "x");
    }
    await store.writeAggDay(DAY0, [
      {
        v: 1,
        kind: "agg",
        day: DAY0,
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
    ]);
    aggShardLength934 = (await store.readAggShard(DAY0)).length;
  });

  it("一条 warn 含全部失败文件 basename", () => {
    const hit = warns.filter((m) => m.includes("聚合分片 tmp 残留清理失败"));
    expect(hit.length).toBe(1);
    expect(hit[0].includes(`${DAY0}.jsonl.1700000000001.tmp`)).toBe(true);
    expect(hit[0].includes(`${DAY0}.jsonl.1700000000002.tmp`)).toBe(true);
  });

  it("warn 不记绝对路径", () => {
    const hit = warns.filter((m) => m.includes("聚合分片 tmp 残留清理失败"));
    expect(hit.length).toBe(1);
    expect(hit[0].includes(leakRoot)).toBe(false);
  });

  it("warn 含失败原因实质（存在性，不锁措辞）", () => {
    const hit = warns.filter((m) => m.includes("聚合分片 tmp 残留清理失败"));
    expect(hit.length).toBe(1);
    // 去掉固定前缀与两 basename 后仍有原因实质——“只记 basename 不记原因”的
    // 变异体此处被杀；不断言原因措辞本身（平台 rm 文案差异不进断言）。
    const prefix = `聚合分片 tmp 残留清理失败（${DAY0}）：`;
    const rest = hit[0].slice(hit[0].indexOf(prefix) + prefix.length);
    const substance = rest
      .split(`${DAY0}.jsonl.1700000000001.tmp`)
      .join("")
      .split(`${DAY0}.jsonl.1700000000002.tmp`)
      .join("");
    expect(substance.length).toBeGreaterThan(10);
  });

  it("主写照常推进", () => {
    expect(aggShardLength934).toBe(1);
  });

  afterAll(() => {
    // P3：占位目录落 /tmp 也要收（mkdtemp 配套 rm；多失败占位目录 rm 删不掉，此处兜底）。
    if (leakRoot) rmSync(leakRoot, { recursive: true, force: true });
  });
});

afterAll(() => cleanupStoreRoots());
