/** dsh-provider-usage — unit: 小时桶累加与重建。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TrendAggregator,
  TrendStore,
  mergeHourRows,
} from "../../../src/server/aggregate/interface.ts";
import { type TrendAggRow, type TrendHourRow } from "../../../src/server/collect/interface.ts";
import { isValidShardRow } from "../../../src/server/shared/interface.ts";
import { DAY0 } from "./collector-test-support.ts";
import { callOf } from "./aggregator-test-support.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
    const root = createRoot("dou-trend-hour-store-");
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

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
