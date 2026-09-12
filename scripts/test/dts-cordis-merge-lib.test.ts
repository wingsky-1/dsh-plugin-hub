#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * dts-cordis-merge-lib 门禁自测（#733 M2，§9「门禁自测：违规判红、合规判绿」）。
 *
 * 为什么存在：本判据唯一的真实使用者是 pack:check 的 tarball 循环，那里只能观测到
 * 「合规态跑出 PASS」——无法证明判红有效（假绿风险）。故用 mkdtemp 隔离 fixture 根
 * 做正反双向断言，覆盖五种形态：
 *   - 合规：合并写在包入口 `.ts` → 随产物进 `lib/index.d.ts` → 闭包命中；
 *   - 合规（间接）：合并物理在被入口 re-export 的域文件（dsh-mcp-manager 形态）
 *     → 经闭包可达，不得误判为红；
 *   - 违规（源 `.d.ts` 形态）：合并写在 `src/service.d.ts`，tsc 不 emit 源 `.d.ts`
 *     → 闭包零命中（dsh-notifier 的原始缺陷形态）；
 *   - 违规（孤儿形态）：合并确实进了 `lib/`，但 `lib/index.d.ts` 不引用该文件
 *     → 闭包零命中。这条是「判据是闭包而非『lib 里存在即可』」的判别用例，
 *     缺了它，实现退化成「grep 一下 lib/ 有没有 declare module」也能全绿；
 *   - 违规（合并被整块删除）：适用性若只按「src 有没有写合并」判定，删掉合并即
 *     退化为「不适用」而假绿；产物侧的 `ctx.provide` 事实把这条路堵死。
 * 另加真实包正向断言（dsh-notifier 产物闭包命中、dsh-mcp-manager 间接可达），
 * 确保不断言一个永远为假的形态。
 *
 * fixture 全部落 mkdtempSync 隔离目录（产物零污染纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkCordisMergeReachability, closureDeclaresCordisMerge, collectDtsClosure, detectCordisServiceProvide, srcDeclaresCordisMerge } from '../lib/dts-cordis-merge-lib.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** 合并声明片段（与真实包同形）。 */
const MERGE = 'declare module "@deepseek-ai/cordis" {\n  interface Context { "wingsome.svc": unknown }\n}\n'

/**
 * 在隔离根内铺一个 fixture 包并跑断言。
 * @param {Record<string, string>} files 相对 `pkg/` 的文件表
 * @param {(pkgDir: string) => void} fn 断言体
 */
function withFixturePkg(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'dts-cordis-merge-'))
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, 'pkg', rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text, 'utf8')
    }
    fn(join(root, 'pkg'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('合规（入口 .ts 直写）：闭包命中，不判红', () => {
  withFixturePkg({
    'src/index.ts': `export const name = "x";\n${MERGE}`,
    'lib/index.d.ts': `export declare const name = "x";\n${MERGE}`,
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true, '源面声明了合并 → 判据必须适用')
    assert.equal(r.problem, null)
  })
})

test('合规（合并落在被 re-export 的域文件）：闭包可达，不得误判为红', () => {
  withFixturePkg({
    'src/index.ts': 'export { Svc } from "./sdk/interface.ts";\n',
    'src/sdk/interface.ts': 'export { Svc } from "./service.ts";\n',
    'src/sdk/service.ts': `export interface Svc { a: 1 }\n${MERGE}`,
    'lib/index.d.ts': 'export { Svc } from "./sdk/interface.js";\n',
    'lib/sdk/interface.d.ts': 'export { Svc } from "./service.js";\n',
    'lib/sdk/service.d.ts': `export interface Svc { a: 1 }\n${MERGE}`,
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true)
    assert.equal(r.problem, null)
  })
})

test('违规（源 .d.ts 形态）：src 有合并、闭包零命中 → 判红', () => {
  withFixturePkg({
    'src/index.ts': 'export const name = "x";\n',
    'src/service.d.ts': MERGE,
    'lib/index.d.ts': 'export declare const name = "x";\n',
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true)
    assert.match(r.problem, /声明合并不可达/u)
  })
})

test('违规（孤儿形态）：合并进了 lib/ 但入口不引用 → 仍判红（判据是闭包不是「存在」）', () => {
  withFixturePkg({
    'src/index.ts': `export const name = "x";\n${MERGE}`,
    'lib/index.d.ts': 'export declare const name = "x";\n',
    'lib/integration/service.d.ts': MERGE,
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true, 'src 声明了合并')
    assert.match(r.problem, /声明合并不可达/u)
    // 反证：lib/ 内确实「存在」合并文件——所以「存在即可」的实现会假绿，本判据不会。
    assert.equal(closureDeclaresCordisMerge(join(pkg, 'lib', 'index.d.ts')).hit, false)
  })
})

