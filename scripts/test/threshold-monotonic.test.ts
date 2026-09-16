#!/usr/bin/env node
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  COVERAGE_THRESHOLD_KEYS,
  parseCoverageThresholds,
  runThresholdMonotonic,
} from "../gate/threshold-monotonic.mjs";
import { resolveSingle } from "../lib/threshold-registry.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/gate/threshold-monotonic.mjs");
const GAUNTLET = "scripts/data/gauntlet.config.json";
const COVERAGE_CONFIG = "scripts/data/coverage.config.json";
const TOPOLOGY = "scripts/data/mutation-topology.json";
const WIRING = "scripts/data/gate-wiring-exceptions.json";
const LEDGER = "scripts/data/gate-exemptions.json";
const REGISTRY = "scripts/data/threshold-registry.json";
const VITEST = "vitest.config.ts";

/**
 * fixture 自带一份**最小声明表**：判据要跑的正是真值声明表的同一套代码路径，所以 fixture 不能没有表，
 * 但也不能照抄整份（真值表里多数事实源在 fixture 里不存在，会撞「悬空声明」而红）。
 * 真值表的自洽性与真值判据由文件末尾的「本仓真值快照」覆盖。
 */
const guard = (fields) => ({ why: "fixture 判据说明", hint: "fixture 修法提示", ...fields });

const COVERAGE_GUARD = guard({
  id: "coverage.thresholds",
  kind: "value",
  sources: [COVERAGE_CONFIG, VITEST],
  paths: ["thresholds"],
  keys: COVERAGE_THRESHOLD_KEYS,
  weaken: "decrease",
  onRemoval: "fail",
  missingIsError: true,
});
const THRESHOLD_GUARD = guard({
  id: "mutation.packageThreshold",
  kind: "value",
  sources: [GAUNTLET],
  paths: ["mutation.packages.*.threshold"],
  weaken: "decrease",
  onRemoval: "fail",
});
const STRICT_GUARD = guard({
  id: "mutation.strict",
  kind: "boolean",
  sources: [GAUNTLET],
  paths: ["mutation.strict"],
  weakenValue: false,
  onRemoval: "fail",
});
const ANCHOR_GUARD = guard({
  id: "mutation.packageAnchor",
  kind: "baseline",
  sources: [GAUNTLET],
  paths: ["mutation.packages"],
  anchorFields: ["fixedCovered", "baselineCovered"],
  onRemoval: "fail",
});
const EXISTENCE_GUARD = guard({
  id: "mutation.packageSet",
  kind: "existence",
  sources: [GAUNTLET],
  paths: ["mutation.packages"],
  universe: { dir: "packages", prefix: "dsh-", requireDir: "src" },
  exemptFrom: { source: TOPOLOGY, path: "$noMutationPackages" },
  requireFields: ["fixedCovered", "baselineCovered"],
  exemptionGate: "threshold-registry",
});
const COMPLEXITY_GUARD = guard({
  id: "complexity.cyclomatic",
  kind: "value",
  sources: [GAUNTLET],
  paths: ["complexity.cyclomatic"],
  weaken: "increase",
  onRemoval: "fail",
});
const CRAP_GUARD = guard({
  id: "crap.threshold",
  kind: "value",
  sources: [GAUNTLET],
  paths: ["crap.threshold"],
  weaken: "increase",
  onRemoval: "fail",
});
const LINT_GUARD = guard({
  id: "lint.maxWarnings",
  kind: "value",
  sources: [GAUNTLET],
  paths: ["lint.maxWarnings"],
  weaken: "increase",
  onRemoval: "fail",
});
const TIMEOUT_GUARD = guard({
  id: "mutation.timeoutMS",
  kind: "value",
  sources: [TOPOLOGY],
  paths: ["sharedDefaults.timeoutMS", "packages.*.timeoutMS"],
  weaken: "increase",
  onRemoval: "fail",
  nonMonotonic: true,
});
const BUDGET_GUARD = guard({
  id: "gateWiring.budgets",
  kind: "value",
  sources: [WIRING],
  paths: ["maxExceptions", "maxJobFaces"],
  weaken: "increase",
  onRemoval: "fail",
});

const BASE_GUARDS = [
  COVERAGE_GUARD,
  THRESHOLD_GUARD,
  STRICT_GUARD,
  ANCHOR_GUARD,
  EXISTENCE_GUARD,
  COMPLEXITY_GUARD,
  CRAP_GUARD,
  LINT_GUARD,
];

