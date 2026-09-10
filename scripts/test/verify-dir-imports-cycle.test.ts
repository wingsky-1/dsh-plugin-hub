#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-dir-imports 规则 5（域级值依赖环）回归测试。
 *
 * 为什么存在：规则 5 是 interface.ts 门面纪律「域依赖单向」的机器化兜底，
 * 而现实包当前全部无环——真实包跑 PASS 无法证明判红有效（假绿风险）。本测试
 * 用隔离 fixture 根注入 fixture 包，正反两向断言：跨目录**值**边成环判红并
 * 报出环路径；仅 **type-only** 边成环放行（编译期擦除，sdk ⇄ pipeline 的
 * type 边是刻意保留的）。
 *
 * fixture 经 VERIFY_DIR_IMPORTS_ROOT 指向 mkdtemp 隔离目录，不在仓库内造包
 * 目录（产物零污染纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'gate', 'verify-dir-imports.mjs')

/** 在隔离根下造 `packages/fixture-pkg/src/<files>`，返回根路径（调用方负责清理）。 */
function makeFixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'verify-dir-imports-'))
  const src = join(root, 'packages', 'fixture-pkg', 'src')
  for (const [rel, content] of Object.entries(files)) {
    const full = join(src, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

/** 对 fixture 根跑脚本，返回 { status, out }。 */
function runOn(root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--package', 'fixture-pkg'], {
    env: { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('规则 5：跨目录值 import 成环 → 判红并报出环路径', () => {
  const root = makeFixtureRoot({
    'a/impl.ts': 'export const A = 1;\n',
    'a/interface.ts': 'export { A } from "./impl.ts";\nexport { B } from "../b/interface.ts";\n',
    'b/impl.ts': 'export const B = 2;\n',
    'b/interface.ts': 'export { B } from "./impl.ts";\nexport { A } from "../a/interface.ts";\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `值环应判红（exit=1），实际 ${status}：\n${out}`)
    assert.match(out, /域级值依赖环/, '输出应点名「域级值依赖环」')
    assert.match(out, /a → b → a|b → a → b/, `输出应含环路径：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('规则 5：仅 type-only 边成环 → 放行（编译期擦除，不入值图）', () => {
  const root = makeFixtureRoot({
    'a/types.ts': 'export interface A { v: number }\n',
    'a/interface.ts':
      'import type { B } from "../b/interface.ts";\nexport type { A } from "./types.ts";\nexport type Linked = { b?: B };\n',
    'b/types.ts': 'export interface B { v: number }\n',
    'b/interface.ts':
      'import type { A } from "../a/interface.ts";\nexport type { B } from "./types.ts";\nexport type Linked = { a?: A };\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 0, `type-only 环应放行（exit=0），实际 ${status}：\n${out}`)
    assert.match(out, /环 0 个/, `summary 应报告 0 环：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
