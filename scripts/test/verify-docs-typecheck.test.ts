#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-docs typecheck 面接线器（issue #474）。
 *
 * 为什么存在：scripts/gate/verify-docs.ts 已去 @ts-nocheck 并纳入
 * scripts/tsconfig.json（noEmit strict）编译面，但 pnpm typecheck 是
 * `pnpm -r --if-present run typecheck`（只进各包，不进根 scripts/），
 * pnpm build/test 也编译不到它——若只靠直跑（Node type-stripping 擦除
 * 类型断言），strict 类型面是「假锁」。本接线器 spawn 仓库 tsc 真实编译
 * scripts/tsconfig.json，tsc 非 0 → 本测试红，随 `pnpm test:scripts`
 * 执行，对「verify-docs.ts ↔ tsconfig 面」漂移零成本判红（反证 D：
 * include 摘除该文件时接线器失联检测——tsc 面空转但 include 摘除会让
 * 断言失败，见 scripts/tsconfig.json include 注释）。
 *
 * 为何自身仍带 @ts-nocheck（#474 R4 预防性声明）：本文件类型面为零——
 * 只 spawn tsc 子进程，不 import 被测物（verify-docs.ts）的任何类型，
 * 纳入 strict 面无检查增量；scripts/test/ 13 个测试统一此形态。scripts
 * 全量测试文件入 typecheck 面属后续独立收紧 issue，不在本 issue 范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
// tsc 真实 JS 入口：严禁 spawn node_modules/.bin/tsc（shell shim，经 node
// 执行报 ERR_UNKNOWN_FILE_EXTENSION；#476 接线器同款先例注释）。
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const TSCONFIG = join(ROOT, 'scripts', 'tsconfig.json')

test('verify-docs 编译面接线：scripts/tsconfig.json 被 tsc 真实编译（#474）', () => {
  assert.ok(existsSync(TSC), `仓库 tsc 应存在（${TSC}）——pnpm install 后才有`)
  assert.ok(existsSync(TSCONFIG), `scripts/tsconfig.json 应存在（${TSCONFIG}）`)
  // 失联检测（复核闸 T3 变体修复）：tsc 对「include 里没有目标文件」静默绿
  // （空 include 才会配置级红）——include 换成别的文件时编译仍成功，接线器
  // 失去对 verify-docs.ts 的覆盖而测试依旧绿。故编译前显式断言 include 面
  // 确实含 verify-docs.ts，缺位即红（确定性，不依赖 tsc 配置错误行为）。
  const tsconfig = readFileSync(TSCONFIG, 'utf8')
  assert.match(
    tsconfig,
    /"include"\s*:\s*\[[^\]]*"gate\/verify-docs\.ts"/,
    'scripts/tsconfig.json 的 include 面必须显式含 gate/verify-docs.ts——摘除即接线器失联（typecheck 面假锁）',
  )
  const result = spawnSync(process.execPath, [TSC, '-p', TSCONFIG, '--noEmit'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  })
  assert.strictEqual(
    result.status,
    0,
    `tsc 编译 scripts/tsconfig.json 失败（exit=${result.status}）——verify-docs.ts 类型面漂移？\n${result.stdout}\n${result.stderr}`,
  )
})
