#!/usr/bin/env node
/**
 * 单函数 CRAP 检查（指导文档 5.0；移植自 gauntlet-demo/scripts/crap-check.mjs，
 * monorepo 适配：按 packages/<pkg>/lib 编译产物扫描——smoke 消费的就是它）。
 *
 *   CRAP = comp^2 * (1 - cov) + comp
 *
 * comp：acorn（ESTree）对 lib 编译产物的逐函数圈复杂度；
 * cov：c8 产出的 istanbul 格式 coverage/coverage-final.json 中该函数的命中状态。
 * 先跑 `pnpm cov` 生成覆盖率，再运行本脚本。
 *
 * 圈复杂度决策点口径——已计入：if / for / for-of / for-in / while / do-while /
 *   case / catch / 三元（ConditionalExpression）/ && / || / ?? / optional chaining（?.）
 * 未计入：label 语句、正则字面量内部逻辑。同行多函数的覆盖判定取「任一命中即算命中」，
 *   该宽松处理使 CRAP 系统性偏低（方向性偏差，校准阈值时须知）。
 *
 * 噪音过滤：esbuild 内联的 node_modules 依赖段与 `__` 前缀垫片函数不计入统计
 *   （发布物自包含导致依赖代码进 bundle，但它们不是本仓自写代码）。
 *
 * 阈值与判红开关唯一事实源 = scripts/data/gauntlet.config.json 的
 *   crap.threshold / crap.strict（`--threshold` 仅作临时覆盖，strict 无 argv 覆盖）。
 *   crap.strict=false：超阈热点 exit 0，仅落盘 coverage/crap-report.json（观察期）；
 *   crap.strict=true：超阈热点 exit 1。翻期只改 config，不改本脚本。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';

const repoRoot = process.cwd();
const configPath = join(repoRoot, 'scripts', 'data', 'gauntlet.config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
/** 阈值与 strict 唯一事实源 = scripts/data/gauntlet.config.json；--threshold 仅作临时覆盖。 */
const DEFAULT_THRESHOLD = config.crap?.threshold ?? 12;
const argv = process.argv.slice(2);
const idx = argv.indexOf('--threshold');
const threshold = Number(idx >= 0 ? argv[idx + 1] : DEFAULT_THRESHOLD);
if (!Number.isFinite(threshold) || threshold <= 0) {
  console.error('crap-check: invalid --threshold');
  process.exit(2);
}
const strict = Boolean(config.crap?.strict);

const coveragePath = join(repoRoot, 'coverage', 'coverage-final.json');
if (!existsSync(coveragePath)) {
  console.error('crap-check: coverage/coverage-final.json 不存在，请先运行 pnpm cov');
  process.exit(2);
}

/** 圈复杂度 = 1 + 决策点数（口径见文件头注释）。 */
function complexityOf(fnNode) {
  let count = 1;
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'IfStatement' || node.type === 'ForStatement'
      || node.type === 'ForOfStatement' || node.type === 'WhileStatement'
      || node.type === 'DoWhileStatement' || node.type === 'SwitchCase'
      || node.type === 'CatchClause' || node.type === 'ConditionalExpression'
      || node.type === 'ChainExpression') count++;
    else if (node.type === 'LogicalExpression') count++;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  }
  if (fnNode.body) visit(fnNode.body);
  return count;
}

/**
 * 标记 esbuild 注入的模块边界注释，划分「本仓段 / 依赖段」：
 * 形如 `// ../../node_modules/.pnpm/...` 的注释开启依赖段，直到下一个路径注释。
 */
function foreignSegments(code) {
  const segments = [];
  let current = null;
  let offset = 0;
  for (const line of code.split('\n')) {
    const m = /^\/\/ (\S+)\s*$/.exec(line);
    // 只把包含 `/` 的注释作为模块边界（路径注释），过滤 `@__NO_SIDE_EFFECTS__` 等
    // esbuild 内联注解——后者不关闭外层依赖段，避免依赖函数漏过滤。
    if (m && m[1].includes('/')) {
      if (current) segments.push({ start: current.start, end: offset, foreign: current.foreign });
      current = { start: offset, foreign: m[1].includes('node_modules') };
    }
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  if (current) segments.push({ start: current.start, end: offset, foreign: current.foreign });
  return segments.filter((s) => s.foreign);
}

function inForeign(offset, ranges) {
  return ranges.some((r) => offset >= r.start && offset < r.end);
}

/**
 * 收集垫片范围：esbuild 以 `var __xxx = (...) => ...` 形式定义的运行时辅助
 * （__async/__await/__generator 等），连同其函数体整体划为依赖段。
 */
function shimRanges(ast) {
  const ranges = [];
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier' && /^__/.test(node.id.name)
      && node.init && node.end != null && node.start != null) {
      ranges.push({ start: node.start, end: node.end });
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  }
  visit(ast);
  return ranges;
}

