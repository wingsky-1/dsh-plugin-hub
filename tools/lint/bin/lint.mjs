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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";

const LINT_PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(LINT_PKG, "..", "..");
const GAUNTLET = join(REPO_ROOT, "scripts", "data", "gauntlet.config.json");

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

const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: join(LINT_PKG, "eslint.config.js"),
  fix,
  // #764 落地项 A4：应用官方 Bulk Suppressions 基线（存量挂账）。
  // 两个硬约束决定了它只能这么接：① 只有 **error** 级规则会被抑制（降为 warn 的规则挂不上账）；
  // ② 创建/修剪只能走 ESLint CLI（--suppress-all / --prune-suppressions），Node API 只负责应用。
  // 基线文件缺失时官方实现按空基线处理，故此处无需存在性判断。
  applySuppressions: true,
  suppressionsLocation: join(REPO_ROOT, "eslint-suppressions.json"),
});

const results = await eslint.lintFiles(patterns.length > 0 ? patterns : DEFAULT_PATTERNS);
if (fix) await ESLint.outputFixes(results);

const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output.trim() !== "") console.log(output);

const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
const warningCount = results.reduce((n, r) => n + r.warningCount, 0);
const fileCount = results.length;
const problems = errorCount + warningCount;
console.log(
  `lint: 检查 ${fileCount} 个文件，error ${errorCount}，warning ${warningCount}（合计 ${problems} / 预算 ${budget}，来源 scripts/data/gauntlet.config.json 的 lint.maxWarnings）`,
);
if (errorCount > 0) process.exit(1);
if (problems > budget) {
  console.error(
    `lint: 问题总数 ${problems} 超出预算 ${budget}（超出 ${problems - budget}）—— 警告预算只许降不许升：` +
      "要么修掉新增问题，要么在原 issue 内取得 approved 后下调 scripts/data/gauntlet.config.json 的 lint.maxWarnings",
  );
  process.exit(1);
}
process.exit(0);
