#!/usr/bin/env node
'use strict'

/**
 * verify-dir-imports — 目录 interface.ts 门面静态检查（#664 D10 决策，#670 C2 扩展）。
 *
 * 规则：
 *   1. 每个 `src/<dir>/` 物理目录若被目录外文件引用，必须提供 `interface.ts`
 *      （该目录的唯一对外引用面，re-export 目录对外「类型 + 函数」）；
 *   2. 跨目录 import / export-from 只能解析到目标目录的 `interface.ts`，
 *      禁止直引目录内实现文件；
 *   3. 同目录相对 import 放行；`src/` 根文件之间互引暂不约束；子目录
 *      import 根文件放行（阶段 2–5 过渡债，阶段 6 清零后如仍有残余应转硬校验）；
 *   4. interface.ts 符号存在性（防虚导出）：被外部引用的 interface.ts 的每个
 *      具名导出符号，必须沿其 re-export 链可解析到真实实现（链终点可为目录内
 *      实现文件或同包根文件——子目录 import 根文件本规则放行；悬空符号即
 *      interface.ts 虚导出）。两模式（soft/hard）均硬执行（exit != 0）。
 *   5. 域级值依赖图无环：跨目录的**值** import/re-export 构成的有向图不得成环。
 *      `import type` / `export type` 边编译期擦除，允许成环（如 sdk ⇄ pipeline
 *      的 type 边是刻意的：pipeline 只把 sdk 当类型面）；值边成环会带来 ESM
 *      初始化顺序耦合（TDZ 风险）并破坏「域依赖单向」目标，故机械判红。
 *      根文件（src/index.ts 等）是装配层，不入图。两模式均硬执行（exit != 0）。
 *
 * 豁免：
 *   - `src/client/`（index.ts 为 build-client 契约锚点，D10 只约束逻辑目录；
 *     客户端分层在阶段 7 另行处理）：from 侧完全豁免——client→shared 等
 *     跨目录直引不检查（#670 A 主控裁决：client 走 shared/interface.ts 会把
 *     node:fs/schemastery 拉入 browser bundle，9 条直引保留）；目标侧
 *     shared/ 等目录被其他目录引用时照常要求 interface.ts。
 *   - 跨包 shared/ 共享层、lib/ 产物、node_modules、client/ 内部资源
 *     （style.css 等非 TS import）不在检查范围。
 *
 * 模式：
 *   - 默认（hard）：规则 1–3 违规即 FAIL（exit 1）——dsh-mcp-manager（#664
 *     重构包）的既有强制行为。
 *   - `--soft`：规则 1–3 违规只打印软报告清单、不判红（exit 0，review 用，
 *     不卡 CI）；规则 4 符号存在性在两模式均硬执行。provider-usage（#670
 *     阶段四）走 soft——跨目录直引是过渡债（review 跟踪），interface.ts
 *     虚导出是真实缺陷（必须卡）。
 *
 * 适用包白名单：`--package <name>`（可多次）；缺省 = 仅 dsh-mcp-manager。
 * 用法：node scripts/gate/verify-dir-imports.mjs [--package dsh-mcp-manager] [--soft] [--verbose]
 * 退出码：0 = 通过（或 soft 模式仅软违规）；1 = 硬违规 / 符号存在性失败。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根；测试可用 VERIFY_DIR_IMPORTS_ROOT 注入临时 fixture 根，避免在仓库内
// 造包目录（产物零污染纪律）。
const ROOT = process.env.VERIFY_DIR_IMPORTS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERBOSE = process.argv.includes('--verbose')
const SOFT = process.argv.includes('--soft')
// 适用包白名单：显式 --package 累加；缺省仅 #664 重构包
const ARGV = process.argv.slice(2)
const applyPackages = ARGV.includes('--package')
  ? ARGV.filter((a, i) => ARGV[i - 1] === '--package')
  : ['dsh-mcp-manager']
const failures = [] // 硬失败：跨目录直引违规（hard 模式）或符号存在性失败（两模式）
const softViolations = [] // soft 模式软报告的跨目录直引违规
const summary = []

/** 递归收集目录下全部 .ts/.tsx 文件（绝对路径，from 侧扫描用）。 */
function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

