#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * dts-cordis-merge-lib — 「cordis 声明合并必须在包入口声明闭包内」判据（#733 宪法第 3 条）。
 *
 * 缺陷形态（dsh-notifier 实证）：声明合并若写在**源 `.d.ts`**（曾经
 * `packages/dsh-notifier/src/service.d.ts`），tsc 的 include 只把它当声明输入、
 * 不 emit，产物 `lib/` 里既没有该文件、`lib/index.d.ts` 也不引用它。消费方
 * （其他 hub 插件）按包名导入时 `ctx['wingsky.notifier']` 与
 * `ctx.on('wingsky-notify/sent', ...)` 双双失类型，而**任何既有门禁都看不见**：
 * 导出面快照只比对导出符号集与「导出符号」的定义块，孤立声明文件两者都不进。
 *
 * 判据（对「合并写在哪」免疫、对「可达性」敏感）：包**对外提供 cordis 服务**
 * （产物内经 `ctx.provide("<名>", ...)` 注册，或源面已声明合并）⇒ 从 tarball 的
 * `lib/index.d.ts` 出发、沿相对说明符递归得到的 `.d.ts` 闭包内必须至少命中一次
 * `declare module "@deepseek-ai/cordis"`。
 *
 * 适用性为什么取**双信号并集**：单看「源面有没有写合并」有个退化方向——把合并
 * 整块删掉后判据变成「不适用」而假绿（正是本判据要防的静默失效）。产物侧的
 * `ctx.provide` 是运行时事实，删除合并不会让它消失，故并集对「合并写错地方」
 * 与「合并被删掉」两个方向都 fail-closed。反之，单看产物侧则会漏掉「写了合并
 * 但没 provide」的形态，故取并集而非二选一。
 *
 * 为什么是**闭包**而不是「index.d.ts 内直接出现」：合并可以合法地落在被
 * `index.d.ts` re-export 的域文件里——`dsh-mcp-manager` 的合并物理在
 * `lib/integration/service.d.ts`，经 `lib/integration/interface.d.ts` 的
 * re-export 可达，消费方程序内同样生效。只判「直接出现」会把这种正确形态误判为红。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** 合并的目标模块：本仓消费方依赖的宿主类型面（cordis 服务/事件声明合并）。 */
export const CORDIS_MODULE = '@deepseek-ai/cordis'

const MERGE_RE = new RegExp(`declare\\s+module\\s+["']${CORDIS_MODULE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']`, 'u')
// 相对说明符的三种写法：`from "./x.js"`、`import("./x.js")`、副作用 `import "./x.js"`。
const REL_SPEC_RE = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/gu

/**
 * 递归枚举目录下全部 `.ts` / `.tsx` 文件（含 `.d.ts`）。
 * @param {string} dir 起始目录
 * @returns {string[]} 绝对路径列表（目录不存在时为空）
 */
function collectTsFiles(dir) {
  const out = []
  const visit = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name)
      if (entry.isDirectory()) { visit(abs); continue }
      if (/\.tsx?$/u.test(entry.name)) out.push(abs)
    }
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) visit(dir)
  return out
}

/**
 * 源面判据：`src/` 下是否存在 cordis 声明合并（写在 `.ts` 或源 `.d.ts` 都算）。
 * 返回命中的源文件绝对路径（空数组 = 本包不声明合并，判据不适用）。
 * @param {string} srcDir 包源码目录
 * @returns {string[]} 命中文件列表
 */
export function srcDeclaresCordisMerge(srcDir) {
  return collectTsFiles(srcDir).filter((f) => MERGE_RE.test(readFileSync(f, 'utf8')))
}

/**
 * 把相对说明符解析为候选声明文件（只认 `.d.ts`——本判据走的是声明闭包）。
 * @param {string} fromFile 引用方文件
 * @param {string} spec 相对说明符
 * @returns {string[]} 候选绝对路径（按优先级）
 */
function dtsCandidates(fromFile, spec) {
  const base = join(dirname(fromFile), spec)
  if (base.endsWith('.d.ts')) return [base]
  const out = []
  const stem = base.replace(/\.(?:js|mjs|cjs|jsx|ts|tsx)$/u, '')
  if (stem !== base) out.push(`${stem}.d.ts`)
  out.push(`${base}.d.ts`, join(base, 'index.d.ts'))
  return out
}

