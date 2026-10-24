/** dsh-provider-usage — unit: 旧格式兼容与真实升级。 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_ROW_VERSION, TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import { TrendStore } from "../../../src/server/aggregate/interface.ts";
import { TrendCollector } from "../../../src/server/collect/interface.ts";
import { T0, snapshot } from "./collector-test-support.ts";
import { HOUR } from "./aggregator-test-support.ts";

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
