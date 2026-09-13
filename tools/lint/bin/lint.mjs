#!/usr/bin/env node
/**
 * 仓库 lint 入口（#722 阶段五）。
 *
 * 为什么包一层而不直接跑 eslint：ESLint 的 basePath 由 cwd 决定，而 `eslint` 可执行文件位于
 * tools/lint/node_modules —— 直接在子包目录里跑会让配置文件中的 `files` 模式、以及 lint-staged
 * 传入的仓库根相对路径双双错位。这里把 cwd 恒定在仓库根，使两条路径口径统一。
 *
 * #764 落地项 A2：本入口同时是**警告预算**的执行点。ESLint 自带的 `--max-warnings` 在这里
 * 无效——参数会被下方的 `argv.filter` 静默丢弃，照抄 CLI 用法等于没有预算（实测）。故预算在
 * 此处对 errorCount + warningCount 求和判定，阈值取 scripts/data/gauntlet.config.json 的
 * `lint.maxWarnings`（与复杂度同一个阈值事实源、同一套治理）；预算只许降，上调由
 * scripts/gate/threshold-monotonic.mjs 判红。
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { ESLint } from "eslint";

const LINT_PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(LINT_PKG, "..", "..");
const GAUNTLET = join(REPO_ROOT, "scripts", "data", "gauntlet.config.json");
/** 存量基线抑制文件（#764 A4；基线内容与生成/修剪流程见 docs/DEVELOPMENT.md）。 */
const SUPPRESSIONS = join(REPO_ROOT, "eslint-suppressions.json");

/**
 * 判定失败的出口。为什么用 `process.exitCode` 而不是 `process.exit()`：后者会在**管道**下截断
 * 尚未冲刷的异步 stdout（实测：`| grep` 时汇总行整行丢失，重定向到文件则正常）——CI 日志正是
 * 走管道，判据结论本身被吞掉就等于没有结论。自然退出会让 Node 冲完缓冲。
 *
 * 取值只升不降：多个判据同时失败时保留最严的那个（2 = 环境/配置故障，高于 1 = 判红）。
 */
function fail(code) {
  process.exitCode = Math.max(process.exitCode ?? 0, code);
}

/**
 * 默认 lint 面：手写源码与其配置，不含构建产物（忽略规则见 eslint.config.js）。
 *
 * 为什么写成文件级 glob 而非目录：ESLint 的 lintFiles 对裸目录模式（形如「包目录 + src」）
 * 报 file-not-found，必须展开到文件；且扩展名要逐个列出，花括号写法匹配不到 .d.mts 一类多段后缀。
 */
const SOURCE_EXT = "{ts,tsx,mts,cts,js,mjs,cjs}";
const DEFAULT_PATTERNS = [
  `packages/*/src/**/*.${SOURCE_EXT}`,
  `packages/*/test/**/*.${SOURCE_EXT}`,
  `shared/**/*.${SOURCE_EXT}`,
  `scripts/**/*.${SOURCE_EXT}`,
  "tools/lint/eslint.config.js",
  `tools/lint/bin/*.${SOURCE_EXT}`,
  `vitest.config.${SOURCE_EXT}`,
];

/**
 * 读取警告预算。读不到或不是数字一律 fail-closed（exit 2）：预算被摘除时若静默放行，等于把
 * 「只增不减」原样还回去——而这条判据的全部价值就是它不会自己消失。
 */
function readBudget() {
  let config;
  try {
    config = JSON.parse(readFileSync(GAUNTLET, "utf8"));
  } catch (err) {
    console.error(`lint: 读取 ${GAUNTLET} 失败：${err.message} —— 预算事实源不可读，fail-closed`);
    process.exit(2);
  }
  const budget = config?.lint?.maxWarnings;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
    console.error(
      "lint: gauntlet.config.json 缺 lint.maxWarnings（正整数）—— 警告预算缺失，fail-closed",
    );
    process.exit(2);
  }
  return budget;
}

const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
// 显式覆盖只服务于本地排查与用例（CI 与提交钩子一律走默认值，防绕过）
const budgetArg = argv.find((a) => a.startsWith("--max-warnings="));
const budget = budgetArg === undefined ? readBudget() : Number(budgetArg.split("=")[1]);
if (!Number.isInteger(budget) || budget < 0) {
  console.error(`lint: --max-warnings= 需要一个非负整数（实际 ${budgetArg}）`);
  process.exit(2);
}
const patterns = argv.filter((a) => !a.startsWith("-"));
const lintedPatterns = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
// 与 --max-warnings= 同款：只服务本地排查与用例（CI 与钩子一律走仓库里那份基线，防绕过）
const suppressionsArg = argv.find((a) => a.startsWith("--suppressions="));
const suppressionsPath =
  suppressionsArg === undefined ? SUPPRESSIONS : suppressionsArg.slice("--suppressions=".length);

