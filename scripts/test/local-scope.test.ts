#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 本地门禁分层（#722）的包面推导回归。
 *
 * 为什么存在：`pnpm gate:changed` 的价值全押在「本地切片 == CI 切片」上。它靠解析
 * ci.yml 的 paths-filter `filters` 块拿到包面归属，所以三类回归必须钉死：
 *   1. 解析器被块内注释行/引号形态打挂 → 静默回退全量（本地又变慢，无人察觉）；
 *   2. 解析器「宽容」到把注释里的路径当规则 → 本地少跑（本地绿 CI 红）；
 *   3. 全局面（shared/scripts/.github/包管理文件）不再升级 → 静态闸在本地被绕过。
 * 断言全部锚在真实 ci.yml 上（不另写 fixture 副本，避免与事实源漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { CI_WORKFLOW, matchFilterBlock, parseFilterBlock, planChangedScope } from '../gate/local-scope.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CI_YML = readFileSync(join(ROOT, CI_WORKFLOW), 'utf8')

test('parseFilterBlock：真实 ci.yml 的 filters 块可解析，且含全局面与 7 个包面', () => {
  const filters = parseFilterBlock(CI_YML)
  assert.ok(filters !== null, 'filters 块必须可解析（不可解析 → 本地静默回退全量）')
  assert.ok(Array.isArray(filters.global) && filters.global.length > 0, 'global 面必须存在且非空')
  for (const pkg of ['dsh-notifier', 'dsh-web-file-preview', 'dsh-mcp-manager', 'dsh-provider-usage', 'dsh-lan-proxy', 'dsh-verify-isolated', 'dsh-plugins-all']) {
    assert.ok(Array.isArray(filters[pkg]), `包面 ${pkg} 必须在 filters 块内`)
  }
  // #220 决策：docs/** 与 AGENTS.md 刻意不在全局面，纯文档 PR 不跑变异/切片
  assert.ok(filters.global.includes('shared/**'), 'shared/** 属于全局面')
  assert.ok(filters.global.includes('pnpm-lock.yaml'), '锁文件属于全局面')
  assert.ok(filters.global.some((g) => g === '.github/**'), '.github/** 属于全局面')
  assert.ok(!filters.global.some((g) => g.startsWith('docs/') || g === 'AGENTS.md'), 'docs 面不得混入全局面（#220）')
  // 块内注释行不得被当成规则
  assert.ok(!Object.keys(filters).some((k) => k.startsWith('#')), '注释行不得被解析为 filter 键')
  assert.ok(!Object.values(filters).flat().some((g) => g.startsWith('#')), '注释行不得被解析为 glob')
})

test('parseFilterBlock：块缺失/畸形一律返回 null（调用方 fail-closed）', () => {
  assert.equal(parseFilterBlock('name: CI\non:\n  pull_request:\n'), null, '无 filters 块 → null')
  assert.equal(parseFilterBlock('        filters: |\n          global:\n            - no-quotes-here\n'), null, '未加引号的条目 → null')
})

test('matchFilterBlock：包内改动命中该包；全局面命中 global；纯文档两者都不命中', () => {
  const filters = parseFilterBlock(CI_YML)
  assert.deepEqual(matchFilterBlock(filters, ['packages/dsh-notifier/src/text/sanitize.ts']), { globalHit: false, packages: ['dsh-notifier'] })
  assert.deepEqual(matchFilterBlock(filters, ['pnpm-lock.yaml']), { globalHit: true, packages: [] })
  assert.deepEqual(matchFilterBlock(filters, ['docs/DEVELOPMENT.md', 'AGENTS.md']), { globalHit: false, packages: [] })
  // 段配置是变异单一事实源（#322）：改段配置必须命中该包
  assert.deepEqual(matchFilterBlock(filters, ['stryker.conf.d/dsh-lan-proxy-2.json']), { globalHit: false, packages: ['dsh-lan-proxy'] })
})

test('planChangedScope：全局面命中回退全量；单包改动只命中该包；解析失败回退全量', () => {
  const allPackages = ['dsh-lan-proxy', 'dsh-notifier', 'dsh-plugins-all']

  const scoped = planChangedScope({ root: ROOT, files: ['packages/dsh-lan-proxy/src/proxy.ts'], allPackages })
  assert.deepEqual(scoped.hitPackages, ['dsh-lan-proxy'])
  assert.equal(scoped.globalHit, false)

  const global = planChangedScope({ root: ROOT, files: ['scripts/gate/local-gate.mjs'], allPackages })
  assert.deepEqual(global.hitPackages, allPackages, '改 scripts/** 必须回退全量（本地快线覆盖不到静态闸）')
  assert.equal(global.globalHit, true)

  // 解析失败：临时根里放一份没有 filters 块的 workflow
  const tmpRoot = mkdtempSync(join(tmpdir(), 'local-scope-'))
  try {
    mkdirSync(join(tmpRoot, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(tmpRoot, CI_WORKFLOW), 'name: CI\non:\n  pull_request:\n', 'utf8')
    const broken = planChangedScope({ root: tmpRoot, files: ['packages/dsh-lan-proxy/src/proxy.ts'], allPackages })
    assert.deepEqual(broken.hitPackages, allPackages, 'filters 不可解析 → 全量（fail-closed）')
    assert.equal(broken.escalated, true)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})
