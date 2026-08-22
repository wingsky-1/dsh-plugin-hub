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
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';

/** 单函数 CRAP 上限（观察期起步值：随基线数据校准，外置于此为唯一事实源）。 */
const DEFAULT_THRESHOLD = 16;
const argv = process.argv.slice(2);
const idx = argv.indexOf('--threshold');
const threshold = Number(idx >= 0 ? argv[idx + 1] : DEFAULT_THRESHOLD);
if (!Number.isFinite(threshold) || threshold <= 0) {
  console.error('crap-check: invalid --threshold');
  process.exit(2);
}

const repoRoot = process.cwd();
const coveragePath = join(repoRoot, 'coverage', 'coverage-final.json');
if (!existsSync(coveragePath)) {
  console.error('crap-check: coverage/coverage-final.json 不存在，请先运行 pnpm cov');
  process.exit(2);
}

/** 圈复杂度 = 1 + 决策点数（if/for/while/do/case/catch/三元/&&/||/??）。 */
function complexityOf(fnNode) {
  let count = 1;
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'IfStatement' || node.type === 'ForStatement'
      || node.type === 'ForOfStatement' || node.type === 'WhileStatement'
      || node.type === 'DoWhileStatement' || node.type === 'SwitchCase'
      || node.type === 'CatchClause' || node.type === 'ConditionalExpression') count++;
    else if (node.type === 'LogicalExpression' && node.operator !== '??') count++;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  }
  if (fnNode.body) visit(fnNode.body);
  return count;
}

/** 收集一个文件的全部函数，返回 {comp, line} 列表（line 为 1-based 起始行）。 */
function functionsOf(code) {
  // lib 宿主产物为 ESM，client 外壳为 IIFE：先按 module 解析，失败降级 script
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  } catch {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  }
  const out = [];
  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression';
    if (isFn && node.body) out.push({ comp: complexityOf(node), line: node.loc.start.line });
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  }
  visit(ast);
  return out;
}

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
const hotspots = [];
let totalFns = 0;
let coveredFns = 0;

for (const [file, data] of Object.entries(coverage)) {
  // 只关心插件包编译产物（lib 目录），跳过测试脚本与工具链文件
  if (!/\/packages\/[^/]+\/lib\//.test(file)) continue;
  const rel = file.startsWith(repoRoot) ? file : join(repoRoot, file);
  if (!existsSync(rel)) continue;
  const fns = functionsOf(readFileSync(rel, 'utf8'));

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
console.log(`crap-check: 函数总数 ${totalFns}，已覆盖 ${coveredFns}`
  + `（${totalFns ? Math.round((coveredFns / totalFns) * 100) : 0}%），阈值 ${threshold}`);

// 全量明细落盘，供 health-report 与趋势对比使用
mkdirSync(join(repoRoot, 'coverage'), { recursive: true });
writeFileSync(
  join(repoRoot, 'coverage', 'crap-report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), threshold, totalFns, coveredFns, hotspots }, null, 2),
);

if (hotspots.length) {
  console.log(`crap-check: 超阈热点 ${hotspots.length} 个（Top10）：`);
  for (const h of hotspots.slice(0, 10)) {
    console.log(`  CRAP=${h.crap} comp=${h.comp}${h.covered ? '' : ' 未覆盖'}  ${h.file}:${h.line}`);
  }
}

// 观察期模式（默认）：只记录趋势与极端热点，不判红；基线校准后加 --strict 启用硬卡点
if (argv.includes('--strict')) {
  if (hotspots.length > 0) {
    console.error(`crap-check: [strict] 超阈热点 ${hotspots.length} 个，判定为红`);
    process.exit(1);
  }
  console.log('crap-check: [strict] 无超阈热点，OK');
} else {
  console.log('crap-check: OK（观察期模式：明细已落盘 coverage/crap-report.json）');
}
