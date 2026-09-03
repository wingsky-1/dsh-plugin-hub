#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared-dts-lib 自测（node:test，issue #461 L2）。
 *
 * L2 目标：pack-check 对 shared 声明副本断言从「硬编码 plugin-skeleton.d.ts 单文件」
 * 升级为「仓库 shared/ 全部 .d.ts（递归含子目录）逐一随包」——新增 shared 子目录/文件
 * （如 client/i18n.d.ts）漏打包时必须 fail-loud，机制保证 → 断言保证。
 *
 * 覆盖：
 *   - listSharedDts 枚举正确（含 host/ client/ 子目录，返回相对路径）
 *   - assertSharedDtsPresent 缺文件报错 / 完整通过
 *   - 与 bundle-host d.ts X1 复制谓词同源：bundle-host 必须复用共享 walkFiles
 *     （防「复制机制」与「断言清单」两处枚举实现漂移）
 *   - 真实仓库方向：当前 shared/ 的 d.ts 清单非空且含新增 client/i18n.d.ts
 * 运行：node --test scripts/test/shared-dts.test.ts（或 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSharedDtsNoExtras, assertSharedDtsPresent, listSharedDts } from '../lib/shared-dts-lib.ts'
import { walkFiles } from '../lib/walk-files.ts'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sdt-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fixtureShared(root) {
  // 构造与真实 shared/ 同构的目录：顶层 loopback.d.ts + host/ + client/ 子目录
  const shared = join(root, 'shared')
  mkdirSync(join(shared, 'host'), { recursive: true })
  mkdirSync(join(shared, 'client'), { recursive: true })
  writeFileSync(join(shared, 'loopback.d.ts'), '')
  writeFileSync(join(shared, 'host', 'plugin-skeleton.d.ts'), '')
  writeFileSync(join(shared, 'client', 'i18n.d.ts'), '')
  // 非 .d.ts 文件不得被枚举（.js 是运行时内联源，不随包）
  writeFileSync(join(shared, 'host', 'plugin-skeleton.js'), '')
  writeFileSync(join(shared, 'client', 'i18n.js'), '')
  return shared
}

test('#1 listSharedDts 递归枚举全部 .d.ts（含子目录、排除 .js）', () => {
  const { dir, cleanup } = tempDir()
  try {
    fixtureShared(dir)
    const list = listSharedDts(dir)
    assert.deepEqual(list, ['client/i18n.d.ts', 'host/plugin-skeleton.d.ts', 'loopback.d.ts'])
  } finally {
    cleanup()
  }
})

test('#2 assertSharedDtsPresent 缺文件报错（含子目录路径）', () => {
  const { dir, cleanup } = tempDir()
  try {
    const shared = fixtureShared(dir)
    // 模拟 pack-check 语义：期望清单来自仓库 shared/（删除前快照），
    // tarball 副本缺 client/i18n.d.ts（新增 shared d.ts 漏随包）→ 必须报出
    const expected = listSharedDts(dir)
    rmSync(join(shared, 'client', 'i18n.d.ts'))
    const missing = assertSharedDtsPresent(shared, expected)
    assert.deepEqual(missing, ['client/i18n.d.ts'])
  } finally {
    cleanup()
  }
})

test('#3 assertSharedDtsPresent 完整副本通过（空缺件清单）', () => {
  const { dir, cleanup } = tempDir()
  try {
    fixtureShared(dir)
    const missing = assertSharedDtsPresent(join(dir, 'shared'), listSharedDts(dir))
    assert.deepEqual(missing, [])
  } finally {
    cleanup()
  }
})

test('#4 与真实仓库 shared/ 一致：清单非空、含新增 client/i18n.d.ts、路径真实存在', () => {
  const root = join(import.meta.dirname, '..', '..')
  const list = listSharedDts(root)
  assert.ok(list.length >= 3, '仓库 shared/ 至少含顶层 + host/ + client/ 的 d.ts')
  // 必须命中 L2 新增断言目标：client/ 子目录文件（i18n.d.ts）
  assert.ok(list.includes('client/i18n.d.ts'), '新增 shared/client/i18n.d.ts 必须进入枚举清单')
  // 全部为 .d.ts 且在仓库 shared/ 真实存在
  for (const rel of list) {
    assert.match(rel, /\.d\.ts$/)
    assert.ok(existsSync(join(root, 'shared', rel)), `清单项 ${rel} 应在仓库 shared/ 真实存在`)
  }
})

test('#5 同源防漂移：bundle-host 复用共享 walkFiles，无私有枚举实现', () => {
  const root = join(import.meta.dirname, '..', '..')
  const bundleHost = readFileSync(join(root, 'scripts', 'build', 'bundle-host.ts'), 'utf8')
  // 机制保证：bundle-host d.ts X1（2b）必须 import 共享 walkFiles，而不是自写遍历
  assert.match(bundleHost, /import \{ walkFiles \} from '\.\.\/lib\/walk-files\.ts'/, 'bundle-host 必须复用共享 walkFiles')
  // 断言保证：pack-check 必须经 listSharedDts 枚举期望清单（与复制谓词同源）
  const packCheck = readFileSync(join(root, 'scripts', 'gate', 'pack-check.ts'), 'utf8')
  assert.match(packCheck, /listSharedDts\(ROOT\)/, 'pack-check 必须经 listSharedDts 枚举期望清单')
  // 共享 walkFiles 自身行为基准（防 lib 重构误伤）
  const { dir, cleanup } = tempDir()
  try {
    fixtureShared(dir)
    const walked = walkFiles(join(dir, 'shared'), (f) => f.endsWith('.d.ts'))
    assert.deepEqual(walked, ['client/i18n.d.ts', 'host/plugin-skeleton.d.ts', 'loopback.d.ts'])
  } finally {
    cleanup()
  }
})

test('#6 assertSharedDtsNoExtras 查多：包内预置残留副本 → 报出该文件（红）', () => {
  const { dir, cleanup } = tempDir()
  try {
    const shared = fixtureShared(dir)
    const expected = listSharedDts(dir)
    // 模拟 retired 残留：源 shared/ 已移除某 d.ts，但包内 shared/ 仍残留旧副本
    writeFileSync(join(shared, 'retired.d.ts'), '')
    writeFileSync(join(shared, 'host', 'old-archived.d.ts'), '')
    const extras = assertSharedDtsNoExtras(shared, expected)
    assert.deepEqual(extras, ['host/old-archived.d.ts', 'retired.d.ts'])
  } finally {
    cleanup()
  }
})

test('#6b assertSharedDtsNoExtras 查多：移除残留后出口为空（绿）', () => {
  const { dir, cleanup } = tempDir()
  try {
    const shared = fixtureShared(dir)
    const extras = assertSharedDtsNoExtras(shared, listSharedDts(dir))
    assert.deepEqual(extras, [], '无残留 → 空清单')
  } finally {
    cleanup()
  }
})

test('#7 同源防漂移：pack-check 每包接入查多出口（assertSharedDtsNoExtras fail-loud）', () => {
  const root = join(import.meta.dirname, '..', '..')
  const packCheck = readFileSync(join(root, 'scripts', 'gate', 'pack-check.ts'), 'utf8')
  // 生产路径接入断言（防「检测出口不进生产路径」假绿回归）：pack-check 必须调用
  // assertSharedDtsNoExtras 并对非空 extra 判 FAIL（残留 fail-loud）
  assert.match(packCheck, /assertSharedDtsNoExtras/, 'pack-check 必须调用查多出口 assertSharedDtsNoExtras')
  assert.match(packCheck, /shared 副本残留/, 'pack-check 对残留须报 fail-loud 文案')
})