const defaultGauntlet = () => ({
  mutation: { strict: true, packages: { "dsh-x": { threshold: 60, fixedCovered: 70 } } },
  complexity: { cyclomatic: 78, cognitive: 84 },
  crap: { threshold: 16, strict: false },
  lint: { maxWarnings: 671 },
});

function writeFixtureFile(dir, rel, content) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** 构造一个带基线 commit 的临时 git 仓库；返回其路径。 */
function gitFixture(baseVitestConfig, baseGauntlet = defaultGauntlet(), options = {}) {
  const { guards = BASE_GUARDS, extraFiles = {}, notAGate = [] } = options;
  const dir = mkdtempSync(join(tmpdir(), "threshold-monotonic-test-"));
  writeFixtureFile(dir, GAUNTLET, JSON.stringify(baseGauntlet));
  writeFixtureFile(dir, VITEST, baseVitestConfig);
  writeFixtureFile(
    dir,
    REGISTRY,
    JSON.stringify({ version: 1, note: "fixture", guards, notAGate }, null, 2),
  );
  for (const [rel, content] of Object.entries(extraFiles)) writeFixtureFile(dir, rel, content);
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

function runFixture(dir) {
  return runThresholdMonotonic(["HEAD"], { repoRoot: dir });
}

function removeFixture(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 生成仅 lines 不同的 vitest.config.ts 文本。 */
const vitestText = (lines) =>
  `export default { test: { coverage: { thresholds: { lines: ${lines}, functions: 80, statements: 78, branches: 70 } } } }\n`;

function readGauntlet(dir) {
  return JSON.parse(readFileSync(join(dir, GAUNTLET), "utf8"));
}

function writeGauntlet(dir, value) {
  writeFileSync(join(dir, GAUNTLET), JSON.stringify(value));
}

/** 捕获 console.warn（非单调旋钮的收紧方向走 warning 通道，不进 exit code）。 */
function captureWarn(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.warn = original;
  }
}
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

test("#733: glob 键在后时全局四键仍完整解析，glob 被登记为 scoped", () => {
  const parsed = parseCoverageThresholds(
    "thresholds: { lines: 80, functions: 80, statements: 78, branches: 70, 'packages/x/**': { lines: 92 } }",
  );
  assert.deepEqual(parsed.global, { lines: 80, functions: 80, statements: 78, branches: 70 });
  assert.deepEqual(parsed.scoped, ["packages/x/**"]);
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

test("#733: perFile 一类非阈值选项被忽略，不误判为 scoped", () => {
  const parsed = parseCoverageThresholds("thresholds: { perFile: true, lines: 80 }");
  assert.deepEqual(parsed.global, { lines: 80 });
  assert.deepEqual(parsed.scoped, []);
});

test("#843 D5: 真实 coverage.config.json 的四个阈值键必须是数字（声明表的 keys 求值同口径）", () => {
  // 断言强度不变（四键必须存在且为数字），只是读法从「专用解析函数」换成声明表的通用求值——
  // 这条不变量不该因为换了实现形态而消失。
  const config = JSON.parse(readFileSync(join(ROOT, COVERAGE_CONFIG), "utf8"));
  for (const key of COVERAGE_THRESHOLD_KEYS) {
    assert.equal(
      typeof resolveSingle(config, "thresholds." + key),
      "number",
      `thresholds.${key} 必须是数字（缺失或写成表达式都会让覆盖率该维度失去硬门禁）`,
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

test("#843 D5: 本仓真值快照——声明表自洽（无未登记/幽灵声明/幽灵判据）且相对 HEAD 无放宽", () => {
  // 这一条同时是「声明表被自己守着」的证明：新数据文件没登记、声明了不存在的文件、
  // 或声明的路径在两侧都取不到值，都会在这里以 exit 2 暴露；而真值表里任一条判据被放宽则是 exit 1。
  const r = runThresholdMonotonic(["HEAD"], { repoRoot: ROOT });
  assert.equal(r.exitCode, 0, "真值声明表必须自洽，且工作区相对 HEAD 不得有放宽");
  assert.equal(r.failures, 0);
});

test("#843 D5: 未登记的新数据文件判红（枚举口径 = 运行时读 scripts/data/*.json）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFixtureFile(dir, "scripts/data/coverage-baseline.json", JSON.stringify({ lines: 90 }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "新事实源未声明必须 fail-closed，而不是静默不受守护");
  } finally {
    removeFixture(dir);
  }
});

test("#843 D5: 幽灵声明判红（声明了一个不存在的数据文件）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    notAGate: [{ source: "scripts/data/ghost.json", why: "fixture 故意悬空" }],
  });
  try {
    assert.equal(runFixture(dir).exitCode, 2, "悬空声明会在读者以为它受守护时给出假信心");
  } finally {
    removeFixture(dir);
  }
});

test("#843 D5: 幽灵判据判红（声明了路径但两侧都取不到值）", () => {
  const ghost = guard({
    id: "ghost.path",
    kind: "value",
    sources: [GAUNTLET],
    paths: ["mutation.notThere"],
    weaken: "increase",
    onRemoval: "fail",
  });
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { guards: [...BASE_GUARDS, ghost] });
  try {
    assert.equal(runFixture(dir).exitCode, 2, "声明了取不到值的路径等于一条永不生效的判据");
  } finally {
    removeFixture(dir);
  }
});

test("#843 D5: 声明表判红经由直调入口生效（spawn 真值脚本，不只看函数返回值）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFixtureFile(dir, "scripts/data/undeclared.json", "{}");
    const r = spawnSync(process.execPath, [SCRIPT, "HEAD"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /未在声明表登记/);
  } finally {
    removeFixture(dir);
  }
});
test("#722: 覆盖率阈值降线判红（基准 80 → 工作区 70）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, VITEST), vitestText(70));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "阈值下调必须判红（须原 issue 内 approved）");
    assert.equal(r.failures, 1, "应恰好点名一处降线");
  } finally {
    removeFixture(dir);
  }
});

