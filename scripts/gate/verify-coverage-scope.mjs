#!/usr/bin/env node
/**
 * verify-coverage-scope — 覆盖率面（include / exclude / thresholds）的判据（#733 计划项 3.4）。
 *
 * 为什么需要它：覆盖率面此前内联在 `vitest.config.ts` 里，没有任何判据守着——「改算什么」与
 * 「改卡多严」在 diff 里长得一样；#722 的基线注释（分母 132 文件）与静态复算（223）差了 40%，
 * 无人能解释；`.d.mts`、`.ps1` 这类 src 下的文件既不进分母也不进任何清单，属**静默逃逸**
 * （旧口径下 `uncoveredSrcFiles` 报 0，先例自身就是一次已发生的假绿）。故本闸判六件事：
 *
 *   1. **单一事实源**：`vitest.config.ts` 不得再内联 `thresholds` / `include` / `exclude` 字面量
 *      ——两个事实源必然有一处先腐烂（原则 ④）。
 *   2. **条目结构**：每条 exclude 必须带 `reason` 与 `kind`（值域三值，无第三条路）；
 *      `reviewBy` / `exitCriteria` **只允许且必须由** `pending-project` 携带——给永久事实编到期日
 *      只会逼出「永不续期」的假条目，而临时豁免缺了到期日或解除条件就成了永久事实（原则 ⑤）。
 *   3. **kind 与命中文件形态自洽**：结构合法 ≠ 声明正确——把 `.ts` 源码写成 `not-source` 同样能
 *      过结构校验，却让真实源码退出分母而两条闸都不响。故 `not-source` 不得命中 include 面内的
 *      文件（判据直接用 include 的 glob 判定，不镜像源码后缀表——镜像会与 include 漂移：`.js` 只
 *      由 shared 那条 include 引入，套到各包的 src 面就会把面外的 `.js` 误判成源码），也不得命中
 *      声明文件（面外的声明文件归 `type-only`，仍要认）；`type-only` 只许命中 `.d.ts` / `.d.mts`；
 *      `pending-project` 不作形态限制（它本来就是「是源码，等某个 project 落地」）。
 *   4. **面完整性**：物理枚举 `packages/<pkg>/src/**` 与 `shared/**` 下的**每个文件**，必须落在
 *      include 或某条 exclude 里。未分类即红——新形态资源（新扩展名、新的非源码资产）不能靠
 *      「没写进清单」逃逸。
 *   5. **条目腐烂**：每条 include / exclude 模式都必须命中至少一个物理文件；命中 0 个即红
 *      （条目指向的东西已经不存在了）。
 *   6. **产物交叉断言**：若 `coverage/coverage-final.json` 存在且**比本配置新**，断言其 keys
 *      不超出 include 减 exclude 的源码面；其中具有自身可计数语句的文件不得缺失。
 *      纯类型与仅静态导入/重导出的模块无 Istanbul 计数器，由语法解析确认，不按文件名豁免。
 *      无产物或产物不比配置新时保留静态预检；强制新鲜度与执行指纹不属于这里的判据。
 *
 * 匹配与「源码世界」定义都用 `scripts/lib/glob-files.mjs`（与变异面判据 `gen-stryker-conf --check`
 * 的 ⑤/⑥ 同一份实现与同一个 universe），不引第三方 glob。
 * 用法：node scripts/gate/verify-coverage-scope.mjs [--root <dir>] [--coverage-config <file>]
 * 退出码：0 = 通过；1 = 有违规；2 = 结构/环境错误（配置不可读、include 面为空）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";

import { SOURCE_UNIVERSE_PATTERNS, globFiles, sourceUniverse } from "../lib/glob-files.mjs";
import { failClosed } from "../lib/gate-exit.mjs";

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
/** 两个临时字段各自的语义，判词里直接说清缺的是哪件事。 */
const PENDING_FIELD_MEANING = { reviewBy: "何时再看一眼", exitCriteria: "凭什么能删" };
/** type-only 唯一允许命中的后缀：无运行时代码的声明文件。 */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts"];
/** 判词里最多逐个列出的命中文件数；超出只列前缀并附总数（不静默截断）。 */
const SHAPE_SAMPLE = 5;

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
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
    if (entry.kind === "pending-project") {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        problems.push(
          `${label}：pending-project 必须带 ${field}（${PENDING_FIELD_MEANING[field]}）——临时豁免缺了它就成了永久事实，台账里也无人知道何时能删`,
        );
      }
    } else if (entry[field] !== undefined) {
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

/** 读配置并做结构校验；失败返回 { error }（main 据此 failClosed），成功返回 { config }。 */
function loadCoverageConfig(configPath, configRel) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { error: `verify-coverage-scope: 覆盖率配置不可读（${configRel}）：${e.message}` };
  }
  if (!Array.isArray(config.include) || config.include.length === 0) {
    return {
      error: `verify-coverage-scope: ${configRel} 缺非空 include —— 覆盖率分母为空是配置错误`,
    };
  }
  if (config.thresholds === null || typeof config.thresholds !== "object") {
    return { error: `verify-coverage-scope: ${configRel} 缺 thresholds 对象` };
  }
  if (Object.keys(config.thresholds).length === 0) {
    return {
      error: `verify-coverage-scope: ${configRel} 的 thresholds 没有任何键 —— 全局硬门禁被摘除，fail-closed`,
    };
  }
  return { config };
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

