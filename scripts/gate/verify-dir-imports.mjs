#!/usr/bin/env node
'use strict'

/**
 * verify-dir-imports —— 目录 interface.ts 门面静态检查 + 依赖图尺子（#664 D10 / #670 C2 / #690 S0）。
 *
 * 规则：
 *   1. 模块 = 递归包含 `interface.ts` 的目录（叶子粒度），被模块外文件引用时必须提供
 *      `interface.ts`（该模块唯一对外引用面）。跨模块引用的目标若落在不含
 *      `interface.ts` 的目录内（分组层 / 未登记目录），同样判缺门面。
 *   2. 跨模块 import / export-from / dynamic-import 只能解析到目标模块的
 *      `interface.ts`（入口）或 `deps.ts`（出口），禁止直引模块内实现文件；
 *   3. 同模块相对 import 放行（含模块内子目录）；`src/` 根文件之间互引暂不约束；
 *      模块内文件 import 根文件放行（阶段 2–5 过渡债）。
 *   4. interface.ts 符号存在性（防虚导出）：被外部引用的 interface.ts 的每个具名
 *      导出符号，必须沿其 re-export 链可解析到真实实现（链终点可为模块内实现文件
 *      或同包根文件）。两模式（soft/hard）均硬执行（exit != 0）。
 *   5. 值依赖图无环：跨模块的**值** import/re-export 构成的有向图不得成环。
 *      `import type` / `export type` 边编译期擦除，允许成环。S0 起**判红口径为叶子
 *      模块粒度**（与模块定义同源）；顶层域口径退为「历史对照」行——它原样复刻修复
 *      粒度前的算法（起点与目标的直接父目录都须是顶层目录，嵌套目标整条边被丢弃），
 *      而那个算法正是环检测曾静默归零的成因，故只用于跨期比对、不参与判定。
 *      存量环登记在基线里只许降不许升，拆解属 #690 P1。
 *
 * S0 新增（#690）：
 *   - **叶子粒度模块定义**：模块名取相对 `src/` 的完整路径（如 `config/model`），
 *     分组层（不含 interface.ts 的中间目录）不进模块表，对门禁透明。旧实现只取
 *     `src/` 顶层一层，嵌套目标整条边被丢弃（实测用量统计包 13 个 interface.ts
 *     只被认作 4 个目录、丢弃 115 条边；MCP 包丢弃 27 条）。
 *   - `--zones`：叶子口径跨域引用明细 + R-A 两个语义口径计数（D-2 前后）。
 *   - `--graph`：依赖矩阵 + 扇入扇出 + 模块级/文件级值环 + 死声明。
 *   - **单调基线**：每包每类计数只许降不许升（`scripts/data/dir-imports-baseline.json`），
 *     上升即 exit 1。基线由 `--write-baseline` 生成/更新。
 *   - **源码全覆盖断言**：`src` 下每个文件必须落在 `∪mutate ∪ ∪excludes` 之内。
 *     `gen-stryker-conf --check` 只比对「磁盘配置 ↔ 拓扑派生」，不会因新增源文件
 *     而变红，故新增未被度量覆盖的源文件必须由本断言兜住（存量登记在基线里）。
 *
 * 豁免：
 *   - `src/client/`（index.ts 为 build-client 契约锚点）：from 侧完全豁免；
 *     target 侧同样不入模块表与依赖图。
 *   - 跨包 shared/ 共享层、lib/ 产物、node_modules、client/ 内部资源不在检查范围。
 *
 * 模式（#710 F11：措辞必须区分「有基线 / 无基线」两态，否则会误读成 --soft 也判红）：
 *   - 默认（hard）：规则违规经单调基线判定（实际 > 基线即 FAIL，exit 1）。
 *   - `--soft`：规则 1–3 违规只打印软报告标签，仍受基线约束；规则 4（虚导出）两模式均硬执行。
 *   - **基线缺失或包未登记（fail-closed）**：
 *       · hard 下规则 1/2 违规即刻 exit 1；
 *       · soft 下规则 1/2 仍只进软报告（不判红）——fail-closed 只保证「无基线 = 不放行」，
 *         不改变 soft 对规则 1–3 的软报告语义；
 *       · 两种模式下规则 4（虚导出）、规则 5（值环）与源码全覆盖断言都硬执行。
 *
 * 适用包白名单：`--package <name>`（可多次）；缺省 = 仅 dsh-mcp-manager。
 * 用法：node scripts/gate/verify-dir-imports.mjs [--package <name>] [--soft] [--verbose]
 *                                              [--zones] [--graph] [--write-baseline]
 * 退出码：0 = 通过；1 = 硬违规 / 基线上升 / 新增未覆盖源文件。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectMutationSpecs } from './mutation-topology.mjs'

// 仓库根；测试可用 VERIFY_DIR_IMPORTS_ROOT 注入临时 fixture 根，避免在仓库内
// 造包目录（产物零污染纪律）。基线可用 VERIFY_DIR_IMPORTS_BASELINE 覆盖。
const ROOT = process.env.VERIFY_DIR_IMPORTS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH =
  process.env.VERIFY_DIR_IMPORTS_BASELINE ?? join(ROOT, 'scripts', 'data', 'dir-imports-baseline.json')
const TOPOLOGY_PATH = join(ROOT, 'scripts', 'data', 'mutation-topology.json')
const VERBOSE = process.argv.includes('--verbose')
const SOFT = process.argv.includes('--soft')
const ZONES = process.argv.includes('--zones')
const GRAPH = process.argv.includes('--graph')
const WRITE_BASELINE = process.argv.includes('--write-baseline')
// 适用包白名单：显式 --package 累加；缺省仅 #664 重构包
const ARGV = process.argv.slice(2)
const explicitPackages = ARGV.includes('--package') ? ARGV.filter((a, i) => ARGV[i - 1] === '--package') : null
const failures = [] // 硬失败：规则违规（无基线时）或基线上升
const softViolations = [] // soft 模式软报告的跨模块直引违规
const summary = []
const reports = [] // --zones / --graph 的明细段（最后统一打印）

/** 递归收集目录下全部 .ts/.tsx 文件（绝对路径，from 侧扫描用）。 */
function collectTsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

