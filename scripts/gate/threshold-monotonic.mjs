#!/usr/bin/env node
/**
 * threshold-monotonic — 阈值单调性校验（#85 v3 F3 兜底）
 *
 * 对比工作区与指定 git 基准（默认 origin/main）中的阈值来源，只许升不许降：
 *   - 覆盖率阈值 `{lines,functions,statements,branches}`：#722 阶段三起由 vitest coverage 承载，
 *     **#733 计划项 3.4 起事实源迁到 scripts/data/coverage.config.json**。迁移期**双读**：
 *     某一侧有该 JSON 就用它，没有则回落到同侧的 vitest.config.ts——否则「基准侧还没有 JSON」
 *     会被读成「首次引入，跳过对比」，把一次性静默降线的窗口留在迁移 PR 里；
 *   - scripts/data/gauntlet.config.json 的 mutation.packages.<pkg>.threshold；
 *   - scripts/data/gauntlet.config.json 的 lint.maxWarnings（#764 落地项 A2 的警告预算）。
 * 降线必须走原 issue 内 approved 流程改基线，而不是悄悄调低阈值。
 *
 * 为什么用文本提取而非 import 基准版本：基准取自 git 对象，import 它等于执行历史
 * 代码。两侧走同一个提取函数，语义对称且无副作用。
 *
 * 为什么用 acorn 而非正则：`thresholds\s*:\s*\{([^}]*)\}` 会在第一个 `}` 处截断，再按
 * 「每键取首个匹配」取值——于是一个分包 glob 键就能把它内部的高值顶到全局键之前，把真实
 * 的全局降线读成上升而放行；块内注释里的伪值同样会被采信。改走词法 token 定位 + 表达式
 * 解析后，注释与嵌套交由 acorn 处理，首层键的归属不再取决于文本形态。根 typescript 是
 * tsgo（无 compiler API），故用既有 devDep acorn。
 *
 * 用法：node scripts/gate/threshold-monotonic.mjs [git-ref]
 * 退出码：0 = 无降线；1 = 存在降线；2 = 环境/数据错误
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExpressionAt, tokenizer } from "acorn";

const GAUNTLET = "scripts/data/gauntlet.config.json";
const VITEST_CONFIG = "vitest.config.ts";
/** #733 计划项 3.4 起的覆盖率面单一事实源（include/exclude/thresholds）。 */
const COVERAGE_CONFIG = "scripts/data/coverage.config.json";
export const COVERAGE_THRESHOLD_KEYS = ["lines", "functions", "statements", "branches"];
const ACORN_OPTIONS = { ecmaVersion: "latest", sourceType: "module" };

/**
 * 定位 `thresholds: {` 的对象字面量边界，返回 { start, end }（含两端花括号）；无该形态返回 null。
 * 只走词法不解析语法：整份 vitest.config.ts 含 TS 语法而 acorn 不认，调用方喂进来的也可能是片段，
 * 故把「名字 → 冒号 → 花括号」三个 token 钉住，再按 `{`/`}` token 配平取块。
 *
 * 为什么必须切出独立片段再解析：acorn 的 parseExpressionAt 在「对象闭合 `}` 之后还跟着 `,` 与外层
 * `}`」时会越过对象边界报 unexpected（真实 vitest.config.ts 报在 74:4，即 coverage 的闭括号），
 * 而它自身并无 eof 检查。切到配平位置后片段尾部即 eof，正好绕开该行为；配平又由 token 完成，
 * 注释与字符串里的花括号都不会被计入——旧正则 `[^}]*` 的两个漏洞来源同时消失。
 */
function locateThresholdsObject(text) {
  const tokens = tokenizer(text, ACORN_OPTIONS);
  for (;;) {
    const token = tokens.getToken();
    if (token.type.label === "eof") return null;
    if (token.type.label !== "name" || token.value !== "thresholds") continue;
    if (tokens.getToken().type.label !== ":") continue;
    const open = tokens.getToken();
    if (open.type.label !== "{") return null;
    let depth = 1;
    for (;;) {
      const inner = tokens.getToken();
      if (inner.type.label === "eof") return null;
      if (inner.type.label === "{") {
        depth += 1;
      } else if (inner.type.label === "}") {
        depth -= 1;
        if (depth === 0) return { start: open.start, end: inner.end };
      }
    }
  }
}

/**
 * 解析 coverage.thresholds 的首层键，返回 { global, scoped }。
 * global 是四个覆盖率维度的数字阈值；scoped 是值为对象字面量的分包 glob 键名。
 * 无 `thresholds: {` 形态返回 null（与「块在但一个全局键都没有」区分，后者由调用方 fail-closed）。
 * 词法/语法错误直接上抛，由调用方按环境故障 fail-closed。
 */
