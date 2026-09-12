#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * exports[].types 可解析判据自测（#733 M2c 后续 N9）。
 *
 * 判据本体：scripts/lib/exports-types-lib.ts 的 checkExportTypesResolvable ——
 * **包发布物（tarball 解包目录）**内每个带 types 条件的子路径，其 types 必须指向真实文件。
 * 实证缺陷：`./client` 的 types 曾写 `./lib/client.d.ts`（实际产出 `lib/client/index.d.ts`），
 * 严格 TS 消费方按包名子路径导入静默降级 any（TS7016），而 pack-check / contract-check
 * 都看不见（后者只断言 exports['./client'] 键存在）。
 *
 * 两层证据，缺一不可（同 export-faces-admission.test.ts 范式）：
 *  1. 判据正反双向 fixture：隔离目录铺 package.json + lib 产物，断言合规/违规两侧；
 *  2. 执法接线：spawn 真实 scripts/gate/pack-check.ts 切片，证明判据确实挂在既有
 *     `pnpm pack:check` 上，而不是一个没人调用的库函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { checkExportTypesResolvable, listExportTypesEntries, stripLibPrefix } from '../lib/exports-types-lib.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const PACK_CHECK = join(ROOT, 'scripts', 'gate', 'pack-check.ts')

/**
 * 铺一个「tarball 解包后」形态的最小包目录。
 * @param {{ exports: unknown, files?: string[] }} spec files = 相对包根的产物文件（自动含 package.json）
 */
function fixture(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'exports-types-'))
  const pkg = { name: '@wingspace/fake', version: '0.0.0', exports: spec.exports }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  for (const rel of spec.files ?? []) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, 'export declare const x: 1;\n', 'utf8')
  }
  return dir
}

function withFixture(spec, fn) {
  const dir = fixture(spec)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 1) 判据正反双向

test('合规：每个带 types 的子路径都指向真实存在的产物文件 → 无违规', () => {
  withFixture(
    {
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './client': { types: './lib/client/index.d.ts', default: './lib/client.js' } },
      files: ['lib/index.d.ts', 'lib/index.js', 'lib/client/index.d.ts', 'lib/client.js'],
    },
    (dir) => assert.deepEqual(checkExportTypesResolvable(dir), []),
  )
})

test('违规（本判据要防的核心方向）：types 指向不存在的文件 → 判红且点名子路径与目标', () => {
  withFixture(
    {
      exports: { '.': { types: './lib/index.d.ts' }, './client': { types: './lib/client.d.ts' } },
      // 实际产出是 lib/client/index.d.ts（目录形态），lib/client.d.ts 不存在
      files: ['lib/index.d.ts', 'lib/client/index.d.ts'],
    },
    (dir) => {
      const problems = checkExportTypesResolvable(dir)
      assert.equal(problems.length, 1, problems.join('\n'))
      assert.match(problems[0], /exports\["\.\/client"\]\.types 指向不存在的文件：\.\/lib\/client\.d\.ts/)
    },
  )
})

test('违规：types 不在 ./lib/ 下 → 判红且说明无法定位产物（不静默跳过）', () => {
  withFixture({ exports: { '.': { types: './types/index.d.ts' } }, files: [] }, (dir) => {
    const problems = checkExportTypesResolvable(dir)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0], /不在 \.\/lib\/ 下（无法定位产物）/)
  })
})

test('排除面：无 types 条件的子路径（./package.json 等）不参与判据', () => {
  withFixture({ exports: { '.': { types: './lib/index.d.ts' }, './package.json': './package.json' }, files: ['lib/index.d.ts'] }, (dir) => {
    const entries = listExportTypesEntries(dir)
    assert.deepEqual(entries.map((e) => e.subpath), ['.'])
    assert.deepEqual(checkExportTypesResolvable(dir), [])
  })
})

test('fail-closed：package.json 缺失 → 抛（不静默当作零子路径全合规）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exports-types-empty-'))
  try {
    assert.throws(() => checkExportTypesResolvable(dir), /package.json 不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fail-closed：exports 为字符串形态（无法解析子路径）→ 抛', () => {
  withFixture({ exports: './lib/index.js' }, (dir) => {
    assert.throws(() => checkExportTypesResolvable(dir), /exports 不是对象形态/)
  })
})

test('stripLibPrefix：映射口径（含非 ./lib/ 前缀与空尾段返回 null）', () => {
  assert.equal(stripLibPrefix('./lib/client/index.d.ts'), 'client/index.d.ts')
  assert.equal(stripLibPrefix('./lib/index.d.ts'), 'index.d.ts')
  assert.equal(stripLibPrefix('./types/index.d.ts'), null)
  assert.equal(stripLibPrefix('./lib/'), null)
})

// ---------------------------------------------------------------- 2) 真实包形态锁（防回退到修复前的值）

test('真实包：全部客户端包的 exports 子路径与 types 指向 emit 布局（防回退 lib/client.d.ts）', () => {
  // 实测这 5 个包**全部**有同一缺陷（types 指向不存在的 lib/client.d.ts，实际产物是
  // lib/client/index.d.ts）：新判据在全部实例上发声，故形态锁也覆盖全部实例。
  for (const pkg of ['dsh-notifier', 'dsh-lan-proxy', 'dsh-mcp-manager', 'dsh-provider-usage', 'dsh-web-file-preview']) {
    assert.deepEqual(
      listExportTypesEntries(join(ROOT, 'packages', pkg)),
      [
        { subpath: '.', types: './lib/index.d.ts' },
        { subpath: './client', types: './lib/client/index.d.ts' },
      ],
      `${pkg} 的 exports types 形态漂移`,
    )
  }
})

// ---------------------------------------------------------------- 3) 执法接线（真实脚本）

test('端到端：真实仓库 pack-check 切片 → exit 0（判据挂在既有 pack:check 上）', () => {
  const r = spawnSync(process.execPath, [PACK_CHECK, '--packages', 'dsh-notifier'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 })
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /PASS @wingsky-1\/dsh-notifier \| tarball 完整/)
})
