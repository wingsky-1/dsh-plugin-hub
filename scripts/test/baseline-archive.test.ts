#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 变异基线归档分支的纯函数回归（#714 后续修复）。
 *
 * 为什么存在：归档分支 `baseline/mutation` 由两个入口维护——夜间增量班次（全量恢复+强推）
 * 与 PR 合并后的 overlay（只覆盖本次 CI 产出的段）。后者曾因 **artifact API 默认分页 30 条**
 * 只覆盖 14/31 段，再配合整棵树强推，把未覆盖的段固化成旧版本、把两个「本来没有基线」的段
 * （provider-usage-errsurf、web-file-preview）每次合并都抹掉。实测证据（2026-09-11）：
 *   gh api repos/.../actions/runs/34559972509/artifacts            → total_count 70、mutation-incremental 14
 *   gh api repos/.../actions/runs/34559972509/artifacts?per_page=100 → total_count 70、mutation-incremental 31
 * 本文件把「分页合并」「期望集合派生」「对账缺口」三件事钉死，避免再次静默丢段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BASELINE_FILE_RE,
  GH_API_PER_PAGE,
  expectedBaselineFiles,
  mergeArtifactPage,
  mutationArtifacts,
  reconcileArchive,
} from '../gate/baseline-archive.mjs'

const ROOT = join(import.meta.dirname, '..', '..')

/** 造一页 artifact API 响应。 */
function page(names, totalCount) {
  return { total_count: totalCount ?? names.length, artifacts: names.map((name) => ({ name })) }
}

test('分页合并：单页已取满时一轮结束', () => {
  const first = mergeArtifactPage([], page(['a', 'b'], 2), 1)
  assert.equal(first.items.length, 2)
  assert.equal(first.nextPage, null, '已取满 total_count 时不应再翻页')
  assert.equal(first.done, true)
})

test('分页合并：total_count 大于本页时给出下一页', () => {
  const first = mergeArtifactPage([], page(Array.from({ length: 30 }, (_, i) => `a${i}`), 70), 1)
  assert.equal(first.items.length, 30)
  assert.equal(first.nextPage, 2, '应继续翻页（原缺陷就是在这里停住）')

  const second = mergeArtifactPage(first.items, page(Array.from({ length: 40 }, (_, i) => `b${i}`), 70), 2)
  assert.equal(second.items.length, 70, '两页应合并为 70 条')
  assert.equal(second.nextPage, null, '取满 total_count 后终止')
})

test('分页合并：空页终止（短页 + total_count 偏大时不重复请求同一页）', () => {
  // 页号必须严格递增：用「已收条数 / perPage」反推会在短页时算回同一页。
  const first = mergeArtifactPage([], page(Array.from({ length: 7 }, (_, i) => `c${i}`), 70), 1)
  assert.equal(first.nextPage, 2, '短页但未达 total_count 时页号应 +1')
  const second = mergeArtifactPage(first.items, page([], 70), 2)
  assert.equal(second.nextPage, null, '空页应终止')
  assert.equal(second.items.length, 7, '空页不得改变已合并结果')
  assert.equal(second.done, true)
})

test('分页合并：模拟真实两次请求的循环（30 + 40 = 70）并终止', () => {
  const pages = [
    page(Array.from({ length: 30 }, (_, i) => `p1-${i}`), 70),
    page(Array.from({ length: 40 }, (_, i) => `p2-${i}`), 70),
  ]
  let items = []
  let pageNo = 1
  let rounds = 0
  for (;;) {
    rounds++
    const merged = mergeArtifactPage(items, pages[pageNo - 1] ?? page([], 70), pageNo)
    items = merged.items
    if (merged.nextPage === null) break
    pageNo = merged.nextPage
    assert.ok(rounds < 10, '不得死循环')
  }
  assert.equal(rounds, 2, '两页数据应两轮取完')
  assert.equal(items.length, 70)
})

test('产物筛选：只认 mutation-incremental- 前缀，且容忍脏数据', () => {
  const picked = mutationArtifacts([
    { name: 'mutation-incremental-dsh-mcp-manager-entry' },
    { name: 'dsh-mcp-manager-entry.json' },
    { name: 'coverage-self' },
    { name: null },
    {},
    { name: 'mutation-incremental-dsh-notifier-sdk' },
  ])
  assert.deepEqual(picked.map((a) => a.name), [
    'mutation-incremental-dsh-mcp-manager-entry',
    'mutation-incremental-dsh-notifier-sdk',
  ])
})