/** 递归收集目录下全部文件（绝对路径，覆盖断言用）。 */
function collectAllFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectAllFiles(full, acc)
    else acc.push(full)
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
  // TS/ESM 约定：源码写 `./foo.js` 而磁盘上是 `./foo.ts`。不做这步映射会把整条引用
  // 静默丢弃，等于给「改用 .js 后缀即可绕开门禁」留后门。
  if (/\.(?:js|mjs|cjs)$/.test(spec)) {
    const stem = base.replace(/\.(?:js|mjs|cjs)$/, '')
    for (const ext of ['.ts', '.tsx', '.mts']) tryAdd(stem + ext)
  }
  for (const name of ['index.ts', 'index.tsx', 'index.mts', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
    tryAdd(join(base, name))
  }
  return cands
}

/** 解析一个相对 import 目标的绝对路径（取首个存在候选；无则 null）。 */
function resolveTarget(fromFile, spec) {
  return resolveCandidates(fromFile, spec)[0] ?? null
}

/** 剥离注释，避免注释里的 import 示例被当成真实引用（`(^|[^:])//` 防误伤 `https://`）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 判定一个 import/export 子句是否**整句类型**（含内联 `type X` 逐符号修饰）。
 * 入参是 `from` 之前的子句（不含 import/export 关键字），故整句类型以 `type` 起头。
 */
function isTypeOnlyClause(clause) {
  if (/^type\b/.test(clause.trim())) return true
  const brace = clause.match(/\{([^}]*)\}/)
  if (brace === null) return false
  const names = brace[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
  return names.length > 0 && names.every((n) => /^type\s+/.test(n))
}

/**
 * 提取文件文本里的全部相对引用（spec + 是否类型位置）。
 *
 * 覆盖形态：`import|export ... from "spec"`、副作用 `import "spec"`、动态
 * `import("spec")`。特别注意 TS 的**类型查询** `import("spec").T` 与运行时动态导入
 * 同形：纯文本无法完全区分，而运行时形态必经 `await` 或 `.then/.catch`，故只在
 * 明确表达式上下文判值，其余按类型处理——否则纯类型代码会造出幻影值边与假值环。
 */
function extractRefs(text) {
  const out = []
  const staticRe =
    /(?:^|\n)[ \t]*(?:import|export)\s+([^'"]*?)\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g
  let m
  while ((m = staticRe.exec(text)) !== null) {
    if (m[3] !== undefined) out.push({ spec: m[3], isType: false }) // 副作用导入仍是值依赖
    else out.push({ spec: m[2], isType: isTypeOnlyClause(m[1]) })
  }
  const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynRe.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 12), m.index)
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10)
    const isValue = /\bawait\s*$/.test(before) || /^\s*\.\s*(?:then|catch|finally)\b/.test(after)
    out.push({ spec: m[1], isType: !isValue })
  }
  return out
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
    // `export default` 是匿名默认导出，具名声明正则抓不到；规则 4 判定
    // `export { default as A } from "./impl.ts"` 时需要它在符号集里，否则假红。
    if (/^\s*export\s+default\b/m.test(text)) syms.add('default')
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

/**
 * 叶子模块表：递归全部含 interface.ts 的目录（顶层 client 子树整体豁免）。
 * 模块**必是目录**：`src/interface.ts` 这类根级同名文件不构成模块（它没有「对外引用面」
 * 语义——根文件的引用在规则 3 下本就放行），故根级 interface.ts 的导出符号不存在性
 * 也不进入规则 4 的检查对象（#710 F13 的显式声明）。
 */
