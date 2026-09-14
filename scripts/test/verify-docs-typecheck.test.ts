#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * scripts 编译面接线器（issue #474 起，issue #776 批 3 改为程序覆盖断言）。
 *
 * 为什么存在：scripts/tsconfig.json 是 scripts/ 唯一的 strict 编译面，但 pnpm typecheck 是
 * `pnpm -r --if-present run typecheck`（只进各包，不进根 scripts/），pnpm build/test 也编
 * 译不到它——若只靠直跑（Node type-stripping 擦除类型断言），strict 类型面是「假锁」。
 * 本接线器 spawn 仓库 tsc 真实编译 scripts/tsconfig.json，tsc 非 0 → 本测试红，随
 * `pnpm test:scripts` 执行。
 *
 * 为什么断言程序集而不是 tsconfig 文本（#776 批 3）：include 由逐项枚举改为 glob 后，
 * 「文本里有某个条目」不再等价于「该文件真在编译面内」；且 tsc 对 include/exclude 漏掉
 * 具体文件静默绿（只有 include 全空才配置级报错），文本正则既漏检又易假绿。故改为对账
 * 两侧真实集合：磁盘上 scripts/ 下全部 .ts/.mts/.cts 减去 tsc --listFiles 报出的程序文件集，
 * 差额必须逐一等于 EXPECTED_TEMPORARY_EXCLUSIONS（显式清单，不写通配）。
 *
 * 为何自身仍带 @ts-nocheck（#474 R4 预防性声明）：本文件只 spawn tsc 子进程并读它的输出，
 * 不 import 被测物的类型（walk-files.ts 仅作运行时遍历工具），纳入 strict 面无检查增量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkFiles } from "../lib/walk-files.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "scripts");
// tsc 真实 JS 入口：严禁 spawn node_modules/.bin/tsc（shell shim，经 node
// 执行报 ERR_UNKNOWN_FILE_EXTENSION；#476 接线器同款先例注释）。
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const TSCONFIG = join(SCRIPTS, "tsconfig.json");

/**
 * 编译面外的 scripts 文件全集（仓库根相对、/ 分隔）。本批只开非 test 全树，
 * scripts/test/** 的类型错误留待后续批次，故这里逐一登记当前被暂时排除的测试文件。
 *
 * 这是棘轮而非快照：新增一个 test 文件就会使「磁盘 - 程序」多出一项并判红，必须显式
 * 追加到本清单——排除面只能被有意识地扩大，不会被静默顺延。
 */
const EXPECTED_TEMPORARY_EXCLUSIONS = [
  "scripts/test/baseline-archive.test.ts",
  "scripts/test/build-client.test.ts",
  "scripts/test/bundle-host-x1.test.ts",
  "scripts/test/catalog-peers.test.ts",
  "scripts/test/changed-test-packages.test.ts",
  "scripts/test/ci-face-coverage.test.ts",
  "scripts/test/ci-matrix.test.ts",
  "scripts/test/client-leak-gate.test.ts",
  "scripts/test/collect-exemptions.test.ts",
  "scripts/test/collect-licenses.test.ts",
  "scripts/test/config-matrix-extractor.test.ts",
  "scripts/test/config-matrix-negative.test.ts",
  "scripts/test/crap-check-diff.test.ts",
  "scripts/test/crap-check.test.ts",
  "scripts/test/dts-cordis-merge-lib.test.ts",
  "scripts/test/export-faces-admission.test.ts",
  "scripts/test/forbid-homedir-src.test.ts",
  "scripts/test/forbid-module-state-src.test.ts",
  "scripts/test/gate-scope-registry.test.ts",
  "scripts/test/lint-toolchain.test.ts",
  "scripts/test/local-gate-steps.test.ts",
  "scripts/test/local-scope.test.ts",
  "scripts/test/mutation-ledger.test.ts",
  "scripts/test/mutation-plan.test.ts",
  "scripts/test/mutation-topology-coverage.test.ts",
  "scripts/test/orphan-baseline.test.ts",
  "scripts/test/package-scope.test.ts",
  "scripts/test/pack-check-exports-types.test.ts",
  "scripts/test/pack-check-scope.test.ts",
  "scripts/test/plugins-manifest.test.ts",
  "scripts/test/repair-mcp-catalog-sessions.test.ts",
  "scripts/test/service-contract-wiring.test.ts",
  "scripts/test/shared-client-ensure-style.test.ts",
  "scripts/test/shared-client-i18n.test.ts",
  "scripts/test/shared-dsh-home.test.ts",
  "scripts/test/shared-dts.test.ts",
  "scripts/test/shared-host-utils-guard.test.ts",
  "scripts/test/shared-host-utils.test.ts",
  "scripts/test/stryker-conf-layers.test.ts",
  "scripts/test/surface-extract-lib.test.ts",
  "scripts/test/threshold-monotonic.test.ts",
  "scripts/test/vendored-binaries.test.ts",
  "scripts/test/verify-coverage-scope.test.ts",
  "scripts/test/verify-dir-imports-cycle.test.ts",
  "scripts/test/verify-dir-imports-s0.test.ts",
  "scripts/test/verify-docs-agent-docs.test.ts",
  "scripts/test/verify-docs-typecheck.test.ts",
  "scripts/test/verify-scripts-index.test.ts",
  "scripts/test/workflow-assert.test.ts",
];

