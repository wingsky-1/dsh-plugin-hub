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
 * 模式说明：
 * 1. 全量模式（默认）：
 *    读取 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict。
 *    crap.strict=false：超阈热点 exit 0，仅落盘 coverage/crap-report.json（观察期）；
 *    crap.strict=true：超阈热点 exit 1。
 *
 * 2. 增量防劣化模式（--diff [base]）：
 *    对比 base（默认 origin/main，自适应 fallback）与当前工作区的改动：
 *    - 过滤只对本次改动触及的函数进行 CRAP 评估；
 *    - 新增函数：必须满足 CRAP <= threshold（默认 16）；
 *    - 修改的存量函数：若存量函数原本超标，修改后不得恶化（CRAP_new <= CRAP_base）；
 *    - 未触及的存量函数：全部豁免报警；
 *    - 存在新增超标或存量恶化时打印阻断日志并 exit 1；全部合规时 exit 0。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

/** 圈复杂度 = 1 + 决策点数（口径见文件头注释）。 */
export function complexityOf(fnNode) {
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
export function foreignSegments(code) {
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

export function inForeign(offset, ranges) {
  return ranges.some((r) => offset >= r.start && offset < r.end);
}

/**
 * 收集垫片范围：esbuild 以 `var __xxx = (...) => ...` 形式定义的运行时辅助
 * （__async/__await/__generator 等），连同其函数体整体划为依赖段。
 */
export function shimRanges(ast) {
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

/** 提取 AST 函数节点名或所在变量/属性名 */
function getFunctionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent) {
    if (parent.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
    if (parent.type === 'Property' || parent.type === 'MethodDefinition') {
      if (parent.key?.type === 'Identifier') return parent.key.name;
      if (parent.key?.type === 'Literal') return String(parent.key.value);
    }
    if (parent.type === 'AssignmentExpression') {
      if (parent.left?.type === 'Identifier') return parent.left.name;
      if (parent.left?.type === 'MemberExpression' && parent.left.property?.name) {
        return parent.left.property.name;
      }
    }
  }
  return '';
}

/** 收集一个文件的全部本仓函数，返回 {comp, line, startLine, endLine, name} 列表（line 为 1-based 起始行）。 */
export function functionsOf(code) {
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
  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression';
    if (isFn && node.body) {
      // 过滤 esbuild 垫片（__commonJS/__toESM/__async 等）与依赖段内函数
      const isShim = (node.id?.name ?? '').startsWith('__');
      if (isShim || inForeign(node.start, foreign) || inForeign(node.start, shims)) {
        skippedForeign++;
      } else {
        const startLine = node.loc.start.line;
        const endLine = node.loc.end.line;
        const name = getFunctionName(node, parent);
        out.push({
          name,
          comp: complexityOf(node),
          line: startLine,
          startLine,
          endLine,
        });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c, node);
      } else if (child && typeof child === 'object' && typeof child.type === 'string') {
        visit(child, node);
      }
    }
  }
  visit(ast, null);
  return { fns: out, skippedForeign };
}

/**
 * 解析 git diff -U0 的输出文本，构建文件改动元数据与变更行号集合。
 * 返回 Map<string, DiffFileEntry>，key 为相对路径。
 */
export function parseGitDiff(diffText) {
  const files = new Map();
  if (!diffText || typeof diffText !== 'string') return files;

  const lines = diffText.split('\n');
  let currentFile = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const parts = line.slice('diff --git '.length).trim().split(' ');
      const aPath = parts[0]?.replace(/^a\//, '') ?? '';
      const bPath = parts[1]?.replace(/^b\//, '') ?? '';
      const targetPath = (bPath && bPath !== '/dev/null') ? bPath : aPath;
      currentFile = {
        file: targetPath,
        oldFile: aPath,
        isNew: false,
        isDeleted: false,
        hunks: [],
        newChangedLines: new Set(),
        oldChangedLines: new Set(),
      };
      files.set(currentFile.file, currentFile);
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('--- /dev/null')) {
      currentFile.isNew = true;
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile.isDeleted = true;
      continue;
    }
    if (line.startsWith('--- a/')) {
      currentFile.oldFile = line.slice('--- a/'.length).trim();
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile.file = line.slice('+++ b/'.length).trim();
      files.set(currentFile.file, currentFile);
      continue;
    }

    // Hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@
    if (line.startsWith('@@ ')) {
      const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

        currentFile.hunks.push({ oldStart, oldCount, newStart, newCount });

        if (newCount > 0) {
          for (let l = newStart; l < newStart + newCount; l++) {
            currentFile.newChangedLines.add(l);
          }
        }
        if (oldCount > 0) {
          for (let l = oldStart; l < oldStart + oldCount; l++) {
            currentFile.oldChangedLines.add(l);
          }
        }
      }
    }
  }

  return files;
}

