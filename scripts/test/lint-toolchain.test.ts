#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * lint 工具链隔离的结构断言（#722 阶段五）。
 *
 * 为什么需要：tools/lint 位于 packages/ 之外，所有既有门禁（listPluginDirs / catalog-peers /
 * ci-matrix / aggregate / pack-check）都只扫 packages/，因此这一层没有任何现成看守。而它承载
 * 一个会「静默失效」的关键前提——typescript-eslint 必须解析到带 compiler API 的 TS 6.x，
 * 同时仓根 typescript 必须仍是 tsgo（根 tsc 由它提供，各包 build/typecheck 依赖它）。
 * 隔离一旦被破坏（依赖被提升、overrides 被加、根本被降级），失败形态是「lint 全绿但没在跑规则」
 * 或「build/typecheck 换了编译器」，两者都不会自己报出来，故在此逐条钉死。
 *
 * 运行：pnpm test:scripts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const requireRoot = createRequire(join(ROOT, 'package.json'))
const requireLint = createRequire(join(ROOT, 'tools', 'lint', 'package.json'))

test('#722 阶段五：lint 工具链隔离——根 tsgo 与 lint 专用 TS 6 各自归位', () => {
  // ⓪ 结构存在性
  for (const rel of [
    'tools/lint/package.json',
    'tools/lint/eslint.config.js',
    'tools/lint/bin/lint.mjs',
  ]) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 必须存在（lint 工具链隔离包）`)
  }

  // ① 根 typescript 必须仍是 tsgo：有版本号、无 compiler API
  const rootTs = requireRoot('typescript')
  assert.match(String(rootTs.version), /^7\./, `根 typescript 应为 7.x（实测 ${rootTs.version}）`)
  assert.equal(typeof rootTs.createSourceFile, 'undefined',
    '根 typescript 必须是 tsgo 原生版（无 compiler API）——根 tsc 由它提供，各包 build/typecheck 依赖它；被换成 6.x 会静默改变全部产物的生成器')

  // ② tools/lint 的 typescript 必须有 compiler API（typescript-eslint 的硬前提）
  const lintTs = requireLint('typescript')
  assert.equal(typeof lintTs.createSourceFile, 'function',
    'tools/lint 的 typescript 必须带 compiler API——否则 typescript-eslint 会在加载时抛 "does not support TS 7.0"')
  assert.match(String(lintTs.version), /^6\./,
    `tools/lint 的 typescript 应为 6.x（实测 ${lintTs.version}）；7.x 无 API，typescript-eslint 不支持`)

  // ③ 两个版本必须真的共存（防止某一侧被提升/覆盖后「看起来还能跑」）
  assert.notEqual(rootTs.version, lintTs.version,
    '根与 lint 子包必须解析到不同大版本的 typescript——同版意味着隔离已失效')

  // ④ 根 tsc 可执行文件必须仍来自 tsgo
  const tscBin = join(ROOT, 'node_modules', '.bin', 'tsc')
  assert.ok(existsSync(tscBin), 'node_modules/.bin/tsc 必须存在（各包 build/typecheck 调用它）')
})

test('#722 阶段五：复杂度阈值唯一事实源在 gauntlet.config.json，配置不得硬编码', () => {
  const gauntlet = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'gauntlet.config.json'), 'utf8'))
  const c = gauntlet.complexity
  assert.ok(c !== undefined, 'gauntlet.config.json 必须有 complexity 段（阈值唯一事实源）')
  assert.equal(typeof c.cyclomatic, 'number', 'complexity.cyclomatic 必须是数字')
  assert.equal(typeof c.cognitive, 'number', 'complexity.cognitive 必须是数字')
  // 起步值 = 全域实测最大值；收紧路线见 issue #732。此处只锁「不得高于起步基线」，
  // 允许后续按 #732 下调（下调是收紧，方向正确），但不得反弹回更高。
  assert.ok(c.cyclomatic <= 78, `complexity.cyclomatic 不得高于起步基线 78（实测 ${c.cyclomatic}）`)
  assert.ok(c.cognitive <= 84, `complexity.cognitive 不得高于起步基线 84（实测 ${c.cognitive}）`)

  // 配置必须消费事实源，不得写死数字阈值（否则改 gauntlet 不生效 = 事实源被绕过）
  const configText = readFileSync(join(ROOT, 'tools', 'lint', 'eslint.config.js'), 'utf8')
  assert.ok(!/complexity:\s*\[\s*'error'\s*,\s*\d/.test(configText),
    'eslint.config.js 不得硬编码 complexity 的数字阈值（必须读 gauntlet.config.json）')
  assert.ok(!/'sonarjs\/cognitive-complexity':\s*\[\s*'error'\s*,\s*\d/.test(configText),
    'eslint.config.js 不得硬编码 cognitive-complexity 的数字阈值（必须读 gauntlet.config.json）')
  assert.match(configText, /gauntlet\.config\.json/,
    'eslint.config.js 必须显式读取 gauntlet.config.json 作为阈值来源')
})
