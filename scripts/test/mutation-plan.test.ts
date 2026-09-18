#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * 夜间变异矩阵的段清单与逐段超时派生回归（#718 S1.1 / S1.4）。
 *
 * 为什么需要它：矩阵的段清单与每段超时都直接决定「哪些变异会跑」「跑多久算擦边」——
 * 前者漏段 = 包级变异率静默偏低（mutation-gate 按 mutant id 去重聚合，遗漏偏低），
 * 后者取错口径 = 长段在正常抖动下被误杀（用增量实测定全量超时就属此类，实测同段
 * 全量可达增量的数倍）。故这里锁死四条：
 *   1. 段清单口径与 ci-matrix / mutation-gate 同源（dsh- 前缀 + .json，去后缀）；
 *   2. 超时只认 `scope=full` 的实测（增量值不得参与定标）；
 *   3. 超时公式与下限不被静默放宽（下限 #718 整合版规定 10 分钟，实测证明不足，
 *      故 `TIMEOUT_FLOOR_MINUTES` 取 30——抬高不违反「最小值要求」，见 mutation-plan.mjs）；
 *   4. 无实测的段必须落到保守默认值，而不是 0 或继承别的段的值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_TIMEOUT_MINUTES,
  SETUP_OVERHEAD_MINUTES,
  SAFETY_FACTOR,
  TIMEOUT_FLOOR_MINUTES,
  buildShardMatrix,
  fullScopePeaks,
  listSegments,
  timeoutForSegment,
} from "../gate/mutation-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "mutation-plan.mjs");