test("#722: 覆盖率阈值上调放行（基准 80 → 工作区 85）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, VITEST), vitestText(85));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 0, "阈值上调是收紧，必须放行");
  } finally {
    removeFixture(dir);
  }
});

test("#722: 基准尚无 thresholds 时跳过对比并放行（首次引入）", () => {
  const dir = gitFixture("export default { test: {} }\n");
  try {
    writeFileSync(join(dir, VITEST), vitestText(80));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 0, "基准无该块属首次引入，无从对比应放行");
  } finally {
    removeFixture(dir);
  }
});

test("#722: 工作区缺 thresholds 判红（fail-closed，防门禁被静默摘除）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, VITEST), "export default { test: {} }\n");
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "阈值块整体消失不是「降线」而是配置错误，须 fail-closed");
  } finally {
    removeFixture(dir);
  }
});

/** 把 vitest.config.ts 写成指定 thresholds 字面量文本（片段或整份文件均可）。 */
const configWith = (thresholds) =>
  `export default { test: { coverage: { thresholds: ${thresholds} } } }\n`;

test("#733: 分包 glob 键在前时不得顶掉全局键——glob 高值 + 全局降线必须判红", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(
      join(dir, VITEST),
      configWith(
        "{ 'packages/x/src/**': { lines: 92 }, lines: 70, functions: 80, statements: 78, branches: 70 }",
      ),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "旧正则会采信 glob 内的 lines:92 而放行真实的 80→70 降线");
    assert.equal(r.failures, 1, "应恰好点名全局 lines 这一处降线");
  } finally {
    removeFixture(dir);
  }
});

test("#733: 只剩 glob 键（无任何全局键）判红——全局硬门禁被摘除", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, VITEST), configWith("{ 'packages/x/**': { lines: 92 } }"));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "全局键全缺属配置错误，须 fail-closed 而非放行");
  } finally {
    removeFixture(dir);
  }
});

test("#733: 阈值键被移除与降线同罪——基准 lines:80、工作区删掉该键判红", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFileSync(join(dir, VITEST), configWith("{ functions: 80, statements: 78, branches: 70 }"));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "删键等价于摘除该维度的硬门禁，不得静默放行");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

const gauntletWith = (budget) => ({
  ...defaultGauntlet(),
  ...(budget === null ? { lint: undefined } : { lint: { maxWarnings: budget } }),
});

test("#764 A2: lint.maxWarnings 上调判红（预算只许降）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeGauntlet(dir, gauntletWith(700));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "671 → 700 属放宽，必须判红");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#764 A2: lint.maxWarnings 删键判红（等价于摘除预算）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeGauntlet(dir, gauntletWith(null));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "删键后 lint.mjs 会 fail-closed，但阈值层面也必须显式拦一次");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#764 A2: lint.maxWarnings 下调放行（收紧方向正确）", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(671));
  try {
    writeGauntlet(dir, gauntletWith(600));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 0, "收紧不得被拦（否则棘轮会锁死存量清理）");
    assert.equal(r.failures, 0);
  } finally {
    removeFixture(dir);
  }
});