const isTypeScript = (name) => /\.(ts|mts|cts)$/.test(name);
const toPosix = (p) => p.split(sep).join("/");

test("scripts 编译面接线：非 test 全树入面，排除集与 tsc 程序集双向对账（#474/#776）", () => {
  assert.ok(existsSync(TSC), `仓库 tsc 应存在（${TSC}）——pnpm install 后才有`);
  assert.ok(existsSync(TSCONFIG), `scripts/tsconfig.json 应存在（${TSCONFIG}）`);

  const result = spawnSync(process.execPath, [TSC, "-p", TSCONFIG, "--noEmit", "--listFiles"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.strictEqual(
    result.status,
    0,
    `tsc 编译 scripts/tsconfig.json 失败（exit=${result.status}）——编译面类型漂移？\n${result.stdout}\n${result.stderr}`,
  );

  // --listFiles 逐行输出程序文件的绝对路径；只取 scripts/ 下的 TS 源文件。
  const program = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(SCRIPTS + sep) && isTypeScript(line))
      .map((line) => toPosix(relative(ROOT, line))),
  );
  assert.ok(
    program.size > 0,
    `tsc --listFiles 未解析出任何 scripts/ 程序文件——输出格式变了？\n${result.stdout}`,
  );

  // 磁盘侧不做任何排除：程序集的补集即为「被漏在面外」的文件。
  const onDisk = walkFiles(SCRIPTS, isTypeScript).map((rel) => `scripts/${rel}`);
  const missingFromProgram = onDisk.filter((rel) => !program.has(rel)).sort();

  assert.deepStrictEqual(
    missingFromProgram,
    [...EXPECTED_TEMPORARY_EXCLUSIONS].sort(),
    "编译面外的 scripts 文件集合与 EXPECTED_TEMPORARY_EXCLUSIONS 不一致：漏面或新增未登记（tsc 对漏文件静默绿，必须在此判红）",
  );

  // 双向断言：常量不得写成空集/陈旧集造成假绿——每一项都必须真实存在于磁盘，
  // 且确实不在 tsc 程序集里（既不能漏登记，也不能登记已被覆盖的文件）。
  for (const rel of EXPECTED_TEMPORARY_EXCLUSIONS) {
    assert.ok(
      onDisk.includes(rel),
      `${rel} 登记在 EXPECTED_TEMPORARY_EXCLUSIONS 但磁盘上不存在（陈旧条目）`,
    );
    assert.ok(!program.has(rel), `${rel} 已在 tsc 程序集内却仍登记为排除项（假绿）`);
  }
});