const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: join(LINT_PKG, "eslint.config.js"),
  fix,
  // #764 落地项 A4：应用官方 Bulk Suppressions 基线（存量挂账）。
  // 两个硬约束决定了它只能这么接：① 只有 **error** 级规则会被抑制（降为 warn 的规则挂不上账）；
  // ② 创建/修剪只能走 ESLint CLI（--suppress-all / --prune-suppressions），Node API 只负责应用。
  // 基线文件缺失时官方实现按空基线处理，故此处无需存在性判断。
  applySuppressions: true,
  suppressionsLocation: suppressionsPath,
});

const results = await eslint.lintFiles(lintedPatterns);
if (fix) await ESLint.outputFixes(results);

/**
 * 基线的「只许收缩」棘轮。为什么必须自己补：官方只在 **CLI** 侧检查「不再出现的条目」
 * （`--prune-suppressions` 的前置），而 Node API 的 lintFiles 把 `applySuppressions` 返回的
 * `unused` 直接丢弃——不补这一段，条目对应的存量被修掉之后没人会催你收缩基线，挂账只增不减
 * （ESLint 官方 issue #19706 说的也正是「同一提交里修掉旧警告、引入新警告」这类盲区）。
 *
 * 判据：基线条目数 > 实际被抑制条数 = 有存量已修掉而基线未收缩；判定只覆盖**本次 lint 到的文件**。
 */
function staleSuppressions(linted) {
  if (!existsSync(suppressionsPath)) return [];
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(suppressionsPath, "utf8"));
  } catch (err) {
    console.error(`lint: 基线 ${suppressionsPath} 解析失败：${err.message} —— fail-closed`);
    process.exit(2);
  }
  // 抑制消息按 result 分组（SuppressedLintMessage 自身不带 filePath），故以 result 为文件来源
  const actual = new Map();
  const lintedFiles = new Set();
  for (const result of linted) {
    const rel = relative(REPO_ROOT, result.filePath).replaceAll("\\", "/");
    lintedFiles.add(rel);
    for (const message of result.suppressedMessages ?? []) {
      const key = `${rel}\u0000${message.ruleId}`;
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
  }
  const stale = [];
  for (const [file, rules] of Object.entries(baseline)) {
    // 本次没 lint 到它（提交钩子只喂 staged 文件，或显式传了子集）→ 不在判定范围内。
    // 与官方 prune 同口径：只能对**真正跑过的文件**说「条目多余」。少了这一条，任何子集运行
    // 都会把其余文件的条目全判成失效（实测：pre-commit 钩子因此直接拦住提交）。
    // 文件被删则无论如何都算失效，故先用存在性单独判一次——它不依赖本次跑过哪些文件。
    if (!existsSync(join(REPO_ROOT, file))) {
      stale.push(`${file} → 文件已不存在（基线条目应删除）`);
      continue;
    }
    if (!lintedFiles.has(file)) continue;
    for (const [rule, entry] of Object.entries(rules)) {
      const suppressedHere = actual.get(`${file}\u0000${rule}`) ?? 0;
      if (entry.count > suppressedHere) {
        stale.push(`${file} → ${rule}：基线 ${entry.count}，实际只剩 ${suppressedHere}`);
      }
    }
  }
  return stale;
}

const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output.trim() !== "") console.log(output);

// 被抑制的消息挂在每个 result 上（ESLint 10 的 Node API 没有 getSuppressedMessages 方法）
const suppressedCount = results.reduce((n, r) => n + (r.suppressedMessages?.length ?? 0), 0);
const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
const warningCount = results.reduce((n, r) => n + r.warningCount, 0);
const fileCount = results.length;
const problems = errorCount + warningCount;
console.log(
  `lint: 检查 ${fileCount} 个文件，error ${errorCount}，warning ${warningCount}（合计 ${problems} / 预算 ${budget}，来源 scripts/data/gauntlet.config.json 的 lint.maxWarnings）；基线已抑制 ${suppressedCount} 处`,
);
if (errorCount > 0) fail(1);

// 有未抑制的错误时不再跑棘轮与预算：此刻「基线 > 实际」是违背基线造成的，不是条目失效，
// 报出来只会把「超基线」说成「该 prune」，误导修复方向。
if (errorCount === 0) {
  const stale = staleSuppressions(results);
  if (stale.length > 0) {
    console.error(
      `lint: 基线里有 ${stale.length} 处条目已经失效（存量被修掉或文件被删，基线未收缩）—— 基线只许减不许留：`,
    );
    for (const item of stale.slice(0, 10)) console.error(`  - ${item}`);
    if (stale.length > 10) console.error(`  ...（其余 ${stale.length - 10} 处同类）`);
    console.error(
      `请收缩基线后重跑：./tools/lint/node_modules/.bin/eslint --config tools/lint/eslint.config.js --prune-suppressions --suppressions-location eslint-suppressions.json ${DEFAULT_PATTERNS.map((p) => `'${p}'`).join(" ")}`,
    );
    fail(1);
  }

  if (problems > budget) {
    console.error(
      `lint: 问题总数 ${problems} 超出预算 ${budget}（超出 ${problems - budget}）—— 警告预算只许降不许升：` +
        "要么修掉新增问题，要么在原 issue 内取得 approved 后下调 scripts/data/gauntlet.config.json 的 lint.maxWarnings",
    );
    fail(1);
  }
}