/** 判词里的命中文件清单：超过样例上限只列前缀并附总数，不静默截断。 */
function sampleFiles(files) {
  return files.length <= SHAPE_SAMPLE
    ? files.join("、")
    : `${files.slice(0, SHAPE_SAMPLE).join("、")} 等 ${files.length} 个`;
}

/**
 * kind ↔ 命中文件形态一致性：结构合法只说明条目声明得「像」，不保证「声明得对」——
 * 把 `.ts` 源码写成 `not-source` 同样能过结构校验，却让真实源码退出分母而两条闸都不响。
 * 「是不是源码」直接问 include 的 glob，不镜像一份后缀表：后缀表是全 include 面的并集，
 * 按 pattern 全局套用就会把只在部分 include 上成立的后缀（如 shared 那条 include 引入的 `.js`）
 * 误判到别的 pattern 上，判词依据也随之失真。代价是放弃「资源性」判定——面外的代码文件标成
 * not-source 不再判红；这条取舍可以接受：该判定本无机械依据（后缀证明不了资源性），且面外文件
 * 本就不在分母里，标 not-source 与标 pending-project 对覆盖率没有差别，台账要登记的是「把代码
 * 排除出分母」这个动作，面外文件不是被条目排除的，要求登记反而是错的口径。剩下的只是 kind 值域
 * 与文件性质的语义诚实性问题，没有机械后果；而「将来 include 面扩大、旧条目开始命中面内文件」
 * 这条静默通道由本判据自己关掉：它每次都对当时的 include 面求值，面一扩大当场判红。
 * 声明文件另算：面外的 `.d.ts` 不被任何 include 命中，但把它写成 not-source 是把声明错当资源，
 * 故「声明文件须走 type-only」不随面放宽。
 * 命中 0 个由「条目腐烂」单独判红，kind 越界由结构判据报，这里都不重复。
 */
export function kindShapeProblems(pattern, kind, hits, includeFace) {
  if (hits.length === 0) return [];
  const suffixList = (list) => list.join(" / ");
  if (kind === "not-source") {
    const inFace = hits.filter((f) => includeFace.has(f));
    const declarations = hits.filter(
      (f) => !includeFace.has(f) && DECLARATION_SUFFIXES.some((s) => f.endsWith(s)),
    );
    if (inFace.length === 0 && declarations.length === 0) return [];
    const named = inFace.map((f) => `${f}（命中 include 模式 ${includeFace.get(f).join(" / ")}）`);
    const parts = [];
    if (named.length > 0) {
      parts.push(`${named.length} 个在 include 面内的文件：${sampleFiles(named)}`);
    }
    if (declarations.length > 0) {
      parts.push(`${declarations.length} 个声明文件：${sampleFiles(declarations)}`);
    }
    return [
      `exclude 条目 ${pattern}（kind=not-source）命中 ${parts.join("；")}——not-source 只允许命中 include 面之外的非声明资源：把源码移出分母必须改用 kind=pending-project 并写明 reviewBy/exitCriteria，声明文件应改用 kind=type-only`,
    ];
  }
  if (kind === "type-only") {
    const bad = hits.filter((f) => !DECLARATION_SUFFIXES.some((s) => f.endsWith(s)));
    if (bad.length === 0) return [];
    return [
      `exclude 条目 ${pattern}（kind=type-only）命中 ${bad.length} 个非声明文件：${sampleFiles(bad)}——type-only 只允许 ${suffixList(DECLARATION_SUFFIXES)}（无运行时代码的声明）；把可执行源码声明成 type-only 只是把缺口藏起来`,
    ];
  }
  return []; // pending-project 不作形态限制：它本来就是「是源码，但要等某个 project 落地才计」
}

