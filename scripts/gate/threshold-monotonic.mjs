#!/usr/bin/env node
/**
 * threshold-monotonic — 阈值单调性校验（#85 v3 F3 兜底；#843 D5 起**由声明表驱动**）。
 *
 * 事实源与方向不再写在这里：`scripts/data/threshold-registry.json` 逐条声明「哪个文件、哪条路径、
 * 哪个 kind、哪个方向是放宽、删键算不算放宽」，比较逻辑按 kind 通用求值（scripts/lib/threshold-registry.mjs）。
 * 为什么改：原先是一条条 if 手写——新增一个阈值/开关/预算事实源就要手写读取分支，方向语义散落在各 if 里，
 * 「新增事实源忘了加守卫」没有任何判据能拦（本轮审计的 S1/S2/T1/M-1/M-2 都是这么漏出去的）。
 * 现在未登记的事实源一律判红（枚举口径 = 运行时读 scripts/data/*.json，见声明表的 note）。
 *
 * 唯一保留的**非 JSON 读取器**是 vitest.config.ts：覆盖率阈值在 #733 计划项 3.4 才迁到
 * scripts/data/coverage.config.json，基准侧仍可能只有 .ts，故该源走 acorn 词法+表达式解析
 * （不能用正则：`thresholds\s*:\s*\{([^}]*)\}` 会在第一个 `}` 截断，块内注释里的伪值也会被采信）。
 * 迁移期双读的语义现在是数据：coverage 守卫的 sources 是 [JSON, .ts]，按顺序取第一个存在的源。
 *
 * 声明表自己也被同一套语义守着（#843 对抗评审 P0-1）：guard 只许新增，同 id 的判据形状字段
 * （kind / weaken / weakenValue / onRemoval / paths / keys / anchorFields / requireFields / sources /
 * missingIsError / nonMonotonic / minAllowed / maxAllowed）相对基准只许补全收紧，除非在表里显式登记
 * `retired`（整条退役）或 `contractApprovals`（改某个字段），两者都要求 trackingIssue + reason，
 * 且都做反向腐烂校验。否则「删一条 guard / 翻一个 direction / 把 onRemoval 改成 ignore」就是一行
 * 数据改动且 CI 全绿。
 * `sources` 是回落链，只许**尾部追加**：前置一个镜像基准值的影子源能让基准侧与工作区侧解析到
 * 不同的事实源，守卫于是对着影子文件判绿而真实事实源已被改弱（#850 批次评审 F-1）。声明表比对
 * 之外，比较器还记录两侧实际命中的源，工作区命中基准未声明的文件即判红——两道判据不同源。
 *
 * 用法：node scripts/gate/threshold-monotonic.mjs [git-ref]
 * 退出码：0 = 无判据放宽；1 = 存在放宽/摘除（含声明表自身被削弱）；2 = 声明表、事实源或环境故障（fail-closed）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExpressionAt, tokenizer } from "acorn";
import { loadLedger } from "../lib/exemption-gate.ts";
import {
  REGISTRY_PATH,
  compareDeclarationTable,
  compareRegistry,
  loadRegistry,
  makeSourceLoader,
  readJsonText,
  validateDeclarations,
  validateGuardFacts,
} from "../lib/threshold-registry.mjs";

/** 覆盖率阈值在 #733 计划项 3.4 前的旧事实源；声明表的 coverage 守卫把双读表达成 sources。 */
const VITEST_CONFIG = "vitest.config.ts";
/** 声明表里 existence 守卫的豁免通道（#765：临时项的唯一登记处）。 */
const EXEMPTIONS = "scripts/data/gate-exemptions.json";
const EXEMPTION_GATE = "threshold-registry";
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
function findThresholdsOpenToken(tokens) {
  for (;;) {
    const token = tokens.getToken();
    if (token.type.label === "eof") return null;
    if (token.type.label !== "name" || token.value !== "thresholds") continue;
    if (tokens.getToken().type.label !== ":") continue;
    const open = tokens.getToken();
    if (open.type.label !== "{") return null;
    return open;
  }
}