test("#764 A2: 首次引入 lint.maxWarnings（基准无该键）放行，不得误判为降线", () => {
  const dir = gitFixture(vitestText(80), gauntletWith(null));
  try {
    writeGauntlet(dir, gauntletWith(671));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 0, "基准侧没有该键 = 首次引入，不是「降线」");
    assert.equal(r.failures, 0);
  } finally {
    removeFixture(dir);
  }
});
const withMutation = (overrides) => ({
  ...defaultGauntlet(),
  mutation: { ...defaultGauntlet().mutation, ...overrides },
});

/** 逐包表与锚点的 fixture 生成器（只改被声明的那几个键，其余保持缺省）。 */
const withPackages = (packages) => withMutation({ packages });

test("#843 S2: mutation.strict 由 true 翻到 false 判红（判据被整体摘除）", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: true }));
  try {
    writeGauntlet(dir, withMutation({ strict: false }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "本轮审计实测：翻转后四道闸全绿，必须有判据拦");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 S2: mutation.strict 由 false 置 true 放行（收紧方向）", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: false }));
  try {
    writeGauntlet(dir, withMutation({ strict: true }));
    assert.equal(runFixture(dir).exitCode, 0, "收紧不得被拦");
  } finally {
    removeFixture(dir);
  }
});

test("#843 S2: mutation.strict 删键判红（等价于摘除开关）", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: true }));
  try {
    const gauntlet = readGauntlet(dir);
    delete gauntlet.mutation.strict;
    writeGauntlet(dir, gauntlet);
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "删键让 observe-check 的 strict 分支失去显式来源");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 回落锚点 fixedCovered 下调判红（回落判据的分界被往下搬）", () => {
  const dir = gitFixture(
    vitestText(80),
    withPackages({ "dsh-x": { threshold: 60, fixedCovered: 92.27 } }),
  );
  try {
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60, fixedCovered: 60 } }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "本轮实测：92.27 → 60 时阈值闸 exit 0");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 回落锚点上调放行（基线随加固抬升）", () => {
  const dir = gitFixture(
    vitestText(80),
    withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 } }),
  );
  try {
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60, fixedCovered: 92.27 } }));
    assert.equal(runFixture(dir).exitCode, 0);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 锚点被整体移除判红（不得退回观察期语义）", () => {
  const dir = gitFixture(
    vitestText(80),
    withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 } }),
  );
  try {
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60 } }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "锚点消失后 regressed 恒为 false，等于该包不再被判回落");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 回退链不得被用来降锚（fixedCovered 删掉后回落读 baselineCovered）", () => {
  // notifier 的真实形态：baselineCovered=1.33 是 bridge 修正前的作废记录，生效锚点是 fixedCovered。
  // 删掉 fixedCovered 会让读法回落到 1.33——本判据必须把它读成「锚点被大幅下调」而不是「换了个字段」。
  const dir = gitFixture(
    vitestText(80),
    withPackages({ "dsh-x": { threshold: 60, fixedCovered: 92.27 } }),
  );
  try {
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60, baselineCovered: 1.33 } }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "回退链是「读哪个字段」的规则，不是「可以把锚点换小」的许可");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843: complexity.cyclomatic 上调判红（此前零守卫）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    const gauntlet = readGauntlet(dir);
    gauntlet.complexity.cyclomatic = 90;
    writeGauntlet(dir, gauntlet);
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "本轮审计：strict/cyclomatic/crap 的守卫 grep 零命中");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843: complexity.cyclomatic 下调放行（#732 的收紧方向）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    const gauntlet = readGauntlet(dir);
    gauntlet.complexity.cyclomatic = 50;
    writeGauntlet(dir, gauntlet);
    assert.equal(runFixture(dir).exitCode, 0, "收紧被拦会锁死 #732 的收敛路线");
  } finally {
    removeFixture(dir);
  }
});

