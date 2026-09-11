#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-dir-imports S0（#690 A 轨）回归测试：叶子粒度 / deps.ts 判据 / 单调基线 /
 * 源码全覆盖断言。
 *
 * 为什么存在：S0 的三项能力全部建立在「真实包当前恰好干净」之上——真实包跑出 PASS
 * 无法证明判红有效（假绿风险）。故用隔离 fixture 根做正反双向断言：
 *   - 叶子粒度：同样三域「平铺」与「移入 src/server/」必须报出**相同**的模块数与
 *     值边数（旧实现下后者退化为 1 目录 / 0 值边但仍 PASS）；
 *   - deps.ts 判据：跨模块引用目标 deps.ts 放行、直引实现文件判红；
 *   - 死声明判据（#733 M0a）：值面判死、类型面豁免；deps.ts 自身含值 import 硬判红；
 *   - 单调基线：写入基线后人为把某计数调高必须 exit 1（#733 M0b 起分结构型 / 质量型）；
 *   - 全覆盖断言：新增未被 mutate/excludes 覆盖的 src 文件必须 exit 1。
 *
 * fixture 经 VERIFY_DIR_IMPORTS_ROOT 指向 mkdtemp 隔离目录（基线路径随根推导），
 * 不在仓库内造包目录（产物零污染纪律）。断言同时校验 exit code 与输出计数——
 * `node --test` 零匹配也会 exit 0，只看 exit code 会假绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'gate', 'verify-dir-imports.mjs')
const PKG = 'fixture-pkg'
const SRC = `packages/${PKG}/src`

/** 在隔离根下造任意相对路径文件，返回根路径（调用方负责清理）。 */
function makeFixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'verify-dir-imports-s0-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

