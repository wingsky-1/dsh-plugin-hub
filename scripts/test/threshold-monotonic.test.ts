#!/usr/bin/env node
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  COVERAGE_THRESHOLD_KEYS,
  parseCoverageConfigThresholds,
  parseCoverageThresholds,
  runThresholdMonotonic,
} from "../gate/threshold-monotonic.mjs";

const ROOT = join(import.meta.dirname, "../..");

/** 构造一个带基线 commit 的临时 git 仓库；返回其路径与 git 调用器。 */
function gitFixture(
  baseVitestConfig,
  baseGauntlet = { mutation: { packages: { "dsh-x": { threshold: 60 } } } },
) {
  const dir = mkdtempSync(join(tmpdir(), "threshold-monotonic-test-"));
  mkdirSync(join(dir, "scripts/data"), { recursive: true });
  writeFileSync(join(dir, "scripts/data/gauntlet.config.json"), JSON.stringify(baseGauntlet));
  writeFileSync(join(dir, "vitest.config.ts"), baseVitestConfig);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

/** 生成仅 lines 不同的 vitest.config.ts 文本。 */
const vitestText = (lines) =>
  `export default { test: { coverage: { thresholds: { lines: ${lines}, functions: 80, statements: 78, branches: 70 } } } }\n`;

test("parseCoverageThresholds: 提取 thresholds 块内的四个数值", () => {
  const text = [
    "coverage: {",
    '  provider: "istanbul",',
    "  thresholds: {",
    "    lines: 80,",
    "    functions: 80,",
    "    statements: 78,",
    "    branches: 70,",
    "  },",
    "},",
  ].join("\n");
  assert.deepEqual(parseCoverageThresholds(text).global, {
    lines: 80,
    functions: 80,
    statements: 78,
    branches: 70,
  });
});

test("parseCoverageThresholds: 无 thresholds 块返回 null（与「阈值为 0」区分）", () => {
  assert.equal(parseCoverageThresholds("export default { test: {} }"), null);
  assert.equal(parseCoverageThresholds(""), null);
});

test("parseCoverageThresholds: 小数阈值与部分键可用", () => {
  assert.deepEqual(parseCoverageThresholds("thresholds: { lines: 79.5 }").global, { lines: 79.5 });
});

test("#733 3.4: 真实 coverage.config.json 必须声明 coverage 阈值四键且为数字", () => {
  // 事实源自 #733 计划项 3.4 起从 vitest.config.ts 迁到 scripts/data/coverage.config.json；
  // 断言强度不变（四键必须存在且为数字），只是换了读的地方——同一条不变量不该因为搬家而消失。
  const thresholds = parseCoverageConfigThresholds(
    readFileSync(join(ROOT, "scripts/data/coverage.config.json"), "utf8"),
  );
  assert.ok(
    thresholds,
    "coverage.config.json 缺少 thresholds —— 覆盖率硬门禁的唯一事实源，不得缺失",
  );
  for (const key of COVERAGE_THRESHOLD_KEYS) {
    assert.equal(
      typeof thresholds.global[key],
      "number",
      `thresholds.${key} 必须是数字（提取失败或写成了表达式）`,
    );
  }
});

test("#733 3.4: vitest.config.ts 不得再内联 coverage 阈值（否则两个事实源）", () => {
  const text = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const block = /\bcoverage\s*:\s*\{[\s\S]*/.exec(text)?.[0] ?? "";
  assert.ok(block.length > 0, "vitest.config.ts 应有 coverage 块");
  assert.ok(
    !/thresholds\s*:\s*\{/.test(block),
    "coverage 块内不得再出现 thresholds 对象字面量——它属 scripts/data/coverage.config.json",
  );
});

test("#722: 覆盖率阈值降线判红（基准 80 → 工作区 70）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, "vitest.config.ts"), vitestText(70));
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 1, "阈值下调必须判红（须原 issue 内 approved）");
    assert.equal(r.failures, 1, "应恰好点名一处降线");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#722: 覆盖率阈值上调放行（基准 80 → 工作区 85）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, "vitest.config.ts"), vitestText(85));
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 0, "阈值上调是收紧，必须放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#722: 基准尚无 thresholds 时跳过对比并放行（首次引入）", () => {
  const dir = gitFixture("export default { test: {} }\n");
  try {
    writeFileSync(join(dir, "vitest.config.ts"), vitestText(80));
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 0, "基准无该块属首次引入，无从对比应放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#722: 工作区缺 thresholds 判红（fail-closed，防门禁被静默摘除）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, "vitest.config.ts"), "export default { test: {} }\n");
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 2, "阈值块整体消失不是「降线」而是配置错误，须 fail-closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 把 vitest.config.ts 写成指定 thresholds 字面量文本（片段或整份文件均可）。 */
const configWith = (thresholds) =>
  `export default { test: { coverage: { thresholds: ${thresholds} } } }\n`;

test("#733: 分包 glob 键在前时不得顶掉全局键——glob 高值 + 全局降线必须判红", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(
      join(dir, "vitest.config.ts"),
      configWith(
        "{ 'packages/x/src/**': { lines: 92 }, lines: 70, functions: 80, statements: 78, branches: 70 }",
      ),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 1, "旧正则会采信 glob 内的 lines:92 而放行真实的 80→70 降线");
    assert.equal(r.failures, 1, "应恰好点名全局 lines 这一处降线");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733: glob 键在后时全局四键仍完整解析，glob 被登记为 scoped", () => {
  const parsed = parseCoverageThresholds(
    "thresholds: { lines: 80, functions: 80, statements: 78, branches: 70, 'packages/x/**': { lines: 92 } }",
  );
  assert.deepEqual(parsed.global, { lines: 80, functions: 80, statements: 78, branches: 70 });
  assert.deepEqual(parsed.scoped, ["packages/x/**"]);
});

test("#733: 只剩 glob 键（无任何全局键）判红——全局硬门禁被摘除", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, "vitest.config.ts"), configWith("{ 'packages/x/**': { lines: 92 } }"));
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 2, "全局键全缺属配置错误，须 fail-closed 而非放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733: 块内注释里的伪值与闭括号不得被采信", () => {
  const parsed = parseCoverageThresholds(
    "thresholds: {\n  // lines: 999 } 注释里的闭括号\n  /* } lines: 888 */\n  lines: 80, functions: 80, statements: 78, branches: 70,\n}",
  );
  assert.equal(
    parsed.global.lines,
    80,
    "注释里的 lines:999 不得覆盖真实值，且注释里的 } 不得提前截断块",
  );
  assert.deepEqual(parsed.scoped, [], "注释不得产生幻影 glob 键");
});

test("#733: 阈值键被移除与降线同罪——基准 lines:80、工作区删掉该键判红", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(
      join(dir, "vitest.config.ts"),
      configWith("{ functions: 80, statements: 78, branches: 70 }"),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 1, "删键等价于摘除该维度的硬门禁，不得静默放行");
    assert.equal(r.failures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733: perFile 一类非阈值选项被忽略，不误判为 scoped", () => {
  const parsed = parseCoverageThresholds("thresholds: { perFile: true, lines: 80 }");
  assert.deepEqual(parsed.global, { lines: 80 });
  assert.deepEqual(parsed.scoped, []);
});

// ── #764 落地项 A2：lint 警告预算的单调性（同一份 gauntlet 事实源，同一套只许降治理）──

const gauntletWith = (budget) => ({
  mutation: { packages: { "dsh-x": { threshold: 60 } } },
  ...(budget === null ? {} : { lint: { maxWarnings: budget } }),
});

test("#764 A2: lint.maxWarnings 上调判红（预算只许降）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeFileSync(
      join(dir, "scripts/data/gauntlet.config.json"),
      JSON.stringify(gauntletWith(700)),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 1, "671 → 700 属放宽，必须判红");
    assert.equal(r.failures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#764 A2: lint.maxWarnings 删键判红（等价于摘除预算）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeFileSync(
      join(dir, "scripts/data/gauntlet.config.json"),
      JSON.stringify(gauntletWith(null)),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 1, "删键后 lint.mjs 会 fail-closed，但阈值层面也必须显式拦一次");
    assert.equal(r.failures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#764 A2: lint.maxWarnings 下调放行（收紧方向正确）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeFileSync(
      join(dir, "scripts/data/gauntlet.config.json"),
      JSON.stringify(gauntletWith(600)),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 0, "收紧不得被拦（否则棘轮会锁死存量清理）");
    assert.equal(r.failures, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#764 A2: 首次引入 lint.maxWarnings（基准无该键）放行，不得误判为降线", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(
      join(dir, "scripts/data/gauntlet.config.json"),
      JSON.stringify(gauntletWith(671)),
    );
    const r = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    assert.equal(r.exitCode, 0, "基准侧没有该键 = 首次引入，不是「降线」");
    assert.equal(r.failures, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
