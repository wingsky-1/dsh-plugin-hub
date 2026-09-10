#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * catalog-peers（#695）：官方类型层依赖声明一致性门禁的单测。
 *
 * 正向用真实仓库数据（零 problem 是回归底线）；负向用 mkdtemp 最小副本
 * （不触碰真实仓库，符合测试产物零污染纪律 #218）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCatalogPeers, parseCatalog, parseReleaseExclude } from '../lib/catalog-peers-lib.ts'

const ROOT = join(import.meta.dirname, '..', '..')

test('真实仓库：catalog ↔ peer 零违规', () => {
  const { problems, catalogSize, officialPeerCount } = checkCatalogPeers(ROOT)
  assert.deepEqual(problems, [])
  assert.ok(catalogSize >= 15, `catalog 应含补全后的官方包，实际 ${catalogSize}`)
  // #698：dsh-web-file-preview 重定位为纯客户端转发后依赖归零（移除其
  // dsh-host-webserver / dsh-client-ui-slots 声明），总数 21 → 19。紧贴实际保持
  // 回归底线语义：误删任一插件仍在使用中的官方 peer 声明依旧判红。
  assert.ok(officialPeerCount >= 19, `官方 peer 应覆盖全部插件，实际 ${officialPeerCount}`)
})

test('parseCatalog：只取 catalog 段，不被后续顶层段污染', () => {
  const yaml = [
    'catalog:',
    "  '@deepseek-ai/cordis': 4.0.2",
    "  '@deepseek-ai/dsh-session': 0.1.2-rc.1",
    'allowBuilds:',
    '  esbuild: true',
    '',
  ].join('\n')
  const catalog = parseCatalog(yaml)
  assert.equal(catalog.size, 2)
  assert.equal(catalog.get('@deepseek-ai/dsh-session'), '0.1.2-rc.1')
})

test('parseReleaseExclude：剥离 @version 后缀', () => {
  const yaml = ['minimumReleaseAgeExclude:', "  - '@deepseek-ai/dsh-session@0.1.2-rc.1'", 'allowBuilds:', ''].join('\n')
  assert.ok(parseReleaseExclude(yaml).has('@deepseek-ai/dsh-session'))
})

/** 造最小仓库副本：pnpm-workspace.yaml + 一个带官方 peer 的包。 */
function makeRepo({
  peer = 'catalog:',
  catalogLine = "  '@deepseek-ai/dsh-session': 0.1.2-rc.1",
  excludeLine = "  - '@deepseek-ai/dsh-session@0.1.2-rc.1'",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-peers-'))
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    ['catalog:', catalogLine, 'minimumReleaseAgeExclude:', excludeLine, ''].join('\n'),
  )
  mkdirSync(join(dir, 'packages', 'dsh-probe'), { recursive: true })
  writeFileSync(
    join(dir, 'packages', 'dsh-probe', 'package.json'),
    JSON.stringify({ name: 'probe', peerDependencies: { '@deepseek-ai/dsh-session': peer } }, null, 2),
  )
  return dir
}

function withRepo(options, fn) {
  const dir = makeRepo(options)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('负向：peer 写显式字面版本 → 判红', () => {
  withRepo({ peer: '0.1.2-rc.1' }, (dir) => {
    const { problems } = checkCatalogPeers(dir)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /一律写 catalog:/)
  })
})

test('负向：catalog: 引用无对应条目 → 判红', () => {
  withRepo({ catalogLine: "  '@deepseek-ai/other': 1.0.0", excludeLine: "  - '@deepseek-ai/other@1.0.0'" }, (dir) => {
    const { problems } = checkCatalogPeers(dir)
    assert.ok(problems.some((p) => /无此 catalog 条目/.test(p)), `实际: ${JSON.stringify(problems)}`)
  })
})

test('负向：catalog 键未登记供应链豁免清单 → 判红', () => {
  withRepo({ excludeLine: "  - '@deepseek-ai/unrelated@1.0.0'" }, (dir) => {
    const { problems } = checkCatalogPeers(dir)
    assert.ok(
      problems.some((p) => /未登记进 minimumReleaseAgeExclude/.test(p)),
      `实际: ${JSON.stringify(problems)}`,
    )
  })
})