/** 对 fixture 根跑脚本，返回 { status, out }。 */
function runOn(root, args = []) {
  const env = { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root }
  // 外部若设了基线路径，会与 fixture 自己的基线串味（残留风险），显式清掉。
  delete env.VERIFY_DIR_IMPORTS_BASELINE
  const r = spawnSync(process.execPath, [SCRIPT, '--package', PKG, ...args], { env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 三域链式依赖体（a → b → c），`prefix` 决定平铺还是移入分组层。 */
function chainFixture(prefix) {
  const p = prefix === '' ? '' : `${prefix}/`
  return {
    [`${SRC}/${p}a/interface.ts`]: `export { A } from "./impl.ts";\nexport { B } from "../b/interface.ts";\n`,
    [`${SRC}/${p}a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/${p}b/interface.ts`]: `export { B } from "./impl.ts";\nexport { C } from "../c/interface.ts";\n`,
    [`${SRC}/${p}b/impl.ts`]: 'export const B = 2;\n',
    [`${SRC}/${p}c/interface.ts`]: 'export { C } from "./impl.ts";\n',
    [`${SRC}/${p}c/impl.ts`]: 'export const C = 3;\n',
  }
}

test('叶子粒度：三域平铺与移入分组层 src/server/ 报出相同模块数与值边数', () => {
  const flat = makeFixtureRoot(chainFixture(''))
  const nested = makeFixtureRoot(chainFixture('server'))
  try {
    const a = runOn(flat)
    const b = runOn(nested)
    assert.equal(a.status, 0, `平铺形态应 PASS，实际 ${a.status}：\n${a.out}`)
    assert.equal(b.status, 0, `分组层形态应 PASS，实际 ${b.status}：\n${b.out}`)
    assert.match(a.out, /叶子模块 3 个、值边 2 条/, `平铺应报 3 模块 / 2 值边：\n${a.out}`)
    assert.match(b.out, /叶子模块 3 个、值边 2 条/, `分组层不得退化（旧实现退化为 1 目录 / 0 值边）：\n${b.out}`)
    // 退化证据：顶层域历史口径下分组层形态确实归零（这正是修复前的门禁盲区），
    // 而门禁口径不受影响——两条断言必须同时成立才说明粒度修正真的生效。
    assert.match(a.out, /历史对照（顶层域口径，已退出门禁）：值边 2 条/, `平铺顶层口径应为 2 条：\n${a.out}`)
    assert.match(b.out, /历史对照（顶层域口径，已退出门禁）：值边 0 条/, `分组层顶层口径应退化为 0：\n${b.out}`)
    // 模块 id 保留分组层路径（分组层透明，不吞掉层级）。
    const graphed = runOn(nested, ['--graph'])
    assert.match(graphed.out, /server\/a/, `分组层模块 id 应保留完整路径：\n${graphed.out}`)
    assert.doesNotMatch(graphed.out, /^  (a|b|c) /m, `不得把分组层当模块：\n${graphed.out}`)
  } finally {
    rmSync(flat, { recursive: true, force: true })
    rmSync(nested, { recursive: true, force: true })
  }
})

test('deps.ts 判据：跨模块引用他域 deps.ts 放行（D-2 出口面）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/a/deps.ts`]: 'export type { A } from "./interface.ts";\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/deps.ts";\nexport const B = A;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 0, `引用他域 deps.ts 应放行（exit 0），实际 ${status}：\n${out}`)
    assert.match(out, /叶子模块 2 个、值边 1 条/, `应报 2 模块 / 1 值边：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deps.ts 判据：跨模块直引他域实现文件仍判红（无基线 fail-closed）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/impl.ts";\nexport const B = A;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `直引他域实现文件应判红（exit 1），实际 ${status}：\n${out}`)
    assert.match(out, /跨模块引用必须走目标模块 interface\.ts\/deps\.ts/, `应点名规则：\n${out}`)
    assert.match(out, /b\/impl\.ts → import "\.\.\/a\/impl\.ts"/, `应给出违规点：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('规则 1：跨模块引用落在不含 interface.ts 的目录内判红', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { X } from "../group/x.ts";\nexport const B = X;\n',
    [`${SRC}/group/x.ts`]: 'export const X = 1;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `目标目录缺 interface.ts 应判红，实际 ${status}：\n${out}`)
    assert.match(out, /目标目录缺少 interface\.ts/, `应点名缺门面：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('单调基线：写入基线后 PASS，人为把跨域引用计数调高即 exit 1', () => {
  const files = chainFixture('')
  const root = makeFixtureRoot(files)
  try {
    const written = runOn(root, ['--write-baseline'])
    assert.equal(written.status, 0, `写基线应成功：\n${written.out}`)
    const before = runOn(root)
    assert.equal(before.status, 0, `基线写入后应 PASS，实际 ${before.status}：\n${before.out}`)
    assert.match(before.out, /单调基线通过/, `应报基线通过：\n${before.out}`)

    // 人为把计数调高：c 域新增一条跨模块引用（模块级值边与跨模块引用计数同时 +1）。
    const impl = join(root, `${SRC}/c/impl.ts`)
    writeFileSync(impl, 'import { A } from "../a/interface.ts";\nexport const C = A;\n')
    const after = runOn(root)
    assert.equal(after.status, 1, `计数上升应 exit 1，实际 ${after.status}：\n${after.out}`)
    assert.match(after.out, /单调基线上升/, `应点名单调基线上升：\n${after.out}`)
    assert.match(after.out, /leafValueEdges: 3 > 基线 2/, `应给出具体计数对照：\n${after.out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--graph 死声明（#733 M0a）：deps.ts 只 import type 时不得报死声明（类型面豁免）', () => {
  // 语义变化（相对 S0 原断言「deps.ts 声明而本模块无事实边 → 报出」）：原实现把
  // deps.ts 的**类型边**也计入意图图，故该形态报 1 条死声明。M0a 改「值面判死、
  // 类型面豁免」后恒为 0 条——修正目的即此：deps.ts 一旦落地（M1 的 F1 / #690 P1），
  // 跨域类型引用会集中进 deps.ts，实现文件上的事实边随之消失，旧口径会把真声明
  // 报成假死声明（已定位实例：sdk → stores 的唯一来源是 sdk/interface.ts 的
  // import type { HistoryStore }，迁入 deps.ts 后 actual 变空）。
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = 2;\n',
    [`${SRC}/b/deps.ts`]: 'import type { A } from "../a/interface.ts";\nexport type BDep = A;\n',
  })
  try {
    const { status, out } = runOn(root, ['--graph'])
    assert.equal(status, 0, `类型面声明豁免后应 PASS，实际 ${status}：\n${out}`)
    assert.match(out, /死声明（意图 - 事实，只计 deps\.ts 的值声明）：0 条/, `类型边不得报死声明：\n${out}`)
    assert.match(out, /deps\.ts 值依赖声明（声明面混入值 import，硬判红）：0 条/, `类型边不得报值依赖：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--graph 死声明（#733 M0a）：值面判死——deps.ts 值边无佐证 → 报出，有佐证 → 不报', () => {
  const base = {
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = 2;\n',
    [`${SRC}/b/deps.ts`]: 'import { A } from "../a/interface.ts";\nexport const AFromA = A;\n',
  }
  const dead = makeFixtureRoot(base)
  // 有事实边：佐证来自**非 deps.ts** 的本模块实现文件（deps.ts 自身不自证）。
  const alive = makeFixtureRoot({
    ...base,
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/interface.ts";\nexport const B = A;\n',
  })
  try {
    const d = runOn(dead, ['--graph'])
    assert.match(d.out, /死声明（意图 - 事实，只计 deps\.ts 的值声明）：1 条/, `值声明无事实支撑应报死声明：\n${d.out}`)
    assert.match(d.out, /b\/deps\.ts → a（值声明有而事实无）/, `应点名死声明来源与目标：\n${d.out}`)
    const a = runOn(alive, ['--graph'])
    assert.match(a.out, /死声明（意图 - 事实，只计 deps\.ts 的值声明）：0 条/, `有事实边时不得误报死声明：\n${a.out}`)
  } finally {
    rmSync(dead, { recursive: true, force: true })
    rmSync(alive, { recursive: true, force: true })
  }
})

test('deps.ts 值依赖判红（#733 M0a）：声明面混入值 import → exit 1 且提示清晰', () => {
  const crossModule = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = 2;\n',
    [`${SRC}/b/deps.ts`]: 'import { A } from "../a/interface.ts";\nexport type BDep = typeof A;\n',
  })
  // 同模块值 import 同样是「声明面混入值依赖」：deps.ts 只能声明形状，不得参与运行时。
  const sameModule = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/a/deps.ts`]: 'import { A } from "./impl.ts";\nexport type ADep = typeof A;\n',
  })
  try {
    const c = runOn(crossModule)
    assert.equal(c.status, 1, `跨模块值 import 应硬判红，实际 ${c.status}：\n${c.out}`)
    assert.match(c.out, /b\/deps\.ts 出现值 import "\.\.\/a\/interface\.ts"/, `应点名文件与 spec：\n${c.out}`)
    assert.match(c.out, /deps\.ts 只能声明类型依赖/, `应给出修法提示：\n${c.out}`)
    const s = runOn(sameModule)
    assert.equal(s.status, 1, `同模块值 import 同样应判红，实际 ${s.status}：\n${s.out}`)
    assert.match(s.out, /a\/deps\.ts 出现值 import "\.\/impl\.ts"/, `应点名同模块值 import：\n${s.out}`)
  } finally {
    rmSync(crossModule, { recursive: true, force: true })
    rmSync(sameModule, { recursive: true, force: true })
  }
})

test('--zones：R-A 双口径计数与明细（合法跨域引用：旧口径 2 条 / 新口径 0 条）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\nexport type { TA } from "./types.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/a/types.ts`]: 'export type TA = number;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]:
      'import { A } from "../a/interface.ts";\nimport type { TA } from "../a/interface.ts";\nexport const B: TA = A;\n',
  })
  try {
    const { status, out } = runOn(root, ['--zones'])
    assert.equal(status, 0, `引用他域 interface.ts 应 PASS，实际 ${status}：\n${out}`)
    assert.match(out, /R-A 语义切换前（impl → 他域任意文件，旧口径）：2 条（值 1 \/ type 1）/, `旧口径应 2 条：\n${out}`)
    assert.match(out, /R-A 语义切换后（impl → 他域实现文件，D-2 批准口径）：0 条/, `新口径应 0 条：\n${out}`)
    assert.match(out, /b\/impl\.ts → a\/interface\.ts \[type\]/, `应列出 type 明细：\n${out}`)
    assert.match(out, /b\/impl\.ts → a\/interface\.ts \[value\]/, `应列出 value 明细：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--zones：impl 直引他域实现文件在新口径下计数为 1', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/impl.ts";\nexport const B = A;\n',
  })
  try {
    const { status, out } = runOn(root, ['--zones'])
    assert.equal(status, 1, `直引实现文件应判红，实际 ${status}：\n${out}`)
    assert.match(out, /R-A 语义切换前（impl → 他域任意文件，旧口径）：1 条（值 1 \/ type 0）/, `旧口径应 1 条：\n${out}`)
    assert.match(out, /R-A 语义切换后（impl → 他域实现文件，D-2 批准口径）：1 条/, `新口径应 1 条：\n${out}`)
    assert.match(out, /b\/impl\.ts → a\/impl\.ts \[value\]/, `应列出违规明细：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--graph：依赖矩阵与扇入扇出报出叶子模块边', () => {
  const root = makeFixtureRoot(chainFixture(''))
  try {
    const { status, out } = runOn(root, ['--graph'])
    assert.equal(status, 0, `--graph 应 PASS，实际 ${status}：\n${out}`)
    assert.match(out, /依赖矩阵（行=from 模块，列=to 模块；V=值边 T=type 边 B=两者 \.=无）/, `应有矩阵表头：\n${out}`)
    // a → b → c 各 1 条值边：矩阵须真的落在对应单元格上，而非只打印空表。
    assert.match(out, /a\s+-\s+V\s+\./, `a 行应指向 b：\n${out}`)
    assert.match(out, /c\s+\.\s+\.\s+-/, `c 行应无出边：\n${out}`)
    assert.match(out, /b\s+扇出 1\/0\s+扇入 1\/0/, `b 扇出/扇入应为 1/1：\n${out}`)
    assert.match(out, /叶子模块级值环（门禁口径，按节点集合去重的环集合数，只许降不许升）：0 个/, `应报 0 环：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件级值环：同模块内文件互引成环 → 计入文件级值环并 fail-closed 判红', () => {
  // 同模块内部的文件环不影响叶子模块图，只有文件级图能看见（notifier 的 sdk 域
  // 就是这一形态，S3 待修）。缺了这条断言，fileCycles 整条判据坏掉也不会被发现。
  const root = makeFixtureRoot({
    [`${SRC}/sdk/interface.ts`]: 'export { A } from "./service.ts";\n',
    [`${SRC}/sdk/service.ts`]: 'import { A } from "./interface.ts";\nexport const A = 1;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `文件级值环应 fail-closed 判红，实际 ${status}：\n${out}`)
    assert.match(out, /模块级值环 0 个、文件级值环 1 个/, `模块级 0 / 文件级 1：\n${out}`)
    assert.match(out, /无基线 fail-closed：文件级值环 1 个/, `应点名文件级值环：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--soft：单调基线上升仍判红（CI 对 provider-usage 走 --soft）', () => {
  const root = makeFixtureRoot(chainFixture(''))
  try {
    assert.equal(runOn(root, ['--write-baseline']).status, 0)
    const clean = runOn(root, ['--soft'])
    assert.equal(clean.status, 0, `无上升时 --soft 应 PASS，实际 ${clean.status}：\n${clean.out}`)
    // 人为把计数调高：--soft 只影响明细打印标签，不得成为绕过基线判红的开关。
    writeFileSync(join(root, `${SRC}/c/impl.ts`), 'import { A } from "../a/interface.ts";\nexport const C = A;\n')
    const after = runOn(root, ['--soft'])
    assert.equal(after.status, 1, `--soft 下计数上升仍须判红，实际 ${after.status}：\n${after.out}`)
    assert.match(after.out, /单调基线上升：leafValueEdges: 3 > 基线 2/, `应给出计数对照：\n${after.out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('引用提取：类型查询 import("…") 不产生值边，await import() 动态导入才产生（F1）', () => {
  const typed = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export type { T } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export type T = { b?: import("../b/interface.ts").U };\n',
    [`${SRC}/b/interface.ts`]: 'export type { U } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export type U = { a?: import("../a/interface.ts").T };\n',
  })
  const dynamic = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = await import("../a/interface.ts");\n',
  })
  try {
    const t = runOn(typed)
    assert.equal(t.status, 0, `类型查询互引不应造出幻影值环，实际 ${t.status}：\n${t.out}`)
    assert.match(t.out, /值边 0 条、模块级值环 0 个/, `类型查询不应计入值边：\n${t.out}`)
    const d = runOn(dynamic)
    assert.equal(d.status, 0, `await import 应正常解析：\n${d.out}`)
    assert.match(d.out, /值边 1 条/, `await import() 是值依赖，应计 1 条值边：\n${d.out}`)
  } finally {
    rmSync(typed, { recursive: true, force: true })
    rmSync(dynamic, { recursive: true, force: true })
  }
})

test('引用提取：.d.ts 声明文件不作 from 侧（F2）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = 2;\n',
    [`${SRC}/b/service.d.ts`]: 'import { A } from "../a/interface.ts";\nexport declare const A2: typeof A;\n',
  })
  try {
    const { status, out } = runOn(root, ['--zones'])
    assert.equal(status, 0, `声明文件不应参与门禁：\n${out}`)
    assert.match(out, /R-A 语义切换前（impl → 他域任意文件，旧口径）：0 条/, `声明文件不得计入 R-A：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('引用提取：.js 后缀 specifier 映射到 .ts（F3：不得整条丢弃）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/impl.js";\nexport const B = A;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `用 .js 后缀直引他域实现文件同样应判红，实际 ${status}：\n${out}`)
    assert.match(out, /跨模块引用必须走目标模块 interface\.ts\/deps\.ts/, `应点名规则 2：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('引用提取：副作用导入 import "spec" 也被识别（F4）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import "../a/impl.ts";\nexport const B = 2;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `副作用直引他域实现文件应判红，实际 ${status}：\n${out}`)
    assert.match(out, /b\/impl\.ts → import "\.\.\/a\/impl\.ts"/, `应报出副作用导入：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('引用提取：注释里的 import 不被当真（F5）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    // 关键形态：块注释内**顶格**的 import（行首即 import）。注释若不被剥离，
    // 提取正则会把整行当真（` * import` 这类带星号的缩进反而不会命中）。
    [`${SRC}/b/impl.ts`]:
      '/*\nimport { A } from "../a/impl.ts";\n*/\n// import { A } from "../a/impl.ts";\nconst url = "https://example.com/x";\nexport const B = 2;\n',
  })
  try {
    const { status, out } = runOn(root, ['--zones'])
    assert.equal(status, 0, `注释中的 import 不应产生违规，实际 ${status}：\n${out}`)
    assert.match(out, /R-A 语义切换前（impl → 他域任意文件，旧口径）：0 条/, `注释不得计入 R-A：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('引用提取：内联 import { type X } 判为类型边（F6）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { type A } from "../a/interface.ts";\nexport const B: A = 1 as never;\n',
  })
  try {
    const { status, out } = runOn(root, ['--zones'])
    assert.equal(status, 0, `内联 type 修饰不应造出值边：\n${out}`)
    assert.match(
      out,
      /R-A 语义切换前（impl → 他域任意文件，旧口径）：1 条（值 0 \/ type 1）/,
      `内联 type 应计入 type 而非 value：\n${out}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('门面资格：非模块目录下的 deps.ts 不是出口（F7：规则 2 不得放水）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { X } from "../c/internal/deps.ts";\nexport const B = X;\n',
    [`${SRC}/c/interface.ts`]: 'export { X } from "./internal/deps.ts";\n',
    [`${SRC}/c/internal/deps.ts`]: 'export const X = 1;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `同名但非模块根部的 deps.ts 不得被当出口，实际 ${status}：\n${out}`)
    assert.match(out, /c\/internal\/deps\.ts/, `应点名该实现文件：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('规则 4：export { default as A } from 不假报虚导出（F8）', () => {
  const root = makeFixtureRoot({
    [`${SRC}/a/impl.ts`]: 'export default 1;\n',
    [`${SRC}/a/interface.ts`]: 'export { default as A } from "./impl.ts";\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'import { A } from "../a/interface.ts";\nexport const B = A;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 0, `default re-export 应可解析，实际 ${status}：\n${out}`)
    assert.doesNotMatch(out, /虚导出/, `不得误报虚导出：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('规则 4：同模块子目录引用 interface.ts 的虚导出仍判红（F12：判定按目录而非模块）', () => {
  // 引用方 a/sub/x.ts 与 a/interface.ts 属**同一叶子模块**，但目录不同。
  // 按模块比较会整块跳过该 interface.ts 的符号存在性检查（F12 的漏面），
  // 按目录比较才与「interface.ts 是这一层唯一的对外符号面」的语义一致。
  const root = makeFixtureRoot({
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/a/interface.ts`]: 'export { MISSING } from "./impl.ts";\n',
    [`${SRC}/a/sub/x.ts`]: 'import { MISSING } from "../interface.ts";\nexport const X = MISSING;\n',
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `同模块子目录的虚导出应判红，实际 ${status}：\n${out}`)
    assert.match(out, /虚导出/, `应点名虚导出：\n${out}`)
    assert.match(out, /a\/interface\.ts 导出符号 "MISSING"/, `应点名符号与文件：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模块定义：根级 src/interface.ts 不构成模块（F13：模块必是目录）', () => {
  // 根级 interface.ts 没有「对外引用面」语义（根文件互引在规则 3 下放行），
  // 故它既不入模块表，也不进规则 4 的符号存在性检查对象——显式固化该取值。
  const root = makeFixtureRoot({
    [`${SRC}/interface.ts`]: 'export const ROOT_FACADE = "src 根文件不是模块";\n',
    [`${SRC}/a/interface.ts`]: 'export { A } from "./impl.ts";\n',
    [`${SRC}/a/impl.ts`]: 'export const A = 1;\n',
    [`${SRC}/b/interface.ts`]: 'export { B } from "./impl.ts";\n',
    [`${SRC}/b/impl.ts`]: 'export const B = 2;\n',
  })
  try {
    const { status, out } = runOn(root, ['--graph'])
    assert.equal(status, 0, `根级 interface.ts 不得引入违规，实际 ${status}：\n${out}`)
    assert.match(out, /叶子模块 2 个、值边 0 条/, `模块表应只含 a/ 与 b/：\n${out}`)
    assert.doesNotMatch(out, /^  interface /m, `根级 interface.ts 不得成为模块行：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--write-baseline --package 不抹掉其他包条目（F9）', () => {
  const root = makeFixtureRoot({
    ...chainFixture(''),
    'scripts/data/dir-imports-baseline.json': JSON.stringify({
      version: 1,
      packages: { 'other-pkg': { modules: 7, marker: 'keep-me' } },
    }),
  })
  try {
    assert.equal(runOn(root, ['--write-baseline']).status, 0)
    const written = JSON.parse(readFileSync(join(root, 'scripts/data/dir-imports-baseline.json'), 'utf8'))
    assert.equal(written.packages['other-pkg']?.marker, 'keep-me', `其他包条目必须原样保留：${JSON.stringify(written)}`)
    assert.equal(written.packages[PKG]?.modules, 3, `本次包应被写入：${JSON.stringify(written)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 覆盖断言所需的最小拓扑：mutate 覆盖 src/<域>/**，不含 excludes。 */
function coverageTopology(domains) {
  return JSON.stringify(
    {
      sharedDefaults: {},
      packages: {
        [PKG]: {
          segments: {
            s1: {
              mutate: domains.map((d) => `packages/${PKG}/src/${d}/**/*.ts`),
              excludes: [`!packages/${PKG}/src/client/**`],
            },
          },
        },
      },
    },
    null,
    2,
  )
}

test('全覆盖断言：包未登记变异拓扑 → fail-closed 判红（封堵「删条目即绕过」）', () => {
  const root = makeFixtureRoot({
    ...chainFixture(''),
    'scripts/data/mutation-topology.json': JSON.stringify({
      sharedDefaults: {},
      packages: { 'other-pkg': { segments: {} } },
    }),
  })
  try {
    const { status, out } = runOn(root)
    assert.equal(status, 1, `包未登记拓扑应 fail-closed 判红，实际 ${status}：\n${out}`)
    assert.match(out, /未在 scripts\/data\/mutation-topology\.json 登记/, `应点名未登记：\n${out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('全覆盖断言：拓扑缺登记的新增 src 文件判红，登记后放行', () => {
  const files = {
    ...chainFixture(''),
    'scripts/data/mutation-topology.json': coverageTopology(['a', 'b', 'c']),
  }
  const root = makeFixtureRoot(files)
  try {
    const written = runOn(root, ['--write-baseline'])
    assert.equal(written.status, 0, `写基线应成功：\n${written.out}`)
    const before = runOn(root)
    assert.equal(before.status, 0, `未覆盖清单为空时应 PASS，实际 ${before.status}：\n${before.out}`)

    // 新增一个既不在 mutate 也不在 excludes 的源文件 → 必须红。
    const orphan = join(root, `${SRC}/newdir/orphan.ts`)
    mkdirSync(dirname(orphan), { recursive: true })
    writeFileSync(orphan, 'export const ORPHAN = 1;\n')
    const after = runOn(root)
    assert.equal(after.status, 1, `新增未覆盖源文件应 exit 1，实际 ${after.status}：\n${after.out}`)
    assert.match(after.out, /uncoveredSrcFiles: 新增未覆盖源文件/, `应点名覆盖断言：\n${after.out}`)
    assert.match(after.out, /src\/newdir\/orphan\.ts/, `应给出文件路径：\n${after.out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('全覆盖断言：非 .ts 孤儿（资源/声明类）同样判红，且红因不被其它计数混淆', () => {
  const root = makeFixtureRoot({
    ...chainFixture(''),
    'scripts/data/mutation-topology.json': coverageTopology(['a', 'b', 'c']),
  })
  try {
    assert.equal(runOn(root, ['--write-baseline']).status, 0)
    // .ps1 不是 TS：两个 TS 计数口径（#710 F14 拆分后的 scannedSrcFiles / allSrcTsFiles）
    // 都不变，故本次判红只可能来自覆盖断言（把红因隔离出来，否则新增 .ts 孤儿会同时抬高
    // 计数、断言被别的计数「代偿」成假绿）。
    writeFileSync(join(root, `${SRC}/a/toast.ps1`), 'Write-Host hi\n')
    const after = runOn(root)
    assert.equal(after.status, 1, `非 .ts 孤儿应判红，实际 ${after.status}：\n${after.out}`)
    assert.match(
      after.out,
      /uncoveredSrcFiles: 新增未覆盖源文件 packages\/fixture-pkg\/src\/a\/toast\.ps1/,
      `应点名未覆盖文件：\n${after.out}`,
    )
    assert.doesNotMatch(after.out, /scannedSrcFiles:/, `红因不得是 scannedSrcFiles：\n${after.out}`)
    assert.doesNotMatch(after.out, /allSrcTsFiles:/, `红因不得是 allSrcTsFiles：\n${after.out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('全覆盖断言：未覆盖清单之外的既有文件不会被误判（正反双向）', () => {
  const files = {
    ...chainFixture(''),
    'scripts/data/mutation-topology.json': coverageTopology(['a', 'b']),
  }
  const root = makeFixtureRoot(files)
  try {
    // c/ 未登记 → 首次写基线即把两个文件登记为存量。
    const written = runOn(root, ['--write-baseline'])
    assert.equal(written.status, 0, `写基线应成功：\n${written.out}`)
    const before = runOn(root)
    assert.equal(before.status, 0, `存量未覆盖文件不得判红，实际 ${before.status}：\n${before.out}`)
    assert.match(before.out, /单调基线通过/, `存量应被基线接受：\n${before.out}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
