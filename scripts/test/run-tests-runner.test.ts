#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * run-tests runner 自测（#690 S2；#712 二轮对抗复核 P1）。
 *
 * 锁住 runner 的判红判据，含两处实测假绿向量（改动 runner 时这些用例必须先红再谈放宽）：
 *   - 零匹配：`node --test` 无文件时 exit 0 → 文件数下限判红；
 *   - 首位文件永不落定：node 静默输出 `1..0` 且 exit 0、其余文件全不求值 → 计划数少于
 *     glob 文件数判红（P1 回归）；
 *   - 文件内 `process.exitCode = 1`：TAP 仍报 pass，只有退出码能判红（承重判据，勿删）；
 *   - 断言抛错 → `not ok` 判红；
 *   - 残留句柄：进程不退出 → 超时判红（`RUN_TESTS_TIMEOUT_MS` 仅用于收紧等待）。
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

test('单文件通过：exit 0 且打印文件数与条目数', () => {
  const dir = fixture({ 'a.test.ts': '// 无断言也要产出条目\n' })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /1 个测试文件 \/ 1 个测试条目全部通过/)
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

test('断言抛错：not ok 判红', () => {
  const dir = fixture({
    'a.test.ts': 'import assert from "node:assert/strict";\nassert.fail("fixture-boom");\n',
  })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 1)
    assert.match(r.err, /1 个测试条目失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件内 process.exitCode=1：TAP 仍 pass，靠退出码判红（承重判据）', () => {
  const dir = fixture({ 'a.test.ts': 'process.exitCode = 1;\n' })
  try {
    const r = runRunner(dir, ['--min', '1'])
    assert.equal(r.code, 1)
    assert.match(r.out, /1\.\.1/, '该形态的 TAP 计划行仍是 1..1（失败只体现在退出码）')
    assert.match(r.err, /退出码 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1 回归：首位文件永不落定（node 静默 1..0）不得判绿', () => {
  const dir = fixture({
    'a-hang.test.ts': 'await new Promise(() => {});\n',
    'z-ok.test.ts': '// 该文件在假绿场景下根本不会被求值\n',
  })
  try {
    const r = runRunner(dir, ['--min', '2'], { RUN_TESTS_TIMEOUT_MS: '15000' })
    assert.equal(r.code, 1, `不得判绿（stdout: ${r.out}）`)
    assert.match(r.err, /计划数 0 少于 glob 文件数 2|未退出/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残留句柄：进程不退出由超时判红', () => {
  const dir = fixture({ 'a.test.ts': 'setInterval(() => {}, 1000);\n' })
  try {
    const r = runRunner(dir, ['--min', '1'], { RUN_TESTS_TIMEOUT_MS: '6000' })
    assert.equal(r.code, 1)
    assert.match(r.err, /未退出（疑似残留句柄）/)
    assert.ok(r.ms < 60000, `超时兜底应在数十秒内返回，实测 ${r.ms}ms`)
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