function collectModules(srcDir) {
  const modules = new Map() // 绝对目录 → 模块 id（相对 src 的 posix 路径）
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // client 是包级（顶层）概念：判定面必须与 inClient 一致，否则深层同名目录
      // 会被这里跳过、却被 inClient 当作普通源码，产生自相矛盾的归属。
      if (depth === 0 && entry.name === 'client') continue
      const full = join(dir, entry.name)
      if (existsSync(join(full, 'interface.ts'))) modules.set(full, relative(srcDir, full).split(sep).join('/'))
      walk(full, depth + 1)
    }
  }
  walk(srcDir, 0)
  return modules
}

/** *.json 拓扑 glob → 正则（`**` 跨目录，单个 `*` 不跨层；`**` 前缀可匹配零层目录）。 */
function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * 在值依赖图上跑三色 DFS，返回**环集合**（不是环个数）：节点集合排序去重后作 key，
 * 值为一条代表环路径。语义后果（#710 F16）：同一节点集合上的另一条同类路径不会让
 * 计数变化——本指标衡量「哪些节点互相纠缠」，不衡量「有几条回路」，增量基线据此只许降不许升。
 */
function findCycles(edges) {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map()
  const stack = []
  const cycles = new Map()
  const visit = (node) => {
    color.set(node, GRAY)
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const state = color.get(next) ?? WHITE
      if (state === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(next)), next]
        const key = [...new Set(cycle)].sort().join('|')
        if (!cycles.has(key)) cycles.set(key, cycle)
      } else if (state === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    color.set(node, BLACK)
  }
  for (const node of edges.keys()) if ((color.get(node) ?? WHITE) === WHITE) visit(node)
  return cycles
}

function edgeCount(map) {
  return [...map.values()].reduce((n, s) => n + s.size, 0)
}

function rel(base, p) {
  return relative(base, p).split(sep).join('/')
}

