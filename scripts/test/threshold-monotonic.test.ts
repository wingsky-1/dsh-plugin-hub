#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  COVERAGE_THRESHOLD_KEYS,
  parseCoverageThresholds as parseCoverageThresholdsImpl,
  runThresholdMonotonic,
} from "../gate/threshold-monotonic.mjs";
import { resolveSingle, validateDeclarations } from "../lib/threshold-registry.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/gate/threshold-monotonic.mjs");
const GAUNTLET = "scripts/data/gauntlet.config.json";
const COVERAGE_CONFIG = "scripts/data/coverage.config.json";
const TOPOLOGY = "scripts/data/mutation-topology.json";
const WIRING = "scripts/data/gate-wiring-exceptions.json";
const LEDGER = "scripts/data/gate-exemptions.json";
const REGISTRY = "scripts/data/threshold-registry.json";
const VITEST = "vitest.config.ts";
/** parseCoverageThresholds 结果归一：实现仍带 @ts-nocheck，动态装配的 global/scoped 被推断为
 * 空对象/空数组——测试侧按门禁自述的形态收，null 保持（无块分支另有专条用例）。 */
interface CoverageParsed {
  global: Record<string, number>;
  scoped: string[];
}
const parseThresholds = (text: string) =>
  parseCoverageThresholdsImpl(text) as CoverageParsed | null;

/**
 * fixture 自带一份**最小声明表**：判据要跑的正是真值声明表的同一套代码路径，所以 fixture 不能没有表，
 * 但也不能照抄整份（真值表里多数事实源在 fixture 里不存在，会撞「悬空声明」而红）。
 * 真值表的自洽性与真值判据由文件末尾的「本仓真值快照」覆盖。
 */
// 泛型保留各 guard 字面量的自有字段（sources/paths/kind 等），下游按具体字段断言。
const guard = <T extends { id: string } & Record<string, unknown>>(fields: T) => ({
  why: "fixture 判据说明",
  hint: "fixture 修法提示",
  ...fields,
});

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
  minAllowed: 60,
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
  mutation: {
    strict: true,
    note: "fixture 的说明文本（非布尔字段，供 boolean 幽灵判据用例）",
    packages: { "dsh-x": { threshold: 60, fixedCovered: 70 } },
  },
  complexity: { cyclomatic: 78, cognitive: 84 },
  crap: { threshold: 16, strict: false },
  lint: { maxWarnings: 671 },
});

