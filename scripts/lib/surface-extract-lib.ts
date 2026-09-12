#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * surface-extract-lib — 包导出面提取与入口归属（单一实现）。
 *
 * 抽取动机（#733 M2c 后续 N0(B)）：这两段提取器原先内联在
 * scripts/gate/export-surface-snapshot.mjs 里，fixture 无法直接断言；更关键的是
 * 调用侧 `declMapFor` 用 `Map.set(name, block)` 让**同名多块只留排序末块**——
 * 包入口 `apply`（宿主）与 `./client` 的 `apply` 同名时，改宿主 apply 签名红不了
 * （被比对的成了客户端块），改客户端块才红（归属错误）。按入口归属后，两边各归
 * 各入口比对。
 *
 * 口径（门禁自述与 docs/DEVELOPMENT.md 同步）：本文件只做「文本 → 符号/块」与
 * 「文件 → 入口」两件可判的事，不做判红决策——判红与文案留在门禁，测试可对同一
 * 实现做正反 fixture。
 */

/**
 * 提取顶层导出符号集（d.ts 产物形态：re-export 块 + declare 声明）。
 * @param {string} text
 * @returns {{ name: string, isType: boolean }[]} 按名字字典序、同名去重
 */
export function extractExports(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
  const out = []
  // export { A, B as C } from "./x.js"; 与 export type { ... } from ...
  const blockRe = /export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*"[^"]*")?;/gu
  for (const m of noComments.matchAll(blockRe)) {
    const isType = m[1] !== undefined
    for (const raw of m[2].split(',')) {
      const name = raw.trim()
      if (name.length === 0) continue
      const asIdx = name.indexOf(' as ')
      out.push({ name: (asIdx >= 0 ? name.slice(asIdx + 4) : name).trim(), isType })
    }
  }
  // export declare const/function/interface/class/type/enum Name（含 `const enum`：
  // 可选前缀必须回溯，否则 `const enum E` 会被读成 kind=const、名字="enum"）
  const declRe = /export\s+declare\s+(?:type\s+)?(?:abstract\s+)?(?:const\s+)?(const|function|interface|class|type|enum)\s+([A-Za-z_$][\w$]*)/gu
  for (const m of noComments.matchAll(declRe)) {
    const isType = m[1] === 'interface' || m[1] === 'type' || m[1] === 'enum'
    out.push({ name: m[2], isType })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  // 同名字符串去重（值与类型同名共存的形态罕见，快照内保留首见）
  const seen = new Set()
  return out.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
}

/**
 * 提取单个 d.ts 文本的全部顶层 `export declare ...` 声明块（含多行 interface/class，
 * 空白归一化为单行）。排序只影响块数组顺序，**不丢重复块**（多重集语义）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractDeclBlocks(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
  const blocks = []
  for (let i = 0; i < noComments.length; i += 1) {
    if (!noComments.startsWith('export declare', i)) continue
    // 声明起点：从 export declare 之后扫描到块结束（; 或匹配的 }）
    let j = i + 'export declare'.length
    let depth = 0
    for (; j < noComments.length; j += 1) {
      const ch = noComments[j]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          j += 1
          if (noComments[j] === ';') j += 1
          break
        }
      } else if (ch === ';' && depth === 0) {
        j += 1
        break
      }
    }
    blocks.push(noComments.slice(i, j).replace(/\s+/gu, ' ').trim())
    i = j - 1
  }
  blocks.sort()
  return blocks
}

/** 声明块的声明名（`export declare function apply(...)` → `apply`）；非声明块返回 null。 */
export function declBlockName(block) {
  const m = /^export declare (?:type |abstract )?(?:const )?(?:enum|const|function|interface|class|type) ([A-Za-z_$][\w$]*)/u.exec(block)
  return m === null ? null : m[1]
}

/**
 * 入口归属：每个 emit 相对路径按**最长前缀**归属到唯一入口。
 *
 * 前缀语义：入口 e 的 prefix = typesTarget(e) 的 dirname（根入口 → ""）。文件 f 匹配
 * prefix p 当且仅当 p === "" 或 f 以 `${p}/` 开头。**取最长命中**——`client/index.d.ts`
 * 同时命中 "" 与 "client"，归 `./client`；这正是 F-1（`extractExports` 只读 index.d.ts
 * 导致 `./client` 入口零判据）的修复点。
 *
 * @param {string[]} files emit 产物内全部 .d.ts 的相对路径（POSIX 分隔）
 * @param {{ subpath: string, prefix: string }[]} entries
 * @returns {{ byEntry: Record<string, string[]>, orphans: string[], conflicts: string[] }}
 *   orphans = 未被任何 prefix 归属的文件（调用方判红，不得静默丢弃）；
 *   conflicts = 同长度多命中的文件（前缀歧义，归属不唯一 ⇒ 调用方判红）。
 */
export function attributeEmitFiles(files, entries) {
  const byEntry = {}
  for (const e of entries) byEntry[e.subpath] = []
  const orphans = []
  const conflicts = []
  for (const file of files) {
    let best = -1
    const matched = []
    for (const e of entries) {
      const hit = e.prefix === '' || file.startsWith(`${e.prefix}/`)
      if (!hit) continue
      if (e.prefix.length > best) {
        best = e.prefix.length
        matched.length = 0
        matched.push(e)
      } else if (e.prefix.length === best) {
        matched.push(e)
      }
    }
    if (matched.length === 0) {
      orphans.push(file)
    } else if (matched.length > 1) {
      conflicts.push(`${file}（命中 ${matched.map((e) => `${e.subpath} 前缀 "${e.prefix}"`).join('、')}）`)
    } else {
      byEntry[matched[0].subpath].push(file)
    }
  }
  for (const subpath of Object.keys(byEntry)) byEntry[subpath].sort()
  orphans.sort()
  conflicts.sort()
  return { byEntry, orphans, conflicts }
}
