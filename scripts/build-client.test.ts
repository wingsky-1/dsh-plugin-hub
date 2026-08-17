#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * build-client 脚本自测（node:test）。
 *
 * 覆盖有决策逻辑的关键面：
 *   - wrapper 模式：干净模块（无 loader 痕迹）→ 契约外壳产物（load id 注入 + 契约断言）
 *   - legacy 检测：源码含 __ModuleLoader__.load → 原样构建
 *   - 注释剥离：干净模块注释提到 loader 不误判 legacy
 *   - 内建校验：load id 拼错/遮蔽时构建即失败（throw）
 * 运行：node --test scripts/build-client.test.ts（或 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildClient } from './build-client.ts'
import { assertClientContract } from './client-contract-lib.ts'

const PKG = '@wingsky-1/buildclient-test'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bc-test-'))
  return {
    dir,
    rm: () => rmSync(dir, { recursive: true, force: true }),
    src: (name = 'client.ts', content) => {
      const p = join(dir, name)
      writeFileSync(p, content)
      return p
    },
  }
}

test('wrapper 模式：干净模块 → 契约产物（load id 注入 + apply/inject 装配）', async () => {
  const t = tempDir()
  try {
    const src = t.src('client.ts', [
      'export const inject: string[] = []',
      'export function apply(_ctx: unknown): () => void { return () => {} }',
      '',
    ].join('\n'))
    const out = join(t.dir, 'client.js')
    const { mode } = await buildClient({ src, outfile: out, packageName: PKG })
    assert.equal(mode, 'wrapper', '无 loader 痕迹应走 wrapper 模式')
    const { ok, checks } = assertClientContract(PKG, readFileSync(out, 'utf8'))
    assert.ok(ok, `契约断言失败: ${JSON.stringify(checks)}`)
    const code = readFileSync(out, 'utf8')
    assert.ok(code.includes('"use strict"'), '产物含 use strict')
    assert.ok(code.includes(PKG), '产物注入完整包名')
  } finally { t.rm() }
})

test('legacy 检测：源码含 __ModuleLoader__.load → 原样构建', async () => {
  const t = tempDir()
  try {
    const src = t.src('client.ts', [
      'window.__ModuleLoader__.load({',
      '  id: __DSH_PLUGIN_ID__,',
      '  factory: function (require) { var m = { exports: {} }; m.exports.apply = function(){}; m.exports.inject = []; return m.exports; },',
      '});',
      '',
    ].join('\n'))
    const out = join(t.dir, 'client.js')
    const { mode } = await buildClient({ src, outfile: out, packageName: PKG })
    assert.equal(mode, 'legacy', '含 load 注册应走 legacy 模式')
    assert.ok(readFileSync(out, 'utf8').includes(PKG), 'define 注入仍生效')
  } finally { t.rm() }
})

test('注释剥离：干净模块注释提到 loader 不误判 legacy', async () => {
  const t = tempDir()
  try {
    const src = t.src('client.ts', `// 说明：运行时由 __ModuleLoader__.load 装配（契约）
export const inject: string[] = []
export function apply(): () => void { return () => {} }
`)
    const out = join(t.dir, 'client.js')
    const { mode } = await buildClient({ src, outfile: out, packageName: PKG })
    assert.equal(mode, 'wrapper', '注释含 loader 不应误判 legacy（应剥离注释后检测）')
  } finally { t.rm() }
})

test('内建校验：占位符拼错 → 构建即失败（throw）', async () => {
  const t = tempDir()
  try {
    // wrapper 模式下源码不引用 __DSH_PLUGIN_ID__，注入必然成功；此用例验证
    // legacy 源若把占位符写错（如 __DSH_PLUGIN_ID_ 少下划线），define 后产物
    // load id 不是包名 → 内建校验抛错。
    const src = t.src('client.ts', [
      'window.__ModuleLoader__.load({',
      '  id: __DSH_PLUGIN_ID_X,', // 拼错：esbuild define 不替换 → 自由变量
      '  factory: function (require) { var m = { exports: {} }; m.exports.apply = function(){}; m.exports.inject = []; return m.exports; },',
      '});',
      '',
    ].join('\n'))
    const out = join(t.dir, 'client.js')
    await assert.rejects(
      () => buildClient({ src, outfile: out, packageName: PKG }),
      /客户端契约校验失败/,
      '占位符拼错应在构建期失败',
    )
  } finally { t.rm() }
})