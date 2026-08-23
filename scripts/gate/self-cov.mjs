#!/usr/bin/env node
/**
 * self-cov — self-written 覆盖率口径报告
 *
 * 从 c8 的 coverage-final.json 中过滤掉 esbuild 内联的第三方 vendor 段与垫片，
 * 仅保留 self-written 函数/行/分支的覆盖率口径。
 *
 * 复用 crap-check.mjs 的已验证边界口径（esbuild 边界注释 / 垫片过滤 / 字节偏移分段），
 * 函数计数方式与 crap-check 完全一致（AST 遍历 + 逐行命中宽松判定），
 * 确保两个门禁的 self-written 函数计数完全吻合（单一事实源）。
 *
 * 输入：coverage/coverage-final.json（先跑 pnpm cov）
 * 输出：coverage/self-coverage.json + 文字摘要（--dry-run 仅预览不落盘）
 *
 * 用法：
 *   node scripts/gate/self-cov.mjs           # 文字+JSON 落盘
 *   node scripts/gate/self-cov.mjs --json    # 仅 stdout JSON 摘要（依然落盘，除非 --dry-run）
 *   node scripts/gate/self-cov.mjs --dry-run # 预览，不落盘
 *
 * 观察期模式：本脚本只记录不判红；gauntlet.config.json 的
 * coverage.selfWrittenFunctions 字段记录基线，不做硬卡点。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import * as acorn from 'acorn';

const repoRoot = process.cwd();
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const dryRun = argv.includes('--dry-run');

const coveragePath = join(repoRoot, 'coverage', 'coverage-final.json');
if (!existsSync(coveragePath)) {
  console.error('self-cov: coverage/coverage-final.json 不存在，请先运行 pnpm cov');
  process.exit(2);
}

// ── 分段工具（复用 crap-check.mjs 的已验证逻辑） ──────────────

/**
 * 预计算每行起始字节偏移，用于快速将 line/col 转为字节偏移。
 * 与 foreignSegments 的 offset 计算一致（每行末尾 +1 字节 '\n'）。
 * 返回数组 lineOffsets[len+1]，lineOffsets[i] = 第 i 行（1-based）起始字节偏移。
 */
function buildLineOffsets(code) {
  const offsets = [0]; // 第 0 行占位
  let offset = 0;
  for (const line of code.split('\n')) {
    offsets.push(offset);
    offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
  }
  return offsets;
}

/** 根据预计算的 lineOffsets 将 line/col 转为字节偏移 */
function lineColToOffset(lineOffsets, line, col) {
  return lineOffsets[line] + col;
}

