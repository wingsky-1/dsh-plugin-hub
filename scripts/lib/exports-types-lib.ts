#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * exports-types-lib — `package.json` 的 `exports[].types` → 产物相对路径 映射（单一实现）。
 *
 * 两个判据共用本文件（§9 禁止双轨），但**判的是不同产物**——这是刻意的分工，不是重复：
 *  1. pack-check：**tarball（发布物）**内每个带 `types` 条件的子路径，其 `types` 所指
 *     文件必须真实存在。实证缺陷：`./client` 的 types 写成 `./lib/client.d.ts`，而实际
 *     产出是 `lib/client/index.d.ts` —— 严格 TS 消费方按包名子路径导入时静默降级为
 *     `any`（TS7016），而 pack-check / contract-check 都看不见（后者只断言
 *     `exports['./client']` 键存在）。**该缺陷实测存在于全部 5 个有客户端的包**
 *     （dsh-notifier / dsh-lan-proxy / dsh-mcp-manager / dsh-provider-usage /
 *     dsh-web-file-preview），故判据面对全部包生效、不留切片。
 *  2. export-surface-snapshot：**tsc emit 产物**内的入口归属，用同一映射把子路径挂到
 *     对应 `.d.ts` 上（门禁自跑 `tsc --declaration`，与是否已 build 无关）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 发布物内产物目录前缀（`exports[].types` 的约定根）。 */
export const LIB_PREFIX = './lib/'

/**
 * 读取 package.json 的 exports 中「带 types 条件」的子路径条目。
 * 显式排除 `./package.json` 这类无 `types` 的子路径（字符串形态同样排除）。
 * @param {string} pkgRoot 包根目录（解包后的 tarball 根，或 `packages/<name>`）
 * @returns {{ subpath: string, types: string }[]} 按子路径字典序（判定面顺序稳定）
 */
export function listExportTypesEntries(pkgRoot) {
  const pkgJsonPath = join(pkgRoot, 'package.json')
  if (!existsSync(pkgJsonPath)) throw new Error(`package.json 不存在：${pkgJsonPath}`)
  const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const exportsField = parsed.exports
  if (exportsField === undefined) return []
  // fail-loud：不认识的 exports 形态不得静默退化为「零子路径 = 全合规」
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    throw new Error(`${pkgJsonPath} 的 exports 不是对象形态，无法解析子路径 types`)
  }
  const entries = []
  for (const [subpath, value] of Object.entries(exportsField)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (typeof value.types !== 'string') continue
    entries.push({ subpath, types: value.types })
  }
  entries.sort((a, b) => (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0))
  return entries
}

/**
 * `types` 字段 → 相对产物根的路径（`./lib/client/index.d.ts` → `client/index.d.ts`）。
 * @param {string} typesField
 * @returns {string|null} 相对路径；不以 `./lib/` 开头（含空尾段）返回 null —— 调用方判红，
 *   不静默丢弃。
 */
export function stripLibPrefix(typesField) {
  if (typeof typesField !== 'string' || !typesField.startsWith(LIB_PREFIX)) return null
  const rel = typesField.slice(LIB_PREFIX.length)
  return rel.length === 0 ? null : rel
}

/**
 * tarball（发布物）判据：每个带 types 条件的子路径，其 types 所指文件必须存在于包内。
 * @param {string} pkgRoot 解包后的 tarball 根目录
 * @returns {string[]} 违规描述列表（空 = 合规）
 */
export function checkExportTypesResolvable(pkgRoot) {
  const problems = []
  for (const { subpath, types } of listExportTypesEntries(pkgRoot)) {
    if (existsSync(join(pkgRoot, types))) continue
    const rel = stripLibPrefix(types)
    problems.push(
      rel === null
        ? `exports["${subpath}"].types 不在 ${LIB_PREFIX} 下（无法定位产物）：${types}`
        : `exports["${subpath}"].types 指向不存在的文件：${types}`,
    )
  }
  return problems
}