function writeFixtureFile(dir: string, rel: string, content: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** 构造一个带基线 commit 的临时 git 仓库；返回其路径。 */
function gitFixture(
  baseVitestConfig: string,
  baseGauntlet: unknown = defaultGauntlet(),
  options: { guards?: unknown; extraFiles?: Record<string, string>; notAGate?: unknown } = {},
) {
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
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

function runFixture(dir: string) {
  // 捕获 console.error：函数式 API 只回 { exitCode, failures }，判词在 stderr 上，
  // 断言「说了什么」比只断言退出码更能证明判据命中预期的缺口（也才挡得住「恰好因别的理由红」）。
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const result = runThresholdMonotonic(["HEAD"], { repoRoot: dir });
    return { ...result, stderr: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

function removeFixture(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** 生成仅 lines 不同的 vitest.config.ts 文本。 */
const vitestText = (lines: number) =>
  `export default { test: { coverage: { thresholds: { lines: ${lines}, functions: 80, statements: 78, branches: 70 } } } }\n`;

function readGauntlet(dir: string) {
  return JSON.parse(readFileSync(join(dir, GAUNTLET), "utf8"));
}

function writeGauntlet(dir: string, value: unknown) {
  writeFileSync(join(dir, GAUNTLET), JSON.stringify(value));
}

/** 捕获 console.warn（非单调旋钮的收紧方向走 warning 通道，不进 exit code）。 */
function captureWarn<T>(fn: () => T) {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
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
  assert.deepEqual(parseThresholds(text)?.global, {
    lines: 80,
    functions: 80,
    statements: 78,
    branches: 70,
  });
});

test("parseCoverageThresholds: 无 thresholds 块返回 null（与「阈值为 0」区分）", () => {
  assert.equal(parseThresholds("export default { test: {} }"), null);
  assert.equal(parseThresholds(""), null);
});

test("parseCoverageThresholds: 小数阈值与部分键可用", () => {
  assert.deepEqual(parseThresholds("thresholds: { lines: 79.5 }")?.global, { lines: 79.5 });
});

test("#733: glob 键在后时全局四键仍完整解析，glob 被登记为 scoped", () => {
  const parsed = parseThresholds(
    "thresholds: { lines: 80, functions: 80, statements: 78, branches: 70, 'packages/x/**': { lines: 92 } }",
  );
  assert.deepEqual(parsed?.global, { lines: 80, functions: 80, statements: 78, branches: 70 });
  assert.deepEqual(parsed?.scoped, ["packages/x/**"]);
});

test("#733: 块内注释里的伪值与闭括号不得被采信", () => {
  const parsed = parseThresholds(
    "thresholds: {\n  // lines: 999 } 注释里的闭括号\n  /* } lines: 888 */\n  lines: 80, functions: 80, statements: 78, branches: 70,\n}",
  );
  assert.equal(
    parsed?.global.lines,
    80,
    "注释里的 lines:999 不得覆盖真实值，且注释里的 } 不得提前截断块",
  );
  assert.deepEqual(parsed?.scoped, [], "注释不得产生幻影 glob 键");
});

test("#733: perFile 一类非阈值选项被忽略，不误判为 scoped", () => {
  const parsed = parseThresholds("thresholds: { perFile: true, lines: 80 }");
  assert.deepEqual(parsed?.global, { lines: 80 });
  assert.deepEqual(parsed?.scoped, []);
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
const configWith = (thresholds: string) =>
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

const gauntletWith = (budget: number | null) => ({
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
const withMutation = (overrides: Record<string, unknown>) => ({
  ...defaultGauntlet(),
  mutation: { ...defaultGauntlet().mutation, ...overrides },
});

/** 逐包表与锚点的 fixture 生成器（只改被声明的那几个键，其余保持缺省）。 */
const withPackages = (packages: unknown) => withMutation({ packages });

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
/** 两个「磁盘上存在」的包：dsh-x 对应缺省表里的条目，dsh-y 用于新增/漏登场景。 */
const packageFile = {
  "packages/dsh-x/src/index.ts": "export const x = 1;\n",
  "packages/dsh-y/src/index.ts": "export const y = 1;\n",
};

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
        path: "mutation.packages.dsh-y#anchor",
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

const topologyWith = (shared: unknown, pkgTimeout: unknown) =>
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

// ── #843 对抗评审（P0-1 / P1-2 / P1-3 / P1-4 / P1-5 / P1-7 与低成本 P2）──

/** 复写工作区声明表（用于「相对基准被削弱」的注入；基准侧那份由 gitFixture 的提交提供）。 */
function writeRegistry(dir: string, guards: unknown, extra: Record<string, unknown> = {}) {
  writeFixtureFile(
    dir,
    REGISTRY,
    JSON.stringify(
      {
        version: 1,
        retired: [],
        contractApprovals: [],
        note: "fixture",
        guards,
        notAGate: [],
        ...extra,
      },
      null,
      2,
    ),
  );
}

const without = (ids: string[]) => BASE_GUARDS.filter((item) => !ids.includes(item.id));
const withMinAllowed = (id: string) =>
  BASE_GUARDS.map((item) => (item.id === id ? { ...item, minAllowed: 60 } : item));

test("#843 P0-1: 声明表删掉一条 guard 判红（一行数据改动不再能摘掉判据）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(dir, without(["complexity.cyclomatic"]));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "删 guard 等于摘掉该事实源的判据，且测试面原本打不红");
    assert.match(r.stderr, /声明表：complexity\.cyclomatic 被整体移除/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: 登记 retired（带 trackingIssue）后退役放行", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(dir, without(["complexity.cyclomatic"]), {
      retired: [
        {
          id: "complexity.cyclomatic",
          trackingIssue: "#999",
          reason: "fixture：口径迁移，已由新守卫覆盖",
        },
      ],
    });
    assert.equal(runFixture(dir).exitCode, 0, "退役必须可审计，但不得默认禁止");
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: retired 登记了却仍在 guards 里判红（登记与事实不符）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(dir, BASE_GUARDS, {
      retired: [{ id: "complexity.cyclomatic", trackingIssue: "#999", reason: "fixture" }],
    });
    assert.equal(runFixture(dir).exitCode, 2);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: 翻转 weaken 判红（原先判红的放宽会变成合法）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === "complexity.cyclomatic" ? { ...item, weaken: "decrease" } : item,
      ),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /complexity\.cyclomatic\.weaken 相对基准被改动/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: onRemoval 由 fail 改 ignore 判红（删键不再判红）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === "lint.maxWarnings" ? { ...item, onRemoval: "ignore" } : item,
      ),
    );
    assert.equal(runFixture(dir).exitCode, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: paths 丢掉一项判红（声明的覆盖面只许补全）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, TIMEOUT_GUARD],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeRegistry(dir, [...BASE_GUARDS, { ...TIMEOUT_GUARD, paths: ["sharedDefaults.timeoutMS"] }]);
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /mutation\.timeoutMS\.paths 相对基准被改动/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: 收紧方向放行（新增绝对下限不需要批准块）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(dir, withMinAllowed("mutation.packageThreshold"));
    assert.equal(runFixture(dir).exitCode, 0, "一律「变了就红」会逼出写满批准块的假治理");
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: 合法改动经 contractApprovals 登记后放行", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === "complexity.cyclomatic" ? { ...item, weaken: "decrease" } : item,
      ),
      {
        contractApprovals: [
          {
            id: "complexity.cyclomatic",
            field: "weaken",
            trackingIssue: "#999",
            reason: "fixture：口径迁移",
          },
        ],
      },
    );
    assert.equal(runFixture(dir).exitCode, 0);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P0-1: 失效的批准块判红（已无对应改动）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(dir, BASE_GUARDS, {
      contractApprovals: [
        {
          id: "complexity.cyclomatic",
          field: "weaken",
          trackingIssue: "#999",
          reason: "fixture",
        },
      ],
    });
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /已无对应改动/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-2: 非生效锚点字段被下调也判红（口径与机制对齐）", () => {
  const dir = gitFixture(
    vitestText(80),
    withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70, baselineCovered: 50 } }),
  );
  try {
    // 生效锚点（fixedCovered 70）不动，只毒化非生效的 baselineCovered——旧实现 exit 0。
    writeGauntlet(
      dir,
      withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70, baselineCovered: 5 } }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.failures, 1);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-7: 新包阈值低于绝对下限判红（改名重登记不能免检）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { extraFiles: packageFile });
  try {
    writeGauntlet(
      dir,
      withPackages({
        "dsh-x": { threshold: 60, fixedCovered: 70 },
        "dsh-y": { threshold: 1, fixedCovered: 10 },
      }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "新增条目走「首次引入」跳过对比，故下限必须是绝对判据");
    assert.match(r.stderr, /低于下限 60/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-7: 表里有条目但磁盘没有对应包判红（幽灵条目）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: { "packages/dsh-x/src/index.ts": "export const x = 1;\n" },
  });
  try {
    writeGauntlet(
      dir,
      withPackages({
        "dsh-x": { threshold: 60, fixedCovered: 70 },
        "dsh-ghost": { threshold: 60, fixedCovered: 70 },
      }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /dsh-ghost 没有对应的真实包/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-3: 豁免按判据分开登记——#anchor 不能豁免「不在表里」", () => {
  const ledger = {
    version: 1,
    exemptions: [
      {
        gate: "threshold-registry",
        path: "mutation.packages.dsh-y#anchor",
        reason: "fixture：只豁免锚点存在性",
        trackingIssue: "#999",
        reviewBy: "2027-01-01",
      },
    ],
  };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: { ...packageFile, [LEDGER]: JSON.stringify(ledger) },
    notAGate: [{ source: LEDGER, why: "fixture 台账" }],
  });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "#anchor 只豁免锚点，整包不在表里仍须判红");
    assert.match(r.stderr, /有 src 但不在 mutation\.packages/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-5: 陈旧豁免判红（豁免还在、缺口已不存在）", () => {
  const ledger = {
    version: 1,
    exemptions: [
      {
        gate: "threshold-registry",
        path: "mutation.packages.dsh-x#anchor",
        reason: "fixture：该包已声明锚点",
        trackingIssue: "#999",
        reviewBy: "2027-01-01",
      },
    ],
  };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: { ...packageFile, [LEDGER]: JSON.stringify(ledger) },
    notAGate: [{ source: LEDGER, why: "fixture 台账" }],
  });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "豁免没有反向腐烂校验就会长期挂着，到期复核变成噪音");
    assert.match(r.stderr, /反向腐烂/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 P1-4: 事实源损坏是 exit 2（配置错误），不是「判据放宽」", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFixtureFile(dir, GAUNTLET, "{ 坏 JSON");
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "损坏走环境故障通道，按退出码分流的调用方不会误读成放宽");
  } finally {
    removeFixture(dir);
  }
});

