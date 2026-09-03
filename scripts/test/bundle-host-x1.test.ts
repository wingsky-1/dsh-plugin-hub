#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * bundle-host d.ts X1 机制回归（node:test，issue #478）。
 *
 * X1 = bundle-host 构建宿主产物时对 tsc 声明产物做的两件事（运行时无关）：
 *   2a 路径改写（rewriteDtsPaths）：lib/**\/*.d.ts 中指向仓库外 shared/ 的相对引用
 *      （tsc 原样写入的 `../../shared/` 等）改写为指向包内副本——前缀按当前文件在
 *      lib/ 下的目录深度归一为 '../'.repeat(depth + 1)（整体吞掉任意 ../ 前缀后按
 *      文件深度重算），另把相对 .ts 后缀 import 回写 .js（#276）；
 *   2b 声明副本进包：仓库根 shared/ 全部 .d.ts（递归，含子目录 client/ 等）
 *      复制进包内 shared/（保留相对目录结构），谓词/遍历 = scripts/lib/walk-files.ts。
 *
 * 覆盖（spec v2）：
 *   - 归一化极端：同文件内引用深度 ≠ 文件深度（任意 ../ 深度混写 + import() 动态
 *     形态）→ 全部按文件目录深度归一为固定 prefix；
 *   - 目录级集成：真实 mkdtemp 目录树跑完整递归遍历（锁 depth+1 传参），
 *     d=0 → ../shared/、d=1 → ../../shared/、d=2 → ../../../shared/、d=3 → 4 个 ../；
 *   - 边界：非 shared 相对引用零误伤；无 shared 引用的文件内容原样；.ts 回写 .js；
 *   - 2b 深层子目录复制：shared/<d>/<d>/x.d.ts 连同目录结构原样复制进包
 *     （walkFiles 同源谓词，目录级验证复制落点）。
 * 运行：node --test scripts/test/bundle-host-x1.test.ts（或 pnpm test:scripts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rewriteDtsPaths, rewriteDtsText } from '../lib/rewrite-dts-paths.ts'
import { listSharedDts } from '../lib/shared-dts-lib.ts'
import { walkFiles } from '../lib/walk-files.ts'

const ROOT = join(import.meta.dirname, '..', '..')

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'x1-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 递归读目录下全部文件内容（相对路径 → 文本）
function readTree(dir) {
  const out = {}
  const visit = (cur) => {
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, f.name)
      if (f.isDirectory()) visit(abs)
      else if (f.isFile()) out[abs] = readFileSync(abs, 'utf8')
    }
  }
  visit(dir)
  return out
}

// 复制真实仓库 shared/（含子目录）到目标，返回目标 shared 目录
function copyRealShared(destRoot) {
  const src = join(ROOT, 'shared')
  const dest = join(destRoot, 'shared')
  cpSync(src, dest, { recursive: true })
  return dest
}

// ---------- 纯函数层：字符串归一语义 ----------

test('#3a 归一化极端：同文件内引用深度 ≠ 文件深度 → 全部按文件目录深度归一为固定 prefix', () => {
  // 同文件（深度 0）内混写任意 ../ 深度的 shared 引用（极端输入）→ 全部归一为 ../shared/
  const text = [
    "import { a } from '../../shared/x.js';",
    "import { b } from '../../../../shared/y.js';",
    "import type { C } from '../../../shared/z.js';",
    "const m = import('../../shared/dyn.js');",
    "export { x } from '../shared/x.js';", // 浅引用（本不可能由 tsc 产出，防御输入）
  ].join('\n')
  const out = rewriteDtsText(text, 0)
  assert.match(out, /from '\.\.\/shared\/x\.js'/, 'd=0 深度 2 引用 → ../shared/x.js')
  assert.match(out, /from '\.\.\/shared\/y\.js'/, 'd=0 深度 4 引用 → ../shared/y.js')
  assert.match(out, /from '\.\.\/shared\/z\.js'/, 'd=0 深度 3 引用 → ../shared/z.js')
  assert.match(out, /import\('\.\.\/shared\/dyn\.js'\)/, 'd=0 动态 import 深度 2 → ../shared/dyn.js')
  assert.match(out, /from '\.\.\/shared\/x\.js'/, '浅引用同样按文件深度归一')
  assert.ok(!/\.\.\/\.\.\/shared/.test(out), '归一后不得残留多级 ../ 前缀')
  assert.equal(out.split('\n').length, text.split('\n').length, '行数不变（只改前缀）')
})

test('#3b 归一化极端反向：深层文件内的浅引用 → 按文件深度（而非引用深度）归一', () => {
  // d=2 文件内写浅引用 ../shared/x.js（防御输入）→ 仍归一为 ../../../shared/x.js
  const out = rewriteDtsText("import { x } from '../shared/x.js';\n", 2)
  assert.match(out, /from '\.\.\/\.\.\/\.\.\/shared\/x\.js'/, 'd=2 → 3 个 ../（按文件深度而非引用深度）')
})

test('#3c 归一化对非 shared 相对引用零误伤（含任意深度 ../ 前缀）', () => {
  const text = [
    "import { a } from './z.js';",
    "import { b } from '../types.js';",
    "import { c } from '../../deep/local.js';",
    "import { d } from '../shared-not-this.js';", // shared 开头但不是 shared/ 目录
  ].join('\n')
  const out = rewriteDtsText(text, 1)
  assert.match(out, /from '\.\/z\.js'/, './z.js 原样')
  assert.match(out, /from '\.\.\/types\.js'/, '../types.js 原样')
  assert.match(out, /from '\.\.\/\.\.\/deep\/local\.js'/, '../../deep/local.js 原样')
  assert.match(out, /from '\.\.\/shared-not-this\.js'/, '非 shared/ 目录的 shared* 引用原样')
})

test('#5a 无 shared 引用的文件内容原样不变；.ts 后缀回写 .js（#276）', () => {
  const noRef = "export declare const a: number;\n"
  assert.equal(rewriteDtsText(noRef, 2), noRef, '无 shared 引用无匹配 → 原样')
  // .ts 后缀回写（声明文件里 TS 不回写的 #276 修正）
  const tsSuffix = "import { helper } from './helper.ts';\nimport('./mod.ts');\n"
  const out = rewriteDtsText(tsSuffix, 0)
  assert.match(out, /from '\.\/helper\.js'/, "相对 .ts 后缀 from → .js")
  assert.match(out, /import\('\.\/mod\.js'\)/, "动态 import .ts 后缀 → .js")
  assert.ok(!out.includes('.ts\''), '不得残留相对 .ts 后缀引用')
})

// ---------- 目录级集成：完整递归遍历（锁 depth+1 传参） ----------

function makeLibTree(root) {
  // 构造 lib/ 目录树（root 即 lib 目录）：顶层 + client/（d=1）+ a/b/（d=2）+ a/b/c/（d=3）
  mkdirSync(join(root, 'client'), { recursive: true })
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
  writeFileSync(join(root, 'index.d.ts'), "export { a } from '../../shared/x.js';\n")
  writeFileSync(join(root, 'client', 'x.d.ts'), "export { b } from '../../shared/y.js';\n")
  writeFileSync(join(root, 'a', 'b', 'c.d.ts'), "export { c } from '../../../shared/z.js';\n")
  writeFileSync(join(root, 'a', 'b', 'c', 'deep.d.ts'), "export { d } from '../../../../shared/w.js';\n")
  // 混入非 .d.ts 与无关引用（不得触碰）
  writeFileSync(join(root, 'notes.txt'), "import { x } from '../../shared/ignored.js';\n")
  writeFileSync(join(root, 'client', 'x.js'), "export {};\n")
}

test('#4 目录级集成：mkdtemp 目录树递归遍历按深度改写（d=0/1/2/3 全覆盖）', () => {
  const { dir, cleanup } = tempDir()
  try {
    const lib = join(dir, 'lib')
    makeLibTree(lib)
    rewriteDtsPaths(lib, 0)
    const out = readTree(lib)
    assert.match(out[join(lib, 'index.d.ts')], /from '\.\.\/shared\/x\.js'/, 'd=0 → ../shared/（1 个 ../）')
    assert.match(out[join(lib, 'client', 'x.d.ts')], /from '\.\.\/\.\.\/shared\/y\.js'/, 'd=1 → ../../shared/（2 个 ../）')
    assert.match(out[join(lib, 'a', 'b', 'c.d.ts')], /from '\.\.\/\.\.\/\.\.\/shared\/z\.js'/, 'd=2 → ../../../shared/（3 个 ../）')
    assert.match(out[join(lib, 'a', 'b', 'c', 'deep.d.ts')], /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/w\.js'/, 'd=3 → 4 个 ../')
    // 非 .d.ts / 非目标文件不得改写
    assert.match(out[join(lib, 'notes.txt')], /from '\.\.\/\.\.\/shared\/ignored\.js'/, '非 .d.ts 文件不改写')
    assert.match(out[join(lib, 'client', 'x.js')], /export \{\};/, '.js 文件不改写')
  } finally {
    cleanup()
  }
})

// ---------- 2b：shared 深层子目录复制 ----------

test('#6 2b 复制含深层子目录：shared/<d>/<d>/x.d.ts 连同目录结构原样复制进包', () => {
  const { dir, cleanup } = tempDir()
  try {
    // 构造仓库 shared/（模拟含 >1 级子目录的 shared 树）
    mkdirSync(join(dir, 'shared', 'deep', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'shared', 'loopback.d.ts'), '')
    writeFileSync(join(dir, 'shared', 'deep', 'deeper', 'x.d.ts'), '')
    // 非 .d.ts 不得复制
    writeFileSync(join(dir, 'shared', 'deep', 'sample.js'), '')
    // 复制落点 = 包内 shared/，保留相对目录结构（walkFiles 同源谓词）
    const pkgDir = join(dir, 'pkg')
    mkdirSync(pkgDir)
    for (const rel of walkFiles(join(dir, 'shared'), (f) => f.endsWith('.d.ts'))) {
      const dest = join(pkgDir, 'shared', rel)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(join(dir, 'shared', rel), dest)
    }
    assert.ok(existsSync(join(pkgDir, 'shared', 'loopback.d.ts')), '顶层 .d.ts 复制')
    assert.ok(existsSync(join(pkgDir, 'shared', 'deep', 'deeper', 'x.d.ts')), '2 级子目录 .d.ts 连同目录结构复制')
    assert.ok(!existsSync(join(pkgDir, 'shared', 'deep', 'sample.js')), '非 .d.ts 不复制')
    // 与 listSharedDts 同源枚举一致（复制清单 == 期望清单）
    assert.deepEqual(walkFiles(join(dir, 'shared'), (f) => f.endsWith('.d.ts')),
      ['deep/deeper/x.d.ts', 'loopback.d.ts'])
  } finally {
    cleanup()
  }
})

test('#4b 真实仓库方向：bundle-host 2b 复制谓词与 listSharedDts 同源且含深层子目录', () => {
  // 真实仓库 shared/ 清单复制到临时目录后，包内副本结构与源逐一对应
  const { dir, cleanup } = tempDir()
  try {
    const sharedDest = copyRealShared(dir)
    const expected = listSharedDts(ROOT)
    assert.ok(expected.length >= 3, '仓库 shared/ 至少含顶层 + 若干子目录的 d.ts')
    // shared/ 至少含 client/ 一级子目录（深层复制面）
    assert.ok(expected.some((rel) => rel.includes('/')), '清单含子目录路径（深层复制面）')
    for (const rel of expected) {
      assert.ok(existsSync(join(sharedDest, rel)), `包内副本 ${rel} 存在且结构保留`)
    }
    // 包内除期望清单外无多余 .d.ts（同源复制）
    const copied = walkFiles(sharedDest, (f) => f.endsWith('.d.ts'))
    assert.deepEqual(copied.sort(), expected.slice().sort())
  } finally {
    cleanup()
  }
})
