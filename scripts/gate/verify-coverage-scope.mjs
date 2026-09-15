#!/usr/bin/env node
/**
 * verify-coverage-scope — 覆盖率面（include / exclude / thresholds）的判据（#733 计划项 3.4）。
 *
 * 为什么需要它：覆盖率面此前内联在 `vitest.config.ts` 里，没有任何判据守着——「改算什么」与
 * 「改卡多严」在 diff 里长得一样；#722 的基线注释（分母 132 文件）与静态复算（223）差了 40%，
 * 无人能解释；`.d.mts`、`.ps1` 这类 src 下的文件既不进分母也不进任何清单，属**静默逃逸**
 * （旧口径下 `uncoveredSrcFiles` 报 0，先例自身就是一次已发生的假绿）。故本闸判四件事：
 *
 *   1. **单一事实源**：`vitest.config.ts` 不得再内联 `thresholds` / `include` / `exclude` 字面量
 *      ——两个事实源必然有一处先腐烂（原则 ④）。
 *   2. **条目结构**：每条 exclude 必须带 `reason` 与 `kind`（值域三值，无第三条路）；
 *      `reviewBy` / `exitCriteria` **只允许** `pending-project` 携带——给永久事实编到期日只会
 *      逼出「永不续期」的假条目（原则 ⑤）。
 *   3. **面完整性**：物理枚举 `packages/<pkg>/src/**` 与 `shared/**` 下的**每个文件**，必须落在
 *      include 或某条 exclude 里。未分类即红——新形态资源（新扩展名、新的非源码资产）不能靠
 *      「没写进清单」逃逸。
 *   4. **条目腐烂**：每条 include / exclude 模式都必须命中至少一个物理文件；命中 0 个即红
 *      （条目指向的东西已经不存在了）。
 *   5. **产物交叉断言**：若 `coverage/coverage-final.json` 存在且**比本配置新**，断言其 keys
 *      全部落在 include 面内——用产物而不是第三次实现 glob 来验分母。产物比配置旧即跳过
 *      （那是上一次配置跑出来的东西，拿它判现在的面会假红）。
 *
 * 匹配用 `node:fs` 的 `globSync`（与 `test-surface.mjs` 同一实现），不引第三方 glob。
 * 用法：node scripts/gate/verify-coverage-scope.mjs [--root <dir>] [--coverage-config <file>]
 * 退出码：0 = 通过；1 = 有违规；2 = 结构/环境错误（配置不可读、include 面为空）。
 */
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const COVERAGE_CONFIG_REL = join("scripts", "data", "coverage.config.json");
const VITEST_CONFIG_REL = "vitest.config.ts";
const ARTIFACT_REL = join("coverage", "coverage-final.json");

/** exclude 条目的 kind 值域（无第三条路）。 */
const KINDS = ["type-only", "not-source", "pending-project"];
/** 只允许 pending-project 携带的字段：它们表达「临时性」，永久事实带上即是假条目。 */
const PENDING_ONLY_FIELDS = ["reviewBy", "exitCriteria"];
/** 必须由本文件持有、不得内联在 vitest.config.ts 的键。 */
const INLINE_KEYS = ["thresholds", "include", "exclude"];
/** 覆盖率的物理根（universe）：include 只可能落在这两处。 */
const UNIVERSE_PATTERNS = ["packages/*/src/**/*", "shared/**/*"];

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/** 展开 glob 取**文件**（相对 root 的 posix 路径，排序去重）。 */
function globFiles(root, pattern) {
  const out = new Set();
  for (const hit of globSync(pattern, { cwd: root })) {
    const abs = join(root, hit);
    try {
      if (statSync(abs).isFile()) out.add(hit.split("\\").join("/"));
    } catch {
      // 竞态下消失的文件忽略：universe 每次现算，不是清单
    }
  }
  return [...out].sort();
}

/** 条目形状（对象 + 非空 pattern）与重复检测；返回 null 表示后续判据无从谈起。 */
function checkEntryShape(entry, seen, problems) {
  if (entry === null || typeof entry !== "object") {
    problems.push("exclude 含非对象项");
    return null;
  }
  const label = typeof entry.pattern === "string" ? entry.pattern : "(缺 pattern)";
  if (typeof entry.pattern !== "string" || entry.pattern.length === 0) {
    problems.push("exclude 条目缺 pattern");
    return null;
  }
  if (seen.has(entry.pattern)) problems.push(`exclude 存在重复 pattern：${entry.pattern}`);
  seen.add(entry.pattern);
  return label;
}