/** 单包全量分析：模块表、引用明细、三套依赖图、R-A 双口径、规则违例、变异覆盖。 */
function analyzePackage(pkgName, topology) {
  const srcDir = join(ROOT, 'packages', pkgName, 'src')
  if (!existsSync(srcDir)) return null
  const modules = collectModules(srcDir)
  const inSrc = (p) => p === srcDir || p.startsWith(srcDir + sep)
  const inClient = (p) => inSrc(p) && rel(srcDir, p).split('/')[0] === 'client'
  /**
   * 门面资格：文件名是 interface.ts/deps.ts **且**所在目录就是一个模块目录。
   * 只看文件名会让 `../other/internal/deps.ts` 这类同名文件被当成合法出口放行
   * （interface.ts 天然保证同级目录即模块，deps.ts 没有这个前提）。
   */
  const isFacade = (p) => {
    const b = basename(p)
    if (b !== 'interface.ts' && b !== 'deps.ts') return false
    return modules.has(dirname(p))
  }
  /** 文件的叶子模块归属：最近的含 interface.ts 的祖先目录；根文件/包外为 null。 */
  const moduleOf = (file) => {
    let d = dirname(file)
    while (d === srcDir || d.startsWith(srcDir + sep)) {
      if (modules.has(d)) return modules.get(d)
      if (d === srcDir) break
      d = dirname(d)
    }
    return null
  }
  const allTsFiles = collectTsFiles(srcDir)
  // `.d.ts` 是声明文件：引用他域类型不构成运行时依赖，作为 from 侧会污染计数与
  // 规则判定（notifier `service.d.ts` 实测贡献 6 条 crossModuleRefs、2 条文件边）。
  const files = allTsFiles.filter((f) => !inClient(f) && !f.endsWith('.d.ts'))
  const refs = []
  for (const fromFile of files) {
    const text = stripComments(readFileSync(fromFile, 'utf8'))
    for (const { spec, isType } of extractRefs(text)) {
      const target = resolveTarget(fromFile, spec)
      if (target === null) continue // 非相对/不存在（node_modules 等）跳过
      if (inClient(target)) continue // client 目标不参与门禁
      refs.push({
        fromFile,
        spec,
        target,
        targetFile: basename(target),
        isType,
        fromModule: moduleOf(fromFile),
        toModule: moduleOf(target),
        targetInSrc: inSrc(target),
      })
    }
  }

  const crossModule = (r) =>
    r.fromModule !== r.toModule && !(r.fromModule === null && r.toModule === null)

  // 规则 1/2：跨模块引用必须落到目标模块的 interface.ts / deps.ts；目标目录无
  // interface.ts（分组层或未登记目录）判缺门面。
  const missingInterface = []
  const directImpl = []
  for (const r of refs) {
    if (!crossModule(r)) continue
    if (r.toModule === null) {
      // 目标在 src 根（装配层）放行；目标在不含 interface.ts 的目录内即缺门面。
      const targetDir = dirname(r.target)
      if (!r.targetInSrc || targetDir === srcDir) continue
      missingInterface.push(r)
      continue
    }
    if (!isFacade(r.target)) directImpl.push(r)
  }

  // R-A 双口径（#690 D-2）：旧语义「impl 只 import 本目录」；新语义「impl 不得引用
  // 他域**实现文件**」（impl → 他域 interface.ts/deps.ts 合法）。
  const raLegacy = []
  const raImpl = []
  for (const r of refs) {
    if (r.fromModule === null || r.toModule === null || r.fromModule === r.toModule) continue
    if (isFacade(r.fromFile)) continue // interface/deps 走 R-B，不计入 R-A
    raLegacy.push(r)
    if (!isFacade(r.target)) raImpl.push(r)
  }

  // 三套值图：顶层域「历史对照口径」（复刻修复粒度前的算法：目标必须直接位于顶层
  // 目录下，因此嵌套目标整条边被丢弃——环检测曾因此静默归零）、叶子模块口径
  // （S0 门禁口径）、文件口径。
  const topDirSet = new Set()
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'client') topDirSet.add(join(srcDir, entry.name))
  }
  const topValueEdges = new Map()
  const leafValueEdges = new Map()
  const fileValueEdges = new Map()
  const addEdge = (map, from, to) => {
    if (!map.has(from)) map.set(from, new Set())
    map.get(from).add(to)
  }
  for (const r of refs) {
    if (r.isType) continue
    const fromDir = dirname(r.fromFile)
    const targetDir = dirname(r.target)
    // 历史口径的原样复刻：起点与目标的**直接父目录**都必须是顶层目录，否则整条边
    // 丢弃——这正是嵌套目录依赖脱管的成因。
    if (topDirSet.has(fromDir) && topDirSet.has(targetDir) && targetDir !== fromDir) {
      const fromName = relative(srcDir, fromDir).split(sep)[0]
      const toName = relative(srcDir, targetDir).split(sep)[0]
      if (fromName !== toName) addEdge(topValueEdges, fromName, toName)
    }
    if (r.fromModule !== null && r.toModule !== null && r.fromModule !== r.toModule) {
      addEdge(leafValueEdges, r.fromModule, r.toModule)
    }
    if (r.targetInSrc && r.fromFile !== r.target) addEdge(fileValueEdges, rel(srcDir, r.fromFile), rel(srcDir, r.target))
  }
  const topCycles = findCycles(topValueEdges)
  const leafCycles = findCycles(leafValueEdges)
  const fileCycles = findCycles(fileValueEdges)

  // 死声明（意图 - 事实）：deps.ts 声明依赖某模块，而本模块 deps.ts **之外**的
  // 实现/门面文件并无对应事实边。deps.ts 自身的边属意图声明，不能自证为事实。
  // S0 时 deps.ts 尚未落地，故一般为空；机制先建好，S5 落地后即自动生效。
  const deadDeclarations = []
  for (const [modDir, modId] of modules) {
    const depsFile = join(modDir, 'deps.ts')
    if (!existsSync(depsFile)) continue
    const intended = new Set()
    for (const r of refs) {
      if (r.fromFile !== depsFile) continue
      if (r.toModule === null || r.toModule === modId) continue
      intended.add(r.toModule)
    }
    const actual = new Set()
    for (const r of refs) {
      if (r.fromModule !== modId || r.toModule === null || r.toModule === modId) continue
      if (basename(r.fromFile) === 'deps.ts') continue
      actual.add(r.toModule)
    }
    for (const target of intended) {
      if (!actual.has(target)) deadDeclarations.push(`${modId}/deps.ts → ${target}（意图有而事实无）`)
    }
  }

  const specs = collectMutationSpecs(topology, pkgName)
  const uncoveredSrcFiles = []
  if (specs !== null) {
    const covered = (relPath) =>
      specs.excludes.some((g) => globToRegExp(g).test(relPath)) ||
      specs.mutate.some((g) => globToRegExp(g).test(relPath))
    for (const f of collectAllFiles(srcDir)) {
      const r = rel(ROOT, f)
      if (!covered(r)) uncoveredSrcFiles.push(r)
    }
    uncoveredSrcFiles.sort()
  }

  const valueCount = raLegacy.filter((r) => !r.isType).length
  return {
    package: pkgName,
    srcDir,
    modules,
    moduleIds: [...modules.values()].sort(),
    refs,
    rules: { missingInterface, directImpl },
    raLegacy,
    raImpl,
    graphs: { topValueEdges, leafValueEdges, fileValueEdges },
    cycles: { top: topCycles, leaf: leafCycles, file: fileCycles },
    deadDeclarations,
    // 覆盖断言可判定性：包未登记拓扑时 uncoveredSrcFiles 恒为空，若不显式区分，
    // 「从拓扑里删掉一个包」就成了让覆盖断言消失的绕过路径（已复现的假绿向量）。
    topologyRegistered: specs !== null,
    metrics: {
      modules: modules.size,
      // F14：两个口径必须自解释——scannedSrcFiles = 实际参与规则扫描的文件
      // （已排除 client 子树与 .d.ts 声明面）；allSrcTsFiles = src 下全部 TS 文件。
      scannedSrcFiles: files.length,
      allSrcTsFiles: allTsFiles.length,
      interfaceFacades: 0, // 主流程按被引用面填充
      topValueEdges: edgeCount(topValueEdges),
      topModuleCycles: topCycles.size,
      leafValueEdges: edgeCount(leafValueEdges),
      leafModuleCycles: leafCycles.size,
      fileValueEdges: edgeCount(fileValueEdges),
      fileCycles: fileCycles.size,
      crossModuleRefs: refs.filter(crossModule).length,
      raLegacy: raLegacy.length,
      raLegacyValue: valueCount,
      raLegacyType: raLegacy.length - valueCount,
      implToOtherImpl: raImpl.length,
      missingInterface: missingInterface.length,
      directImpl: directImpl.length,
      uncoveredSrcFiles,
    },
  }
}