test("#843 P2: $noMutationPackages 的豁免理由必须是可读的裁决记录", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: {
      ...packageFile,
      [TOPOLOGY]: JSON.stringify({
        $noMutationPackages: { $comment: "fixture", "dsh-y": "" },
      }),
    },
  });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /豁免理由必须是非空字符串/);
  } finally {
    removeFixture(dir);
  }
});

// ── #850 批次评审：F-1 影子源 / M1 零锚点 / M2 无上限 / M3 整包退役 / M4 幽灵判据按 kind 对齐 / P5 枚举边界 ──

const SHADOW = "scripts/data/gauntlet-shadow.json";
const FALLBACK = "scripts/data/gauntlet-fallback.json";

test("#843 F-1: sources 只许尾部追加——前置一个源即判红（影子文件尚不存在也要拦）", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: true }));
  try {
    // 只前置、不写影子文件：此刻唯一能判红的只有「回落链只许尾部追加」这条契约，
    // 命中源比对与阈值比较都不该在这里生效（否则这条用例会因为别的判据红而失去指向性）。
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === STRICT_GUARD.id ? { ...item, sources: [SHADOW, GAUNTLET] } : item,
      ),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "前置/重排会把守卫指到另一个文件，必须判红");
    assert.match(r.stderr, /mutation\.strict\.sources 相对基准被改动/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 F-1: sources 改动即使有批准块，两侧命中不同的事实源仍判红", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: true }));
  try {
    // 批准块只能放行「声明表被改动」这件事；它不该同时放行「守卫私自换了事实源」。
    writeFixtureFile(dir, SHADOW, JSON.stringify({ mutation: { strict: true } }));
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === STRICT_GUARD.id ? { ...item, sources: [SHADOW, GAUNTLET] } : item,
      ),
      {
        notAGate: [{ source: SHADOW, why: "fixture：影子文件" }],
        contractApprovals: [
          {
            id: STRICT_GUARD.id,
            field: "sources",
            trackingIssue: "#999",
            reason: "fixture：模拟已批准的 sources 改动",
          },
        ],
      },
    );
    writeGauntlet(dir, withMutation({ strict: false }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "批准块只放行声明表改动，放行不了「守卫私自换源」");
    assert.match(r.stderr, /不是基准对 mutation\.strict 声明的事实源/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 F-1: 影子源前置到全部事实源 + 篡改走 exit 1（判据放宽，不是配置故障）", () => {
  const dir = gitFixture(vitestText(80), withMutation({ strict: true }));
  try {
    // 攻击把影子源前置到**所有**读 gauntlet 的 guard，真实源因此不再被工作区消费。
    // 「工作区消费的源不在声明表内」的覆盖校验若抢先，同一次攻击会被报成 exit 2，读成工具坏了。
    writeFixtureFile(dir, SHADOW, JSON.stringify({ mutation: { strict: true } }));
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.sources?.[0] === GAUNTLET ? { ...item, sources: [SHADOW, GAUNTLET] } : item,
      ),
    );
    writeGauntlet(dir, withMutation({ strict: false }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "影子源前置是判据被削弱，必须落在 exit 1 通道");
    assert.match(r.stderr, /有更靠前的源接管了该守卫（影子源）/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 F-1: 基准尚无声明表时，影子源态由判词点名（仍是 exit 2 通道）", () => {
  const dir = mkdtempSync(join(tmpdir(), "threshold-decl-"));
  try {
    // 复现基准没有本表时的形态：真实源被声明过、却没有任何 guard 读到它（被影子源接管）。
    // 此时无从比对声明表，只能按未登记 fail-closed，但判词必须点名影子源而不是泛泛的「未登记」。
    writeFixtureFile(dir, GAUNTLET, "{}");
    writeFixtureFile(dir, "scripts/data/gauntlet-shadow.json", "{}");
    const registry = {
      guards: [
        guard({
          id: "fixture.value",
          kind: "value",
          sources: [GAUNTLET],
          paths: ["threshold"],
          weaken: "decrease",
          onRemoval: "fail",
        }),
      ],
      notAGate: [],
    };
    // 实现（scripts/lib/threshold-registry.mjs）仍带 @ts-nocheck：解构入参只从默认值推断出 dataDir，
    // repoRoot/consumed 在实现体真实消费，测试侧按调用形态整体断言。
    const problems = validateDeclarations(registry, {
      repoRoot: dir,
      consumed: new Set(["scripts/data/gauntlet-shadow.json"]),
    } as unknown as Parameters<typeof validateDeclarations>[1]).join("\n");
    assert.match(problems, /未在声明表登记/);
    assert.match(problems, /有 guard 在 sources 里列过它，但工作区里没有任何 guard 实际读到它/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#843 F-1: sources 尾部追加合法源放行（只是给回落链留位，不改当前生效源）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === STRICT_GUARD.id ? { ...item, sources: [GAUNTLET, FALLBACK] } : item,
      ),
    );
    assert.equal(runFixture(dir).exitCode, 0, "尾部追加不改变当前读取的事实源，不得被拦");
  } finally {
    removeFixture(dir);
  }
});

