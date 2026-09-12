#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * pack-check 聚合段切片口径的回归（#722 门禁分层 / PR #747 实证）。
 *
 * 为什么存在：`pack-check.ts` 的聚合包专项是**产物级**断言（要 `dsh-plugins-all/lib/index.js`），
 * 而聚合包由 `pnpm build` 产出、不由本脚本产出。它此前不受 `--packages` 切片控制，于是
 * 「HIT_PACKAGES 不含聚合包」的 PR（改单个插件包、纯文档 PR 等）会在 CI 上假红——
 * 而这正是本仓大多数 PR 的形态，属比「漏检」更难发现的**假红**失败模式。
 *
 * 本测试锁死两条语义，缺一不可：
 *   1. 增量切片（--packages 命中的是真子集）⇒ 聚合段**不执行**，且不得报 FAIL；
 *   2. 全仓口径（未传 --packages）⇒ 聚合段**必须执行**（缺产物时 fail-loud，不得静默跳过）。
 * 第 2 条防的是「修第 1 条时把全仓覆盖一并删掉」——那会把切片代价从假红变成真漏检。
 *
 * 产物前提：`test:scripts` 只保证 `script-test-prereqs.mjs` 登记的包被构建，**不含聚合包**。
 * 故全仓口径的用例对「产物在 / 不在」两种情形分别断言，不假定聚合包已被构建
 * （与 pack-check 自身的 fail-loud 语义一致）。
 *
 * 成本：全仓口径会真实 `pnpm pack` 各包（约 12-15s），故该口径只在模块内跑一次、共享结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACK_CHECK = join(ROOT, 'scripts', 'gate', 'pack-check.ts')

/** 跑 pack-check 并返回 { status, stdout }（非 0 也要拿到输出，不抛）。 */
function runPackCheck(args) {
  try {
    const stdout = execFileSync(process.execPath, [PACK_CHECK, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ''}` }
  }
}

test('增量切片：聚合段不执行，且不报 FAIL（修的是假红，不是放宽判据）', () => {
  // 切片取真子集（不含 dsh-plugins-all）：这正是 CI 上改单个插件包时的形态。
  const { status, stdout } = runPackCheck(['--packages', 'dsh-verify-isolated'])
  assert.equal(status, 0, `增量切片应 exit 0，实际 ${status}\n${stdout}`)
  assert.match(stdout, /聚合包专项跳过/, '应明示聚合段被切片跳过——口径可见，避免被误读为「已检查」')
  assert.doesNotMatch(stdout, /FAIL dsh-plugins-all/, '切片下不得对聚合包报 FAIL')
})

test('增量切片（切片内含聚合包）：聚合段仍执行，不因门控被误跳过', () => {
  const { stdout } = runPackCheck(['--packages', 'dsh-plugins-all'])
  assert.doesNotMatch(stdout, /聚合包专项跳过/, '聚合包在切片内时不得跳过')
  assert.match(stdout, /(PASS|FAIL) @wingsky-1\/dsh-plugins-all/, '聚合包在切片内时必须进入聚合段')
})

test('全仓口径：聚合段必须执行，且产物缺失时 fail-loud 可诊断', () => {
  // 全仓口径只跑一次（真实 pack 各包，约 12-15s）：三条断言共享同一份输出。
  const { stdout } = runPackCheck([])
  assert.doesNotMatch(stdout, /聚合包专项跳过/, '全仓口径不得跳过聚合段——这是夜间/发版覆盖的唯一入口')
  assert.match(stdout, /(PASS|FAIL) @wingsky-1\/dsh-plugins-all/, '全仓口径必须进入聚合段')
  if (/PASS @wingsky-1\/dsh-plugins-all/.test(stdout)) return
  // 产物缺失分支（test:scripts 不保证聚合包已构建）：须给出可诊断原因而非 pnpm 裸错误
  assert.match(stdout, /缺 packages\/dsh-plugins-all\/lib\/index\.js/, '缺产物须给出可诊断原因，而非 pnpm 裸错误')
  assert.match(stdout, /本段是产物级断言/, '须显式声明本段的产物前提')
})
