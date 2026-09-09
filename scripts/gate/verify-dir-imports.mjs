#!/usr/bin/env node
'use strict'

/**
 * verify-dir-imports — 目录 interface.ts 门面静态检查（issue #664 D10 决策）。
 *
 * 规则（严格模式，维护者拍板）：
 *   1. 每个 `src/<dir>/` 物理目录若被目录外文件引用，必须提供 `interface.ts`
 *      （该目录的唯一对外引用面，re-export 目录对外「类型 + 函数」）；
 *   2. 跨目录 import / export-from 只能解析到目标目录的 `interface.ts`，
 *      禁止直引目录内实现文件；
 *   3. 同目录相对 import 放行；`src/` 根文件之间互引暂不约束（阶段 6 集中
 *      搬移后根只剩汇聚点，两两互引自然消失）；子目录 import 根文件放行
 *      （阶段 2–5 过渡债，阶段 6 清零后如仍有残余应转硬校验）。
 *
 * 豁免：`src/client/`（index.ts 为 build-client 契约锚点，D10 只约束逻辑目录；
 * 客户端分层在阶段 7 另行处理）；跨包 shared/ 共享层、lib/ 产物、node_modules、
 * client/ 内部资源（style.css 等非 TS import）不在检查范围。
 * 适用包白名单：`--package <name>`（可多次）；缺省 = 仅 dsh-mcp-manager
 * （#664 重构包）。其他包目录形态不在本机制约束内，避免误伤历史结构。
 *
 * 用法：node scripts/gate/verify-dir-imports.mjs [--package dsh-mcp-manager] [--verbose]
 * 退出码：0 = 通过；1 = 存在违规（任一包）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERBOSE = process.argv.includes('--verbose')
// 适用包白名单：显式 --package 累加；缺省仅 #664 重构包
const ARGV = process.argv.slice(2)
const applyPackages = ARGV.includes('--package')
  ? ARGV.filter((a, i) => ARGV[i - 1] === '--package')
  : ['dsh-mcp-manager']
const failures = []
const summary = []

/** 递归收集目录下全部 .ts/.tsx 文件（绝对路径）。 */
function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

/** 解析一个相对 import 目标的绝对路径（支持 .ts/.tsx 后缀与目录 index 落点）。 */
function resolveTarget(fromFile, spec) {
  if (!spec.startsWith('.') || isAbsolute(spec)) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

for (const pkgName of applyPackages) {
  const srcDir = join(ROOT, 'packages', pkgName, 'src')
  if (!existsSync(srcDir)) continue
  const rel = (p) => relative(join(ROOT, 'packages', pkgName), p)

  // 物理目录集合（不含 src 根本身，豁免 client/——index.ts 为 build-client 契约锚点）
  const dirSet = new Set()
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'client') dirSet.add(join(srcDir, entry.name))
  }

  // 被外部引用的目录 → 必须有 interface.ts
  const fileToDir = new Map() // 绝对文件路径 → 所属目录（根文件为 null）
  for (const f of collectTsFiles(srcDir)) {
    const d = dirname(f)
    fileToDir.set(f, dirSet.has(d) ? d : null)
  }

  const importedDirs = new Set()
  for (const [fromFile, fromDir] of fileToDir) {
    const absDir = fromDir ?? srcDir // 根文件以 src 本身为边界起点
    const text = readFileSync(fromFile, 'utf8')
    // from 子句：import/export-from/dynamic-import 三种形态
    const re = /(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    let m
    while ((m = re.exec(text)) !== null) {
      const spec = m[1] ?? m[2]
      const target = resolveTarget(fromFile, spec)
      if (target === null) continue // 非相对/不存在（node_modules/shared 等）跳过
      const targetDir = dirname(target)
      const targetFile = target.split(sep).pop()
      if (!dirSet.has(targetDir)) continue // client/、跨包/共享/根文件目标，不受目录门面约束
      importedDirs.add(targetDir)
      if (targetDir === absDir) continue // 同目录相对 import 放行
      const dirName = relative(srcDir, targetDir).split(sep)[0]
      if (targetFile !== 'interface.ts') {
        failures.push(
          `[${pkgName}] ${rel(fromFile)} → import "${spec}"（${dirName}/${targetFile}）：跨目录引用必须走 ${dirName}/interface.ts`,
        )
      }
    }
  }
  // 被外部引用却无 interface.ts 的目录
  for (const d of importedDirs) {
    if (!existsSync(join(d, 'interface.ts'))) {
      failures.push(`[${pkgName}] src/${relative(srcDir, d)}/ 被目录外引用但缺少 interface.ts（该目录唯一对外面）`)
    }
  }
  summary.push(`${pkgName}: ${fileToDir.size} 个 src TS 文件、${dirSet.size} 个目录`)
}

for (const line of summary) console.log(`verify-dir-imports | ${line}`)
if (failures.length > 0) {
  console.log(`verify-dir-imports | FAIL ${failures.length} 条目录门面违规：`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
console.log('verify-dir-imports | PASS（跨目录引用全部走 interface.ts）')
process.exit(0)