/**
 * 从入口声明文件出发，沿相对说明符递归收集 `.d.ts` 闭包。
 * 只跟相对引用（裸包名不展开）；目标不存在即跳过——「闭包」是包内可达性，
 * 不要求每个相对引用都在 tarball 内可解析。
 * @param {string} entryDts 入口声明文件（`lib/index.d.ts`）
 * @returns {string[]} 闭包内文件绝对路径（含入口自身）
 */
export function collectDtsClosure(entryDts) {
  const seen = new Set()
  const stack = [entryDts]
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(REL_SPEC_RE)) {
      for (const cand of dtsCandidates(file, m[1])) {
        if (existsSync(cand)) { stack.push(cand); break }
      }
    }
  }
  return [...seen]
}

/**
 * 闭包内是否命中 cordis 声明合并。
 * @param {string} entryDts 入口声明文件
 * @returns {{ hit: boolean, files: string[] }} hit 与命中的声明文件列表
 */
export function closureDeclaresCordisMerge(entryDts) {
  const files = collectDtsClosure(entryDts).filter((f) => MERGE_RE.test(readFileSync(f, 'utf8')))
  return { hit: files.length > 0, files }
}

/**
 * 产物面判据：`lib/index.js` 是否经 `ctx.provide("<名>", ...)` 注册了 cordis 服务。
 * 只认字面量服务名（动态拼接的名字无法判定，宁可漏认也不误认）。
 * @param {string} libIndexJs 产物入口（tarball 内 `lib/index.js`）
 * @returns {string[]} 注册的服务名列表（空 = 未注册服务）
 */
export function detectCordisServiceProvide(libIndexJs) {
  if (!existsSync(libIndexJs)) return []
  const text = readFileSync(libIndexJs, 'utf8')
  return [...text.matchAll(/\.provide\(\s*["'`]([^"'`\n]+)["'`]/gu)].map((m) => m[1])
}

/**
 * 包级判据：包对外提供 cordis 服务 ⇒ 产物声明闭包内必须可达合并。
 * @param {string} pkgDir 包根（仓库内 `packages/<name>`，用于扫 src/）
 * @param {string} libDir tarball 解包后的 `lib/`（用于扫产物声明闭包与 provide 事实）
 * @returns {{ applicable: boolean, problem: string | null, detail: string }} applicable=false 表示本包不提供 cordis 服务（不适用）
 */
export function checkCordisMergeReachability(pkgDir, libDir) {
  const rel = (f) => relative(pkgDir, f).split(sep).join('/')
  const srcHits = srcDeclaresCordisMerge(join(pkgDir, 'src'))
  const provided = detectCordisServiceProvide(join(libDir, 'index.js'))
  if (srcHits.length === 0 && provided.length === 0) {
    return { applicable: false, problem: null, detail: 'src 未声明 cordis 合并、产物未注册 cordis 服务（不适用）' }
  }
  const why = []
  if (provided.length > 0) why.push(`产物经 ctx.provide 注册服务（${provided.join(', ')}）`)
  if (srcHits.length > 0) why.push(`src 内含 declare module "${CORDIS_MODULE}"（${srcHits.map(rel).join(', ')}）`)
  const entry = join(libDir, 'index.d.ts')
  if (!existsSync(entry)) {
    return { applicable: true, problem: `缺 lib/index.d.ts（${why.join('；')}，声明合并无法随包发布）`, detail: entry }
  }
  const { hit } = closureDeclaresCordisMerge(entry)
  if (hit) {
    return { applicable: true, problem: null, detail: '声明合并可达（lib/index.d.ts 相对 import 闭包内命中）' }
  }
  return {
    applicable: true,
    problem: `声明合并不可达：${why.join('；')}，但 lib/index.d.ts 的相对 import 闭包内零命中`
      + '（消费方按包名导入时 ctx 服务合并与 Events 事件合并全部失类型；把合并写进包入口 .ts，或让入口 re-export 承载它的域文件）',
    detail: entry,
  }
}
