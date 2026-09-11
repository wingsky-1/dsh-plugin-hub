#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * probe-handles 探针自测（#690 S2c / #713 T5 前半）。
 *
 * 锁住两条承重假设——S2c「先探针分诊、后切隔离」策略全靠它们：
 *   ① 四态可区分。若 leak 与 hang 混为一谈，分诊表会把「残留句柄」误报成「测试挂起」，
 *      治理方向就此跑偏（首版实现确实把 `setInterval` 泄漏判成了 hang）。
 *   ② 超时按进程组回收。若只杀直接子进程，worker 会成孤儿并继续持有端口——实测其占住
 *      `127.0.0.1:19998` 不放，探针自己就成了下一个 flake 源。
 *
 * 运行：pnpm test:scripts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeFile, triage } from '../gate/probe-handles.mjs'

const PROBE = fileURLToPath(new URL('../gate/probe-handles.mjs', import.meta.url))

/** 探针自测用收紧的超时：判据是「能否区分形态」，不是「跑得多快」。 */
const TIMEOUT_MS = 2500
const GRACE_MS = 300

const CLEAN = 'import { test } from "node:test"\ntest("ok", () => {})\n'
const LEAK = 'import { test } from "node:test"\ntest("ok", () => {})\nsetInterval(() => {}, 1000)\n'
/** 测试体内悬挂：测试没跑完，对照组同样挂住 —— 探针无法定性，报 stall。 */
const STALL = 'import { test } from "node:test"\ntest("never", async () => { await new Promise(() => {}) })\n'
/** 脚本式文件挂住：--test-force-exit 对它不生效，同样只能报 stall。 */
const STALL_SCRIPT = 'setInterval(() => {}, 1000)\n'
const FAIL = 'import assert from "node:assert/strict"\nassert.fail("boom")\n'

function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'probe-handles-'))
  const pkgDir = join(root, 'packages', 'fixture-pkg')
  mkdirSync(join(pkgDir, 'test'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', type: 'module' }), 'utf8')
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(pkgDir, 'test', name), content, 'utf8')
  }
  return { root, pkgDir }
}

test('四态可区分：clean / leak / stall / fail', async () => {
  const { root } = fixture({
    'a.test.ts': CLEAN,
    'b.test.ts': LEAK,
    'c.test.ts': STALL,
    'd.test.ts': STALL_SCRIPT,
    'e.test.ts': FAIL,
  })
  try {
    const results = await triage(root, { timeoutMs: TIMEOUT_MS, graceMs: GRACE_MS })
    const byFile = Object.fromEntries(results.map((r) => [r.file, r.status]))
    assert.deepEqual(byFile, {
      'test/a.test.ts': 'clean',
      'test/b.test.ts': 'leak',
      'test/c.test.ts': 'stall',
      'test/d.test.ts': 'stall',
      'test/e.test.ts': 'fail',
    }, `四态判定不符（c=测试体内悬挂、d=脚本式挂起，两者都无法定性故都是 stall）：${JSON.stringify(results.map((r) => [r.file, r.status]))}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('超时按进程组回收：worker 不得成为孤儿', async () => {
  const { root, pkgDir } = fixture()
  const pidFile = join(root, 'worker.pid')
  try {
    writeFileSync(join(pkgDir, 'test', 'leak.test.ts'),
      'import { createServer } from "node:http"\n'
      + 'import { writeFileSync } from "node:fs"\n'
      + 'import { test } from "node:test"\n'
      + 'test("leak", async () => {\n'
      + `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n`
      + '  const s = createServer()\n'
      + '  await new Promise((r) => s.listen(0, "127.0.0.1", r))\n'
      + '})\n', 'utf8')

    const r = await probeFile(pkgDir, 'test/leak.test.ts', TIMEOUT_MS, GRACE_MS)
    assert.equal(r.status, 'leak', `该 fixture 应判 leak：${JSON.stringify(r)}`)
    assert.ok(existsSync(pidFile), 'worker 应已写下自己的 pid')
    const workerPid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(workerPid) && workerPid > 0, `pid 非法：${workerPid}`)
    assert.throws(() => process.kill(workerPid, 0), /ESRCH/,
      `worker ${workerPid} 仍存活——超时未按进程组回收，探针会留下孤儿`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('对照组失效（脚本式文件不注册 node:test）时如实报 stall，不猜测', async () => {
  // 实测：脚本式文件注入 setInterval 后，--test-force-exit 对照组与 A 一样挂住（exit 137、无
  // TAP 汇总），探针无法区分「句柄残留」与「测试没跑完」。此处**不得**用静默启发式猜 leak——
  // mcp-manager 的 e2e/smoke 与 unit/unit-middleware 两个慢文件就因此被误报过。
  const { root, pkgDir } = fixture({ 'leak-script.test.ts': 'console.log("script-done")\nsetInterval(() => {}, 1000)\n' })
  try {
    const r = await probeFile(pkgDir, 'test/leak-script.test.ts', 3000, 200, 600)
    assert.equal(r.status, 'stall', `应如实报 stall：${JSON.stringify(r)}`)
    assert.equal(r.hasOutput, true, `该 fixture 有输出，故不该判 hang：${JSON.stringify(r)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('import 纯模块零副作用：不枚举仓库、不 spawn（CLI 守卫）', () => {
  // 与 test-surface.mjs 的 P0-1 同族：若 import 即跑 CLI，任何 import 它的测试都会真跑一遍
  // 全仓探测（数分钟 + 真实子进程），把测试面变成不可控的成本。
  const probe = spawnSync(process.execPath, [
    '-e',
    `import(${JSON.stringify(PROBE)}).then(() => process.stdout.write('IMPORT-OK'))`,
  ], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) })
  assert.equal(probe.status, 0, `import 应成功：${probe.stdout}${probe.stderr}`)
  assert.equal(probe.stdout.trim(), 'IMPORT-OK', `import 不得产生任何 CLI 输出，实际：${JSON.stringify(probe.stdout)}`)
})
