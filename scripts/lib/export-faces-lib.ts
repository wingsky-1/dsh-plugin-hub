#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * export-faces-lib — 包导出面「分类登记」准入判据（#733 宪法第 3 条 / M2-3.5）。
 *
 * 目的：导出面快照门禁只能证明「符号集与基线一致」，回答不了「这个新符号凭什么是
 * 公共契约」。本判据把「新增导出必须落进三类面之一并显式登记」变成机器可判的准入
 * 条件：**包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面**。
 *
 * 同源（§9 禁止双轨）：符号集来自 export-surface-snapshot.mjs 的同一次
 * `emitDeclarations()` 产物，不另起第二套抽取；执法点也在同一个脚本、同一条既有 CI
 * 步骤（contract-check spawn 的 export-surface-snapshot），不新增 workflow。
 *
 * 存量口径：`legacy` 是 M2a 时点的 100 个存量符号白名单——存量分类（保留 / 移除清单）
 * 是 M2b 的一等交付物，本阶段不预判、不抢跑。新增符号**没有** legacy 通道：只能进
 * `faces` 并显式选择三类面之一，否则判红。把新符号塞进 `legacy` 同样能绕过本判据，
 * 但那是一次显眼且可评审的登记文件改动——本判据的价值是让「静默增长」不可能，而不是
 * 防止人为改写登记文件（任何登记制都做不到后者，如实写明胜过过度声称）。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 三类面（#733 宪法第 3 条：包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面）。 */
export const EXPORT_FACES = ['安装面', '配置面', '契约面']

/**
 * 读取分类登记文件（缺失即抛——登记文件是判据的输入，不能静默降级为「无约束」）。
 * @param {string} path 登记文件路径
 * @returns {{ package?: string, faces: Record<string, string>, legacy: string[] }}
 */
export function loadExportFaces(path) {
  if (!existsSync(path)) throw new Error(`导出面分类登记文件不存在：${path}`)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return {
    package: parsed.package,
    faces: parsed.faces && typeof parsed.faces === 'object' ? parsed.faces : {},
    legacy: Array.isArray(parsed.legacy) ? parsed.legacy : [],
  }
}

/**
 * 准入判据：每个导出符号必须已分类登记（faces）或属存量白名单（legacy）。
 * @param {{ exports: string[], faces: Record<string, string>, legacy: string[], registryPath?: string }} input
 * @returns {string[]} 违规描述列表（空 = 合规）
 */
export function checkExportFaces(input) {
  const { exports: exportNames, faces, legacy, registryPath = 'scripts/data/<pkg>-export-faces.json' } = input
  const problems = []
  const exportSet = new Set(exportNames)
  const legacySet = new Set(legacy)

  if (legacySet.size !== legacy.length) problems.push('legacy 含重复项')
  if (legacy.length === 0 && Object.keys(faces).length === 0) {
    problems.push('登记文件既无 faces 也无 legacy——判据退化为「无约束」，拒绝放行')
  }
  for (const name of legacy) {
    if (!exportSet.has(name)) problems.push(`legacy 含已不存在的导出符号：${name}（符号退役后须一并从 legacy 移除）`)
  }
  for (const [name, face] of Object.entries(faces)) {
    if (!EXPORT_FACES.includes(face)) {
      problems.push(`faces["${name}"] 的分类「${face}」不在三类面内（合法值：${EXPORT_FACES.join(' / ')}）`)
    }
    if (legacySet.has(name)) problems.push(`符号 ${name} 同时登记在 faces 与 legacy（二者互斥）`)
    if (!exportSet.has(name)) problems.push(`faces 含已不存在的导出符号：${name}`)
  }
  for (const name of exportNames) {
    if (faces[name] === undefined && !legacySet.has(name)) {
      problems.push(`新增导出未分类登记：${name}（必须落进 ${EXPORT_FACES.join(' / ')} 之一，写进 ${registryPath} 的 faces）`)
    }
  }
  return problems
}
