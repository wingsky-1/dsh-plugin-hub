/**
 * dsh-provider-usage — unit：isValidShardRow 分片行判别契约（#732 T3 缺陷 1–3）。
 *
 * 锁的是**契约**（每种 kind 收什么行、不收什么行），不是实现形状：SHARD_CHECKS 的键集、
 * 每项 checker 的身份、函数怎么拆都不在本文件的断言面内。
 *
 * 覆盖（按「谁被证伪」组织，每条都能被一次 checker 置空/放行打红）：
 * - (a) 五个 kind 各一条有效行通过——同时证明分片表**五个键都在**（少一个键 = 整类行静默全丢）。
 * - (b) 每个 kind 一条**该 kind 专属**的坏字段被拒：detail.calls 恒 1 / counter.turns∈{0,1} /
 *   agg.provider 必字符串 / dir.dir 非空 / hour.hour∈0..23——证明每个 kind 的 checker 列表非空壳。
 * - (c) 共享 checker 逐条被证伪：day key、token 四元组、counts 三元组、model 可空串、
 *   detail/counter 的可选 dir——「共用项」也必须每条都有断言，否则把某个共用项从表里删掉不会变红。
 * - (d) hour 边界穷举：非整数、<0、>23。
 * - (e) 未知 kind 返回 false，且不抛——含 Object.prototype 上的键名（缺陷 1 的
 *   Record<string,…> 索引会取到原型链成员，checks.every 直接 TypeError）。
 * - (f) detail/counter 缺 dir 仍合法（加性可选键的既有语义，见 trend.ts TREND_ROW_VERSION 注释）。
 */
import { describe, expect, it } from "vitest";
import { isValidShardRow, TREND_ROW_VERSION } from "../../../src/server/shared/interface.ts";

const DAY = "2026-09-04";
/** checker 只看 typeof time === "number"，任意 epoch ms 即可（不参与任何日期折算）。 */
const TIME = 1_789_000_000_000;
const TOKENS = { input: 10, output: 20, cacheRead: null, cacheWrite: null };
const COUNTS = { calls: 3, turns: 1, toolCalls: 2 };

type Row = Record<string, unknown>;
/** 覆盖式行工厂：bad 里的键覆盖基底行，用于「只坏一个字段」的定点证伪。 */
const row = (base: Row, bad: Row = {}): Row => ({ ...base, ...bad });

const DETAIL: Row = {
  v: TREND_ROW_VERSION,
  kind: "detail",
  time: TIME,
  day: DAY,
  session: "s1",
  turn: 1,
  step: 2,
  retry: 1,
  provider: "prov",
  model: "mdl",
  dir: "proj",
  ...TOKENS,
  calls: 1,
};

const COUNTER: Row = {
  v: TREND_ROW_VERSION,
  kind: "counter",
  time: TIME,
  day: DAY,
  session: "s1",
  provider: "prov",
  model: "mdl",
  dir: "proj",
  turns: 1,
  toolCalls: 0,
};

const AGG: Row = {
  v: TREND_ROW_VERSION,
  kind: "agg",
  day: DAY,
  provider: "prov",
  model: "mdl",
  ...TOKENS,
  ...COUNTS,
};

const DIR: Row = {
  v: TREND_ROW_VERSION,
  kind: "dir",
  day: DAY,
  dir: "proj",
  ...TOKENS,
  ...COUNTS,
};

const HOUR: Row = {
  v: TREND_ROW_VERSION,
  kind: "hour",
  day: DAY,
  hour: 12,
  ...TOKENS,
  ...COUNTS,
};

const BY_KIND: Record<string, Row> = {
  detail: DETAIL,
  counter: COUNTER,
  agg: AGG,
  dir: DIR,
  hour: HOUR,
};