/** 标记 esbuild 注入的模块边界注释，划分「本仓段 / 依赖段」 */
function foreignSegments(code) {
  const segments = [];
  let current = null;
  let offset = 0;
  for (const line of code.split('\n')) {
    const m = /^\/\/ (\S+)\s*$/.exec(line);
    if (m) {
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

/** 收集垫片范围：esbuild 以 `var __xxx = (...) => ...` 形式定义的运行时辅助 */
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

// ── 路径解析 ────────────────────────────────────────────────

/**
 * coverage-final.json 的键可能是：
 *   1. 本 checkout 绝对路径（生成覆盖时在本目录）；
 *   2. 其它 checkout 绝对路径（如 pnpm cov 在另一个 worktree 中跑，产物被复制）；
 *   3. 相对路径（异常情况）。
 *
 * 返回 { abs, rel } 或 null（跳过）。
 */
function resolveCoverageKey(file) {
  const normalized = file.replace(/[\\/]+/g, '/');

  // 情况 1：本 checkout 绝对路径
  if (normalized.startsWith(repoRoot + '/')) {
    return { abs: normalized, rel: normalized.slice(repoRoot.length + 1) };
  }

  // 情况 2：其它 checkout 绝对路径 → 提取 packages/<pkg>/lib/* 相对部分
  const m = normalized.match(/(packages\/[^/]+\/lib\/[^\s]+)$/);
  if (m) {
    return { abs: resolve(repoRoot, m[1]), rel: m[1] };
  }

  // 情况 3：绝对路径但不在本仓库且不含 packages/ → 跳过
  if (isAbsolute(normalized)) return null;

  // 相对路径 → 直接解析
  return { abs: resolve(repoRoot, normalized), rel: normalized };
}

// ── 函数收集（与 crap-check.mjs 一致：AST 遍历 + 每行宽松判定） ───

/**
 * 与 crap-check.mjs functionsOf 完全一致：收集自写函数的起始行。
 * 返回 {fns, skipped, foreign, shims, lineOffsets}。
 */
function analyzeFile(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  } catch {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true });
  }
  const foreign = foreignSegments(code);
  const shims = shimRanges(ast);
  const lineOffsets = buildLineOffsets(code);
  const fns = [];
  let skipped = 0;

  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression';
    if (isFn && node.body) {
      const isShim = (node.id?.name ?? '').startsWith('__');
      if (isShim || inForeign(node.start, foreign) || inForeign(node.start, shims)) {
        skipped++;
      } else {
        fns.push({ line: node.loc.start.line });
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
  return { fns, skipped, foreign, shims, lineOffsets };
}

// ── 主逻辑 ────────────────────────────────────────────────────

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
const report = {
  generatedAt: new Date().toISOString(),
  selfWritten: {
    lines: { total: 0, covered: 0, pct: 0 },
    functions: { total: 0, covered: 0, pct: 0 },
    branches: { total: 0, covered: 0, pct: 0 },
  },
  perFile: {},
  skippedForeign: 0,
};

for (const [file, data] of Object.entries(coverage)) {
  // 只关心插件包编译产物（lib 目录），跳过测试脚本与工具链文件
  if (!/\/packages\/[^/]+\/lib\//.test(file)) continue;

  const resolved = resolveCoverageKey(file);
  if (!resolved || !existsSync(resolved.abs)) continue;

  const code = readFileSync(resolved.abs, 'utf8');

  // 单次解析：AST + 分段 + 偏移表（与 crap-check 一致的函数收集）
  const { fns, skipped, foreign, shims, lineOffsets } = analyzeFile(code);

  // 构建逐行命中映射（与 crap-check.mjs:164-170 一致）
  const hitByLine = new Map();
  for (const [id, fn] of Object.entries(data.fnMap ?? {})) {
    const line = fn.loc?.start?.line ?? fn.decl?.start?.line;
    if (line == null) continue;
    const hit = (data.f?.[id] ?? 0) > 0;
    hitByLine.set(line, (hitByLine.get(line) ?? false) || hit);
  }

  // 函数统计（AST 自写函数 + 逐行宽松命中判定）
  let fnTotal = 0, fnCovered = 0;
  for (const fn of fns) {
    fnTotal++;
    if (hitByLine.get(fn.line) ?? false) fnCovered++;
  }

  // 语句/行统计（statementMap + 自写段过滤）
  let stmtTotal = 0, stmtCovered = 0;
  for (const [id, stmt] of Object.entries(data.statementMap ?? {})) {
    const { line, column } = stmt.start;
    if (line == null || column == null) continue;
    const offset = lineColToOffset(lineOffsets, line, column);
    if (inForeign(offset, foreign) || inForeign(offset, shims)) continue;
    stmtTotal++;
    if ((data.s?.[id] ?? 0) > 0) stmtCovered++;
  }

  // 分支统计（branchMap + 自写段过滤）
  let brTotal = 0, brCovered = 0;
  for (const [id, branch] of Object.entries(data.branchMap ?? {})) {
    const { line, column } = branch.loc?.start ?? {};
    if (line == null || column == null) continue;
    const offset = lineColToOffset(lineOffsets, line, column);
    if (inForeign(offset, foreign) || inForeign(offset, shims)) continue;
    brTotal++;
    const hits = data.b?.[id] ?? [];
    if (Array.isArray(hits) && hits.some((h) => h > 0)) brCovered++;
  }

  // 汇总到全局
  report.selfWritten.functions.total += fnTotal;
  report.selfWritten.functions.covered += fnCovered;
  report.selfWritten.lines.total += stmtTotal;
  report.selfWritten.lines.covered += stmtCovered;
  report.selfWritten.branches.total += brTotal;
  report.selfWritten.branches.covered += brCovered;
  report.skippedForeign += skipped;

  report.perFile[resolved.rel] = {
    functions: { total: fnTotal, covered: fnCovered },
    lines: { total: stmtTotal, covered: stmtCovered },
    branches: { total: brTotal, covered: brCovered },
    skippedForeign: skipped,
  };
}

// 计算百分比
function calcPct(covered, total) {
  return total > 0 ? Math.round((covered / total) * 10000) / 100 : 0;
}
report.selfWritten.functions.pct = calcPct(report.selfWritten.functions.covered, report.selfWritten.functions.total);
report.selfWritten.lines.pct = calcPct(report.selfWritten.lines.covered, report.selfWritten.lines.total);
report.selfWritten.branches.pct = calcPct(report.selfWritten.branches.covered, report.selfWritten.branches.total);

// ── 输出 ──────────────────────────────────────────────────────

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    generatedAt: report.generatedAt,
    selfWritten: report.selfWritten,
    skippedForeign: report.skippedForeign,
  }));
} else {
  console.log('self-cov: self-written 覆盖率口径报告');
  console.log(`  lines:     ${report.selfWritten.lines.covered}/${report.selfWritten.lines.total} (${report.selfWritten.lines.pct}%)`);
  console.log(`  functions: ${report.selfWritten.functions.covered}/${report.selfWritten.functions.total} (${report.selfWritten.functions.pct}%)`);
  console.log(`  branches:  ${report.selfWritten.branches.covered}/${report.selfWritten.branches.total} (${report.selfWritten.branches.pct}%)`);
  console.log(`  已跳过（依赖/垫片）: ${report.skippedForeign} 个 IST 条目`);

  for (const [file, r] of Object.entries(report.perFile)) {
    const fnPct = calcPct(r.functions.covered, r.functions.total);
    const lnPct = calcPct(r.lines.covered, r.lines.total);
    const brPct = calcPct(r.branches.covered, r.branches.total);
    console.log(`  ${file}: fns=${r.functions.covered}/${r.functions.total}(${fnPct}%) lines=${r.lines.covered}/${r.lines.total}(${lnPct}%) branches=${r.branches.covered}/${r.branches.total}(${brPct}%)`);
  }
}

// 落盘：dry-run 不写文件；json 模式落盘到 stderr 确认，不污染 stdout
if (!dryRun) {
  mkdirSync(join(repoRoot, 'coverage'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'coverage', 'self-coverage.json'),
    JSON.stringify(report, null, 2),
  );
  const msg = 'self-cov: 明细已落盘 coverage/self-coverage.json';
  if (jsonMode) {
    process.stderr.write(msg + '\n');
  } else {
    console.log(msg);
  }
}