export function parseCoverageThresholds(text) {
  const span = locateThresholdsObject(text);
  if (span === null) return null;
  const node = parseExpressionAt(text.slice(span.start, span.end), 0, ACORN_OPTIONS);
  const global = {};
  const scoped = [];
  for (const prop of node.type === "ObjectExpression" ? node.properties : []) {
    if (prop.type !== "Property" || prop.computed) continue;
    const name = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
    if (prop.value.type === "ObjectExpression") {
      scoped.push(String(name));
    } else if (prop.value.type === "Literal" && COVERAGE_THRESHOLD_KEYS.includes(name)) {
      if (typeof prop.value.value === "number") global[name] = prop.value.value;
    }
  }
  return { global, scoped };
}

/**
 * 分包 glob 阈值不在本门禁的覆盖面内（比较它们需要 glob 语义，本仓当前也未使用），
 * 但静默略过会让「用 glob 键夹带高值、同时在别处削弱全局键」看起来全绿，故显式告警。
 */
function warnScopedThresholds(label, parsed) {
  if (parsed.scoped.length === 0) return;
  console.warn(
    `threshold-monotonic: ${label} 含 ${parsed.scoped.length} 个 coverage.thresholds 分包 glob 键（${parsed.scoped.join(", ")}）—— 本门禁只比较全局键，分包阈值不在覆盖面内`,
  );
}

/**
 * 从 coverage.config.json 取全局阈值（#733 3.4 起的形态）。
 * 结构不合法（缺 thresholds / 非数字）返回 null：与「配置里没有 thresholds」同义，由调用方
 * 决定是回落 vitest.config.ts 还是 fail-closed。
 */
export function parseCoverageConfigThresholds(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = json?.thresholds;
  if (raw === null || typeof raw !== "object") return null;
  const global = {};
  for (const key of COVERAGE_THRESHOLD_KEYS) {
    if (typeof raw[key] === "number") global[key] = raw[key];
  }
  return Object.keys(global).length === 0 ? null : { global, scoped: [] };
}

/**
 * 基准 ref 本身是否可解析。必须先查它：`cat-file -e` 对「路径不存在」与「ref 不存在」都报
 * fatal（实测路径不存在退出 **128**，不是 1），只看退出码会把写错的 ref 读成「基准上没这个
 * 文件」→ 走进「首次引入，跳过对比」而静默放行。
 */
function refExists(ref, repoRoot) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** 基准上是否存在该文件：路径不存在退出 1 或 128（git 版本差异），两者都算「没有」；其它错误上抛。 */
function existsInGit(ref, path, repoRoot) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch (err) {
    if (err.status === 1 || err.status === 128) return false;
    throw err;
  }
}

