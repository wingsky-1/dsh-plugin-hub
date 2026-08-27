#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * plugins-manifest-lib 自测（node:test，issue #36）。
 *
 * 覆盖三类漂移的 fail-loud 与 manifest 自身校验：
 *   - deps 多一行（退役包 / 未收录名两种分支文案）
 *   - 聚合 patch 少一行 / 多未知 id（回归保护）
 *   - 目录集 ↔ manifest.active 双向不等（新目录未登记 / active 悬空）
 *   - loadManifest：JSON 语法错、形状错、名字不合规、active∩retired 重名、数组重复项
 *   - 正向全绿：当前真实 manifest + 真实 packages/ 目录
 * 运行：node --test scripts/test/plugins-manifest.test.ts（或 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAggregateConsistency, listPluginDirs, loadManifest } from '../lib/plugins-manifest-lib.ts'

const ACTIVE = ['dsh-alpha', 'dsh-beta']
const MANIFEST = {
  active: ACTIVE,
  retired: [
    { name: 'dsh-gone', reason: '测试退役', successor: '@wingsky-1/dsh-alpha' },
  ],
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'))
  // 预建 packages/ 与 scripts/data/，各用例按需写入
  mkdirSync(join(dir, 'packages'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'data'), { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fixtureRepo(manifestObj) {
  const { dir, cleanup } = tempRepo()
  mkdirSync(join(dir, 'packages', 'dsh-alpha'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'dsh-beta'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify(manifestObj))
  return { dir, cleanup }
}

const EXPECTED_DEPS = { '@wingsky-1/dsh-alpha': 'workspace:*', '@wingsky-1/dsh-beta': 'workspace:*' }

test('#1 deps 多一行（退役包）→ 命中 retired 分支文案', () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, '@wingsky-1/dsh-gone': 'workspace:*' },
    aggPatchIds: ['ui-dsh-alpha', 'ui-dsh-beta'],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /多出已退役包 @wingsky-1\/dsh-gone/)
})

test('#2 deps 多一行（未收录名）→ 命中「既不在 active 也不在 retired」分支', () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, '@wingsky-1/dsh-typo': 'workspace:*' },
    aggPatchIds: ['ui-dsh-alpha', 'ui-dsh-beta'],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /多出未收录包 @wingsky-1\/dsh-typo/)
})

test('#3 patch 少一行 → 报缺失 id（回归保护）', () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: EXPECTED_DEPS,
    aggPatchIds: ['ui-dsh-alpha'],
  })
  assert.deepEqual(problems, ['聚合 patch 缺 ui-dsh-beta（active 在册但无聚合行）'])
})

test('#3b patch 多未知 id → fail-loud', () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ['ui-dsh-alpha', 'ui-dsh-beta', 'ui-dsh-ghost'],
  })
  assert.deepEqual(problems, ['聚合 patch 多出未知 id ui-dsh-ghost'])
})

test('#3c patch 同 id 重复行 → fail-loud（Set 去重盲区闭合）', () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ['ui-dsh-alpha', 'ui-dsh-alpha', 'ui-dsh-beta'],
  })
  assert.deepEqual(problems, ['聚合 patch 存在重复 id 行: ui-dsh-alpha'])
})

test('#4 目录有包但 manifest 没有 → 报「未登记」', () => {
  const problems = checkAggregateConsistency({ dirNames: [...ACTIVE, 'dsh-newkid'], manifest: MANIFEST })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /未登记 manifest: dsh-newkid/)
})

test('#4b 目录有包但只在 standalone → 双向通过；聚合 deps 误引 → fail-loud', () => {
  const manifest = { active: ACTIVE, standalone: ['dsh-demo'], retired: MANIFEST.retired }
  // 目录集 == active ∪ standalone：正向全绿（无聚合断言段）
  assert.deepEqual(checkAggregateConsistency({ dirNames: [...ACTIVE, 'dsh-demo'], manifest }), [])
  // 聚合 deps 误引 standalone 包 → 明确分支文案
  const problems = checkAggregateConsistency({
    dirNames: [...ACTIVE, 'dsh-demo'],
    manifest,
    aggDeps: { ...EXPECTED_DEPS, '@wingsky-1/dsh-demo': 'workspace:*' },
    aggPatchIds: ['ui-dsh-alpha', 'ui-dsh-beta'],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /多出独立发包 @wingsky-1\/dsh-demo/)
})

test('#5 active 引用不存在目录 → 报「不存在的目录」', () => {
  const problems = checkAggregateConsistency({ dirNames: ACTIVE, manifest: { active: [...ACTIVE, 'dsh-vapor'], retired: [] } })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /不存在的目录: dsh-vapor/)
})