test("#843 F-1: 只在 sources 里列名的数据文件不算已登记（必须真的被读到）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    // 生效源仍是 gauntlet，尾部这个源从未被读到——只列名就洗白「未登记即红」正是影子源的入口。
    writeFixtureFile(dir, FALLBACK, JSON.stringify({ mutation: { strict: true } }));
    writeRegistry(
      dir,
      BASE_GUARDS.map((item) =>
        item.id === STRICT_GUARD.id ? { ...item, sources: [GAUNTLET, FALLBACK] } : item,
      ),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "未被消费的数据文件仍须显式登记为守护或 not-a-gate");
    assert.match(r.stderr, /未在声明表登记/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-1: 新包把回落锚点写成 0 判红（0 锚点与无锚点等价）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { extraFiles: packageFile });
  try {
    // observe-check 的回退链取 fixedCovered ?? baselineCovered，生效锚点为 0 时
    // regressed = covered < 0 - 1 恒为假：与「没有锚点」是同一件事。
    writeGauntlet(
      dir,
      withPackages({
        "dsh-x": { threshold: 60, fixedCovered: 70 },
        "dsh-y": { threshold: 60, fixedCovered: 0, baselineCovered: 0 },
      }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "锚点判据必须落在生效值上，0 也是无效锚点");
    assert.match(r.stderr, /没有声明任何回落锚点/);
  } finally {
    removeFixture(dir);
  }
});

