#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 夜间变异矩阵的段清单与逐段超时派生回归（#718 S1.1 / S1.4）。
 *
 * 为什么需要它：矩阵的段清单与每段超时都直接决定「哪些变异会跑」「跑多久算擦边」——
 * 前者漏段 = 包级变异率静默偏低（mutation-gate 按 mutant id 去重聚合，遗漏偏低），
 * 后者取错口径 = 长段在正常抖动下被误杀（用增量实测定全量超时就属此类，实测同段
 * 全量可达增量的数倍）。故这里锁死四条：
 *   1. 段清单口径与 ci-matrix / mutation-gate 同源（dsh- 前缀 + .json，去后缀）；
 *   2. 超时只认 `scope=full` 的实测（增量值不得参与定标）；
 *   3. 超时公式与下限（#718 整合版规定 10 分钟）不被静默放宽；
 *   4. 无实测的段必须落到保守默认值，而不是 0 或继承别的段的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_TIMEOUT_MINUTES,
  SETUP_OVERHEAD_MINUTES,
  SAFETY_FACTOR,
  TIMEOUT_FLOOR_MINUTES,
  buildShardMatrix,
  fullScopePeaks,
  listSegments,
  timeoutForSegment,
} from '../gate/mutation-plan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('段清单：只认 dsh-*.json 且去后缀，与 ci-matrix / mutation-gate 同源口径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-plan-'))
  try {
    for (const f of ['dsh-b-z.json', 'dsh-a.json', 'README.md', 'not-dsh-c.json']) {
      writeFileSync(join(dir, f), '{}')
    }
    assert.deepEqual(listSegments(dir), ['dsh-a', 'dsh-b-z'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('段清单：目录为空时返回空数组（由调用方 fail-closed，不在此吞掉）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-plan-'))
  try {
    assert.deepEqual(listSegments(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超时定标只用 scope=full 的实测：增量值不得参与（同段全量可达增量的数倍）', () => {
  const peaks = fullScopePeaks({
    measurements: [
      { scope: 'incremental', segments: [{ seg: 's1', wallSeconds: 3600 }] },
      { scope: 'full', segments: [{ seg: 's1', wallSeconds: 600 }] },
    ],
  })
  assert.equal(peaks.get('s1'), 600, '必须取 full 口径的值，忽略更大的 incremental 值')
})

test('超时定标：同一段多次 full 测量取最大值（不得取平均或首次）', () => {
  const peaks = fullScopePeaks({
    measurements: [
      { scope: 'full', segments: [{ seg: 's1', wallSeconds: 600 }] },
      { scope: 'full', segments: [{ seg: 's1', wallSeconds: 900 }] },
    ],
  })
  assert.equal(peaks.get('s1'), 900)
})

test('超时公式：实测 × 安全系数 + 构建开销，且不低于下限', () => {
  const peaks = new Map([['big', 21.2 * 60], ['tiny', 20]])
  // 21.2 min × 1.5 + 4 = 35.8 → 36
  assert.equal(timeoutForSegment('big', peaks), Math.ceil(21.2 * SAFETY_FACTOR + SETUP_OVERHEAD_MINUTES))
  // 20 s × 1.5 + 4 = 4.5 → 5，但下限 10 生效
  assert.equal(timeoutForSegment('tiny', peaks), TIMEOUT_FLOOR_MINUTES)
  assert.ok(SAFETY_FACTOR > 1, '安全系数必须 > 1（大于 1 才是余量）')
})

test('超时：无实测的段取保守默认，不得取 0 或继承他段值', () => {
  const peaks = new Map([['known', 600]])
  assert.equal(timeoutForSegment('unknown', peaks), DEFAULT_TIMEOUT_MINUTES)
  assert.ok(DEFAULT_TIMEOUT_MINUTES >= TIMEOUT_FLOOR_MINUTES, '保守默认不得低于下限')
})

test('矩阵结构：每项含 seg 与 timeoutMinutes，顺序与传入段序一致', () => {
  const m = buildShardMatrix(['a', 'b'], new Map([['a', 600]]))
  assert.deepEqual(m.map((x) => x.seg), ['a', 'b'])
  for (const x of m) assert.ok(Number.isInteger(x.timeoutMinutes) && x.timeoutMinutes >= TIMEOUT_FLOOR_MINUTES)
})

test('真实仓库：段清单与 stryker.conf.d 文件集精确一致（漏段即判红）', () => {
  const confFiles = readdirSync(join(ROOT, 'stryker.conf.d')).filter((f) => f.endsWith('.json')).sort()
  const expected = confFiles.map((f) => f.slice(0, -'.json'.length))
  assert.deepEqual(listSegments(join(ROOT, 'stryker.conf.d')), expected,
    'mutation-plan 的段清单必须与 stryker.conf.d 文件集一一对应')
})

test('真实仓库：入库台账的 full 测量值确实被超时派生消费', () => {
  const ledger = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'mutation-segment-ledger.json'), 'utf8'))
  const peaks = fullScopePeaks(ledger)
  const matrix = buildShardMatrix(listSegments(join(ROOT, 'stryker.conf.d')), peaks)
  const measured = matrix.filter((m) => m.timeoutMinutes !== DEFAULT_TIMEOUT_MINUTES)
  // 不硬编码具体段数：只断言「有全量实测的段确实派生出非默认超时」这一因果关系
  for (const m of matrix) {
    if (peaks.has(m.seg)) {
      assert.notEqual(m.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES,
        `${m.seg} 有 full 实测却落到默认超时——派生链断了`)
    }
  }
  assert.ok(measured.length > 0 || peaks.size === 0,
    '台账里存在 full 测量时，矩阵必须至少消费一条')
})