test('期望集合派生：dsh- 前缀剥离 + seg=0 单配置形态', () => {
  assert.deepEqual(
    expectedBaselineFiles(['dsh-mcp-manager-entry.json', 'dsh-web-file-preview.json', 'dsh-notifier-sdk.json']),
    ['incremental-mcp-manager-entry.json', 'incremental-notifier-sdk.json', 'incremental-web-file-preview.json'],
  )
  assert.deepEqual(expectedBaselineFiles(['README.md', null]), [], '非 .json 条目不得进期望集合')
})

test('期望集合与真实仓库一致：stryker.conf.d/*.json 一条不落（31 段）', () => {
  const confNames = readdirSync(join(ROOT, 'stryker.conf.d')).filter((f) => f.endsWith('.json'))
  const expected = expectedBaselineFiles(confNames)
  assert.equal(expected.length, confNames.length, '每个段配置都应对应一个基线文件')
  assert.equal(expected.length, 31, `段数应为 31，实际 ${expected.length}`)
  for (const f of expected) assert.match(f, BASELINE_FILE_RE, `文件名应匹配归档形态：${f}`)
})

test('对账：既未覆盖也不在旧基线 → 报缺口（复现原缺陷的两段）', () => {
  const expected = ['incremental-a.json', 'incremental-b.json', 'incremental-c.json']
  const r = reconcileArchive({
    expected,
    overlaid: ['incremental-a.json'],
    carriedForward: ['incremental-b.json'],
  })
  assert.deepEqual(r.missing, ['incremental-c.json'], '只有两处都没有的段才算缺口')
  assert.equal(r.overlaidCount, 1)
  assert.equal(r.carriedCount, 1)
})

test('对账：空归档（首次 overlay）不得误报为「数据丢失」之外的语义', () => {
  const r = reconcileArchive({ expected: ['incremental-a.json'], overlaid: [], carriedForward: [] })
  assert.deepEqual(r.missing, ['incremental-a.json'])
})

test('对账：全覆盖时缺口为空', () => {
  const r = reconcileArchive({
    expected: ['incremental-a.json', 'incremental-b.json'],
    overlaid: ['incremental-a.json'],
    carriedForward: ['incremental-b.json'],
  })
  assert.deepEqual(r.missing, [])
})

test('回归：旧实现（只读第 1 页）会丢段，新实现拿全 31 段', () => {
  // 用真实形状构造两页：page1 30 条里混入 14 个 mutation-incremental，page2 40 条里含其余 17 个。
  const mutPage1 = Array.from({ length: 14 }, (_, i) => `mutation-incremental-pkg-${i}`)
  const mutPage2 = [
    'mutation-incremental-dsh-provider-usage-errsurf',
    'mutation-incremental-dsh-web-file-preview-0',
    ...Array.from({ length: 15 }, (_, i) => `mutation-incremental-pkg-${i + 14}`),
  ]
  const others = (n) => Array.from({ length: n }, (_, i) => `report-${i}`)
  const page1 = [...mutPage1, ...others(16)]
  const page2 = [...mutPage2, ...others(23)]
  assert.equal(page1.length + page2.length, 70, 'fixture 应与真实 run 的 total_count 同形')

  let items = []
  const first = mergeArtifactPage(items, page(page1, 70), 1)
  const oldWay = mutationArtifacts(first.items) // 旧实现停在第 1 页
  items = first.items
  const second = mergeArtifactPage(items, page(page2, 70), 2)
  const newWay = mutationArtifacts(second.items)

  assert.equal(oldWay.length, 14, '旧实现只看到 14 个（与实测一致）')
  assert.equal(newWay.length, 31, '新实现应拿全 31 个')
  for (const name of ['mutation-incremental-dsh-provider-usage-errsurf', 'mutation-incremental-dsh-web-file-preview-0']) {
    assert.ok(!oldWay.some((a) => a.name === name), `旧实现应缺失 ${name}`)
    assert.ok(newWay.some((a) => a.name === name), `新实现应包含 ${name}`)
  }
})

test('脚本静态检查：两处 GitHub API 调用都显式带上分页参数', () => {
  // 防回归：任何新增的 actions API 调用若不带 per_page，就是同一个缺陷的复发。
  const src = readFileSync(join(ROOT, 'scripts/gate/overlay-baseline.mjs'), 'utf8')
  const apiCalls = (src.match(/['"]api['"],\s*\n?\s*`[^`]+`/g) ?? [])
    .filter((call) => /actions\/runs/.test(call) || /artifacts/.test(call))
  assert.ok(apiCalls.length >= 2, `应至少有两处 actions API 调用，实际 ${apiCalls.length}`)
  for (const call of apiCalls) {
    assert.match(call, /per_page=/, `gh api 调用缺少分页参数（默认 30 条会截断）：${call}`)
  }
})
