#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * catalog-peers-lib — catalog ↔ peer/devDeps 一致性校验（纯逻辑库，可单测）。
 *
 * 动机（#695）：官方类型层版本曾在 pnpm-workspace.yaml 的 catalog 与各包
 * peerDependencies 双写，一次 rc 升级要手改 20 处字面量，改漏无任何信号；
 * dsh-verify-isolated 的 peer 还一度游离于 catalog 之外。peer 统一走 catalog:
 * 后事实源收敛为 catalog 一处（pnpm pack 时替换回具体版本，发布物字节语义不变），
 * 本库把「收敛后不再漂移」变成机器约束。
 *
 * 零新增依赖：yaml 只解析本文件自用的两个顶层段（受限子集，非通用 YAML 解析器）。
 * 该文件由本仓独占维护，其格式受本门禁约束，故不做通用性兜底。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const OFFICIAL_SCOPE = '@deepseek-ai/'
const DEP_FIELDS = ['peerDependencies', 'devDependencies', 'dependencies']

/** 解析顶层 `catalog:` 段的 name → version。 */
export function parseCatalog(yamlText) {
  const catalog = new Map()
  let inSection = false
  for (const line of yamlText.split('\n')) {
    if (/^catalog:\s*$/.test(line)) {
      inSection = true
      continue
    }
    // 顶层键（非缩进行）终止当前段
    if (/^[A-Za-z]/.test(line)) inSection = false
    if (!inSection) continue
    const m = /^ {2}'([^']+)':\s*(\S+)\s*$/.exec(line)
    if (m) catalog.set(m[1], m[2])
  }
  return catalog
}

/** 解析顶层 `minimumReleaseAgeExclude:` 段的包名集（剥离 @version 后缀）。 */
export function parseReleaseExclude(yamlText) {
  const names = new Set()
  let inSection = false
  for (const line of yamlText.split('\n')) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
      inSection = true
      continue
    }
    if (/^[A-Za-z]/.test(line)) inSection = false
    if (!inSection) continue
    const m = /^ {2}- '([^']+)'\s*$/.exec(line)
    if (!m) continue
    const at = m[1].lastIndexOf('@')
    names.add(at > 0 ? m[1].slice(0, at) : m[1])
  }
  return names
}

/**
 * 全仓校验：官方包依赖声明必须走 catalog:，且 catalog: 引用必须有条目、
 * catalog 每个键都要在供应链豁免清单里登记。
 */
export function checkCatalogPeers(root) {
  const yamlText = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const catalog = parseCatalog(yamlText)
  const excluded = parseReleaseExclude(yamlText)
  const problems = []
  let officialPeerCount = 0

  const pkgDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort()

  for (const dir of pkgDirs) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    for (const field of DEP_FIELDS) {
      const deps = pkg[field]
      if (deps === undefined || deps === null || typeof deps !== 'object') continue
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith(OFFICIAL_SCOPE)) continue
        if (field === 'peerDependencies') officialPeerCount++
        if (spec !== 'catalog:') {
          problems.push(`${dir}: ${field}["${name}"] = "${spec}" —— 官方包一律写 catalog:`)
        } else if (!catalog.has(name)) {
          problems.push(`${dir}: ${field}["${name}"] 用了 catalog: 但 pnpm-workspace.yaml 无此 catalog 条目`)
        }
      }
    }
  }

  for (const name of catalog.keys()) {
    if (!excluded.has(name)) {
      problems.push(`catalog["${name}"] 未登记进 minimumReleaseAgeExclude（供应链豁免清单与事实源漂移）`)
    }
  }

  const lines = [
    `catalog ${catalog.size} 键 | 官方 peer ${officialPeerCount} 处 | 豁免清单 ${excluded.size} 条`,
  ]
  return { lines, problems, catalogSize: catalog.size, officialPeerCount }
}