/**
 * 将新文件行号映射回老文件行号。
 * 若行落在新增/修改的 hunk 内部，返回 null；否则返回在老文件中的对应行号。
 */
export function mapNewToOldLine(newLine, hunks) {
  if (!hunks || hunks.length === 0) return newLine;
  let cumulativeOffset = 0;
  for (const hunk of hunks) {
    if (newLine < hunk.newStart) {
      return newLine - cumulativeOffset;
    }
    if (newLine >= hunk.newStart && newLine < hunk.newStart + hunk.newCount) {
      return null;
    }
    cumulativeOffset += (hunk.newCount - hunk.oldCount);
  }
  return newLine - cumulativeOffset;
}

/**
 * 将老文件行号映射到新文件行号。
 * 若行落在被删除/修改的 hunk 内部，返回 null；否则返回在新文件中的对应行号。
 */
export function mapOldToNewLine(oldLine, hunks) {
  if (!hunks || hunks.length === 0) return oldLine;
  let cumulativeOffset = 0;
  for (const hunk of hunks) {
    if (oldLine < hunk.oldStart) {
      return oldLine + cumulativeOffset;
    }
    if (oldLine >= hunk.oldStart && oldLine < hunk.oldStart + hunk.oldCount) {
      return null;
    }
    cumulativeOffset += (hunk.newCount - hunk.oldCount);
  }
  return oldLine + cumulativeOffset;
}

/**
 * 判断函数是否被改动触及（Touched）：
 * 1. 文件为全新增文件；
 * 2. 新版本中函数的 [startLine, endLine] 范围包含任何变更行；
 * 3. 存在纯删除插入点落在函数体内（newCount === 0）。
 */
export function isFunctionTouched(fn, fileDiff) {
  if (!fileDiff) return false;
  if (fileDiff.isNew) return true;

  for (let l = fn.startLine; l <= fn.endLine; l++) {
    if (fileDiff.newChangedLines.has(l)) return true;
  }

  for (const hunk of fileDiff.hunks) {
    if (hunk.newCount === 0 && hunk.newStart >= fn.startLine && hunk.newStart <= fn.endLine) {
      return true;
    }
  }

  return false;
}

/**
 * 在 baseFns 中寻找与当前新函数匹配的存量函数：
 * 优先依据行号映射匹配，次之同名匹配；未匹配则判定为新增函数。
 */
export function findBaseFunction(newFn, baseFns, hunks) {
  if (!baseFns || baseFns.length === 0) return null;

  // 1. 优先通过行号映射匹配
  const mappedOldLine = mapNewToOldLine(newFn.startLine, hunks);
  if (mappedOldLine !== null) {
    const exactMatch = baseFns.find((bf) => bf.startLine === mappedOldLine);
    if (exactMatch) {
      if (!newFn.name || !exactMatch.name || newFn.name === exactMatch.name) {
        return exactMatch;
      }
    }
  }

  // 2. 函数名匹配（当函数声明被修改或换行时）
  if (newFn.name) {
    const nameMatches = baseFns.filter((bf) => bf.name === newFn.name);
    if (nameMatches.length === 1) {
      return nameMatches[0];
    }
    if (nameMatches.length > 1) {
      const targetLine = mappedOldLine ?? newFn.startLine;
      return nameMatches.slice().sort((a, b) =>
        Math.abs(a.startLine - targetLine) - Math.abs(b.startLine - targetLine)
      )[0];
    }
  }

  // 3. 匿名函数在替换 hunk 内的对应
  if (!newFn.name && hunks) {
    for (const hunk of hunks) {
      if (newFn.startLine >= hunk.newStart && newFn.startLine < hunk.newStart + hunk.newCount) {
        const candidates = baseFns.filter((bf) =>
          !bf.name && bf.startLine >= hunk.oldStart && bf.startLine < hunk.oldStart + hunk.oldCount
        );
        if (candidates.length === 1) {
          return candidates[0];
        }
      }
    }
  }

  return null;
}

/**
 * 确定有效的 base git ref（支持 fallback）。
 */
export function resolveBaseRef(base, cwd) {
  const tryRef = (ref) => {
    const res = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return res.status === 0;
  };
  if (base && tryRef(base)) return base;
  if (!base || base === 'origin/main') {
    if (tryRef('origin/main')) return 'origin/main';
    if (tryRef('main')) return 'main';
    if (tryRef('HEAD~1')) return 'HEAD~1';
    if (tryRef('HEAD')) return 'HEAD';
  }
  return base || 'HEAD';
}

/**
 * 规范化文件路径为相对于 repoRoot 的正斜杠路径。
 */