test('违规（合并被整块删掉，产物仍注册服务）：双信号并集 → 不因「不适用」假绿', () => {
  withFixturePkg({
    'src/index.ts': 'export function apply(ctx) { ctx.provide("demand.svc", {}); }\n',
    'lib/index.js': 'function apply(ctx) { return ctx.provide("demand.svc", {}); }\n',
    'lib/index.d.ts': 'export declare function apply(ctx: unknown): void;\n',
  }, (pkg) => {
    const provided = detectCordisServiceProvide(join(pkg, 'lib', 'index.js'))
    assert.deepEqual(provided, ['demand.svc'], '先断言产物侧信号非空')
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true, '删除合并后仍必须适用（否则判据退化为恒绿）')
    assert.match(r.problem, /声明合并不可达/u)
  })
})

test('不适用：src 未声明合并、产物未注册服务时一律不判红（即使 lib/ 里有合并）', () => {
  withFixturePkg({
    'src/index.ts': 'export const name = "x";\n',
    'lib/index.js': 'export const name = "x";\n',
    'lib/index.d.ts': MERGE,
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, false)
    assert.equal(r.problem, null)
    assert.deepEqual(srcDeclaresCordisMerge(join(pkg, 'src')), [])
    assert.deepEqual(detectCordisServiceProvide(join(pkg, 'lib', 'index.js')), [])
  })
})

test('违规：src 有合并但产物缺 lib/index.d.ts → 判红（fail-closed）', () => {
  withFixturePkg({
    'src/index.ts': MERGE,
    'lib/other.d.ts': 'export {};\n',
  }, (pkg) => {
    const r = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
    assert.equal(r.applicable, true)
    assert.match(r.problem, /缺 lib\/index\.d\.ts/u)
  })
})

test('闭包收集：不含不可达文件，且入口自身在集合内', () => {
  withFixturePkg({
    'lib/index.d.ts': 'export { A } from "./a/interface.js";\n',
    'lib/a/interface.d.ts': 'export { A } from "./a.js";\n',
    'lib/a/a.d.ts': 'export declare const A = 1;\n',
    'lib/orphan.d.ts': 'export declare const O = 1;\n',
  }, (pkg) => {
    const closure = collectDtsClosure(join(pkg, 'lib', 'index.d.ts'))
    assert.equal(closure.length > 0, true, '闭包集合必须先断言非空（every/some 空集恒真陷阱）')
    const rels = closure.map((f) => f.slice(pkg.length + 1)).sort()
    assert.deepEqual(rels, ['lib/a/a.d.ts', 'lib/a/interface.d.ts', 'lib/index.d.ts'])
    assert.equal(rels.includes('lib/orphan.d.ts'), false, '孤儿文件不在闭包内')
  })
})

test('真实包：dsh-notifier 产物闭包命中合并（合并已迁入 src/index.ts，#733 M2）', () => {
  const pkg = join(ROOT, 'packages', 'dsh-notifier')
  const srcHits = srcDeclaresCordisMerge(join(pkg, 'src'))
  assert.equal(srcHits.length > 0, true, 'dsh-notifier 源面必须声明 cordis 合并（先断言非空）')
  // 源面命中文件必须唯一落在包入口附近——孤立源 .d.ts 是本判据的缺陷形态。
  assert.deepEqual(srcHits.map((f) => f.slice(pkg.length + 1)), ['src/index.ts'])
  const merge = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
  assert.equal(merge.applicable, true)
  assert.equal(merge.problem, null)
  // 直接证据：产物 lib/index.d.ts 文本内含合并（不只看函数返回值）。
  assert.match(readFileSync(join(pkg, 'lib', 'index.d.ts'), 'utf8'), /declare module "@deepseek-ai\/cordis"/u)
})

test('真实包：dsh-mcp-manager 的间接形态可达（防「只认直接出现」的误红）', () => {
  const pkg = join(ROOT, 'packages', 'dsh-mcp-manager')
  const merge = checkCordisMergeReachability(pkg, join(pkg, 'lib'))
  assert.equal(merge.applicable, true, 'dsh-mcp-manager 源面声明了 cordis 合并')
  assert.equal(merge.problem, null)
  const direct = readFileSync(join(pkg, 'lib', 'index.d.ts'), 'utf8').includes('declare module "@deepseek-ai/cordis"')
  assert.equal(direct, false, '该包入口不直接写合并——正是「必须走闭包」的现实反例')
})