/**
 * 基线字段（数值型）：只许降不许升。
 * 全部为**叶子模块粒度**——顶层域历史对照口径不进此表也不进基线：它复刻的是
 * 有缺陷的旧算法（嵌套目标丢边），对它设阈值等于让「结构搬迁」误红（三域移入
 * src/server/ 就会改变顶层域集合），且与叶子口径构成同一约束的双轨判定
 * （ARCHITECTURE-METHOD §9 禁止双轨）。它只用于打印跨期对照。
 */
const COUNTED_METRICS = [
  'modules',
  'scannedSrcFiles',
  'allSrcTsFiles',
  'interfaceFacades',
  'leafValueEdges',
  'leafModuleCycles',
  'fileValueEdges',
  'fileCycles',
  'crossModuleRefs',
  'raLegacy',
  'raLegacyValue',
  'raLegacyType',
  'implToOtherImpl',
  'missingInterface',
  'directImpl',
]

/** 读取基线 JSON；缺失返回 null（调用方按 fail-closed 处理）。 */
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch (e) {
    failures.push(`[baseline] 基线文件解析失败：${BASELINE_PATH}（${e.message}）`)
    return null
  }
}

/** 单调基线比对：数值上升或未覆盖清单新增条目即判红。 */
function compareWithBaseline(analysis, baseline) {
  const pkgBase = baseline?.packages?.[analysis.package]
  if (pkgBase === undefined) return { mode: 'absent', rises: [] }
  const rises = []
  for (const key of COUNTED_METRICS) {
    const cur = analysis.metrics[key]
    const base = pkgBase[key]
    if (typeof base !== 'number') rises.push(`${key}: 基线未登记（当前 ${cur}）`)
    else if (cur > base) rises.push(`${key}: ${cur} > 基线 ${base}`)
  }
  const baseUncovered = new Set(pkgBase.uncoveredSrcFiles ?? [])
  for (const f of analysis.metrics.uncoveredSrcFiles) {
    if (!baseUncovered.has(f)) rises.push(`uncoveredSrcFiles: 新增未覆盖源文件 ${f}`)
  }
  return { mode: 'compared', rises }
}

/** 规则违规的判红入口：有基线则比基线，无基线则立即红（fail-closed）。 */
function registerRuleViolations(analysis, state) {
  const { package: pkgName, srcDir } = analysis
  if (state.mode === 'compared') {
    // 有基线：违规明细只作报告，判红交给单调基线（存量豁免、增量收紧）。
    if (SOFT || VERBOSE) {
      for (const r of analysis.rules.directImpl) {
        softViolations.push(
          `[${pkgName}] 存量直引实现文件（基线锁定）：${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)}`,
        )
      }
      for (const r of analysis.rules.missingInterface) {
        softViolations.push(`[${pkgName}] 存量缺门面目录（基线锁定）：${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)}`)
      }
    }
    return
  }
  for (const r of analysis.rules.directImpl) {
    const line = `[${pkgName}] ${rel(srcDir, r.fromFile)} → import "${r.spec}"：跨模块引用必须走目标模块 interface.ts/deps.ts`
    if (SOFT) softViolations.push(line)
    else failures.push(line)
  }
  for (const r of analysis.rules.missingInterface) {
    const line = `[${pkgName}] ${rel(srcDir, r.fromFile)} → import "${r.spec}"：目标目录缺少 interface.ts（该模块唯一对外面）`
    if (SOFT) softViolations.push(line)
    else failures.push(line)
  }
}