describe("#732 缺陷 1：分片表键集 = 五个 kind，缺一即整类行静默丢失", () => {
  it("五个 kind 各一条有效行都通过（键集完整的充分证据）", () => {
    for (const [kind, valid] of Object.entries(BY_KIND)) {
      expect(isValidShardRow(valid), kind).toBe(true);
    }
  });

  it("未知 kind 返回 false", () => {
    expect(isValidShardRow(row(DETAIL, { kind: "detaill" }))).toBe(false);
    expect(isValidShardRow(row(DETAIL, { kind: "week" }))).toBe(false);
    expect(isValidShardRow(row(DETAIL, { kind: "" }))).toBe(false);
  });

  it("非字符串 kind 返回 false（不落进表查找）", () => {
    for (const kind of [1, null, undefined, true, {}, ["detail"]]) {
      expect(isValidShardRow(row(DETAIL, { kind })), JSON.stringify(kind) ?? "undefined").toBe(
        false,
      );
    }
  });

  it("Object.prototype 上的键名返回 false 而不抛（表查找不得穿透原型链）", () => {
    for (const kind of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(isValidShardRow(row(DETAIL, { kind })), kind).toBe(false);
    }
  });

  it("版本号不符返回 false（先于 kind 分派）", () => {
    for (const valid of Object.values(BY_KIND)) {
      expect(isValidShardRow(row(valid, { v: TREND_ROW_VERSION + 1 }))).toBe(false);
    }
  });

  it("非对象载荷返回 false", () => {
    for (const bad of [null, undefined, 1, "detail", true, []]) {
      expect(isValidShardRow(bad)).toBe(false);
    }
  });
});

describe("#732 缺陷 1/2：每个 kind 的 checker 都在校验（逐条定点证伪）", () => {
  it("detail：calls 恒为 1、turn/step/retry 必为数字、time/session/provider 必为对应类型", () => {
    expect(isValidShardRow(row(DETAIL, { calls: 2 }))).toBe(false);
    expect(isValidShardRow(row(DETAIL, { retry: "1" }))).toBe(false);
    expect(isValidShardRow(row(DETAIL, { time: String(TIME) }))).toBe(false);
    expect(isValidShardRow(row(DETAIL, { session: 7 }))).toBe(false);
  });

  it("counter：turns/toolCalls 只能 0 或 1、time/session/provider 必为对应类型", () => {
    expect(isValidShardRow(row(COUNTER, { turns: 2 }))).toBe(false);
    expect(isValidShardRow(row(COUNTER, { toolCalls: 5 }))).toBe(false);
    expect(isValidShardRow(row(COUNTER, { time: null }))).toBe(false);
    expect(isValidShardRow(row(COUNTER, { provider: null }))).toBe(false);
  });

  it("agg：provider 必为字符串（dir/hour 行无 provider 键，恒真）", () => {
    expect(isValidShardRow(row(AGG, { provider: 7 }))).toBe(false);
    expect(isValidShardRow(row(AGG, { provider: null }))).toBe(false);
  });

  it("dir：dir 键强制存在且合法（detail/counter 的 dir 是可选键，语义不同）", () => {
    expect(isValidShardRow(row(DIR, { dir: "" }))).toBe(false);
    expect(isValidShardRow(row(DIR, { dir: 7 }))).toBe(false);
    expect(isValidShardRow(row(DIR, { dir: "x".repeat(257) }))).toBe(false);
  });

  it("hour：hour 必落在 0–23 整数", () => {
    expect(isValidShardRow(row(HOUR, { hour: 24 }))).toBe(false);
  });
});