test('#6 JSON 语法错 → 单行友好错误（非裸 SyntaxError）', () => {
  const { dir, cleanup } = tempRepo()
  try {
    mkdirSync(join(dir, 'packages', 'dsh-alpha'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), '{ active: ')
    assert.throws(() => loadManifest(dir), (e) => /JSON 语法错误/.test(e.message) && !/SyntaxError/.test(e.message))
  } finally {
    cleanup()
  }
})

test('#7 形状错 / 名字不合规 → 报错', () => {
  const { dir, cleanup } = tempRepo()
  try {
    // 缺 active
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({ retired: [] }))
    assert.throws(() => loadManifest(dir), /缺 active 数组/)
    // 名字不合规
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({ active: ['Dsh_Foo'], retired: [] }))
    assert.throws(() => loadManifest(dir), /非法名字/)
  } finally {
    cleanup()
  }
})

test('#8 active∩retired 重名 / 数组重复项 → 报错', () => {
  const { dir, cleanup } = tempRepo()
  try {
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({
      active: ['dsh-a'],
      retired: [{ name: 'dsh-a' }],
    }))
    assert.throws(() => loadManifest(dir), /同时出现在 active 与 retired/)
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({
      active: ['dsh-a', 'dsh-a'],
      retired: [],
    }))
    assert.throws(() => loadManifest(dir), /active 数组重复项：dsh-a/)
  } finally {
    cleanup()
  }
})

test('#8b standalone 校验：重名互斥 / 数组重复项 → 报错；缺省缺省为空集', () => {
  const { dir, cleanup } = tempRepo()
  try {
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({
      active: ['dsh-a'],
      standalone: ['dsh-a'],
      retired: [],
    }))
    assert.throws(() => loadManifest(dir), /同时出现在 active 与 standalone/)
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({
      active: [],
      standalone: ['dsh-b', 'dsh-b'],
      retired: [],
    }))
    assert.throws(() => loadManifest(dir), /standalone 数组重复项：dsh-b/)
    writeFileSync(join(dir, 'scripts', 'data', 'plugins-manifest.json'), JSON.stringify({
      active: ['dsh-a'], retired: [],
    }))
    assert.deepEqual(loadManifest(dir).standalone, [], '缺 standalone 键应为空集')
  } finally {
    cleanup()
  }
})

test('#9 正向全绿：真实仓库 manifest + 真实目录 + 真实聚合 deps/patch', async () => {
  // 直接 import 根 package.json 同级的真实数据（node --test 直跑 TS，无构建步骤）
  const { readFileSync } = await import('node:fs')
  const root = join(import.meta.dirname, '..', '..')
  const manifest = loadManifest(root)
  const dirs = listPluginDirs(root)
  assert.deepEqual(checkAggregateConsistency({ dirNames: dirs, manifest }), [])
  // 聚合包真实 deps 与 patch 也应双向相等
  const aggPkg = JSON.parse(readFileSync(join(root, 'packages', 'dsh-plugins-all', 'package.json'), 'utf8'))
  const patch = readFileSync(join(root, 'packages', 'dsh-plugins-all', 'cordis.patch.yml'), 'utf8')
  const aggRows = [...patch.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1])
  // 期望 id 集 = 各 active 子包 patch 实际 insert id（不硬编码 ui-，纯宿主插件如
  // dsh-verify-isolated 用 skill- 前缀；与 aggregate「原样拼接」语义一致）
  const expectedPatchIds = []
  for (const dir of manifest.active) {
    const child = readFileSync(join(root, 'packages', dir, 'cordis.patch.yml'), 'utf8')
    expectedPatchIds.push(...[...child.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1]))
  }
  assert.deepEqual(
    checkAggregateConsistency({ dirNames: dirs, manifest, aggDeps: aggPkg.dependencies ?? {}, aggPatchIds: aggRows, expectedPatchIds }),
    [],
  )
})
