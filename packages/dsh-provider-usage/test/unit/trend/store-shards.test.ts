/** Store 分片读写、坏行校验；原 beforeAll 动作与 snapshot 时点整体保留。 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrendStore } from "../../../src/server/aggregate/interface.ts";
import type { TrendAggRow, TrendHourRow } from "../../../src/server/collect/interface.ts";
import {
  isValidShardRow,
  type TrendCounterRow,
  type TrendDetailRow,
  type TrendDirRow,
} from "../../../src/server/shared/interface.ts";
import { DAY0, T0, snapshot } from "./collector-test-support.ts";

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

describe("store：明细/聚合分片读写与 prune", () => {
  let appendOk: boolean;
  let expectedRows: Array<TrendDetailRow | TrendCounterRow>;
  let back: Array<TrendDetailRow | TrendCounterRow>;
  let hasAggBeforeWrite: boolean;
  let hasAggAfterWrite: boolean;
  let aggShardLength: number;
  let afterDelete: Array<TrendDetailRow | TrendCounterRow>;
  let removed: number;
  let oldAggFileExists: boolean;

  beforeAll(async () => {
    const root = createStoreRoot("dou-trend-store-");
    const store = new TrendStore({ root });
    const rows: Array<TrendDetailRow | TrendCounterRow> = [
      {
        v: 1,
        kind: "detail",
        time: T0,
        day: DAY0,
        session: "s1",
        turn: 1,
        step: 1,
        retry: 1,
        provider: "p",
        model: "m",
        input: 1,
        output: 2,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
      },
      {
        v: 1,
        kind: "counter",
        time: T0,
        day: DAY0,
        session: "s1",
        provider: "p",
        model: "m",
        turns: 1,
        toolCalls: 0,
      },
    ];
    expectedRows = snapshot(rows);
    const ok = await store.appendRows(rows);
    appendOk = ok instanceof Set && ok.has(DAY0);
    back = snapshot(await store.readDetailShard(DAY0));
    hasAggBeforeWrite = await store.hasAggShard(DAY0);

    await store.writeAggDay(DAY0, [
      {
        v: 1,
        kind: "agg",
        day: DAY0,
        provider: "p",
        model: "m",
        input: 3,
        output: 2,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 1,
        toolCalls: 0,
      },
    ]);
    hasAggAfterWrite = await store.hasAggShard(DAY0);
    aggShardLength = (await store.readAggShard(DAY0)).length;

    await store.deleteDetailShard(DAY0);
    afterDelete = snapshot(await store.readDetailShard(DAY0));

    // prune：旧日删除、当日保留
    mkdirSync(join(root, "agg"), { recursive: true });
    writeFileSync(
      join(root, "agg", "2026-01-01.jsonl"),
      '{"v":1,"kind":"agg","day":"2026-01-01","provider":"p","model":null,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"calls":0,"turns":0,"toolCalls":0}\n',
    );
    removed = await store.prune("2026-06-01");
    oldAggFileExists = existsSync(join(root, "agg", "2026-01-01.jsonl"));
  });

  it("appendRows 返回成功日集合", () => {
    expect(appendOk).toBeTruthy();
  });

  it("明细分片 roundtrip", () => {
    expect(back).toEqual(expectedRows);
  });

  it("聚合分片未写不存在", () => {
    expect(hasAggBeforeWrite).toBe(false);
  });

  it("聚合分片写入", () => {
    expect(hasAggAfterWrite).toBe(true);
  });

  it("聚合分片读回", () => {
    expect(aggShardLength).toBe(1);
  });

  it("明细分片删除", () => {
    expect(afterDelete).toEqual([]);
  });

  it("prune 删除过期聚合分片", () => {
    expect(removed).toBe(1);
  });

  it("过期文件已删", () => {
    expect(oldAggFileExists).toBe(false);
  });
});

describe("store：坏行跳过", () => {
  let rows: Array<TrendAggRow | TrendDirRow | TrendHourRow>;

  beforeAll(async () => {
    const root = createStoreRoot("dou-trend-badline-");
    const store = new TrendStore({ root, warn: () => {} });
    mkdirSync(join(root, "agg"), { recursive: true });
    writeFileSync(
      join(root, "agg", DAY0 + ".jsonl"),
      `not-json\n{"v":99,"kind":"agg","day":"${DAY0}","provider":"p","model":null,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"calls":0,"turns":0,"toolCalls":0}\n{"v":1,"kind":"agg","day":"${DAY0}","provider":"p","model":null,"input":1,"output":1,"cacheRead":null,"cacheWrite":null,"calls":1,"turns":0,"toolCalls":0}\n`,
    );
    rows = snapshot(await store.readAggShard(DAY0));
  });

  it("坏行/异版本行跳过，仅收当前 schema 版本", () => {
    expect(rows.length).toBe(1);
  });
});

describe("评审修复 P2-4：分片行校验补强（坏行拒收 + 逐行告警）", () => {
  let validBadToken: boolean;
  let validBadModel: boolean;
  let validBadDay: boolean;
  let validBadCounter: boolean;
  let validBadAgg: boolean;
  let validGood: boolean;
  let detailsLength: number;
  let details0Session: string;
  let aggShardLength: number;
  let warnsLength: number;

  beforeAll(async () => {
    // P2-4：token 字符串 "x" / model 数字 / day 非零填充格式（"2026-9-4"）→
    // isValidShardRow 拒收、readDetailShard/readAggShard 跳过并逐行告警
    //（防垃圾值进 sumToken 拼接、垃圾日键进内存桶）。
    const root = createStoreRoot("dou-trend-badrow-");
    const warns: string[] = [];
    const store = new TrendStore({ root, warn: (m) => warns.push(m) });
    const good = {
      v: 1,
      kind: "detail",
      time: T0,
      day: DAY0,
      session: "s1",
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
    };
    const badToken = { ...good, session: "s2", input: "x" };
    const badModel = { ...good, session: "s3", model: 3 };
    const badDay = { ...good, session: "s4", day: "2026-9-4" };
    const badCounter = {
      v: 1,
      kind: "counter",
      time: T0,
      day: DAY0,
      session: "s5",
      provider: "p",
      model: 3,
      turns: 1,
      toolCalls: 0,
    };
    const badAgg = {
      v: 1,
      kind: "agg",
      day: DAY0,
      provider: "p",
      model: 3,
      input: "x",
      output: null,
      cacheRead: null,
      cacheWrite: null,
      calls: 1,
      turns: 0,
      toolCalls: 0,
    };
    // 校验面单点断言
    validBadToken = isValidShardRow(badToken);
    validBadModel = isValidShardRow(badModel);
    validBadDay = isValidShardRow(badDay);
    validBadCounter = isValidShardRow(badCounter);
    validBadAgg = isValidShardRow(badAgg);
    validGood = isValidShardRow(good);
    // 分片读取面：坏行跳过 + 告警
    mkdirSync(join(root, "details"), { recursive: true });
    mkdirSync(join(root, "agg"), { recursive: true });
    writeFileSync(
      join(root, "details", `${DAY0}.jsonl`),
      [good, badToken, badModel, badDay, badCounter].map((r) => JSON.stringify(r)).join("\n") +
        "\n",
    );
    writeFileSync(join(root, "agg", `${DAY0}.jsonl`), `${JSON.stringify(badAgg)}\n`);
    const details = await store.readDetailShard(DAY0);
    detailsLength = details.length;
    details0Session = details[0].session;
    aggShardLength = (await store.readAggShard(DAY0)).length;
    warnsLength = warns.length;
  });

  it("token 非有限数拒绝", () => {
    expect(validBadToken).toBe(false);
  });

  it("model 非字符串拒绝", () => {
    expect(validBadModel).toBe(false);
  });

  it("day 非零填充格式拒绝", () => {
    expect(validBadDay).toBe(false);
  });

  it("counter 行 model 数字拒绝", () => {
    expect(validBadCounter).toBe(false);
  });

  it("agg 行坏 token/model 拒绝", () => {
    expect(validBadAgg).toBe(false);
  });

  it("合法行通过", () => {
    expect(validGood).toBe(true);
  });

  it("4 坏行全拒，仅收合法行", () => {
    expect(detailsLength).toBe(1);
  });

  it("保留的是合法 detail 行", () => {
    expect(details0Session).toBe("s1");
  });

  it("agg 坏行拒收", () => {
    expect(aggShardLength).toBe(0);
  });

  it("每个坏行均有告警", () => {
    expect(warnsLength).toBe(5);
  });
});

afterAll(() => cleanupStoreRoots());