/** 全部 exclude 条目的形态一致性判据（结构本身不合法的条目由 checkExcludeEntries 负责）。 */
function excludeKindShapeProblems(entries, hitsInUniverse, includeFace) {
  const problems = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.pattern !== "string" || !KINDS.includes(entry.kind)) continue;
    problems.push(
      ...kindShapeProblems(entry.pattern, entry.kind, hitsInUniverse(entry.pattern), includeFace),
    );
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

/**
 * Istanbul 不为仅含类型或静态导入/重导出的模块生成计数器。
 * 用 Node 的类型擦除与已有 Acorn 解析实际语句，不按文件名放行；
 * 不支持的语法或解析失败保守要求产物，不能据此把执行源码洗成门面。
 */
function hasNoInstrumentableStatements(root, file) {
  try {
    const source = readFileSync(join(root, file), "utf8");
    const javascript = /\.[cm]?tsx?$/.test(file)
      ? stripTypeScriptTypes(source, { mode: "strip" })
      : source;
    const ast = parse(javascript, { ecmaVersion: "latest", sourceType: "module" });
    return ast.body.every(
      (statement) =>
        statement.type === "EmptyStatement" ||
        statement.type === "ImportDeclaration" ||
        statement.type === "ExportAllDeclaration" ||
        (statement.type === "ExportNamedDeclaration" && statement.declaration === null),
    );
  } catch {
    return false;
  }
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
  const reported = new Set(keys);
  const absent = [...scored].filter((file) => !reported.has(file));
  const missing = absent.filter((file) => !hasNoInstrumentableStatements(root, file));
  for (const file of missing) {
    problems.push(`${file} 在当前计分面内但未出现在覆盖率产物里（分母与产物不一致：计分对象缺失）`);
  }
  return `产物交叉断言：${keys.length} 个 keys，面内 ${keys.length - outside.length}，缺失 ${missing.length}，无自身可计数语句 ${absent.length - missing.length}`;
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const configRel = argValue(process.argv, "--coverage-config", COVERAGE_CONFIG_REL);
  const configPath = join(root, configRel);

  const loaded = loadCoverageConfig(configPath, configRel);
  if (loaded.error !== undefined) failClosed(loaded.error);
  const config = loaded.config;
  const thresholdKeys = Object.keys(config.thresholds);

  const problems = [];
  problems.push(...checkExcludeEntries(config.exclude));

  const vitestConfigPath = join(root, VITEST_CONFIG_REL);
  if (!existsSync(vitestConfigPath)) {
    failClosed(`verify-coverage-scope: 缺 ${VITEST_CONFIG_REL}（fail-closed）`);
  }
  problems.push(...inlineLiteralProblems(readFileSync(vitestConfigPath, "utf8")));

  // 物理面（每次现算，不存清单）与实际计分面：universe 定义与变异面共用一份（glob-files.mjs）
  const universe = sourceUniverse(root);
  if (universe.size === 0) {
    failClosed(
      `verify-coverage-scope: universe 为空（${SOURCE_UNIVERSE_PATTERNS.join(" + ")} 没匹配到任何文件）—— 提取口径失效，fail-closed`,
    );
  }
  const includePatterns = config.include;
  const excludePatterns = config.exclude.map((e) => e.pattern);
  // 模式在覆盖率根内命中的文件：根外的命中不算数（client 通配也会命中 node_modules）。
  // 同一条 pattern 会被腐烂 / 形态 / 面完整性三处问到，而 universe 在一次运行内不变，故缓存展开结果。
  const hitsCache = new Map();
  const hitsInUniverse = (pattern) => {
    if (!hitsCache.has(pattern)) {
      hitsCache.set(
        pattern,
        globFiles(root, pattern).filter((f) => universe.has(f)),
      );
    }
    return hitsCache.get(pattern);
  };
  // include 面（文件 → 命中它的 include 模式）：not-source 的判据与判词都要按面判定，
  // 逐个文件记住来源 pattern，判红时才能指明是哪条 include 把它算进来的。
  const includeFace = new Map();
  for (const pattern of includePatterns) {
    for (const file of hitsInUniverse(pattern)) {
      if (!includeFace.has(file)) includeFace.set(file, []);
      includeFace.get(file).push(pattern);
    }
  }
  const includeHits = new Set(includeFace.keys());
  const excludeHits = new Set(excludePatterns.flatMap(hitsInUniverse));

  // 条目腐烂：模式必须在覆盖率根内命中至少一个文件
  problems.push(...rottenPatternProblems("include", includePatterns, hitsInUniverse));
  problems.push(...rottenPatternProblems("exclude", excludePatterns, hitsInUniverse));

  // kind 与命中文件形态自洽：结构合法只说明声明得「像」，不保证「对」
  problems.push(...excludeKindShapeProblems(config.exclude, hitsInUniverse, includeFace));

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