/** 渲染 --zones 段：叶子口径跨域引用明细 + R-A 双口径。 */
function renderZones(analysis) {
  const { package: pkgName, metrics, raLegacy, raImpl, srcDir } = analysis
  const lines = [`zones ${pkgName}（叶子口径跨域引用明细）`]
  lines.push(
    `R-A 语义切换前（impl → 他域任意文件，旧口径）：${metrics.raLegacy} 条（值 ${metrics.raLegacyValue} / type ${metrics.raLegacyType}）`,
  )
  for (const r of raLegacy) {
    lines.push(`  ${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)} [${r.isType ? 'type' : 'value'}]`)
  }
  lines.push(`R-A 语义切换后（impl → 他域实现文件，D-2 批准口径）：${metrics.implToOtherImpl} 条`)
  for (const r of raImpl) {
    lines.push(`  ${rel(srcDir, r.fromFile)} → ${rel(srcDir, r.target)} [${r.isType ? 'type' : 'value'}]`)
  }
  return lines
}

/** 渲染 --graph 段：依赖矩阵 + 扇入扇出 + 模块级/文件级值环 + 死声明。 */
function renderGraph(analysis) {
  const { package: pkgName, moduleIds, graphs, cycles, deadDeclarations, refs } = analysis
  const lines = [`graph ${pkgName}（叶子粒度依赖图）`]
  const cellType = (from, to) => {
    const hasV = (graphs.leafValueEdges.get(from) ?? new Set()).has(to)
    const hasT = refs.some((r) => r.fromModule === from && r.toModule === to && r.isType)
    if (hasV && hasT) return 'B'
    if (hasV) return 'V'
    if (hasT) return 'T'
    return '.'
  }
  const short = (id) => id.split('/').pop()
  // 列宽按最长短名自适应：固定截断会让长名模块（orchestrator/runtime 等）在矩阵里
  // 变成无法区分的同名列。
  const shortNames = moduleIds.map(short)
  const colW = Math.max(1, ...shortNames.map((s) => s.length)) + 2
  const rowW = Math.max(4, ...moduleIds.map((m) => m.length)) + 2
  lines.push('依赖矩阵（行=from 模块，列=to 模块；V=值边 T=type 边 B=两者 .=无）：')
  lines.push(`  ${'from'.padEnd(rowW)}${shortNames.map((s) => s.padEnd(colW)).join('')}`)
  for (const from of moduleIds) {
    const cells = moduleIds.map((to) => (from === to ? '-' : cellType(from, to)).padEnd(colW))
    lines.push(`  ${from.padEnd(rowW)}${cells.join('')}`)
  }
  lines.push('扇入/扇出（值边 / 类型边）：')
  for (const id of moduleIds) {
    const outV = (graphs.leafValueEdges.get(id) ?? new Set()).size
    const outT = new Set(refs.filter((r) => r.fromModule === id && r.toModule && r.toModule !== id && r.isType).map((r) => r.toModule)).size
    const inV = moduleIds.filter((m) => (graphs.leafValueEdges.get(m) ?? new Set()).has(id)).length
    const inT = new Set(refs.filter((r) => r.toModule === id && r.fromModule && r.fromModule !== id && r.isType).map((r) => r.fromModule)).size
    lines.push(`  ${id.padEnd(26)} 扇出 ${outV}/${outT}  扇入 ${inV}/${inT}`)
  }
  lines.push(`顶层域值环（历史对照口径，复刻修复粒度前算法，按节点集合去重的环集合数）：${cycles.top.size} 个`)
  for (const c of cycles.top.values()) lines.push(`  ${c.join(' → ')}`)
  lines.push(`叶子模块级值环（门禁口径，按节点集合去重的环集合数，只许降不许升）：${cycles.leaf.size} 个`)
  for (const c of cycles.leaf.values()) lines.push(`  ${c.join(' → ')}`)
  lines.push(`文件级值环（门禁口径，按节点集合去重的环集合数）：${cycles.file.size} 个`)
  for (const c of cycles.file.values()) lines.push(`  ${c.join(' → ')}`)
  lines.push(`死声明（意图 - 事实）：${deadDeclarations.length} 条`)
  for (const d of deadDeclarations) lines.push(`  ${d}`)
  lines.push('（意图图 = 各模块 deps.ts；S0 阶段尚未落地，故死声明为空属预期）')
  return lines
}

