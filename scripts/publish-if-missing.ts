#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * publish-if-missing — 幂等发布清单：对每个包检查 npm registry 是否已存在
 * name@version，输出「缺失（待发布）」的包名列表（每行一个，stdout）。
 *
 * 用法：node scripts/publish-if-missing.ts
 *   stdout：待发布包名（依赖序：子包在前、聚合包最后）
 *   stderr：跳过/待发日志（供 CI 观测）
 *   退出码：0（registry 查询失败除外）
 *
 * 用途：release.yml 的 publish 步骤用它做幂等保护——重跑/重复触发 tag 时，
 * 已发布的版本自动跳过，不会因「npm 版本已存在」而失败。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(ROOT, 'packages')

const pkgs = readdirSync(packagesDir)
  .filter((d) => d.startsWith('dsh-'))
  .map((d) => JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8')))
  .filter((p) => !p.private)

// 依赖序：聚合包（dsh-plugins-all）依赖全部子包 → 子包在前、聚合包最后
const isAgg = (p) => p.name.includes('dsh-plugins-all')
const ordered = [...pkgs.filter((p) => !isAgg(p)), ...pkgs.filter(isAgg)]

const missing = []
for (const p of ordered) {
  try {
    execFileSync('npm', ['view', `${p.name}@${p.version}`, 'version'], { stdio: 'pipe' })
    console.error(`[publish-if-missing] 已存在，跳过: ${p.name}@${p.version}`)
  } catch {
    missing.push(p.name)
    console.error(`[publish-if-missing] 待发布: ${p.name}@${p.version}`)
  }
}
console.log(missing.join('\n'))
