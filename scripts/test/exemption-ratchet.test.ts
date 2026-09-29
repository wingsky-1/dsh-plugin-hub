#!/usr/bin/env node
/**
 * exemption-ratchet 自测：分桶只减棘轮的两条判据（常量 == 当下计数、不得比基准多）。
 *
 * 反证优先：这三条通道——「新增一条不改常量」「收口一条不下调常量」「新增一条并上调常量」——
 * 任何一条漏掉，棘轮就退化成一句口号，故每条都配一个必红的用例。
 *
 * 真值快照的计数**在本文件内独立重数**，不调 `lib/exemption-ratchet.ts` 的 `countDeferralNodes`：
 * 用被测实现验证被测实现就是「比较器自我验证」，削弱计数逻辑时会一并失明（data/threshold-registry.json
 * note 自承的同型上限）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RATCHET_BUCKETS,
  bucketSourceState,
  countDeferralNodes,
  ratchetProblems,
} from "../lib/exemption-ratchet.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** 独立重数：带 reviewBy 或 exitCriteria 的对象数。与被测实现同形但不同实现。 */
function recount(node: unknown): number {
  if (Array.isArray(node)) return node.map(recount).reduce((a, b) => a + b, 0);
  if (node === null || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  const own =
    typeof record.reviewBy === "string" || typeof record.exitCriteria === "string" ? 1 : 0;
  return (
    Object.values(record)
      .map(recount)
      .reduce((a, b) => a + b, 0) + own
  );
}

const bucket = (file: string, ceiling: number) => ({ file, ceiling, note: "test" });

test("反证：新增一条待办而常量不动 → 判红（等式与基准比各点一次）", () => {
  const b = bucket("scripts/data/x.json", 3);
  const problems = ratchetProblems(b, 4, 3);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /待办 4 条 > 上限常量 3/);
  assert.match(problems[0], /不能靠上调常量合法化/);
  assert.match(problems[1], /比基准（3 条）多了 1 条/);
});

test("反证：收口一条而常量不下调 → 判红（迁移是机器检查，不靠人记得改常量）", () => {
  const problems = ratchetProblems(bucket("scripts/data/x.json", 3), 2, 3);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /待办 2 条 < 上限常量 3/);
  assert.match(problems[0], /请在本 PR 把常量下调到 2/);
});

test("反证：新增一条并把常量同步上调 → 仍判红（等式成立，靠基准比兜住）", () => {
  // 这是唯一「看起来完全自洽」的抬价手法：数据 +1、常量 +1，等式成立。
  const problems = ratchetProblems(bucket("scripts/data/x.json", 4), 4, 3);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /比基准（3 条）多了 1 条/);
});

test("桶收到 0 后新增一条 → 判红（0 自动成为该桶的硬判红，无需另设守卫）", () => {
  const problems = ratchetProblems(bucket("scripts/data/x.json", 0), 1, 0);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /待办 1 条 > 上限常量 0/);
  assert.match(problems[1], /比基准（0 条）多了 1 条/);
  // 桶在 0 且无新增：无判词（这正是「目标 0」在代码里的落点）
  assert.deepEqual(ratchetProblems(bucket("scripts/data/x.json", 0), 0, 0), []);
});

test("跨桶抵消无效：桶 A 涨 1、桶 B 跌 1，各自单独判红（分桶的核心价值）", () => {
  // 总数持平（15 → 15）骗不过任一桶的等式：A 桶 15 > 14 判红，B 桶 0 < 1 也判红。
  const a = ratchetProblems(bucket("scripts/data/a.json", 14), 15, 14);
  const b = ratchetProblems(bucket("scripts/data/b.json", 1), 0, 1);
  assert.ok(a.length > 0 && b.length > 0, "两个桶都必须各自判红");
  assert.equal(a.length + b.length, 3);
});

test("计数：数组 / 嵌套 / 非对象都算，父与子各自成条", () => {
  assert.equal(
    countDeferralNodes({ a: [{ reviewBy: "2027-01-01" }], b: { exitCriteria: "x" } }),
    2,
  );
  assert.equal(countDeferralNodes({ outer: { inner: { reviewBy: "2027-01-01" } } }), 1);
  assert.equal(countDeferralNodes(["x", 3, null, { no: "fields" }]), 0);
  // 空字符串**算**信号：与台账收集器同形（typeof === "string"），偏保守的一侧（多算 → 判红 → 安全）。
  // 真出现空串时另有判词：verify-coverage-scope 判据② 要求 pending-project 的字段非空。
  assert.equal(countDeferralNodes({ reviewBy: "" }), 1);
});

test("真值快照：本仓三桶的待办数与代码常量一致（独立重数，不调被测计数）", () => {
  const expected: Record<string, number> = {
    // 6 → 5：删掉 mcp-manager 客户端 float/float.ts 那条（本行是**独立重数**
    // 的对照值，与 RATCHET_BUCKETS 的 ceiling 各钉一次；两边必须同 PR 更新。
    "scripts/data/coverage.config.json": 5,
    "scripts/data/gate-exemptions.json": 1,
    "scripts/data/gauntlet.config.json": 1,
  };
  assert.equal(RATCHET_BUCKETS.length, Object.keys(expected).length);
  for (const b of RATCHET_BUCKETS) {
    const json = JSON.parse(readFileSync(join(ROOT, b.file), "utf8")) as unknown;
    const actual = recount(json);
    assert.equal(actual, expected[b.file], `${b.file} 的待办数变了：常量与真值都要在本 PR 更新`);
    assert.equal(b.ceiling, actual, `${b.file} 的上限常量必须等于当下计数`);
    assert.deepEqual(ratchetProblems(b, actual, actual), [], `${b.file} 不该有判词`);
  }
});

test("事实源存在状态：三态各自的后果（删文件不得等于「该桶已收口」）", () => {
  assert.equal(bucketSourceState(true, true), "apply");
  assert.equal(bucketSourceState(true, false), "apply", "新事实源：按基准 0 计，仍要判");
  assert.equal(bucketSourceState(false, false), "vacuous", "两侧都没有 → 本仓没这个面");
  assert.equal(bucketSourceState(false, true), "deleted", "基准有、工作区无 → 事实源被删除");
});

test("常量表本身：三桶互不相同，且不含任何 by-design 的结构性 kind", () => {
  const files = RATCHET_BUCKETS.map((b) => b.file);
  assert.equal(new Set(files).size, files.length, "桶不得重复（重复即给抵消留后门）");
  for (const b of RATCHET_BUCKETS) {
    assert.ok(b.ceiling >= 0 && Number.isInteger(b.ceiling), "上限必须是非负整数");
    assert.ok(b.note.length > 0, "每个桶都要说清在等什么收口");
  }
});