/** 生成基线 JSON 结构（稳定排序，便于 diff）。 */
function buildBaseline(analyses) {
  const packages = {}
  for (const a of [...analyses].sort((x, y) => x.package.localeCompare(y.package))) {
    const m = a.metrics
    packages[a.package] = {
      modules: m.modules,
      scannedSrcFiles: m.scannedSrcFiles,
      allSrcTsFiles: m.allSrcTsFiles,
      interfaceFacades: m.interfaceFacades,
      leafValueEdges: m.leafValueEdges,
      leafModuleCycles: m.leafModuleCycles,
      fileValueEdges: m.fileValueEdges,
      fileCycles: m.fileCycles,
      crossModuleRefs: m.crossModuleRefs,
      raLegacy: m.raLegacy,
      raLegacyValue: m.raLegacyValue,
      raLegacyType: m.raLegacyType,
      implToOtherImpl: m.implToOtherImpl,
      missingInterface: m.missingInterface,
      directImpl: m.directImpl,
      uncoveredSrcFiles: m.uncoveredSrcFiles,
    }
  }
  return {
    // S0（#690 A 轨）门禁基线：每包每类计数只许降不许升。
    // 口径：全部为**叶子模块粒度**实测（S0 起模块 = 递归含 interface.ts 的目录）。
    // 顶层域历史对照口径刻意不入库：它复刻的是有缺陷的旧算法（嵌套目标丢边），
    // 对它设阈值会让结构搬迁误红，并与叶子口径构成同一约束的双轨（§9 禁止双轨）。
    // leafModuleCycles/fileCycles 的存量环待 #690 P1 拆解，本阶段只锁「不许变多」；
    // uncoveredSrcFiles = `src ⊆ ∪mutate ∪ ∪excludes` 断言的历史存量，新增即红。
    $comment:
      'S0 门禁基线（#690）：每包每类计数只许降不许升；uncoveredSrcFiles 只许减不许增。由 verify-dir-imports.mjs --write-baseline 生成。',
    version: 1,
    packages,
  }
}

/** 解析本次要处理的包：显式 --package 优先；--write-baseline 缺省全量扫描。 */
function resolvePackages() {
  if (explicitPackages !== null) return explicitPackages
  if (WRITE_BASELINE) {
    const packagesDir = join(ROOT, 'packages')
    if (!existsSync(packagesDir)) return ['dsh-mcp-manager']
    return readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'src')))
      .map((e) => e.name)
      .sort()
  }
  return ['dsh-mcp-manager']
}

let topology = null
if (existsSync(TOPOLOGY_PATH)) {
  try {
    topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf8'))
  } catch (e) {
    // 拓扑损坏时不能抛栈崩掉整个 contract 段：显式判红并保持其余检查可读。
    failures.push(`[topology] 变异拓扑解析失败：${TOPOLOGY_PATH}（${e.message}）`)
  }
}
const applyPackages = resolvePackages()
const analyses = []
for (const pkgName of applyPackages) {
  const analysis = analyzePackage(pkgName, topology)
  if (analysis === null) continue
  // 被跨模块引用解析到的 interface.ts（任意层级）→ 符号存在性检查对象
  const referencedInterfaces = new Set()
  for (const r of analysis.refs) {
    // F12：判据是「目录不同」而不是「模块不同」。同模块内的子目录（a/sub/x.ts → ../interface.ts）
    // 同样是在引用该门面的对外符号，按模块比较会把这一面整块漏掉（#710 F12 实测向量）。
    if (r.targetFile === 'interface.ts' && dirname(r.fromFile) !== dirname(r.target)) referencedInterfaces.add(r.target)
  }
  for (const ifaceFile of referencedInterfaces) {
    for (const { exported, local, via } of collectInterfaceExports(ifaceFile)) {
      if (via === 'inline') continue // interface.ts 就地声明即自身实现
      const resolved = via.some((t) => collectExports(t).has(local))
      if (!resolved) {
        failures.push(
          `[${pkgName}] ${rel(analysis.srcDir, ifaceFile)} 导出符号 "${exported}"（源 ${local}）沿 re-export 链不可解析到实现（interface.ts 虚导出）`,
        )
      }
    }
  }
  analysis.metrics.interfaceFacades = referencedInterfaces.size
  analyses.push(analysis)
}

if (WRITE_BASELINE) {
  // 写基线前先拦阻断性错误（拓扑损坏 / interface.ts 虚导出）：静默落库会把
  // 「判不出来」固化成「看起来全覆盖」，正是本门禁要防的假绿。
  if (failures.length > 0) {
    console.log('verify-dir-imports | 写基线中止（存在阻断性错误）：')
    for (const f of failures) console.log(`  ${f}`)
    process.exit(1)
  }
  const baseline = buildBaseline(analyses)
  // `--write-baseline --package X` 只应更新 X 的条目：直接整体覆盖会抹掉其他包的
  // 基线（随后它们全部落到 fail-closed），补救只能全量重写——那等于一键放宽。
  if (existsSync(BASELINE_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      for (const [name, entry] of Object.entries(existing?.packages ?? {})) {
        if (!(name in baseline.packages)) baseline.packages[name] = entry
      }
    } catch {
      // 旧基线不可解析时按「全量重写」处理：保留损坏内容只会延续问题。
    }
  }
  mkdirSync(dirname(BASELINE_PATH), { recursive: true })
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`verify-dir-imports | 已写入基线 ${BASELINE_PATH}（${analyses.length} 个包）`)
  for (const a of analyses) {
    const coverNote = a.topologyRegistered
      ? `未覆盖 ${a.metrics.uncoveredSrcFiles.length} 个`
      : '未登记变异拓扑（覆盖断言不适用）'
    console.log(
      `verify-dir-imports |   ${a.package}: ${a.metrics.modules} 个叶子模块、值边 ${a.metrics.leafValueEdges} 条、${coverNote}`,
    )
  }
  process.exit(0)
}

