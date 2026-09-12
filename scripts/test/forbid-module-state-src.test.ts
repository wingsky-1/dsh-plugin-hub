#!/usr/bin/env node
// @ts-nocheck
/** forbid-module-state-src.mjs 自测（#733 M2c 后续 N2a）：正反例 + 三态 + 口径外 + fail-closed。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const SCRIPT = join(ROOT, 'scripts', 'gate', 'forbid-module-state-src.mjs')
const PKG = 'dsh-notifier'

/** 构造最小 fixture 仓库（--root 注入）。pkgFiles: [{ rel, content }] */
function fixture(pkgFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'forbid-module-state-'))
  mkdirSync(join(dir, 'packages', PKG, 'src'), { recursive: true })
  for (const { rel, content } of pkgFiles) {
    const p = join(dir, 'packages', PKG, 'src', rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

function run(dir) {
  try {
    return spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('正例：干净 src（无模块级可变状态）→ exit 0', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'const a = 1\nexport const b = a\n' }]))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /无模块级可变状态/)
})

test('反例：模块级 let → exit 1 且点名符号（本判据要防的核心方向）', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'let lastOutcome = true\nexport const peek = () => lastOutcome\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /模块级 let（lastOutcome）/)
  assert.match(r.stderr, /FAIL（扫描 1 文件，违规 1 /)
})

test('反例：模块级 var → exit 1', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'var cache: unknown = null\nexport const peek = () => cache\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /模块级 var（cache）/)
})

test('反例：export let 顶格形态 → exit 1（不只裸声明）', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'export let counter = 0\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /模块级 let（counter）/)
})

test('放行：函数体内 let/var 是正常局部状态 → exit 0', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'export function f(): number {\n  let x = 1\n  x += 1\n  return x\n}\n' }]))
  assert.equal(r.status, 0, r.stderr)
})

test('放行：declare let 是环境声明（无运行时状态）→ exit 0', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'declare let ambient: number\nexport const peek = () => ambient\n' }]))
  assert.equal(r.status, 0, r.stderr)
})

test('口径外（如实登记）：缩进的模块级 let 不判红，但必须被计数打印（盲区可观测）', () => {
  // 口径源自 #733 宪法（`^(let|var) ` 顶格形态）；缩进形态实测存在于 client/index.tsx，
  // 纳入会一上来就红 22 处，故登记为盲区——但静默的绕过口比已知的绕过口危险，
  // 门禁每次运行都打印口径外计数。
  const r = run(fixture([{ rel: 'a.ts', content: '  let hidden = 1\nexport const peek = () => hidden\n' }]))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /口径外（缩进的模块级声明，不判红；见门禁自述「盲区」）：1 处/)
})

test('豁免三态：有注释但不在 WHITELIST → FAIL（不合法豁免）', () => {
  const r = run(fixture([{ rel: 'a.ts', content: '// dsh-gate:allow-module-state #999 测试理由\nlet x = 1\nexport const peek = () => x\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /有豁免注释但文件不在 WHITELIST/)
})

test('豁免三态：豁免注释缺 issue 号 → 不算合法豁免，按违规报', () => {
  const r = run(fixture([{ rel: 'a.ts', content: '// dsh-gate:allow-module-state 随手一豁\nlet x = 1\nexport const peek = () => x\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /违规 1 /)
})

test('F1：字符串字面量里的伪豁免注释不生效（真实注释词法识别）→ 判违规', () => {
  const r = run(fixture([{ rel: 'a.ts', content: 'const msg = "// dsh-gate:allow-module-state #999 字符串伪造"\nlet x = 1\nexport const peek = () => [x, msg]\n' }]))
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /违规 1 /)
  assert.ok(!r.stderr.includes('字符串伪造'), '字符串内容不得被当作豁免理由')
})

test('fail-closed：语法损坏文件（TS 不可解析）→ exit 1 且指明解析失败', () => {
  const r = run(fixture([{ rel: 'broken.ts', content: 'export const a = (((\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /解析失败（fail-closed，一律判红）/)
})

test('fail-closed：扫描面为空（无任何 src 文件）→ exit 1，不退化为「零违规」', () => {
  const r = run(fixture([]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未发现任何扫描目标/)
})

test('扫描面：.tsx 也在扫描面内（客户端入口形态）', () => {
  const r = run(fixture([{ rel: 'view.tsx', content: 'let shared = 0\nexport const View = () => shared\n' }]))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /模块级 let（shared）/)
})

test('本仓真实快照：exit 0，且口径外计数与盲区登记一致（数字变即提示同步）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /OK（扫描 \d+ 文件，包 dsh-notifier（v1）无模块级可变状态）/)
  // 缩进的模块级 var 实测 22 处，全在 client/index.tsx：该数字是盲区登记的锚点，
  // 若客户端缩进形态变化（或整改纳入判据），此断言先红并提示同步门禁自述与 DEVELOPMENT。
  assert.match(r.stdout, /口径外（缩进的模块级声明，不判红；见门禁自述「盲区」）：22 处/)
  assert.match(r.stdout, /packages\/dsh-notifier\/src\/client\/index\.tsx: 22 处/)
})