test("#843 M-1: 新包回填正数锚点放行（锚点存在即不再恒假）", () => {
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { extraFiles: packageFile });
  try {
    writeGauntlet(
      dir,
      withPackages({
        "dsh-x": { threshold: 60, fixedCovered: 70 },
        "dsh-y": { threshold: 60, fixedCovered: 10 },
      }),
    );
    assert.equal(runFixture(dir).exitCode, 0, "新包回填锚点是正常动作，不得被拦");
  } finally {
    removeFixture(dir);
  }
});

test("#843: 新增包级 timeoutMS 超绝对上限判红（after 独有 leaf 不受相对比较约束）", () => {
  const bounded = { ...TIMEOUT_GUARD, maxAllowed: 60000 };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, bounded],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeFixtureFile(
      dir,
      TOPOLOGY,
      JSON.stringify({
        sharedDefaults: { timeoutMS: 60000 },
        packages: { "dsh-x": { timeoutMS: 60000 }, "dsh-y": { timeoutMS: 3600000 } },
      }),
    );
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "相对比较对新增叶子天然无效，上限必须是绝对判据");
    assert.match(r.stderr, /超过上限 60000/);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 包级 timeoutMS 未超绝对上限放行（上限只拦放宽）", () => {
  const bounded = { ...TIMEOUT_GUARD, maxAllowed: 60000 };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    guards: [...BASE_GUARDS, bounded],
    extraFiles: { [TOPOLOGY]: topologyWith(60000, 60000) },
  });
  try {
    writeFixtureFile(
      dir,
      TOPOLOGY,
      JSON.stringify({
        sharedDefaults: { timeoutMS: 60000 },
        packages: { "dsh-x": { timeoutMS: 30000 }, "dsh-y": { timeoutMS: 60000 } },
      }),
    );
    assert.equal(runFixture(dir).exitCode, 0, "未超上限（含收紧）不得被拦");
  } finally {
    removeFixture(dir);
  }
});

