#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * collect-licenses 自测（node:test，issue #13）。
 *
 * 覆盖：
 *   - extractInlinedPackages：pnpm 布局注释 / 直接 node_modules 注释 /
 *     @deepseek-ai 宿主注入排除 / 去重排序 / 无匹配空集
 *   - collectForPackage：有内联 → 写 lib/THIRD-PARTY-LICENSES 且覆盖包名与
 *     license 文本；无内联 → 返回 [] 且不落文件；缺 lib/ → fail-loud
 * 运行：node --test scripts/collect-licenses.test.ts（或 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectForPackage, extractInlinedPackages } from './collect-licenses.ts'

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lic-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造一个「已构建」的假插件包：lib/index.js 含 esbuild 内联注释 + 包级依赖。 */
function fixturePackage(root, { name, indexSource, depLicense }) {
  const pkg = join(root, 'packages', name)
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'lib', 'index.js'), indexSource)
  if (depLicense) {
    // pnpm 布局：包级 node_modules/<dep> 为 symlink（此处直接用真实目录简化）
    const depDir = join(pkg, 'node_modules', 'fake-lib')
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'LICENSE'), depLicense)
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'fake-lib', version: '1.2.3', license: 'MIT' }))
    symlinkSync(depDir, join(pkg, 'node_modules', 'linked-lib'))
  }
  return pkg
}

test('extractInlinedPackages：pnpm 布局与直接 node_modules 注释均可提取', () => {
  const src = [
    '// ../../node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket.js',
    'export const x = 1',
    '// ../../node_modules/highlight.js/lib/core.js',
  ].join('\n')
  assert.deepEqual(extractInlinedPackages(src), ['highlight.js', 'ws'])
})

test('extractInlinedPackages：@deepseek-ai 宿主注入排除、去重、排序、空集', () => {
  const src = [
    '// node_modules/.pnpm/@deepseek-ai+dsh-client-runtime@1.0.0/node_modules/@deepseek-ai/dsh-client-runtime/index.js',
    '// ../..../node_modules/marked/lib/marked.esm.js',
    '// node_modules/.pnpm/schemastery@3.18.0/node_modules/schemastery/lib/index.js',
    '// node_modules/.pnpm/marked@18.0.9/node_modules/marked/lib/marked.cjs',
  ].join('\n')
  assert.deepEqual(extractInlinedPackages(src), ['marked', 'schemastery'])
  assert.deepEqual(extractInlinedPackages('const a = 1'), [])
})

test('extractInlinedModuleRefs：scoped 包的 .pnpm 安装段无重复前缀', async () => {
  const { extractInlinedModuleRefs } = await import('./collect-licenses.ts')
  const src = '// ../../node_modules/.pnpm/@profoundlogic+hogan@3.0.4/node_modules/@profoundlogic/hogan/lib/compiler.js'
  const refs = extractInlinedModuleRefs(src)
  assert.deepEqual(refs, [{
    name: '@profoundlogic/hogan',
    pnpmSeg: '.pnpm/@profoundlogic+hogan@3.0.4/node_modules/@profoundlogic/hogan',
  }])
})

test('collectForPackage：有内联 → 归集文件存在且覆盖包名与 license 文本', () => {
  const { dir, cleanup } = tempRepo()
  try {
    fixturePackage(dir, {
      name: 'dsh-fixture',
      indexSource: '// ../../node_modules/.pnpm/fake-lib@1.2.3/node_modules/fake-lib/index.js\nexport {}',
      depLicense: 'The MIT License (MIT)\n\nCopyright (c) someone',
    })
    const names = collectForPackage('packages/dsh-fixture', dir)
    assert.deepEqual(names, ['fake-lib'])
    const out = readFileSync(join(dir, 'packages/dsh-fixture/lib/THIRD-PARTY-LICENSES'), 'utf8')
    assert.match(out, /THIRD-PARTY LICENSES/)
    assert.match(out, /fake-lib@1\.2\.3 — MIT/)
    assert.match(out, /The MIT License \(MIT\)/)
  } finally { cleanup() }
})

test('collectForPackage：无第三方内联 → 返回空且不写文件；缺 lib → fail-loud', () => {
  const { dir, cleanup } = tempRepo()
  try {
    fixturePackage(dir, { name: 'dsh-clean', indexSource: 'export const apply = () => {}' })
    assert.deepEqual(collectForPackage('packages/dsh-clean', dir), [])
    assert.ok(!existsSync(join(dir, 'packages/dsh-clean/lib/THIRD-PARTY-LICENSES')))
    assert.throws(() => collectForPackage('packages/dsh-absent', dir), /缺 lib/)
  } finally { cleanup() }
})