test("#843: crap.threshold 上调判红", () => {
  const dir = gitFixture(vitestText(80));
  try {
    const gauntlet = readGauntlet(dir);
    gauntlet.crap.threshold = 20;
    writeGauntlet(dir, gauntlet);
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});
/** 造一个「磁盘上有 src」的包，用于 existence 守卫的目录派生口径。 */
const packageFile = { "packages/dsh-y/src/index.ts": "export const y = 1;\n" };

test("#843 M-1: 有 src 的包不在变异阈值表里判红（整包静默退出变异门禁）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { extraFiles: packageFile });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "包目录是独立事实源：新包被忘在表外不能静默通过");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-1: 包在表里但没有回落锚点判红（回落判据对它恒为假）", () => {
  // 真实形态：dsh-worktree-sidebar 合入时既无 fixedCovered 也无 baselineCovered，
  // observe-check 的 regressed = baseline !== null && … 于是永远为 false——它不会被判回落。
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { extraFiles: packageFile });
  try {
    writeGauntlet(
      dir,
      withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 }, "dsh-y": { threshold: 60 } }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-1: 缺口按台账登记后可放行（唯一到期登记处，不另造机制）", () => {
  const ledger = {
    version: 1,
    exemptions: [
      {
        gate: "threshold-registry",
        path: "mutation.packages.dsh-y",
        reason: "fixture：锚点待夜间班回填",
        trackingIssue: "#999",
        reviewBy: "2027-01-01",
      },
    ],
  };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: { ...packageFile, [LEDGER]: JSON.stringify(ledger) },
    notAGate: [{ source: LEDGER, why: "fixture 的豁免台账" }],
  });
  try {
    writeGauntlet(
      dir,
      withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 }, "dsh-y": { threshold: 60 } }),
    );
    assert.equal(runFixture(dir).exitCode, 0, "登记豁免后必须放行，否则闸会锁死合入");
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-1: $noMutationPackages 里的包不受本判据约束（豁免只有一处登记）", () => {
  const topology = {
    $noMutationPackages: { $comment: "fixture", "dsh-y": "仅 e2e 冒烟，不进变异面" },
  };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: { ...packageFile, [TOPOLOGY]: JSON.stringify(topology) },
  });
  try {
    assert.equal(runFixture(dir).exitCode, 0, "整包不进变异面的裁决登记在 topology，本表只读它");
  } finally {
    removeFixture(dir);
  }
});

const topologyWith = (shared, pkgTimeout) =>
  JSON.stringify({
    sharedDefaults: { timeoutMS: shared },
    packages: { "dsh-x": { timeoutMS: pkgTimeout } },
  });

test("#843 T1: 逐包 timeoutMS 放宽判红（此前 6 处均无守卫）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, TIMEOUT_GUARD],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeFixtureFile(dir, TOPOLOGY, topologyWith(60000, 600000));
    const r = runFixture(dir);
    assert.equal(
      r.exitCode,
      1,
      "放宽超时会把单段墙钟拖爆（先例：放宽到 60s 后总时长冲到 15 分钟以上）",
    );
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 T1: sharedDefaults.timeoutMS 放宽判红", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, TIMEOUT_GUARD],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeFixtureFile(dir, TOPOLOGY, topologyWith(600000, 60000));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 T1: timeoutMS 收紧放行但必须报警（非单调旋钮，收紧方向另有风险）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, TIMEOUT_GUARD],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeFixtureFile(dir, TOPOLOGY, topologyWith(30000, 60000));
    const { result, lines } = captureWarn(() => runFixture(dir));
    assert.equal(result.exitCode, 0, "本表不对无依据的收紧判红");
    assert.equal(
      lines.length,
      1,
      "但必须报警：timeout 被计入 killed，调低会把慢测试判成 timeout 从而虚增分数",
    );
    assert.match(lines[0], /不是单调旋钮/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-2: 接线断言自身的豁免预算上调判红", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, BUDGET_GUARD],
    extraFiles: { [WIRING]: JSON.stringify({ maxExceptions: 12, maxJobFaces: 16 }) },
  });
  try {
    writeFixtureFile(dir, WIRING, JSON.stringify({ maxExceptions: 16, maxJobFaces: 16 }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "实测：预算顶到测试内硬顶时四道闸全绿，放宽必须另有判据");
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-2: 接线断言预算下调放行（缺口收口方向）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, BUDGET_GUARD],
    extraFiles: { [WIRING]: JSON.stringify({ maxExceptions: 12, maxJobFaces: 16 }) },
  });
  try {
    writeFixtureFile(dir, WIRING, JSON.stringify({ maxExceptions: 8, maxJobFaces: 16 }));
    assert.equal(runFixture(dir).exitCode, 0, "收口方向不得被拦");
  } finally {
    removeFixture(dir);
  }
});
