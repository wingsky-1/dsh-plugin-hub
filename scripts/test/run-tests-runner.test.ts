#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * run-tests runner 自测（#690 S2 / S2c）。
 *
 * 锁住 runner 的判红判据与顺序控制。逐文件 spawn 之后有三处语义变化（均经实测确认，见
 * #690 S2c 的 PR 正文）：
 *   1. `1..N` 不再表示「测试条目数」而是「文件数」（每个文件是一个顶层条目），
 *      故「条目数」相关判据退役，承重判据变成「每个文件都通过」；
 *   2. 文件内 `process.exitCode = 1` 由 node 映射为该文件的 `not ok`，
 *      走「未通过文件」分支而不是「runner 退出码」分支；
 *   3. 首位文件悬挂**不再**让其余文件静默跳过（每文件独立进程），故 #712 P1 的判据
 *      从「计划数不足」改为「悬挂文件判红**且其余文件确实被执行**」——后者才是它真正要防的。
 *
 * 运行：pnpm test:scripts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../gate/run-tests.mjs', import.meta.url))

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-fixture-'))
  mkdirSync(join(dir, 'test'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'test', name), content, 'utf8')
  }
  return dir
}

function runRunner(dir, args, env = {}) {
  const started = Date.now()
  // 本文件自身跑在 `node --test` 内，子进程若继承 NODE_TEST_CONTEXT 会把测试事件
  // 走 IPC 上报给外层 runner（stdout 不再是 TAP），故必须剔除后再 spawn。
  const childEnv = { ...process.env, ...env }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.NODE_TEST_WORKER_ID
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv,
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', ms: Date.now() - started }
}

test('单文件通过：exit 0 且打印文件数与执行顺序', () => {
  const dir = fixture({ 'a.test.ts': '// 无断言也要产出条目\n' })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /1 个测试文件全部通过（文件数下限 1，执行顺序 lex）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('零匹配：glob 无文件时判红（node --test 本身 exit 0）', () => {
  const dir = fixture({})
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 1)
    assert.match(r.err, /只匹配到 0 个文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件数低于下限：判红', () => {
  const dir = fixture({ 'a.test.ts': '\n' })
  try {
    const r = runRunner(dir, ['--min', '2'])
    assert.equal(r.code, 1)
    assert.match(r.err, /低于下限 2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('断言抛错：判红并按文件名点名', () => {
  const dir = fixture({
    'a.test.ts': 'import assert from "node:assert/strict";\nassert.fail("fixture-boom");\n',
  })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 1)
    assert.match(r.err, /1\/1 个文件未通过/)
    assert.match(r.err, /test\/a\.test\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件内 process.exitCode=1：node 映射为该文件 not ok → 判红并点名（承重判据）', () => {
  // per-file 语义变化点：该形态在 `--test-isolation=none` 下 TAP 仍报 pass、只有 runner 退出码
  // 能判红；逐文件 spawn 后 node 把它映射为文件的 `not ok`，故走「未通过文件」分支。
  const dir = fixture({ 'a.test.ts': 'process.exitCode = 1;\n' })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 1)
    assert.match(r.err, /1\/1 个文件未通过/)
    assert.match(r.err, /test\/a\.test\.ts/)
    assert.match(r.out, /^not ok /m, '该形态应产出 not ok 条目')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1 新语义：悬挂文件判红，且其余文件确实被执行（不得静默跳过）', () => {
  // #712 P1 真正要防的是「其余文件被静默跳过」。per-file 隔离下 node 自己把顶层 unsettled
  // await 判为 `not ok`，`1..0` 那个假绿向量不复存在，故判据改为断言「都跑了」。
  const dir = fixture({
    'a-hang.test.ts': 'await new Promise(() => {});\n',
    'z-ok.test.ts': 'console.log("Z-EXECUTED");\n',
  })
  try {
    const r = runRunner(dir, ['--min', '2'], { RUN_TESTS_TIMEOUT_MS: '15000' })
    assert.equal(r.code, 1, `不得判绿（stdout: ${r.out}）`)
    assert.match(r.err, /1\/2 个文件未通过/)
    assert.match(r.err, /a-hang\.test\.ts/)
    assert.match(r.out, /Z-EXECUTED/, '悬挂文件不得让后续文件被跳过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残留句柄：单文件超时判红并点名，且 worker 不得成为孤儿', () => {
  const dir = fixture({ 'a.test.ts': 'setInterval(() => {}, 1000);\n' })
  try {
    const r = runRunner(dir, ['--min', '1'], { RUN_TESTS_TIMEOUT_MS: '6000' })
    assert.equal(r.code, 1)
    assert.match(r.err, /1\/1 个文件未通过/)
    assert.match(r.err, /未退出（疑似残留句柄），已按进程组终止/)
    assert.ok(r.ms < 60000, `超时兜底应在数十秒内返回，实测 ${r.ms}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('顺序控制：lex / reverse / shuffle 结果一致，且执行顺序真的不同', () => {
  const dir = fixture({
    'a.test.ts': 'console.log("SEQ-A");\n',
    'b.test.ts': 'console.log("SEQ-B");\n',
    'c.test.ts': 'console.log("SEQ-C");\n',
  })
  try {
    const seqOf = (out) => (out.match(/SEQ-[ABC]/g) ?? []).join(',')
    const lex = runRunner(dir, ['--min', '3', '--order', 'lex'])
    const rev = runRunner(dir, ['--min', '3', '--order', 'reverse'])
    assert.equal(lex.code, 0, lex.err)
    assert.equal(rev.code, 0, rev.err)
    assert.equal(seqOf(lex.out), 'SEQ-A,SEQ-B,SEQ-C')
    assert.equal(seqOf(rev.out), 'SEQ-C,SEQ-B,SEQ-A')

    // 洗牌用多个种子：单一种子恰好退化成字典序是可能的，不能据此断言失效。
    const shuffled = ['7', '42', '99'].map((s) => {
      const r = runRunner(dir, ['--min', '3', '--order', `shuffle:${s}`])
      assert.equal(r.code, 0, `shuffle:${s} 应通过：${r.err}`)
      return seqOf(r.out)
    })
    assert.ok(shuffled.some((o) => o !== seqOf(lex.out)),
      `至少一个种子的顺序应不同于 lex，实际 ${shuffled.join(' | ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--min 缺参 / 非法：exit 2（用法错误与门禁违约区分）', () => {
  const dir = fixture({ 'a.test.ts': '\n' })
  try {
    assert.equal(runRunner(dir, []).code, 2)
    assert.equal(runRunner(dir, ['--min', 'abc']).code, 2)
    assert.equal(runRunner(dir, ['--min', '0']).code, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--order 非法值：exit 2', () => {
  const dir = fixture({ 'a.test.ts': '\n' })
  try {
    const r = runRunner(dir, ['--min', '1', '--order', 'bogus'])
    assert.equal(r.code, 2)
    assert.match(r.err, /未知 --order/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