function normalizeRelativePath(file, repoRoot) {
  const normFile = file.replace(/\\/g, '/');
  const normRoot = repoRoot.replace(/\\/g, '/');
  if (normFile.startsWith(normRoot + '/')) {
    return normFile.slice(normRoot.length + 1);
  }
  return normFile;
}

/**
 * 执行 --diff 增量防劣化评估
 */
export function runDiffCheck({ repoRoot, threshold, baseArg, coveragePath }) {
  const baseRef = resolveBaseRef(baseArg, repoRoot);
  const diffRes = spawnSync('git', ['diff', '-U0', baseRef, '--'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (diffRes.status !== 0) {
    console.error(`crap-check [diff]: git diff 失败（base: ${baseRef}）：${diffRes.stderr || '未知错误'}`);
    return { exitCode: 2, passed: false, violations: [] };
  }

  const diffFiles = parseGitDiff(diffRes.stdout);
  // 仅评估 packages/*/lib/ 目录下的改动文件
  const relevantDiffFiles = Array.from(diffFiles.entries()).filter(([path]) =>
    /\/packages\/[^/]+\/lib\//.test('/' + path.replace(/\\/g, '/'))
  );

  if (relevantDiffFiles.length === 0) {
    console.log(`crap-check [diff]: base=${baseRef}，未检测到插件包编译产物（packages/*/lib/）的代码变更，OK`);
    return { exitCode: 0, passed: true, violations: [] };
  }

  let coverage = {};
  if (existsSync(coveragePath)) {
    try {
      coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
    } catch {
      console.warn('crap-check [diff]: coverage/coverage-final.json 解析失败，默认按未覆盖评估');
    }
  } else {
    console.warn('crap-check [diff]: 未检测到 coverage/coverage-final.json，默认按未覆盖（cov=0）评估');
  }

  // 构建 coverage 索引：按 relativePath -> fileData
  const coverageByRel = new Map();
  for (const [covFile, covData] of Object.entries(coverage)) {
    const rel = normalizeRelativePath(covFile, repoRoot);
    coverageByRel.set(rel, covData);
  }

  const violations = [];
  let touchedCount = 0;
  let compliantCount = 0;

  for (const [relPath, fileDiff] of relevantDiffFiles) {
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) continue;

    const currentCode = readFileSync(absPath, 'utf8');
    const { fns: currentFns } = functionsOf(currentCode);

    // 读取 base 提交中的老文件内容
    let baseFns = [];
    if (!fileDiff.isNew) {
      const showRes = spawnSync('git', ['show', `${baseRef}:${fileDiff.oldFile || relPath}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (showRes.status === 0) {
        baseFns = functionsOf(showRes.stdout).fns;
      }
    }

    // 提取当前文件在 coverage 中的逐行命中状态
    const fileCov = coverageByRel.get(relPath);
    const hitByLine = new Map();
    if (fileCov?.fnMap) {
      for (const [id, fn] of Object.entries(fileCov.fnMap)) {
        const line = fn.loc?.start?.line ?? fn.decl?.start?.line;
        if (line == null) continue;
        const hit = (fileCov.f?.[id] ?? 0) > 0;
        hitByLine.set(line, (hitByLine.get(line) ?? false) || hit);
      }
    }

    for (const fn of currentFns) {
      if (!isFunctionTouched(fn, fileDiff)) {
        // 未触及存量函数：全部豁免
        continue;
      }
      touchedCount++;

      const covered = hitByLine.get(fn.line) ?? false;
      const crapNew = fn.comp * fn.comp * (covered ? 0 : 1) + fn.comp;

      if (crapNew <= threshold) {
        // 合规放行
        compliantCount++;
        continue;
      }

      // CRAP 超标，判定存量恶化或新增超标
      const baseFn = findBaseFunction(fn, baseFns, fileDiff.hunks);

      if (!baseFn) {
        // 新增函数超标
        violations.push({
          type: 'NEW_EXCEEDED',
          file: relPath,
          line: fn.startLine,
          name: fn.name || '<anonymous>',
          comp: fn.comp,
          covered,
          crap: crapNew,
          threshold,
        });
      } else {
        // 修改的存量函数：计算 base CRAP
        const crapBase = baseFn.comp * baseFn.comp * (covered ? 0 : 1) + baseFn.comp;
        if (crapNew > crapBase) {
          // 恶化拦截
          violations.push({
            type: 'REGRESSION',
            file: relPath,
            line: fn.startLine,
            name: fn.name || '<anonymous>',
            compNew: fn.comp,
            compBase: baseFn.comp,
            covered,
            crapNew,
            crapBase,
            threshold,
          });
        } else {
          // 未恶化（重构降复杂度或持平），放行
          compliantCount++;
        }
      }
    }
  }

  // 输出结果与报告
  if (violations.length > 0) {
    console.error(`crap-check [diff]: FAIL - 发现 ${violations.length} 处 CRAP 增量违规（base: ${baseRef}，阈值: ${threshold}）：`);
    for (const v of violations) {
      if (v.type === 'NEW_EXCEEDED') {
        console.error(`  [新增超标] ${v.file}:${v.line} (${v.name}) CRAP=${v.crap} > ${threshold}（comp=${v.comp}，${v.covered ? '已覆盖' : '未覆盖'}）`);
      } else if (v.type === 'REGRESSION') {
        console.error(`  [存量恶化] ${v.file}:${v.line} (${v.name}) CRAP 恶化: ${v.crapBase} -> ${v.crapNew}（comp: ${v.compBase} -> ${v.compNew}，${v.covered ? '已覆盖' : '未覆盖'}）`);
      }
    }
    return { exitCode: 1, passed: false, violations, touchedCount, compliantCount };
  }

  console.log(`crap-check [diff]: OK - base=${baseRef}，改动触及 ${touchedCount} 个函数，全部合规放行（未触及存量函数全部豁免）。`);
  return { exitCode: 0, passed: true, violations: [], touchedCount, compliantCount };
}

/**
 * 执行默认的全量评估逻辑
 */
export function runFullCheck({ repoRoot, threshold, strict, coveragePath }) {
  if (!existsSync(coveragePath)) {
    console.error('crap-check: coverage/coverage-final.json 不存在，请先运行 pnpm cov');
    return { exitCode: 2, passed: false, hotspots: [] };
  }

  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const hotspots = [];
  let totalFns = 0;
  let coveredFns = 0;
  let skippedForeignTotal = 0;

  for (const [file, data] of Object.entries(coverage)) {
    if (!/\/packages\/[^/]+\/lib\//.test(file)) continue;
    const rel = file.startsWith(repoRoot) ? file : join(repoRoot, file);
    if (!existsSync(rel)) continue;
    const { fns, skippedForeign } = functionsOf(readFileSync(rel, 'utf8'));
    skippedForeignTotal += skippedForeign;

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
        hotspots.push({
          file: file.slice(repoRoot.length + 1),
          line: fn.line,
          comp: fn.comp,
          covered,
          crap,
        });
      }
    }
  }

  hotspots.sort((a, b) => b.crap - a.crap);
  console.log(`crap-check: 本仓函数 ${totalFns} 个（已排除依赖/垫片 ${skippedForeignTotal} 个），`
    + `已覆盖 ${coveredFns}（${totalFns ? Math.round((coveredFns / totalFns) * 100) : 0}%），阈值 ${threshold}`);

  mkdirSync(join(repoRoot, 'coverage'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'coverage', 'crap-report.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      threshold,
      strict,
      totalFns,
      coveredFns,
      skippedForeignTotal,
      hotspots,
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
      return { exitCode: 1, passed: false, hotspots };
    }
    console.log('crap-check: [strict] 无超阈热点，OK');
    return { exitCode: 0, passed: true, hotspots: [] };
  }

  console.log('crap-check: OK（strict=false 观察期，strict 来源 gauntlet.config.json: crap.strict，明细已落盘 coverage/crap-report.json）');
  return { exitCode: 0, passed: true, hotspots };
}

/**
 * 主入口解析与分发
 */
export function runCrapCheck(argv = process.argv.slice(2), { shouldExit = true } = {}) {
  const repoRoot = process.cwd();
  const configPath = join(repoRoot, 'scripts', 'data', 'gauntlet.config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const DEFAULT_THRESHOLD = config.crap?.threshold ?? 16;

  const idx = argv.indexOf('--threshold');
  const threshold = Number(idx >= 0 ? argv[idx + 1] : DEFAULT_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    console.error('crap-check: invalid --threshold');
    if (shouldExit) process.exit(2);
    return { exitCode: 2 };
  }
  const strict = Boolean(config.crap?.strict);
  const coveragePath = join(repoRoot, 'coverage', 'coverage-final.json');

  // 解析 --diff 参数
  let isDiff = false;
  let baseArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff') {
      isDiff = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        baseArg = argv[i + 1];
      }
    } else if (argv[i].startsWith('--diff=')) {
      isDiff = true;
      baseArg = argv[i].slice('--diff='.length);
    }
  }

  let result;
  if (isDiff) {
    result = runDiffCheck({ repoRoot, threshold, baseArg, coveragePath });
  } else {
    result = runFullCheck({ repoRoot, threshold, strict, coveragePath });
  }

  if (shouldExit && typeof result.exitCode === 'number') {
    process.exit(result.exitCode);
  }
  return result;
}

// 判定是否作为 CLI 主脚本运行
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = realpathSync(fileURLToPath(import.meta.url));
    const execPath = realpathSync(process.argv[1]);
    return scriptPath === execPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCrapCheck(process.argv.slice(2), { shouldExit: true });
}