function readFromGit(ref, path, repoRoot) {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * 主校验。返回 { exitCode, failures }；日志走 stdout/stderr。
 */
export function runThresholdMonotonic(
  argv = process.argv.slice(2),
  { repoRoot = process.cwd() } = {},
) {
  const baseRef = argv[0] ?? "origin/main";
  let failures = 0;

  if (!refExists(baseRef, repoRoot)) {
    console.error(
      `threshold-monotonic: 基准 ref ${baseRef} 不可解析（fetch 了吗？）—— 环境故障按 fail-closed 处理`,
    );
    return { exitCode: 2, failures: 0 };
  }

  // ── 维度一：覆盖率阈值（coverage.config.json，迁移期双读 vitest.config.ts）──
  let oldCoverage = null;
  try {
    const oldSource = existsInGit(baseRef, COVERAGE_CONFIG, repoRoot)
      ? COVERAGE_CONFIG
      : VITEST_CONFIG;
    if (existsInGit(baseRef, oldSource, repoRoot)) {
      oldCoverage =
        oldSource === COVERAGE_CONFIG
          ? parseCoverageConfigThresholds(readFromGit(baseRef, COVERAGE_CONFIG, repoRoot))
          : parseCoverageThresholds(readFromGit(baseRef, VITEST_CONFIG, repoRoot));
      if (oldCoverage === null) {
        console.log(
          `threshold-monotonic: ${baseRef} 的 ${oldSource} 无 coverage.thresholds —— 首次引入，跳过覆盖率阈值对比`,
        );
      } else {
        warnScopedThresholds(`${baseRef} 的 ${oldSource}`, oldCoverage);
      }
    } else {
      console.log(
        `threshold-monotonic: ${baseRef} 上无 ${VITEST_CONFIG} —— 首次引入，跳过覆盖率阈值对比`,
      );
    }
  } catch (err) {
    console.error(
      `threshold-monotonic: 读取 ${baseRef}:${VITEST_CONFIG} 失败：${err.message} —— 环境故障按 fail-closed 处理`,
    );
    return { exitCode: 2, failures: 0 };
  }

  // 工作区侧同样双读：有 coverage.config.json 就用它（#733 3.4 后的正常态），
  // 没有才回落 vitest.config.ts（迁移前的形态或尚未迁移的分支）。
  const newHasConfig = existsSync(join(repoRoot, COVERAGE_CONFIG));
  const newSource = newHasConfig ? COVERAGE_CONFIG : VITEST_CONFIG;
  let newCoverage = null;
  try {
    newCoverage = newHasConfig
      ? parseCoverageConfigThresholds(readFileSync(join(repoRoot, COVERAGE_CONFIG), "utf8"))
      : parseCoverageThresholds(readFileSync(join(repoRoot, VITEST_CONFIG), "utf8"));
  } catch (err) {
    console.error(`threshold-monotonic: 工作区 ${newSource} 读取失败：${err.message}`);
    return { exitCode: 2, failures: 0 };
  }
  if (newCoverage === null) {
    console.error(
      `threshold-monotonic: 工作区 ${newSource} 缺 coverage.thresholds —— 覆盖率阈值是硬门禁，缺失视为配置错误（fail-closed）`,
    );
    return { exitCode: 2, failures: 0 };
  }
  warnScopedThresholds(`工作区 ${newSource}`, newCoverage);
  if (Object.keys(newCoverage.global).length === 0) {
    console.error(
      `threshold-monotonic: 工作区 ${VITEST_CONFIG} 的 coverage.thresholds 没有任何全局阈值键 —— 全局硬门禁被摘除，fail-closed`,
    );
    return { exitCode: 2, failures: 0 };
  }

  if (oldCoverage !== null) {
    for (const key of COVERAGE_THRESHOLD_KEYS) {
      const before = oldCoverage.global[key];
      const after = newCoverage.global[key];
      if (typeof before !== "number") continue;
      // 删键与降线等价：覆盖率的每个维度只有被声明才受约束，删掉即该维度不再有硬门禁
      if (typeof after !== "number") {
        console.error(
          `[FAIL] vitest coverage.thresholds.${key} 被移除（基准 ${before}）—— 删键等价于摘除该维度的硬门禁，须原 issue 内 approved 后方可移除`,
        );
        failures += 1;
      } else if (after < before) {
        console.error(
          `[FAIL] vitest coverage.thresholds.${key} 降线：${before} → ${after}（须原 issue 内 approved 后方可下调）`,
        );
        failures += 1;
      }
    }
  }

  // ── 维度二：变异阈值（gauntlet.config.json）────────────────────
  let oldCfg = null;
  let newCfg = null;
  try {
    const oldGauntletExists = existsInGit(baseRef, GAUNTLET, repoRoot);
    if (!oldGauntletExists) {
      console.log(`threshold-monotonic: ${baseRef} 上无 ${GAUNTLET} —— 首次引入，跳过变异阈值对比`);
    } else {
      oldCfg = JSON.parse(readFromGit(baseRef, GAUNTLET, repoRoot));
    }
    newCfg = JSON.parse(readFileSync(join(repoRoot, GAUNTLET), "utf8"));
  } catch (err) {
    console.error(
      `threshold-monotonic: 读取 ${GAUNTLET} 失败：${err.message} —— 环境故障按 fail-closed 处理`,
    );
    return { exitCode: 2, failures: 0 };
  }

  if (oldCfg !== null) {
    const oldPkgs = oldCfg?.mutation?.packages ?? {};
    const newPkgs = newCfg?.mutation?.packages ?? {};
    for (const [pkg, cfg] of Object.entries(newPkgs)) {
      const oldThreshold = oldPkgs[pkg]?.threshold;
      const newThreshold = cfg?.threshold;
      if (
        typeof oldThreshold === "number" &&
        typeof newThreshold === "number" &&
        newThreshold < oldThreshold
      ) {
        console.error(
          `[FAIL] mutation.packages.${pkg}.threshold 降线：${oldThreshold} → ${newThreshold}`,
        );
        failures += 1;
      }
    }
  }

  // ── 维度三：lint 警告预算（gauntlet.config.json 的 lint.maxWarnings，只许降）──
  // 与变异阈值同一份事实源、同一套治理（#764 落地项 A2）。删键同样判红：预算缺失时 lint.mjs
  // 会 fail-closed，但那是运行期兜底；这里在阈值层面显式拦一次，避免「删掉预算」看起来像
  // 一次无关紧要的整理。
  if (oldCfg !== null) {
    const oldBudget = oldCfg?.lint?.maxWarnings;
    const newBudget = newCfg?.lint?.maxWarnings;
    if (typeof oldBudget === "number") {
      if (typeof newBudget !== "number") {
        console.error(
          `[FAIL] lint.maxWarnings 被移除（基准 ${oldBudget}）—— 删键等价于摘除警告预算，须原 issue 内 approved 后方可移除`,
        );
        failures += 1;
      } else if (newBudget > oldBudget) {
        console.error(
          `[FAIL] lint.maxWarnings 上调：${oldBudget} → ${newBudget}（警告预算只许降，须原 issue 内 approved）`,
        );
        failures += 1;
      }
    }
  }

  if (failures > 0) {
    console.error(
      `\nthreshold-monotonic: ${failures} 处降线 —— 阈值治理红线（AGENTS.md / #85 v3 F3）`,
    );
    return { exitCode: 1, failures };
  }
  console.log("threshold-monotonic: 无阈值降线，校验通过");
  return { exitCode: 0, failures: 0 };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exit(runThresholdMonotonic(process.argv.slice(2)).exitCode);
}
