#!/usr/bin/env node
/**
 * 单函数 CRAP 检查（#722 阶段五重建版，src 口径）。
 *
 *   CRAP = comp^2 * (1 - cov) + comp
 *
 * comp：ESLint 内置 `complexity` 规则对 `packages/<pkg>/src` 的逐函数圈复杂度。
 *   **本脚本不实现第二份复杂度算法**——与 tools/lint 的复杂度门禁共用同一规则实现，
 *   口径不存在长期漂移面（这是 #722 阶段五的单一事实源约定）。
 * cov：`coverage/coverage-final.json`（vitest/istanbul 的 src 口径）中该函数的命中状态。
 *   先跑 `pnpm cov` 生成覆盖率，再运行本脚本。
 *
 * 与旧实现的差别：旧版从 `packages/<pkg>/lib` 编译产物取复杂度，需要 esbuild 边界注释分段
 * （foreignSegments）与垫片识别（shimRanges）来剔除内联 vendor；覆盖率切到 src 口径后两者行号
 * 不可比。阶段五改为直接从源码取复杂度，src 无内联 vendor，分段逻辑整体退役。
 *
 * 两处必须的 join 处理（阶段五实测）：
 *   1. ESLint 把「类字段初始化器」也报为一个可计复杂度节点，而 istanbul 不计入 fnMap；
 *      不过滤会让这类节点稳定匹配失败。
 *   2. vitest/istanbul 在 TS 转译 + sourcemap 回映后存在 ±1 行偏移（ESLint 直接在原始
 *      TS 上工作），故按行号 join 时允许 ±1 容差：实测精确匹配 98.75%、带容差 99.86%，
 *      残余项判为「未覆盖」，方向偏保守。
 *
 * 模式说明：
 * 1. 全量模式（默认）：读 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict。
 *    strict=false：超阈热点 exit 0，仅落盘 coverage/crap-report.json（观察期）；
 *    strict=true：超阈热点 exit 1。
 * 2. 增量防劣化模式（--diff [base]）：
 *    对比 base（默认 origin/main，自适应 fallback）与当前工作区在包 src 下的改动：
 *    - 新增函数：CRAP <= threshold；
 *    - 修改的存量函数：CRAP_new <= CRAP_base；
 *    - 未触及的存量函数：全部豁免；
 *    - 存在新增超标或存量恶化时 exit 1，否则 exit 0。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

// 工具链来源：本脚本所属仓库的 tools/lint 隔离包（与「被评估的仓库」可能是两个位置——
// 测试 fixture 用 cwd 指向临时目录，而 ESLint 工具链始终来自本脚本所在仓库）。
const TOOLCHAIN_PKG = join(SCRIPT_DIR, '..', '..', 'tools', 'lint', 'package.json');

/** 被评估文件的路径口径（仓库根相对 posix）。 */
const SRC_RE = /(?:^|\/)packages\/[^/]+\/src\//;

let toolchainCache = null;

/**
 * 从 tools/lint 隔离包解析 ESLint 工具链。
 * 为什么不能从本文件所在目录解析：lint 工具链装在 tools/lint 下（typescript-eslint 需要带
 * compiler API 的 TS 6，而仓根 typescript 是 tsgo），pnpm 严格布局下父目录解析不到子包依赖。
 */
async function loadToolchain() {
  if (toolchainCache !== null) return toolchainCache;
  const requireFromLint = createRequire(TOOLCHAIN_PKG);
  const { Linter } = await import(pathToFileURL(requireFromLint.resolve('eslint')).href);
  const tseslint = await import(pathToFileURL(requireFromLint.resolve('typescript-eslint')).href);
  toolchainCache = { Linter, parser: tseslint.default.parser };
  return toolchainCache;
}

/** 从 ESLint 诊断文本里取函数名（无名形态回退为空串）。 */
function nameFromMessage(message) {
  const m = /^(?:Function|Method|Getter|Setter|Constructor|Static block) '([^']+)'/.exec(message);
  return m === null ? '' : m[1];
}

/**
 * 单个文件的逐函数圈复杂度（ESLint `complexity` 规则，阈值 0 = 枚举全部函数）。
 * 返回 { fns: [{ name, line, column, complexity }], parseError: string|null }。
 */