describe("#732 缺陷 2：共享 checker 逐条被证伪（共用项删掉也必须变红）", () => {
  it("day key 格式对每个 kind 都生效", () => {
    for (const valid of Object.values(BY_KIND)) {
      expect(isValidShardRow(row(valid, { day: "2026-9-4" }))).toBe(false);
      expect(isValidShardRow(row(valid, { day: "x" }))).toBe(false);
      expect(isValidShardRow(row(valid, { day: 20260904 }))).toBe(false);
    }
  });

  it("token 四元组每项都只收有限数或 null", () => {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      expect(isValidShardRow(row(AGG, { [key]: "10" })), key).toBe(false);
      expect(isValidShardRow(row(AGG, { [key]: Number.NaN })), key).toBe(false);
      expect(isValidShardRow(row(AGG, { [key]: Number.POSITIVE_INFINITY })), key).toBe(false);
    }
  });

  it("counts 三元组每项都只收 number（agg/dir/hour）", () => {
    for (const valid of [AGG, DIR, HOUR]) {
      for (const key of ["calls", "turns", "toolCalls"] as const) {
        expect(isValidShardRow(row(valid, { [key]: "3" })), key).toBe(false);
        expect(isValidShardRow(row(valid, { [key]: null })), key).toBe(false);
      }
    }
  });

  it("model 只收字符串或 null（detail/counter/agg）", () => {
    for (const valid of [DETAIL, COUNTER, AGG]) {
      expect(isValidShardRow(row(valid, { model: 7 }))).toBe(false);
      expect(isValidShardRow(row(valid, { model: undefined }))).toBe(false);
      expect(isValidShardRow(row(valid, { model: null }))).toBe(true);
      expect(isValidShardRow(row(valid, { model: "mdl" }))).toBe(true);
    }
  });

  it("detail/counter 的可选 dir：缺键合法，给了就必须合法", () => {
    for (const valid of [DETAIL, COUNTER]) {
      expect(isValidShardRow(row(valid, { dir: undefined }))).toBe(true);
      expect(isValidShardRow(row(valid, { dir: "" }))).toBe(false);
      expect(isValidShardRow(row(valid, { dir: "x".repeat(257) }))).toBe(false);
    }
  });
});

describe("#732 缺陷 2：hour 边界穷举（非整数 / 越界）", () => {
  it("非整数被拒", () => {
    for (const hour of [1.5, 12.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidShardRow(row(HOUR, { hour })), String(hour)).toBe(false);
    }
  });

  it("小于 0 被拒", () => {
    for (const hour of [-1, -23]) {
      expect(isValidShardRow(row(HOUR, { hour })), String(hour)).toBe(false);
    }
  });

  it("大于 23 被拒", () => {
    for (const hour of [24, 25, 48]) {
      expect(isValidShardRow(row(HOUR, { hour })), String(hour)).toBe(false);
    }
  });

  it("非数字 hour 被拒", () => {
    for (const hour of ["12", null, undefined, true, {}]) {
      expect(isValidShardRow(row(HOUR, { hour })), JSON.stringify(hour) ?? "undefined").toBe(false);
    }
  });

  it("0 与 23 两端合法", () => {
    expect(isValidShardRow(row(HOUR, { hour: 0 }))).toBe(true);
    expect(isValidShardRow(row(HOUR, { hour: 23 }))).toBe(true);
  });
});

describe("#732 缺陷 3：加性可选键语义不受拆解影响", () => {
  it("detail/counter 无 dir 键（旧格式行）仍合法", () => {
    const { dir: _dir, ...detailNoDir } = DETAIL;
    const { dir: _dir2, ...counterNoDir } = COUNTER;
    expect(isValidShardRow(detailNoDir)).toBe(true);
    expect(isValidShardRow(counterNoDir)).toBe(true);
  });

  it("未识别目录桶键（TREND_UNIDENTIFIED 形态）在 detail/counter/dir 上都合法", () => {
    expect(isValidShardRow(row(DETAIL, { dir: "(unidentified)" }))).toBe(true);
    expect(isValidShardRow(row(COUNTER, { dir: "(unidentified)" }))).toBe(true);
    expect(isValidShardRow(row(DIR, { dir: "(unidentified)" }))).toBe(true);
  });

  it("未知键不参与校验（无键白名单遍历，历史行上的扩展字段原样读回）", () => {
    for (const valid of Object.values(BY_KIND)) {
      expect(isValidShardRow(row(valid, { futureField: "x" }))).toBe(true);
    }
  });

  it("null token 是合法计量（零 usage 记 null 而非 0）", () => {
    const nulls: Row = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    };
    expect(isValidShardRow(row(AGG, nulls))).toBe(true);
    expect(isValidShardRow(row(DIR, nulls))).toBe(true);
    expect(isValidShardRow(row(HOUR, nulls))).toBe(true);
  });
});
