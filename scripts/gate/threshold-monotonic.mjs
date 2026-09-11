#!/usr/bin/env node
/**
 * threshold-monotonic — 阈值单调性校验（#85 v3 F3 兜底）
 *
 * 对比工作区与指定 git 基准（默认 origin/main）中的阈值来源，只许升不许降：
 *   - vitest.config.ts 的 coverage.thresholds.{lines,functions,statements,branches}
 *     ——#722 阶段三起覆盖率阈值的唯一事实源，取代原 gauntlet.config.json 的
 *     coverage.selfWrittenFunctions.threshold（该字段随 self-cov.mjs 一并退役）；
 *   - scripts/data/gauntlet.config.json 的 mutation.packages.<pkg>.threshold。
 * 降线必须走原 issue 内 approved 流程改基线，而不是悄悄调低阈值。
 *
 * 为什么用文本提取而非 import 基准版本：基准取自 git 对象，import 它等于执行历史
 * 代码。两侧走同一个提取函数，语义对称且无副作用。
 *
 * 用法：node scripts/gate/threshold-monotonic.mjs [git-ref]
 * 退出码：0 = 无降线；1 = 存在降线；2 = 环境/数据错误
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAUNTLET = 'scripts/data/gauntlet.config.json';
const VITEST_CONFIG = 'vitest.config.ts';
export const COVERAGE_THRESHOLD_KEYS = ['lines', 'functions', 'statements', 'branches'];

/**
 * 从 vitest.config.ts 文本提取 coverage.thresholds 的数值；无该块返回 null。
 * 只做字面量提取、不解析 TS：阈值只可能是数字字面量，且两侧用同一函数保证对称。
 */
export function extractCoverageThresholds(text) {
  const block = /thresholds\s*:\s*\{([^}]*)\}/.exec(text);
  if (!block) return null;
  const out = {};
  for (const key of COVERAGE_THRESHOLD_KEYS) {
    const m = new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\b`).exec(block[1]);
    if (m) out[key] = Number(m[1]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 基准上是否存在该文件：cat-file 退出 1 = 确实没有；其它错误上抛（环境故障不得放行）。 */
function existsInGit(ref, path, repoRoot) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

function readFromGit(ref, path, repoRoot) {
  return execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * 主校验。返回 { exitCode, failures }；日志走 stdout/stderr。
 */
export function runThresholdMonotonic(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
  const baseRef = argv[0] ?? 'origin/main';
  let failures = 0;

  // ── 维度一：覆盖率阈值（vitest.config.ts）──────────────────────
  let oldCoverage = null;
  try {
    if (existsInGit(baseRef, VITEST_CONFIG, repoRoot)) {
      oldCoverage = extractCoverageThresholds(readFromGit(baseRef, VITEST_CONFIG, repoRoot));
      if (oldCoverage === null) {
        console.log(`threshold-monotonic: ${baseRef} 的 ${VITEST_CONFIG} 无 coverage.thresholds —— 首次引入，跳过覆盖率阈值对比`);
      }
    } else {
      console.log(`threshold-monotonic: ${baseRef} 上无 ${VITEST_CONFIG} —— 首次引入，跳过覆盖率阈值对比`);
    }
  } catch (err) {
    console.error(`threshold-monotonic: 读取 ${baseRef}:${VITEST_CONFIG} 失败：${err.message} —— 环境故障按 fail-closed 处理`);
    return { exitCode: 2, failures: 0 };
  }

  let newCoverage = null;
  try {
    newCoverage = extractCoverageThresholds(readFileSync(join(repoRoot, VITEST_CONFIG), 'utf8'));
  } catch (err) {
    console.error(`threshold-monotonic: 工作区 ${VITEST_CONFIG} 读取失败：${err.message}`);
    return { exitCode: 2, failures: 0 };
  }
  if (newCoverage === null) {
    console.error(`threshold-monotonic: 工作区 ${VITEST_CONFIG} 缺 coverage.thresholds —— 覆盖率阈值是硬门禁，缺失视为配置错误（fail-closed）`);
    return { exitCode: 2, failures: 0 };
  }

  if (oldCoverage !== null) {
    for (const key of COVERAGE_THRESHOLD_KEYS) {
      const before = oldCoverage[key];
      const after = newCoverage[key];
      if (typeof before === 'number' && typeof after === 'number' && after < before) {
        console.error(`[FAIL] vitest coverage.thresholds.${key} 降线：${before} → ${after}（须原 issue 内 approved 后方可下调）`);
        failures += 1;
      }
    }
  }

  // ── 维度二：变异阈值（gauntlet.config.json）────────────────────
  let oldCfg = null;
  let newCfg = null;
  try {
    const oldGauntletExists = existsInGit(baseRef, GAUNTLET, repoRoot);
    if (!oldGauntletExists) {
      console.log(`threshold-monotonic: ${baseRef} 上无 ${GAUNTLET} —— 首次引入，跳过变异阈值对比`);
    } else {
      oldCfg = JSON.parse(readFromGit(baseRef, GAUNTLET, repoRoot));
    }
    newCfg = JSON.parse(readFileSync(join(repoRoot, GAUNTLET), 'utf8'));
  } catch (err) {
    console.error(`threshold-monotonic: 读取 ${GAUNTLET} 失败：${err.message} —— 环境故障按 fail-closed 处理`);
    return { exitCode: 2, failures: 0 };
  }

  if (oldCfg !== null) {
    const oldPkgs = oldCfg?.mutation?.packages ?? {};
    const newPkgs = newCfg?.mutation?.packages ?? {};
    for (const [pkg, cfg] of Object.entries(newPkgs)) {
      const oldThreshold = oldPkgs[pkg]?.threshold;
      const newThreshold = cfg?.threshold;
      if (
        typeof oldThreshold === 'number' &&
        typeof newThreshold === 'number' &&
        newThreshold < oldThreshold
      ) {
        console.error(`[FAIL] mutation.packages.${pkg}.threshold 降线：${oldThreshold} → ${newThreshold}`);
        failures += 1;
      }
    }
  }

  if (failures > 0) {
    console.error(`\nthreshold-monotonic: ${failures} 处降线 —— 阈值治理红线（AGENTS.md / #85 v3 F3）`);
    return { exitCode: 1, failures };
  }
  console.log('threshold-monotonic: 无阈值降线，校验通过');
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
