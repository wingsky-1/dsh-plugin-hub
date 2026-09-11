#!/usr/bin/env node
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { COVERAGE_THRESHOLD_KEYS, extractCoverageThresholds, runThresholdMonotonic } from '../gate/threshold-monotonic.mjs'

const ROOT = join(import.meta.dirname, '../..')

/** 构造一个带基线 commit 的临时 git 仓库；返回其路径与 git 调用器。 */
function gitFixture(baseVitestConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'threshold-monotonic-test-'))
  mkdirSync(join(dir, 'scripts/data'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts/data/gauntlet.config.json'),
    JSON.stringify({ mutation: { packages: { 'dsh-x': { threshold: 60 } } } }),
  )
  writeFileSync(join(dir, 'vitest.config.ts'), baseVitestConfig)
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

/** 生成仅 lines 不同的 vitest.config.ts 文本。 */
const vitestText = (lines) => `export default { test: { coverage: { thresholds: { lines: ${lines}, functions: 80, statements: 78, branches: 70 } } } }\n`

test('extractCoverageThresholds: 提取 thresholds 块内的四个数值', () => {
  const text = [
    'coverage: {',
    '  provider: "istanbul",',
    '  thresholds: {',
    '    lines: 80,',
    '    functions: 80,',
    '    statements: 78,',
    '    branches: 70,',
    '  },',
    '},',
  ].join('\n')
  assert.deepEqual(extractCoverageThresholds(text), { lines: 80, functions: 80, statements: 78, branches: 70 })
})

test('extractCoverageThresholds: 无 thresholds 块返回 null（与「阈值为 0」区分）', () => {
  assert.equal(extractCoverageThresholds('export default { test: {} }'), null)
  assert.equal(extractCoverageThresholds(''), null)
})

test('extractCoverageThresholds: 小数阈值与部分键可用', () => {
  assert.deepEqual(extractCoverageThresholds('thresholds: { lines: 79.5 }'), { lines: 79.5 })
})

test('#722: 真实 vitest.config.ts 必须声明 coverage.thresholds 四键且为数字', () => {
  const thresholds = extractCoverageThresholds(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8'))
  assert.ok(thresholds, 'vitest.config.ts 缺少 coverage.thresholds —— 覆盖率硬门禁的唯一事实源，不得缺失')
  for (const key of COVERAGE_THRESHOLD_KEYS) {
    assert.equal(typeof thresholds[key], 'number', `coverage.thresholds.${key} 必须是数字字面量（提取失败或写成了表达式）`)
  }
})

test('#722: 覆盖率阈值降线判红（基准 80 → 工作区 70）', () => {
  const dir = gitFixture(vitestText(80))
  try {
    writeFileSync(join(dir, 'vitest.config.ts'), vitestText(70))
    const r = runThresholdMonotonic(['HEAD'], { repoRoot: dir })
    assert.equal(r.exitCode, 1, '阈值下调必须判红（须原 issue 内 approved）')
    assert.equal(r.failures, 1, '应恰好点名一处降线')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#722: 覆盖率阈值上调放行（基准 80 → 工作区 85）', () => {
  const dir = gitFixture(vitestText(80))
  try {
    writeFileSync(join(dir, 'vitest.config.ts'), vitestText(85))
    const r = runThresholdMonotonic(['HEAD'], { repoRoot: dir })
    assert.equal(r.exitCode, 0, '阈值上调是收紧，必须放行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#722: 基准尚无 thresholds 时跳过对比并放行（首次引入）', () => {
  const dir = gitFixture('export default { test: {} }\n')
  try {
    writeFileSync(join(dir, 'vitest.config.ts'), vitestText(80))
    const r = runThresholdMonotonic(['HEAD'], { repoRoot: dir })
    assert.equal(r.exitCode, 0, '基准无该块属首次引入，无从对比应放行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#722: 工作区缺 thresholds 判红（fail-closed，防门禁被静默摘除）', () => {
  const dir = gitFixture(vitestText(80))
  try {
    writeFileSync(join(dir, 'vitest.config.ts'), 'export default { test: {} }\n')
    const r = runThresholdMonotonic(['HEAD'], { repoRoot: dir })
    assert.equal(r.exitCode, 2, '阈值块整体消失不是「降线」而是配置错误，须 fail-closed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
