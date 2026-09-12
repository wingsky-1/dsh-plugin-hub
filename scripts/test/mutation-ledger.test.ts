#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 变异段台账的解析与覆盖不变量回归（#718 S0.2）。
 *
 * 为什么存在：台账是 S1.4（超时按分段 P95 定标）与 #742（PR wall-clock 上界）的输入，
 * 它的两个失效形态都很隐蔽——漏段（测量没覆盖某段）会让分位数基于不完整样本，
 * 取文件 mtime 当「新鲜度」会把增量班次的文件重写误判成重测。故这里锁死：
 *   1. 解析器只认「日志里真实出现的段」，未闭合的 group 宁缺勿造；
 *   2. wallSeconds 必须是正数（解析失败不得以 0 冒充有效测量）；
 *   3. 入库台账的覆盖不变量：测量值 ∪ unmeasured == 当前 stryker.conf.d 段集合，
 *      消失的历史段必须在 superseded 登记取代关系。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkLedgerEntry,
  expectedSegsFromConfFiles,
  parseLogLine,
  parseSegmentBody,
  parseSegmentLedger,
  reconcileLedgerSegments,
} from '../lib/mutation-ledger-lib.mjs'
import { checkLedger, ledgerCoverage } from '../gate/mutation-ledger.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEDGER_PATH = join(ROOT, 'scripts', 'data', 'mutation-segment-ledger.json')

/** 构造一行 GHA 原始日志（口径：`<job>\t<step>\t<timestamp>Z <content>`，时间戳与正文间单空格）。 */
const line = (ts, body) => `job\tSTEP\t${ts}Z ${body}`

const FIXTURE = [
  line('2026-09-11T08:00:00.0000000', '##[group]stryker dsh-x-a'),
  line('2026-09-11T08:00:01.0000000', '\u001b[32mINFO Instrumenter\u001b[39m Instrumented 1 source file(s) with 100 mutant'),
  line('2026-09-11T08:00:02.0000000', '\u001b[32mINFO DryRunExecutor\u001b[39m Initial test run succeeded. Ran 7 tests in 3 seconds'),
  line('2026-09-11T08:00:03.0000000', '\u001b[32mINFO IncrementalDiffer\u001b[39m Incremental report:'),
  line('2026-09-11T08:00:04.0000000', '40 of 100 mutant result(s) are reused.'),
  line('2026-09-11T08:00:05.0000000', '\u001b[32mINFO MutationTestExecutor\u001b[39m Done in 13 seconds.'),
  line('2026-09-11T08:00:06.0000000', '##[endgroup]'),
  // 未闭合的段（被杀）：不得出现在结果里
  line('2026-09-11T08:00:07.0000000', '##[group]stryker dsh-x-b'),
  line('2026-09-11T08:00:08.0000000', '\u001b[32mINFO Instrumenter\u001b[39m Instrumented 1 source file(s) with 50 mutant'),
].join('\n')

test('解析器：单空格前缀 + ANSI 剥离 + 栈式配对 + 未闭合段宁缺勿造', () => {
  const segs = parseSegmentLedger(FIXTURE)
  assert.equal(segs.length, 1, '只应解析出已闭合的那一段')
  const a = segs[0]
  assert.equal(a.seg, 'dsh-x-a')
  assert.equal(a.mutants, 100)
  assert.equal(a.reused, 40)
  assert.equal(a.reuseTotal, 100)
  assert.equal(a.dryRunSeconds, 3)
  assert.equal(a.strykerReported, '13 seconds')
  assert.equal(a.wallSeconds, 6, 'wallSeconds = endgroup 与 group 的时间差')
  assert.ok(!segs.some((s) => s.seg === 'dsh-x-b'), '未闭合段不得出现（宁缺勿造，不得用 0 冒充）')
})

test('解析器：时间戳与正文间的空格必须剥离（否则 group 前缀判定永不成立）', () => {
  const parsed = parseLogLine(line('2026-09-11T08:00:00.0000000', '##[group]stryker dsh-x-a'))
  assert.equal(parsed.body, '##[group]stryker dsh-x-a')
})