/** reason 必填；kind 越界即停手——临时字段判据以 kind 为前提。 */
function checkEntryKind(entry, label, problems) {
  if (typeof entry.reason !== "string" || entry.reason.length < 10) {
    problems.push(`${label}：exclude 条目缺 reason（排除即缩小判据面，必须写明理由）`);
  }
  if (!KINDS.includes(entry.kind)) {
    problems.push(
      `${label}：kind 须为 ${KINDS.join(" / ")} 之一（当前 ${JSON.stringify(entry.kind)}）`,
    );
    return false;
  }
  for (const field of PENDING_ONLY_FIELDS) {
    if (entry[field] !== undefined && entry.kind !== "pending-project") {
      problems.push(
        `${label}：字段 ${field} 只允许 pending-project 携带（当前 kind=${entry.kind}）——给永久事实编到期日是假条目`,
      );
    }
  }
  return true;
}

/** 校验 exclude 条目结构；返回 problems。 */
export function checkExcludeEntries(entries) {
  const problems = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return ["coverage.config.json 的 exclude 必须是非空数组（结构错误，fail-closed）"];
  }
  const seen = new Set();
  for (const entry of entries) {
    const label = checkEntryShape(entry, seen, problems);
    if (label === null) continue;
    if (!checkEntryKind(entry, label, problems)) continue;
    if (entry.reviewBy !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.reviewBy))) {
      problems.push(
        `${label}：reviewBy 须形如 2027-03-31（当前 ${JSON.stringify(entry.reviewBy)}）`,
      );
    }
  }
  return problems;
}

/** 跳过一段字符串字面量：转义符连同被转义的一格一起越过。 */
function skipQuoted(text, i) {
  const q = text[i];
  i += 1;
  while (i < text.length && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
  return i;
}

/** 跳过行注释，返回换行符处（或文本末尾）的下标。 */
function skipLineComment(text, i) {
  while (i < text.length && text[i] !== "\n") i += 1;
  return i;
}

/** 跳过字符串字面量或行注释，返回停下的下标；两者都不是时返回 null。 */
function skipOpaqueToken(text, i) {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") return skipQuoted(text, i);
  if (ch === "/" && text[i + 1] === "/") return skipLineComment(text, i);
  return null;
}

/**
 * 切出 `coverage: { … }` 块（跳字符串与行注释，按花括号配平）。
 * 为什么必须限定在块内：`projects[].test.include` 是**测试面**，与覆盖率面是两件事——
 * 全局扫 `include:` 会把测试层的 include 误判成第二个事实源。
 */
function coverageBlock(text) {
  const at = /\bcoverage\s*:\s*\{/.exec(text);
  if (at === null) return "";
  let depth = 0;
  let i = at.index + at[0].length - 1;
  const start = i;
  while (i < text.length) {
    const ch = text[i];
    const opaqueEnd = skipOpaqueToken(text, i);
    if (opaqueEnd !== null) {
      i = opaqueEnd;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i += 1;
  }
  return text.slice(start);
}

/** vitest.config.ts 的 coverage 块是否仍内联 thresholds / include / exclude 字面量。 */
export function inlineLiteralProblems(text) {
  const problems = [];
  const block = coverageBlock(text);
  if (block === "") {
    problems.push(
      `${VITEST_CONFIG_REL} 缺 coverage 块——覆盖率面必须显式引用 ${COVERAGE_CONFIG_REL}`,
    );
    return problems;
  }
  const offset = text.indexOf(block);
  for (const key of INLINE_KEYS) {
    const re = new RegExp(`\\b${key}\\s*:\\s*([\\[{])`, "g");
    for (const m of block.matchAll(re)) {
      const line = text.slice(0, offset + m.index).split("\n").length;
      problems.push(
        `${VITEST_CONFIG_REL}:${line} 的 coverage 块内联了 ${key} ${m[1] === "[" ? "数组" : "对象"}字面量——覆盖率面的事实源是 ${COVERAGE_CONFIG_REL}（两个事实源必然有一处先腐烂）`,
      );
    }
  }
  return problems;
}

/** 读配置并做结构校验；失败原因已落 stderr，返回 null（main 据此 fail-closed）。 */
function loadCoverageConfig(configPath, configRel) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`verify-coverage-scope: 覆盖率配置不可读（${configRel}）：${e.message}`);
    return null;
  }
  if (!Array.isArray(config.include) || config.include.length === 0) {
    console.error(`verify-coverage-scope: ${configRel} 缺非空 include —— 覆盖率分母为空是配置错误`);
    return null;
  }
  if (config.thresholds === null || typeof config.thresholds !== "object") {
    console.error(`verify-coverage-scope: ${configRel} 缺 thresholds 对象`);
    return null;
  }
  if (Object.keys(config.thresholds).length === 0) {
    console.error(
      `verify-coverage-scope: ${configRel} 的 thresholds 没有任何键 —— 全局硬门禁被摘除，fail-closed`,
    );
    return null;
  }
  return config;
}

/** 物理覆盖率根：每次现算，不存清单（清单会漂移）。 */
function collectUniverse(root) {
  const universe = new Set();
  for (const pattern of UNIVERSE_PATTERNS) {
    for (const f of globFiles(root, pattern)) universe.add(f);
  }
  return universe;
}

