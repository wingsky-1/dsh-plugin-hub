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
  mkdirSync(join(dir, 'packages/fake/lib'), { recursive: true })
  writeFileSync(join(dir, 'scripts/data/gauntlet.config.json'), JSON.stringify({ crap: { threshold: 1, strict } }))
  writeFileSync(join(dir, 'packages/fake/lib/index.js'), 'function uncovered() { if (false) return 1; return 0 }\nuncovered()\n')
  writeFileSync(join(dir, 'coverage/coverage-final.json'), JSON.stringify({
    [join(dir, 'packages/fake/lib/index.js')]: {
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
  assert.match(observe.stdout, /观察期模式/)
  assert.match(hard.stderr, /判定为红/)
})