test('段字段抽取：字段缺失一律为 null，不得用 0 冒充', () => {
  const body = parseSegmentBody(['nothing here'])
  assert.deepEqual(body, {
    mutants: null, dryTests: null, dryRunSeconds: null, reused: null, reuseTotal: null, strykerReported: null,
  })
})

test('wallSeconds 必须是正数（解析失败不得当作有效测量写入台账）', () => {
  assert.deepEqual(checkLedgerEntry({ seg: 'x', wallSeconds: 1.5, mutants: 10, reused: null, reuseTotal: null }), [])
  assert.ok(checkLedgerEntry({ seg: 'x', wallSeconds: 0, mutants: 10 }).some((p) => p.includes('wallSeconds')))
  assert.ok(checkLedgerEntry({ seg: 'x', wallSeconds: -1, mutants: 10 }).some((p) => p.includes('wallSeconds')))
  assert.ok(checkLedgerEntry({ seg: 'x', wallSeconds: 1, mutants: 10, reused: 5, reuseTotal: 3 })
    .some((p) => p.includes('reused')))
})

test('覆盖对账：漏段与游离段都必须暴露', () => {
  assert.deepEqual(reconcileLedgerSegments(['a', 'b'], ['a', 'b']).ok, true)
  const miss = reconcileLedgerSegments(['a'], ['a', 'b'])
  assert.deepEqual(miss.missing, ['b'])
  assert.equal(miss.ok, false)
  const extra = reconcileLedgerSegments(['a', 'b', 'c'], ['a', 'b'])
  assert.deepEqual(extra.extra, ['c'])
  assert.equal(extra.ok, false)
})

test('覆盖对账：段名派生自 conf 文件名（与 ci-matrix / mutation-gate 同源口径）', () => {
  assert.deepEqual(
    expectedSegsFromConfFiles(['dsh-notifier-config-rest.json', 'README.md', 'dsh-web-file-preview.json']),
    ['dsh-notifier-config-rest', 'dsh-web-file-preview'],
  )
})

test('入库台账：覆盖全部段不变量成立（测量值 ∪ unmeasured == 当前 conf 段集合）', () => {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
  const expected = expectedSegsFromConfFiles(readdirSync(join(ROOT, 'stryker.conf.d')))
  assert.ok(expected.length > 0, 'stryker.conf.d 非空')
  const problems = checkLedger(ledger, expected)
  assert.deepEqual(problems, [], `台账覆盖不变量被破坏：\n${problems.join('\n')}`)
  const { all } = ledgerCoverage(ledger)
  const expectedSet = new Set(expected)
  // 「覆盖全部段」的正面断言：当前每一段都必须被测量值或 unmeasured 解释
  for (const s of expectedSet) assert.ok(all.has(s), `段 ${s} 既无测量值也未登记 unmeasured`)
})

test('入库台账：每条测量记录的 wallSeconds 为正且字段完整（口径是日志墙钟，不是文件 mtime）', () => {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
  assert.ok(ledger.measurements.length > 0, '至少一条测量记录')
  for (const m of ledger.measurements) {
    assert.ok(['full', 'incremental'].includes(m.scope), `run ${m.run.id}: scope 必须标明口径`)
    assert.equal(typeof m.run.headSha, 'string', `run ${m.run.id}: 缺少 headSha（口径溯源）`)
    for (const s of m.segments) {
      assert.ok(s.wallSeconds > 0, `${s.seg}: wallSeconds 必须为正`)
      assert.match(s.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, `${s.seg}: 缺少日志时间戳`)
    }
  }
})

test('入库台账：历史段必须在 superseded 登记取代关系且指向现存段', () => {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
  const expected = new Set(expectedSegsFromConfFiles(readdirSync(join(ROOT, 'stryker.conf.d'))))
  const { measured } = ledgerCoverage(ledger)
  for (const s of measured) {
    if (expected.has(s)) continue
    const sup = ledger.superseded?.[s]
    assert.ok(sup, `历史段 ${s} 未在 superseded 登记`)
    for (const r of sup.replacedBy) assert.ok(expected.has(r), `superseded.${s}.replacedBy 指向不存在的段 ${r}`)
  }
})