export async function functionsOf(code, filename) {
  const { Linter, parser } = await loadToolchain();
  const isJs = /\.(js|mjs|cjs)$/.test(filename);
  const linter = new Linter();
  const config = [{
    files: isJs ? ['**/*.{js,mjs,cjs}'] : ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: isJs
      ? { ecmaVersion: 'latest', sourceType: 'module' }
      : { parser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { complexity: ['error', 0] },
  }];
  const verifyName = isJs ? 'x.mjs' : filename.endsWith('.tsx') ? 'x.tsx' : 'x.ts';
  let messages;
  try {
    messages = linter.verify(code, config, { filename: verifyName });
  } catch (error) {
    return { fns: [], parseError: String(error.message).split('\n')[0] };
  }
  const fatal = messages.find((m) => m.fatal === true);
  if (fatal !== undefined) {
    return { fns: [], parseError: String(fatal.message).split('\n')[0] };
  }
  const fns = [];
  for (const m of messages) {
    // 类字段初始化器不是函数（istanbul 的 fnMap 不含它），排除以保持两侧同口径。
    if (/Class field initializer/.test(m.message)) continue;
    const c = /complexity of (\d+)/.exec(m.message);
    if (c === null) continue;
    fns.push({ name: nameFromMessage(m.message), line: m.line, column: m.column, complexity: Number(c[1]) });
  }
  return { fns, parseError: null };
}

/** 单函数 CRAP 值。 */
export function crapOf(comp, covered) {
  return comp * comp * (covered ? 0 : 1) + comp;
}

/**
 * 构建「起始行 → 是否被覆盖」索引（istanbul fnMap/f）。
 * 同行多函数取「任一命中即算命中」——该放宽使 CRAP 系统性偏低（方向性偏差，校准阈值时须知）。
 */
export function coverageHitLines(fileCov) {
  const hit = new Map();
  for (const [id, fn] of Object.entries(fileCov?.fnMap ?? {})) {
    const line = fn.decl?.start?.line ?? fn.loc?.start?.line ?? fn.line;
    if (typeof line !== 'number') continue;
    const covered = (fileCov.f?.[id] ?? 0) > 0;
    hit.set(line, (hit.get(line) ?? false) || covered);
  }
  return hit;
}

/**
 * 按起始行查覆盖状态，允许 ±1 行容差（istanbul 转译回映的固有偏移）。
 */
export function coveredAt(hitByLine, line) {
  if (hitByLine.has(line)) return hitByLine.get(line);
  if (hitByLine.has(line - 1)) return hitByLine.get(line - 1);
  if (hitByLine.has(line + 1)) return hitByLine.get(line + 1);
  return false;
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
 * 补出函数结束行：ESLint 只报起始位置。用「下一个函数起始行 - 1」近似；
 * 末个函数取大值，使纯删除 hunk 的插入点判定不因范围过窄而漏判。
 */
function withRange(fns) {
  return fns.map((fn, i) => ({
    ...fn,
    startLine: fn.line,
    endLine: i + 1 < fns.length ? fns[i + 1].line - 1 : Number.MAX_SAFE_INTEGER,
  }));
}

/**
 * 执行 --diff 增量防劣化评估。
 */
export async function runDiffCheck({ repoRoot, threshold, baseArg, coveragePath }) {
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
  // 只评估包 src 下的改动（复杂度与覆盖率同口径）
  const relevantDiffFiles = Array.from(diffFiles.entries()).filter(([path]) => SRC_RE.test(path.replace(/\\/g, '/')));

  if (relevantDiffFiles.length === 0) {
    console.log(`crap-check [diff]: base=${baseRef}，未检测到包 src 下的代码变更，OK`);
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

  const coverageByAbs = new Map();
  for (const [covFile, covData] of Object.entries(coverage)) {
    coverageByAbs.set(resolve(covFile), covData);
  }

  const violations = [];
  let touchedCount = 0;
  let compliantCount = 0;

  for (const [relPath, fileDiff] of relevantDiffFiles) {
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) continue;

    const currentCode = readFileSync(absPath, 'utf8');
    const current = await functionsOf(currentCode, absPath);
    if (current.parseError !== null) {
      console.error(`crap-check [diff]: ${relPath} 解析失败（${current.parseError}）—— fail-closed`);
      return { exitCode: 2, passed: false, violations: [] };
    }
    const currentFns = withRange(current.fns);

    // 读取 base 提交中的老文件内容
    let baseFns = [];
    if (!fileDiff.isNew) {
      const showRes = spawnSync('git', ['show', `${baseRef}:${fileDiff.oldFile || relPath}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (showRes.status === 0) {
        baseFns = withRange((await functionsOf(showRes.stdout, absPath)).fns);
      }
    }

    const hitByLine = coverageHitLines(coverageByAbs.get(absPath));

    for (const fn of currentFns) {
      if (!isFunctionTouched(fn, fileDiff)) {
        // 未触及存量函数：全部豁免
        continue;
      }
      touchedCount++;

      const covered = coveredAt(hitByLine, fn.line);
      const crapNew = crapOf(fn.complexity, covered);

      if (crapNew <= threshold) {
        compliantCount++;
        continue;
      }

      const baseFn = findBaseFunction(fn, baseFns, fileDiff.hunks);

      if (!baseFn) {
        violations.push({
          type: 'NEW_EXCEEDED',
          file: relPath,
          line: fn.line,
          name: fn.name || '<anonymous>',
          comp: fn.complexity,
          covered,
          crap: crapNew,
          threshold,
        });
      } else {
        const crapBase = crapOf(baseFn.complexity, covered);
        if (crapNew > crapBase) {
          violations.push({
            type: 'REGRESSION',
            file: relPath,
            line: fn.line,
            name: fn.name || '<anonymous>',
            compNew: fn.complexity,
            compBase: baseFn.complexity,
            covered,
            crapNew,
            crapBase,
            threshold,
          });
        } else {
          compliantCount++;
        }
      }
    }
  }

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
 * 执行默认的全量评估逻辑。
 */
export async function runFullCheck({ repoRoot, threshold, strict, coveragePath }) {
  if (!existsSync(coveragePath)) {
    console.error('crap-check: coverage/coverage-final.json 不存在，请先运行 pnpm cov');
    return { exitCode: 2, passed: false, hotspots: [] };
  }

  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const normRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');

  const hotspots = [];
  let totalFns = 0;
  let coveredFns = 0;
  let scannedFiles = 0;
  let parseFailed = 0;

  for (const [file, data] of Object.entries(coverage)) {
    // 路径口径：只评估包 src（与 vitest coverage 的 include 同口径）。先对分隔符归一，
    // 避免 Windows 反斜杠路径整批跳过而报 0。
    const normFile = file.replace(/\\/g, '/');
    if (!SRC_RE.test(normFile)) continue;
    const absPath = resolve(file);
    if (!existsSync(absPath)) continue;
    scannedFiles++;

    const { fns, parseError } = await functionsOf(readFileSync(absPath, 'utf8'), absPath);
    if (parseError !== null) {
      parseFailed++;
      console.warn(`crap-check: ${normFile} 解析失败，跳过（${parseError}）`);
      continue;
    }

    const hitByLine = coverageHitLines(data);

    for (const fn of fns) {
      totalFns++;
      const covered = coveredAt(hitByLine, fn.line);
      if (covered) coveredFns++;
      const crap = crapOf(fn.complexity, covered);
      if (crap > threshold) {
        hotspots.push({
          file: normFile.startsWith(normRoot + '/') ? normFile.slice(normRoot.length + 1) : normFile,
          line: fn.line,
          name: fn.name,
          comp: fn.complexity,
          covered,
          crap,
        });
      }
    }
  }

  // 零函数 = 数据源口径不匹配，属静默降级（#718 定性），必须 fail-closed。
  if (totalFns === 0) {
    console.error(`crap-check: 在 coverage 数据里没有任何包 src 条目（扫描文件 ${scannedFiles}）——`);
    console.error('  覆盖率数据源口径不匹配（期望 vitest/istanbul 的 src 口径）。请先运行 pnpm cov，再重试。');
    return { exitCode: 2, passed: false, hotspots: [] };
  }

  hotspots.sort((a, b) => b.crap - a.crap);
  console.log(`crap-check: 本仓函数 ${totalFns} 个（${scannedFiles} 个 src 文件，解析失败 ${parseFailed} 个），`
    + `已覆盖 ${coveredFns}（${Math.round((coveredFns / totalFns) * 100)}%），阈值 ${threshold}`);

  mkdirSync(join(repoRoot, 'coverage'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'coverage', 'crap-report.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      threshold,
      strict,
      totalFns,
      coveredFns,
      scannedFiles,
      parseFailed,
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
 * 主入口解析与分发。
 */
export async function runCrapCheck(argv = process.argv.slice(2), { shouldExit = true } = {}) {
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

  const result = isDiff
    ? await runDiffCheck({ repoRoot, threshold, baseArg, coveragePath })
    : await runFullCheck({ repoRoot, threshold, strict, coveragePath });

  if (shouldExit && typeof result.exitCode === 'number') {
    process.exit(result.exitCode);
  }
  return result;
}

// 判定是否作为 CLI 主脚本运行
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = realpathSync(SCRIPT_PATH);
    const execPath = realpathSync(process.argv[1]);
    return scriptPath === execPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  await runCrapCheck(process.argv.slice(2), { shouldExit: true });
}