function findBalancedEnd(tokens, open) {
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

function locateThresholdsObject(text) {
  const tokens = tokenizer(text, ACORN_OPTIONS);
  const open = findThresholdsOpenToken(tokens);
  if (open === null) return null;
  return findBalancedEnd(tokens, open);
}

function readThresholdPropertyName(prop) {
  return prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
}

function collectCoverageThresholdKeys(node) {
  const global = {};
  const scoped = [];
  for (const prop of node.type === "ObjectExpression" ? node.properties : []) {
    if (prop.type !== "Property" || prop.computed) continue;
    const name = readThresholdPropertyName(prop);
    if (prop.value.type === "ObjectExpression") {
      scoped.push(String(name));
    } else if (prop.value.type === "Literal" && COVERAGE_THRESHOLD_KEYS.includes(name)) {
      if (typeof prop.value.value === "number") global[name] = prop.value.value;
    }
  }
  return { global, scoped };
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
  return collectCoverageThresholdKeys(node);
}

/**
 * 分包 glob 阈值不在本门禁的覆盖面内（比较它们需要 glob 语义，本仓当前也未使用），
 * 但静默略过会让「用 glob 键夹带高值、同时在别处削弱全局键」看起来全绿，故显式告警。
 */
export function warnScopedThresholds(label, parsed) {
  if (parsed.scoped.length === 0) return;
  console.warn(
    `threshold-monotonic: ${label} 含 ${parsed.scoped.length} 个 coverage.thresholds 分包 glob 键（${parsed.scoped.join(", ")}）—— 本门禁只比较全局键，分包阈值不在覆盖面内`,
  );
}

/**
 * 声明表里的 `.ts` 事实源读取器：把 acorn 解析结果整理成与 JSON 同构的形状，
 * 使「路径 + keys」这套通用求值对两种源都成立（否则覆盖率这一条永远只能特判）。
 */
const TEXT_READERS = {
  [VITEST_CONFIG]: (text) => {
    const parsed = parseCoverageThresholds(text);
    if (parsed === null) return null;
    warnScopedThresholds(VITEST_CONFIG, parsed);
    return { thresholds: parsed.global };
  },
};

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

function readWorkspaceText(repoRoot, rel) {
  const path = join(repoRoot, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 包目录的子目录名清单：existence 守卫的 universe 由目录结构派生（不是第二份包名清单）。 */
function listPackages(repoRoot) {
  const dir = join(repoRoot, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => ({
      name,
      dirs: existsSync(join(dir, name)) ? readdirSync(join(dir, name)) : [],
    }));
}

function loadExemptions(repoRoot) {
  const path = join(repoRoot, EXEMPTIONS);
  return existsSync(path) ? loadLedger(path, EXEMPTION_GATE) : new Map();
}

/**
 * 主校验。返回 { exitCode, failures }；日志走 stdout/stderr。
 */
export function runThresholdMonotonic(
  argv = process.argv.slice(2),
  { repoRoot = process.cwd() } = {},
) {
  const baseRef = argv[0] ?? "origin/main";

  if (!refExists(baseRef, repoRoot)) {
    console.error(
      `threshold-monotonic: 基准 ref ${baseRef} 不可解析（fetch 了吗？）—— 环境故障按 fail-closed 处理`,
    );
    return { exitCode: 2, failures: 0 };
  }

  const readBase = (rel) =>
    existsInGit(baseRef, rel, repoRoot) ? readFromGit(baseRef, rel, repoRoot) : null;
  const readWorkspace = (rel) => readWorkspaceText(repoRoot, rel);

  let registry;
  try {
    registry = loadRegistry(repoRoot);
  } catch (err) {
    console.error(`threshold-monotonic: ${err.message} —— 环境故障按 fail-closed 处理`);
    return { exitCode: 2, failures: 0 };
  }

  // 声明表自己也要被守：未登记的事实源（新数据文件）与幽灵声明（路径取不到值）都判红，
  // 否则「声明表」会以另一种形态重演「新增事实源忘了加守卫」。
  // consumed 记录工作区侧**实际读到**的源：只在 sources 里列一个文件名不算登记，否则新 JSON
  // 挂进某条 guard 就洗白了「未登记即红」（影子源攻击正是这么进来的）。
  const consumed = new Set();
  const workspaceHits = [];
  const loaders = {
    loadBase: makeSourceLoader({ read: readBase, textReaders: TEXT_READERS, label: baseRef }),
    loadWorkspace: makeSourceLoader({
      read: readWorkspace,
      textReaders: TEXT_READERS,
      label: "工作区",
      onHit: (source, guard) => {
        consumed.add(source);
        workspaceHits.push({ id: guard.id, source });
      },
    }),
  };
  // 先跑幽灵判据校验：它同时把工作区实际读到的源记进 consumed，供下面的影子源判定使用。
  let problems;
  try {
    problems = validateGuardFacts(registry, loaders);
  } catch (err) {
    // 事实源损坏（如 gauntlet.config.json 写成坏 JSON）是配置错误，不是「判据放宽」——
    // 落在同一个 exit 2 通道，按退出码分流的调用方不会把它读成放宽。
    console.error(
      "threshold-monotonic: 声明表/事实源校验失败：" +
        err.message +
        " —— 环境故障按 fail-closed 处理",
    );
    return { exitCode: 2, failures: 0 };
  }

  // 工作区实际命中的源必须是基准为该 guard 声明过的事实源。命中一个基准从未声明的文件，
  // 说明有更靠前的源接管了这条守卫（影子源），两侧比的不是同一份事实——这是**判据放宽**，
  // 走 exit 1；报成 exit 2（配置/环境故障）会让读日志的人把攻击读成「工具坏了」，正是本轮
  // 踩过的坑；而「未登记的新数据文件」这类声明表覆盖问题仍留在 exit 2，两者语义不同。
  // 前提是基准 ref 上已有本表：基准尚无本表时（本表首次引入的那个 PR）这里无从比对，整体跳过，
  // 影子源态改由「未登记即红」以 exit 2 拦下，判词会点名「列过名字但没有任何 guard 读到」。
  let baseRegistry;
  if (existsInGit(baseRef, REGISTRY_PATH, repoRoot)) {
    try {
      baseRegistry = readJsonText(readFromGit(baseRef, REGISTRY_PATH, repoRoot), baseRef);
    } catch (err) {
      console.error(
        "threshold-monotonic: 读取 " +
          baseRef +
          ":" +
          REGISTRY_PATH +
          " 失败：" +
          err.message +
          " —— 环境故障按 fail-closed 处理",
      );
      return { exitCode: 2, failures: 0 };
    }
    // 只查「工作区命中」这一侧：反过来要求基准声明的源都被命中，会把回落链的备用源
    // （覆盖率迁移完成后不再被读的 vitest.config.ts）误判成攻击。
    const baseSourcesById = new Map(
      (baseRegistry.guards ?? []).map((item) => [item.id, item.sources ?? []]),
    );
    const shadowed = workspaceHits.filter((hit) => {
      const declared = baseSourcesById.get(hit.id);
      return declared !== undefined && !declared.includes(hit.source);
    });
    if (shadowed.length > 0) {
      for (const hit of shadowed) {
        console.error(
          "[FAIL] " +
            hit.source +
            " 不是基准对 " +
            hit.id +
            " 声明的事实源（" +
            (baseSourcesById.get(hit.id) ?? []).join(" / ") +
            "）—— 有更靠前的源接管了该守卫（影子源），两侧比的不是同一份事实，判据已放宽",
        );
      }
      console.error(
        "\nthreshold-monotonic: " + shadowed.length + " 处守卫被基准未声明的影子源接管",
      );
      return { exitCode: 1, failures: shadowed.length };
    }
  }

  try {
    problems.push(...validateDeclarations(registry, { repoRoot, consumed }));
  } catch (err) {
    console.error(
      "threshold-monotonic: 声明表/事实源校验失败：" +
        err.message +
        " —— 环境故障按 fail-closed 处理",
    );
    return { exitCode: 2, failures: 0 };
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[FAIL] 声明表：${problem}`);
    console.error(
      `\nthreshold-monotonic: 声明表有 ${problems.length} 处问题 —— 阈值事实源须逐条声明（#843 D5），按 fail-closed 处理`,
    );
    return { exitCode: 2, failures: 0 };
  }

  let exemptions;
  try {
    exemptions = loadExemptions(repoRoot);
  } catch (err) {
    console.error(
      `threshold-monotonic: 豁免台账不可读（${EXEMPTIONS}）：${err.message} —— fail-closed`,
    );
    return { exitCode: 2, failures: 0 };
  }

  // 声明表自身相对基准只许补全收紧（P0-1）：删 guard / 翻方向 / 关删键语义都在这里拦下。
  if (baseRegistry !== undefined) {
    const tableFailures = compareDeclarationTable(baseRegistry, registry);
    if (tableFailures.length > 0) {
      for (const failure of tableFailures) console.error("[FAIL] " + failure);
      console.error(
        "\nthreshold-monotonic: 声明表自身被削弱（" +
          tableFailures.length +
          " 处）—— 判据形状只许补全收紧，退役或改动须在表里登记",
      );
      return { exitCode: 1, failures: tableFailures.length };
    }
  } else {
    console.log(
      "threshold-monotonic: " +
        baseRef +
        " 上无 " +
        REGISTRY_PATH +
        " —— 首次引入，跳过声明表自身的对比",
    );
  }

  let result;
  try {
    result = compareRegistry({
      registry,
      readBase,
      readWorkspace,
      textReaders: TEXT_READERS,
      packages: listPackages(repoRoot),
      exemptions,
    });
  } catch (err) {
    console.error(
      "threshold-monotonic: 事实源比较失败：" + err.message + " —— 环境故障按 fail-closed 处理",
    );
    return { exitCode: 2, failures: 0 };
  }

  for (const skip of result.skips) console.log(`threshold-monotonic: ${skip}`);
  for (const warning of result.warnings) console.warn(`[WARN] ${warning}`);
  if (result.envErrors.length > 0) {
    for (const problem of result.envErrors) console.error(`[FAIL] ${problem}`);
    return { exitCode: 2, failures: 0 };
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`[FAIL] ${failure}`);
    console.error(
      `\nthreshold-monotonic: ${result.failures.length} 处判据放宽/摘除 —— 阈值治理红线（AGENTS.md / #85 v3 F3）`,
    );
    return { exitCode: 1, failures: result.failures.length };
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
