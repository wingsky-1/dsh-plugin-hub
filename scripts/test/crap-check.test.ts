#!/usr/bin/env node
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/gate/crap-check.mjs')

function fixture(strict) {
  const dir = mkdtempSync(join(tmpdir(), 'crap-check-test-'))
  mkdirSync(join(dir, 'scripts/data'), { recursive: true })
  mkdirSync(join(dir, 'coverage'), { recursive: true })
  mkdirSync(join(dir, 'packages/fake/src'), { recursive: true })
  writeFileSync(join(dir, 'scripts/data/gauntlet.config.json'), JSON.stringify({ crap: { threshold: 1, strict } }))
  // 复杂度 2（一个 if）、未覆盖 → CRAP = 2^2 + 2 = 6 > threshold 1，稳定产生超阈热点。
  writeFileSync(join(dir, 'packages/fake/src/index.ts'), 'export function uncovered(): number { if (false) return 1; return 0 }\n')
  writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
    [join(dir, 'packages/fake/src/index.ts')]: {
      fnMap: { '0': { loc: { start: { line: 1, column: 0 } } } },
      f: { '0': 0 },
    },
  }))
  return dir
}

function run(strict) {
  const dir = fixture(strict)
  try {
    return spawnSync(process.execPath, [SCRIPT, '--strict'], { cwd: dir, encoding: 'utf8' })
  } finally {
    // spawnSync 已完成，临时 fixture 可安全清理。
    rmSync(dir, { recursive: true, force: true })
  }
}

test('crap.strict 是唯一判红开关，忽略 --strict argv', () => {
  const observe = run(false)
  const hard = run(true)
  assert.equal(observe.status, 0, `strict=false 应观察期放行：${observe.stderr}`)
  assert.equal(hard.status, 1, `strict=true 应判红：${hard.stderr}`)
  assert.match(observe.stdout, /strict=false 观察期/)
  assert.match(hard.stderr, /判定为红/)
})

test('#722 阶段五: 覆盖率数据里没有包 src 条目时 fail-closed（不再以「0 个函数」静默放行）', () => {
  // 阶段五把 CRAP 的复杂度与覆盖率统一到包 src 口径。若数据源不是该口径（例如误用旧 lib
  // 产物），旧行为是命中 0 个文件、以 exit 0 放行（#718 定性的静默降级）。本用例锁死它。
  const dir = mkdtempSync(join(tmpdir(), 'crap-check-lib-'))
  try {
    mkdirSync(join(dir, 'scripts/data'), { recursive: true })
    mkdirSync(join(dir, 'coverage'), { recursive: true })
    mkdirSync(join(dir, 'packages/fake/lib'), { recursive: true })
    writeFileSync(
      join(dir, 'scripts/data/gauntlet.config.json'),
      JSON.stringify({ crap: { threshold: 16, strict: false } }),
    )
    writeFileSync(join(dir, 'packages/fake/lib/index.js'), 'function f() { return 1 }\nf()\n')
    writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
      [join(dir, 'packages/fake/lib/index.js')]: { fnMap: { '0': { loc: { start: { line: 1 } } } }, f: { '0': 1 } },
    }))
    const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
    assert.equal(res.status, 2, `非 src 口径数据必须 fail-closed：${res.stdout}${res.stderr}`)
    assert.match(res.stderr, /没有任何包 src 条目/, '错误信息必须点名根因，而非静默放行')
    assert.match(res.stderr, /pnpm cov/, '错误信息必须指明重建数据源的命令')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