test("#843: 整包退役登记 #removal 后放行，未登记仍判红", () => {
  const exemption = {
    gate: "threshold-registry",
    path: "mutation.packages.dsh-y.threshold#removal",
    reason: "fixture：整包退役",
    trackingIssue: "#999",
    reviewBy: "2027-01-01",
  };
  const dir = gitFixture(
    vitestText(80),
    withPackages({
      "dsh-x": { threshold: 60, fixedCovered: 70 },
      "dsh-y": { threshold: 60, fixedCovered: 70 },
    }),
    {
      extraFiles: {
        ...packageFile,
        [LEDGER]: JSON.stringify({ version: 1, exemptions: [exemption] }),
      },
      notAGate: [{ source: LEDGER, why: "fixture 台账" }],
    },
  );
  try {
    rmSync(join(dir, "packages/dsh-y"), { recursive: true, force: true });
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 } }));
    assert.equal(
      runFixture(dir).exitCode,
      0,
      "整包退役必须有一条显式台账通道，否则闸会锁死正常退役",
    );
  } finally {
    removeFixture(dir);
  }
});

test("#843: 整包退役未登记 #removal 时仍判红", () => {
  const dir = gitFixture(
    vitestText(80),
    withPackages({
      "dsh-x": { threshold: 60, fixedCovered: 70 },
      "dsh-y": { threshold: 60, fixedCovered: 70 },
    }),
    { extraFiles: packageFile },
  );
  try {
    rmSync(join(dir, "packages/dsh-y"), { recursive: true, force: true });
    writeGauntlet(dir, withPackages({ "dsh-x": { threshold: 60, fixedCovered: 70 } }));
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "没有台账登记时删键仍须判红");
    assert.match(r.stderr, /被移除/);
  } finally {
    removeFixture(dir);
  }
});

test("#843: boolean 判据声明到非布尔字段判红（幽灵判据按 kind 对齐语义）", () => {
  const ghost = guard({
    id: "ghost.boolean",
    kind: "boolean",
    sources: [GAUNTLET],
    paths: ["mutation.note"],
    weakenValue: false,
    onRemoval: "fail",
  });
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { guards: [...BASE_GUARDS, ghost] });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "字符串字段命中不算 boolean 判据命中，否则这条守卫永不生效");
    assert.match(r.stderr, /幽灵判据/);
  } finally {
    removeFixture(dir);
  }
});

test("#843: baseline 判据声明不存在的锚点字段判红（anchorFields 必须命中）", () => {
  const ghost = guard({
    id: "ghost.anchor",
    kind: "baseline",
    sources: [GAUNTLET],
    paths: ["mutation.packages"],
    anchorFields: ["noSuchAnchor"],
    onRemoval: "fail",
  });
  const dir = gitFixture(vitestText(80), defaultGauntlet(), { guards: [...BASE_GUARDS, ghost] });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 2, "锚点字段一个都命中不了，这条判据恒不生效");
    assert.match(r.stderr, /幽灵判据/);
  } finally {
    removeFixture(dir);
  }
});

test("#843: 未登记即红的枚举边界大小写不敏感（SHADOW.JSON 同样判红）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFixtureFile(dir, "scripts/data/SHADOW.JSON", "{}");
    assert.equal(runFixture(dir).exitCode, 2, "扩展名大小写不得成为逃逸口");
  } finally {
    removeFixture(dir);
  }
});

test("#843: 枚举边界是 scripts/data 顶层 .json（.jsonc 与子目录不在面内）", () => {
  const dir = gitFixture(vitestText(80));
  try {
    writeFixtureFile(dir, "scripts/data/nested/shadow.json", "{}");
    writeFixtureFile(dir, "scripts/data/shadow.jsonc", "{}");
    assert.equal(runFixture(dir).exitCode, 0, "这是文档化的边界，不是运行时才发现的漏洞");
  } finally {
    removeFixture(dir);
  }
});

test("#843: 认不出的豁免键进反向腐烂（照旧文档写出条目不会再被静默忽略）", () => {
  const ledger = {
    version: 1,
    exemptions: [
      {
        gate: "threshold-registry",
        path: "mutation.packages.dsh-x",
        reason: "fixture：旧文档写法，无 #membership/#anchor 后缀",
        trackingIssue: "#999",
        reviewBy: "2027-01-01",
      },
    ],
  };
  const dir = gitFixture(vitestText(80), defaultGauntlet(), {
    extraFiles: {
      "packages/dsh-x/src/index.ts": "export const x = 1;\n",
      [LEDGER]: JSON.stringify(ledger),
    },
    notAGate: [{ source: LEDGER, why: "fixture 台账" }],
  });
  try {
    const r = runFixture(dir);
    assert.equal(r.exitCode, 1, "识别不了的豁免键等于一条永远不生效的虚假治理记录");
    assert.match(r.stderr, /没有对应的判据缺口/);
  } finally {
    removeFixture(dir);
  }
});