/** 条目腐烂：模式在覆盖率根内命中 0 个文件即指向了不存在的东西。 */
function rottenPatternProblems(label, patterns, hitsInUniverse) {
  const problems = [];
  for (const pattern of patterns) {
    if (hitsInUniverse(pattern).length === 0) {
      problems.push(`${label} 模式在覆盖率根内命中 0 个文件（条目腐烂）：${pattern}`);
    }
  }
  return problems;
}

/** 面完整性：未分类文件即静默逃逸，必须显式落到 include 或某条 exclude。 */
function unclassifiedProblems(universe, includeHits, excludeHits) {
  const problems = [];
  for (const f of universe) {
    if (!includeHits.has(f) && !excludeHits.has(f)) {
      problems.push(
        `${f} 既不在 include 也不在任何 exclude 条目里（静默逃逸：新形态文件必须显式分类）`,
      );
    }
  }
  return problems;
}

/** 产物交叉断言：产物比配置旧时它反映的是旧的面，拿它判当前面会假红。 */
function artifactCrossCheck(root, configPath, includeHits, excludeHits, problems) {
  const artifactPath = join(root, ARTIFACT_REL);
  if (!existsSync(artifactPath) || statSync(artifactPath).mtimeMs <= statSync(configPath).mtimeMs) {
    return "未发现覆盖率产物（跳过交叉断言）";
  }
  const scored = new Set(includeHits);
  for (const f of excludeHits) scored.delete(f);
  const keys = Object.keys(JSON.parse(readFileSync(artifactPath, "utf8"))).map((k) =>
    k
      .split("\\")
      .join("/")
      .replace(`${root.split("\\").join("/")}/`, ""),
  );
  const outside = keys.filter((k) => !scored.has(k));
  for (const k of outside) {
    problems.push(
      `${k} 出现在覆盖率产物里但不在当前 include 面内（分母与产物不一致：include/exclude 改过而产物未重跑，或面算错）`,
    );
  }
  return `产物交叉断言：${keys.length} 个 keys，面内 ${keys.length - outside.length}`;
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const configRel = argValue(process.argv, "--coverage-config", COVERAGE_CONFIG_REL);
  const configPath = join(root, configRel);

  const config = loadCoverageConfig(configPath, configRel);
  if (config === null) return 2;
  const thresholdKeys = Object.keys(config.thresholds);

  const problems = [];
  problems.push(...checkExcludeEntries(config.exclude));

  const vitestConfigPath = join(root, VITEST_CONFIG_REL);
  if (!existsSync(vitestConfigPath)) {
    console.error(`verify-coverage-scope: 缺 ${VITEST_CONFIG_REL}（fail-closed）`);
    return 2;
  }
  problems.push(...inlineLiteralProblems(readFileSync(vitestConfigPath, "utf8")));

  // 物理面（每次现算，不存清单）与实际计分面
  const universe = collectUniverse(root);
  if (universe.size === 0) {
    console.error(
      `verify-coverage-scope: universe 为空（${UNIVERSE_PATTERNS.join(" + ")} 没匹配到任何文件）—— 提取口径失效，fail-closed`,
    );
    return 2;
  }
  const includePatterns = config.include;
  const excludePatterns = config.exclude.map((e) => e.pattern);
  // 模式在覆盖率根内命中的文件：根外的命中不算数（client 通配也会命中 node_modules）。
  const hitsInUniverse = (pattern) => globFiles(root, pattern).filter((f) => universe.has(f));
  const includeHits = new Set(includePatterns.flatMap(hitsInUniverse));
  const excludeHits = new Set(excludePatterns.flatMap(hitsInUniverse));

  // 条目腐烂：模式必须在覆盖率根内命中至少一个文件
  problems.push(...rottenPatternProblems("include", includePatterns, hitsInUniverse));
  problems.push(...rottenPatternProblems("exclude", excludePatterns, hitsInUniverse));

  // 面完整性：universe 里每个文件都必须被 include 或某条 exclude 覆盖
  problems.push(...unclassifiedProblems(universe, includeHits, excludeHits));

  // 产物交叉断言（仅在产物比配置新时执行——旧的产物反映的是旧的面）
  const artifactNote = artifactCrossCheck(root, configPath, includeHits, excludeHits, problems);

  if (problems.length > 0) {
    console.error(`verify-coverage-scope: ${problems.length} 条违规：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `verify-coverage-scope: FAIL（universe ${universe.size} 文件、include 面 ${includeHits.size}、exclude 命中 ${excludeHits.size}）`,
    );
    return 1;
  }
  const scoredCount = [...includeHits].filter((f) => !excludeHits.has(f)).length;
  console.log(
    `verify-coverage-scope: OK（universe ${universe.size} 文件 = include ${includeHits.size} − exclude ${excludeHits.size} → 计分 ${scoredCount}；阈值键 ${thresholdKeys.join("/")}；${artifactNote}）`,
  );
  return 0;
}

/** 仅直接执行时跑 main（被自测 import 时只取纯函数）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return statSync(process.argv[1]).ino === statSync(new URL(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main());