/** 收集一个文件的全部本仓函数，返回 {comp, line} 列表（line 为 1-based 起始行）。 */
function functionsOf(code) {
  // lib 宿主产物为 ESM，client 外壳为 IIFE：先按 module 解析，失败降级 script
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  } catch {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  }
  const foreign = foreignSegments(code);
  const shims = shimRanges(ast);
  const out = [];
  let skippedForeign = 0;
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression';
    if (isFn && node.body) {
      // 过滤 esbuild 垫片（__commonJS/__toESM/__async 等）与依赖段内函数
      const isShim = (node.id?.name ?? '').startsWith('__');
      if (isShim || inForeign(node.start, foreign) || inForeign(node.start, shims)) {
        skippedForeign++;
      } else {
        out.push({ comp: complexityOf(node), line: node.loc.start.line });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  }
  visit(ast);
  return { fns: out, skippedForeign };
}

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
const hotspots = [];
let totalFns = 0;
let coveredFns = 0;
let skippedForeignTotal = 0;

for (const [file, data] of Object.entries(coverage)) {
  // 只关心插件包编译产物（lib 目录），跳过测试脚本与工具链文件
  if (!/\/packages\/[^/]+\/lib\//.test(file)) continue;
  const rel = file.startsWith(repoRoot) ? file : join(repoRoot, file);
  if (!existsSync(rel)) continue;
  const { fns, skippedForeign } = functionsOf(readFileSync(rel, 'utf8'));
  skippedForeignTotal += skippedForeign;

  // istanbul fnMap：以 id 为键的对象；按声明起始行索引命中状态（同行多函数取「有命中即算命中」）
  const hitByLine = new Map();
  for (const [id, fn] of Object.entries(data.fnMap ?? {})) {
    const line = fn.loc?.start?.line ?? fn.decl?.start?.line;
    if (line == null) continue;
    const hit = (data.f?.[id] ?? 0) > 0;
    hitByLine.set(line, (hitByLine.get(line) ?? false) || hit);
  }

  for (const fn of fns) {
    totalFns++;
    const covered = hitByLine.get(fn.line) ?? false;
    if (covered) coveredFns++;
    const crap = fn.comp * fn.comp * (covered ? 0 : 1) + fn.comp;
    if (crap > threshold) {
      hotspots.push({ file: file.slice(repoRoot.length + 1), line: fn.line, comp: fn.comp, covered, crap });
    }
  }
}

hotspots.sort((a, b) => b.crap - a.crap);
console.log(`crap-check: 本仓函数 ${totalFns} 个（已排除依赖/垫片 ${skippedForeignTotal} 个），`
  + `已覆盖 ${coveredFns}（${totalFns ? Math.round((coveredFns / totalFns) * 100) : 0}%），阈值 ${threshold}`);

// 全量明细落盘，供 health-report 与趋势对比使用
mkdirSync(join(repoRoot, 'coverage'), { recursive: true });
writeFileSync(
  join(repoRoot, 'coverage', 'crap-report.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(), threshold, strict,
    totalFns, coveredFns, skippedForeignTotal, hotspots,
  }, null, 2),
);

if (hotspots.length) {
  console.log(`crap-check: 超阈热点 ${hotspots.length} 个（Top10）：`);
  for (const h of hotspots.slice(0, 10)) {
    console.log(`  CRAP=${h.crap} comp=${h.comp}${h.covered ? '' : ' 未覆盖'}  ${h.file}:${h.line}`);
  }
}

if (strict) {
  if (hotspots.length > 0) {
    console.error(`crap-check: [strict] 超阈热点 ${hotspots.length} 个，判定为红`);
    process.exit(1);
  }
  console.log('crap-check: [strict] 无超阈热点，OK');
} else {
  console.log('crap-check: OK（观察期模式：明细已落盘 coverage/crap-report.json）');
}