const baseline = loadBaseline()
if (baseline === null) {
  console.log(
    `verify-dir-imports | 未找到基线 ${BASELINE_PATH} —— fail-closed：规则违规 / 值环 / 未覆盖源文件均即刻判红（生成基线用 --write-baseline）`,
  )
}

for (const analysis of analyses) {
  const { package: pkgName, metrics } = analysis
  const state = baseline === null ? { mode: 'absent', rises: [] } : compareWithBaseline(analysis, baseline)
  registerRuleViolations(analysis, state)
  if (!analysis.topologyRegistered && topology !== null) {
    failures.push(
      `[${pkgName}] 未在 scripts/data/mutation-topology.json 登记 —— 源码全覆盖断言无法判定（fail-closed：新增源文件会静默逃逸度量）`,
    )
  }

  // 门禁口径（叶子模块）：S0 起模块 = 递归含 interface.ts 的目录，嵌套目标不再丢边。
  summary.push(
    `${pkgName}: 叶子模块 ${metrics.modules} 个、值边 ${metrics.leafValueEdges} 条、模块级值环 ${metrics.leafModuleCycles} 个、文件级值环 ${metrics.fileCycles} 个`,
  )
  summary.push(
    `${pkgName}: src 下 ${metrics.allSrcTsFiles} 个 TS 文件，其中 ${metrics.scannedSrcFiles} 个参与规则扫描（排除 client 与 .d.ts）、${metrics.interfaceFacades} 个 interface.ts 符号面`,
  )
  // 历史对照口径（顶层域，复刻修复粒度前的算法）：仅作跨期可比，不进基线。
  summary.push(
    `${pkgName}: 历史对照（顶层域口径，已退出门禁）：值边 ${metrics.topValueEdges} 条、环 ${metrics.topModuleCycles} 个`,
  )
  summary.push(
    `${pkgName}: R-A 语义切换前 ${metrics.raLegacy}（值 ${metrics.raLegacyValue} / type ${metrics.raLegacyType}）→ 切换后（impl 引用他域实现文件）${metrics.implToOtherImpl}`,
  )

  if (state.mode === 'compared') {
    if (state.rises.length === 0) {
      summary.push(`${pkgName}: 单调基线通过（${COUNTED_METRICS.length} 类计数与未覆盖清单均未上升）`)
    } else {
      for (const rise of state.rises) failures.push(`[${pkgName}] 单调基线上升：${rise}`)
    }
  } else {
    // fail-closed：无基线条目时任何门禁类计数都必须为零（不允许「无基线 = 放行」）。
    for (const [key, label] of [
      ['topModuleCycles', '顶层域值环'],
      ['leafModuleCycles', '叶子模块级值环'],
      ['fileCycles', '文件级值环'],
      ['implToOtherImpl', 'impl 引用他域实现文件'],
    ]) {
      if (metrics[key] > 0) failures.push(`[${pkgName}] 无基线 fail-closed：${label} ${metrics[key]} 个（应为 0）`)
    }
    for (const f of metrics.uncoveredSrcFiles) {
      failures.push(`[${pkgName}] 无基线 fail-closed：src 文件未被度量覆盖 ${f}`)
    }
    summary.push(`${pkgName}: 基线无本包条目 —— fail-closed（违规/环/未覆盖即刻判红）`)
  }

  if (ZONES) reports.push(renderZones(analysis))
  if (GRAPH) reports.push(renderGraph(analysis))
}

for (const line of summary) console.log(`verify-dir-imports | ${line}`)
for (const block of reports) {
  console.log(`verify-dir-imports | ${block[0]}`)
  for (const line of block.slice(1)) console.log(`  ${line}`)
}
if (softViolations.length > 0) {
  console.log(`verify-dir-imports | soft：${softViolations.length} 条跨模块直引（软报告，review 用，不判红）：`)
  for (const v of softViolations) console.log(`  ${v}`)
}
if (failures.length > 0) {
  console.log(`verify-dir-imports | FAIL ${failures.length} 条硬违规：`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
console.log('verify-dir-imports | PASS（跨模块引用全部走 interface.ts/deps.ts，符号存在性校验通过，基线未上升）')
process.exit(0)