test("段清单：只认 dsh-*.json 且去后缀，与 ci-matrix / mutation-gate 同源口径", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutation-plan-"));
  try {
    for (const f of ["dsh-b-z.json", "dsh-a.json", "README.md", "not-dsh-c.json"]) {
      writeFileSync(join(dir, f), "{}");
    }
    assert.deepEqual(listSegments(dir), ["dsh-a", "dsh-b-z"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("段清单：目录为空时返回空数组（由调用方 fail-closed，不在此吞掉）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutation-plan-"));
  try {
    assert.deepEqual(listSegments(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超时定标只用 scope=full 的实测：增量值不得参与（同段全量可达增量的数倍）", () => {
  const peaks = fullScopePeaks({
    measurements: [
      { scope: "incremental", segments: [{ seg: "s1", wallSeconds: 3600 }] },
      { scope: "full", segments: [{ seg: "s1", wallSeconds: 600 }] },
    ],
  });
  assert.equal(peaks.get("s1"), 600, "必须取 full 口径的值，忽略更大的 incremental 值");
});

test("超时定标：同一段多次 full 测量取最大值（不得取平均或首次）", () => {
  const peaks = fullScopePeaks({
    measurements: [
      { scope: "full", segments: [{ seg: "s1", wallSeconds: 600 }] },
      { scope: "full", segments: [{ seg: "s1", wallSeconds: 900 }] },
    ],
  });
  assert.equal(peaks.get("s1"), 900);
});

test("超时公式：实测 × 安全系数 + 构建开销，且不低于下限", () => {
  const peaks = new Map([
    ["big", 21.2 * 60],
    ["tiny", 20],
  ]);
  // 21.2 min × 1.5 + 4 = 35.8 → 36
  assert.equal(
    timeoutForSegment("big", peaks),
    Math.ceil(21.2 * SAFETY_FACTOR + SETUP_OVERHEAD_MINUTES),
  );
  // 20 s × 1.5 + 4 = 4.5 → 5，但下限（TIMEOUT_FLOOR_MINUTES）生效
  assert.equal(timeoutForSegment("tiny", peaks), TIMEOUT_FLOOR_MINUTES);
  assert.ok(SAFETY_FACTOR > 1, "安全系数必须 > 1（大于 1 才是余量）");
});

test("超时：无实测的段取保守默认，不得取 0 或继承他段值", () => {
  const peaks = new Map([["known", 600]]);
  assert.equal(timeoutForSegment("unknown", peaks), DEFAULT_TIMEOUT_MINUTES);
  assert.ok(DEFAULT_TIMEOUT_MINUTES >= TIMEOUT_FLOOR_MINUTES, "保守默认不得低于下限");
});

test("矩阵顺序：按估计耗时降序（长段先跑 = LPT），无实测段按默认超时反推参与排序", () => {
  // 判据刻意不是「顺序 == 传入顺序」（那对字典序与降序都成立，等于没判）：排序的唯一依据是
  // 台账派生出的估计耗时，传入顺序不得影响结果。
  const peaks = new Map([
    ["short", 60],
    ["long", 1200],
  ]);
  const expectOrder = ["long", "unknown", "short"]; // 1200 > 反推估计 1040 > 60
  assert.deepEqual(
    buildShardMatrix(["short", "unknown", "long"], peaks).map((x) => x.seg),
    expectOrder,
    "长段先跑（LPT）；无实测段按 (默认超时-构建开销)/安全系数 反推后参与排序",
  );
  assert.deepEqual(
    buildShardMatrix(["long", "short", "unknown"], peaks).map((x) => x.seg),
    expectOrder,
    "同一份台账必须派生出同一份 matrix（传入顺序无关）",
  );
  assert.deepEqual(
    buildShardMatrix(
      ["bbb", "aaa"],
      new Map([
        ["aaa", 600],
        ["bbb", 600],
      ]),
    ).map((x) => x.seg),
    ["aaa", "bbb"],
    "估计值相同时按段名升序（保证可复现）",
  );
  for (const x of buildShardMatrix(["short", "unknown", "long"], peaks))
    assert.ok(Number.isInteger(x.timeoutMinutes) && x.timeoutMinutes >= TIMEOUT_FLOOR_MINUTES);
});

test("真实仓库：段清单与 stryker.conf.d 文件集精确一致（漏段即判红）", () => {
  const confFiles = readdirSync(join(ROOT, "stryker.conf.d"))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const expected = confFiles.map((f) => f.slice(0, -".json".length));
  assert.deepEqual(
    listSegments(join(ROOT, "stryker.conf.d")),
    expected,
    "mutation-plan 的段清单必须与 stryker.conf.d 文件集一一对应",
  );
});

test("真实仓库：入库台账的 full 测量值确实被超时派生消费（逐段验证公式关系）", () => {
  const ledger = JSON.parse(
    readFileSync(join(ROOT, "scripts", "data", "mutation-segment-ledger.json"), "utf8"),
  );
  const peaks = fullScopePeaks(ledger);
  const matrix = buildShardMatrix(listSegments(join(ROOT, "stryker.conf.d")), peaks);
  // 逐段重算期望值并与矩阵比对，而不是用「值 ≠ 默认常量」间接判断：
  // 实测值恰好使 ceil(实测×系数+开销) 等于默认值时，那种间接判据会误报「派生链断了」。
  for (const m of matrix) {
    const measured = peaks.get(m.seg);
    const expected =
      measured === undefined
        ? DEFAULT_TIMEOUT_MINUTES
        : Math.max(
            TIMEOUT_FLOOR_MINUTES,
            Math.ceil((measured / 60) * SAFETY_FACTOR + SETUP_OVERHEAD_MINUTES),
          );
    assert.equal(
      m.timeoutMinutes,
      expected,
      `${m.seg} 的超时派生与公式不符（full 实测 ${measured ?? "无"} s）`,
    );
  }
  assert.ok(matrix.length > 0, "矩阵非空");
});

/**
 * main 直调探针：failClosed 会 exit 掉调用方，故经子进程调导出的 main。
 * CLI 入口仍只能对真仓求值（路径注入只存在于函数参数，不存在 env/argv 面）。
 */
function mainProbe(args) {
  const dir = mkdtempSync(join(tmpdir(), "plan-probe-"));
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import { main } from ${JSON.stringify(join(ROOT, "scripts/gate/mutation-plan.mjs"))};\n` +
      `process.exitCode = main(${JSON.stringify(args)});\n`,
  );
  try {
    return spawnSync(process.execPath, [probe], { cwd: ROOT, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fail-closed：空段集 → exit 2 且统一故障注解（注入空目录，真仓不动）", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-empty-"));
  try {
    const r = mainProbe({ confDir: dir });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^::error::门禁故障（非判据结论）：\[mutation-plan\].*段集合为空/m);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-closed：台账不可解析 → exit 2 且统一故障注解（注入坏台账，真仓不动）", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-badledger-"));
  try {
    writeFileSync(join(dir, "dsh-x.json"), "{}");
    const badLedger = join(dir, "ledger.json");
    writeFileSync(badLedger, "{ broken");
    const r = mainProbe({ confDir: dir, ledgerPath: badLedger });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^::error::门禁故障（非判据结论）：\[mutation-plan\] 台账不可解析/m);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 三态：真仓矩阵派生 exit 0 且无故障注解（shards 经隔离 GITHUB_OUTPUT）", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutation-plan-"));
  const outFile = join(dir, "github-output");
  writeFileSync(outFile, "");
  try {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outFile },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /::error::门禁故障/);
    assert.match(readFileSync(outFile, "utf8"), /^shards=\[/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