/** 一个相对 import 目标的所有存在候选（支持 .ts/.tsx/.mjs/.mts/.d.ts/.d.mts 与目录 index 落点）。 */
function resolveCandidates(fromFile, spec) {
  if (!spec.startsWith('.') || isAbsolute(spec)) return []
  const base = resolve(dirname(fromFile), spec)
  const cands = []
  const tryAdd = (p) => {
    if (existsSync(p) && statSync(p).isFile()) cands.push(p)
  }
  tryAdd(base) // spec 自带后缀（如 "./opencode-go.mjs"）时字面命中
  for (const ext of ['.ts', '.tsx', '.mts', '.mjs', '.d.ts', '.d.mts']) tryAdd(base + ext)
  for (const name of ['index.ts', 'index.tsx', 'index.mts', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
    tryAdd(join(base, name))
  }
  return cands
}

/** 解析一个相对 import 目标的绝对路径（取首个存在候选；无则 null）。 */
function resolveTarget(fromFile, spec) {
  return resolveCandidates(fromFile, spec)[0] ?? null
}

/** 解析 `A, B as C, type D` 形具名列表 → [{ exported, local }]（exported=对外名）。 */
function parseNameList(list) {
  const out = []
  for (let raw of list.split(',')) {
    let name = raw.trim()
    if (name === '') continue
    name = name.replace(/^type\s+/, '') // 内联 `export { type A }` 形态
    const asIdx = name.indexOf(' as ')
    if (asIdx >= 0) out.push({ exported: name.slice(asIdx + 4).trim(), local: name.slice(0, asIdx).trim() })
    else out.push({ exported: name, local: name })
  }
  return out
}

/**
 * 收集一个文件的具名导出符号集（就地声明 + re-export 链递归展开）。
 * 声明文件（.d.mts）与运行时文件（.mjs）同源并存时合并两侧符号
 * （如 adapters/ 的 .mjs + 相邻 .d.mts：类型只在声明文件、值只在运行时文件）。
 */
function collectExports(file, seen = new Set(), depth = 0) {
  if (depth > 10 || seen.has(file)) return new Set()
  seen.add(file)
  const syms = new Set()
  const files = [file]
  // .mjs 值面 + 同名 .d.mts 类型面合并（interface.ts 对 type 也 re-export 自 .mjs 路径）
  if (file.endsWith('.mjs')) {
    const decl = file.replace(/\.mjs$/, '.d.mts')
    if (existsSync(decl)) files.push(decl)
  }
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const declRe = /^\s*export\s+(?:declare\s+)?(?:abstract\s+|async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm
    let m
    while ((m = declRe.exec(text)) !== null) syms.add(m[1])
    const fromRe = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm
    while ((m = fromRe.exec(text)) !== null) {
      for (const n of parseNameList(m[1])) syms.add(n.local)
      for (const t of resolveCandidates(f, m[2])) {
        for (const s of collectExports(t, seen, depth + 1)) syms.add(s)
      }
    }
    const starRe = /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm
    while ((m = starRe.exec(text)) !== null) {
      for (const t of resolveCandidates(f, m[1])) {
        for (const s of collectExports(t, seen, depth + 1)) syms.add(s)
      }
    }
    const bareRe = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*;/gm
    while ((m = bareRe.exec(text)) !== null) {
      for (const n of parseNameList(m[1])) syms.add(n.local)
    }
  }
  return syms
}

/** interface.ts 的导出面（对外名 → 源符号名 + 引入途径：inline=就地声明 / from 目标文件列表）。 */
function collectInterfaceExports(file) {
  const out = []
  const text = readFileSync(file, 'utf8')
  const declRe = /^\s*export\s+(?:declare\s+)?(?:abstract\s+|async\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = declRe.exec(text)) !== null) out.push({ exported: m[1], local: m[1], via: 'inline' })
  const fromRe = /^\s*export\s+(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm
  while ((m = fromRe.exec(text)) !== null) {
    const via = resolveCandidates(file, m[2])
    for (const n of parseNameList(m[1])) out.push({ exported: n.exported, local: n.local, via })
  }
  const starRe = /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm
  while ((m = starRe.exec(text)) !== null) {
    const via = resolveCandidates(file, m[1])
    for (const t of via) {
      for (const s of collectExports(t)) out.push({ exported: s, local: s, via })
    }
  }
  return out
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
  const referencedInterfaces = new Set() // 被跨目录 import 解析到的 interface.ts（任意层，符号存在性检查对象）
  const valueEdges = new Map() // 域级「值」依赖边：fromDirName → Set<toDirName>（type-only 边不入图）
  for (const [fromFile, fromDir] of fileToDir) {
    // from 侧豁免：src/client/** 的 import 不检查（#670 主控裁决——client 走
    // shared/interface.ts 会炸 browser bundle；client 目录整体豁免 from 侧）。
    if (relative(srcDir, fromFile).split(sep)[0] === 'client') continue
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
      // 符号存在性检查对象：跨目录（fromDir 不同）解析到的 interface.ts，任意层级
      if (targetFile === 'interface.ts' && targetDir !== fromDir) referencedInterfaces.add(target)
      if (!dirSet.has(targetDir)) continue // client/、跨包/共享/根文件目标，不受目录门面约束
      importedDirs.add(targetDir)
      if (targetDir === absDir) continue // 同目录相对 import 放行
      const dirName = relative(srcDir, targetDir).split(sep)[0]
      // 规则 5 边收集：type-only 子句编译期擦除，不入值依赖图；根文件是装配层，
      // 只作为边起点会被跳过（fromDir === null → fromName 为空）。
      const fromName = fromDir === null ? '' : relative(srcDir, fromDir).split(sep)[0]
      if (fromName !== '' && fromName !== dirName && !/^(?:import|export)\s+type\b/.test(m[0])) {
        if (!valueEdges.has(fromName)) valueEdges.set(fromName, new Set())
        valueEdges.get(fromName).add(dirName)
      }
      if (targetFile !== 'interface.ts') {
        const violation = `[${pkgName}] ${rel(fromFile)} → import "${spec}"（${dirName}/${targetFile}）：跨目录引用必须走 ${dirName}/interface.ts`
        if (SOFT) softViolations.push(violation)
        else failures.push(violation)
      }
    }
  }
  // 被外部引用却无 interface.ts 的目录
  for (const d of importedDirs) {
    if (!existsSync(join(d, 'interface.ts'))) {
      const violation = `[${pkgName}] src/${relative(srcDir, d)}/ 被目录外引用但缺少 interface.ts（该目录唯一对外面）`
      if (SOFT) softViolations.push(violation)
      else failures.push(violation)
    }
  }
  // interface.ts 符号存在性（防虚导出）：导出符号必须沿 re-export 链可解析到
  // 真实实现。两模式均硬执行——虚导出是真实缺陷（interface.ts 承诺了不存在的面）。
  // 链终点允许出目录（如 orchestrator/interface.ts → src/manager.ts 根文件——子目录
  // import 根文件在规则中本就放行），但必须落到同包某实现文件，不能悬空。
  for (const ifaceFile of referencedInterfaces) {
    for (const { exported, local, via } of collectInterfaceExports(ifaceFile)) {
      if (via === 'inline') continue // interface.ts 就地声明即自身实现
      const resolved = via.some((t) => collectExports(t).has(local))
      if (!resolved) {
        failures.push(
          `[${pkgName}] ${rel(ifaceFile)} 导出符号 "${exported}"（源 ${local}）沿 re-export 链不可解析到实现（interface.ts 虚导出）`,
        )
      }
    }
  }
  // 规则 5：域级值依赖图无环（三色 DFS；type 边不入图故允许成环）
  {
    const WHITE = 0
    const GRAY = 1
    const BLACK = 2
    const color = new Map()
    const stack = []
    const cycles = new Set()
    const visit = (node) => {
      color.set(node, GRAY)
      stack.push(node)
      for (const next of valueEdges.get(node) ?? []) {
        const state = color.get(next) ?? WHITE
        if (state === GRAY) {
          const cycle = [...stack.slice(stack.indexOf(next)), next]
          // 同一环可能从不同入口重复发现，按去重后的节点集合归并
          cycles.add([...new Set(cycle)].sort().join('|'))
          failures.push(
            `[${pkgName}] 域级值依赖环：${cycle.join(' → ')}（type-only 边允许成环；值边应改走 deps 注入或下沉到更低层域）`,
          )
        } else if (state === WHITE) {
          visit(next)
        }
      }
      stack.pop()
      color.set(node, BLACK)
    }
    for (const node of valueEdges.keys()) if ((color.get(node) ?? WHITE) === WHITE) visit(node)
    const edgeCount = [...valueEdges.values()].reduce((n, s) => n + s.size, 0)
    summary.push(`${pkgName}: 域级值依赖边 ${edgeCount} 条、环 ${cycles.size} 个`)
  }
  summary.push(
    `${pkgName}: ${fileToDir.size} 个 src TS 文件、${dirSet.size} 个目录、${referencedInterfaces.size} 个 interface.ts 符号面`,
  )
}

for (const line of summary) console.log(`verify-dir-imports | ${line}`)
if (softViolations.length > 0) {
  console.log(`verify-dir-imports | soft：${softViolations.length} 条跨目录直引（软报告，review 用，不判红）：`)
  for (const v of softViolations) console.log(`  ${v}`)
}
if (failures.length > 0) {
  console.log(`verify-dir-imports | FAIL ${failures.length} 条硬违规（${SOFT ? 'soft 模式仅 interface.ts 符号存在性' : '目录门面'}）：`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
if (SOFT && softViolations.length > 0) {
  console.log('verify-dir-imports | PASS（--soft：跨目录直引软报告如上，interface.ts 符号存在性硬校验通过）')
} else {
  console.log('verify-dir-imports | PASS（跨目录引用全部走 interface.ts，符号存在性校验通过）')
}
process.exit(0)
