#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-version — 发布门禁：校验每个包的 version 与当前 git tag（vX.Y.Z）一致。
 * tag 是版本唯一来源（与 dsh-web-ui 同策略）。CI release.yml 在发布前执行。
 *
 * 用法：node scripts/verify-version.mjs
 * 退出码：0 = 全部一致；1 = 存在不一致或非 tag 环境（CI 中由 release.yml 保证是 tag push）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function tagVersion() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim()
    return tag.startsWith('v') ? tag.slice(1) : tag
  } catch {
    return null
  }
}

function collectPackages() {
  const pkgs = []
  const packagesDir = join(ROOT, 'packages')
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgJson = join(packagesDir, entry.name, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
      if (pkg.private) continue
      pkgs.push({ dir: entry.name, name: pkg.name, version: pkg.version })
    } catch {
      // 目录无 package.json（如 .gitkeep 占位）→ 跳过
    }
  }
  return pkgs
}

const expected = tagVersion()
if (!expected) {
  console.error('[verify-version] 非 tag 环境（git describe 失败）——CI 中仅 tag push 触发')
  process.exit(1)
}

const pkgs = collectPackages()
let failed = 0
for (const p of pkgs) {
  const ok = p.version === expected
  console.log(`${ok ? 'OK ' : 'FAIL'} ${p.name.padEnd(38)} ${p.version}${ok ? '' : `（期望 ${expected}）`}`)
  if (!ok) failed++
}

if (pkgs.length === 0) {
  console.error('[verify-version] 未发现任何非 private 包（插件尚未迁入）')
  process.exit(1)
}
console.log(failed === 0 ? `\n[verify-version] ${pkgs.length} 个包版本全部一致（v${expected}）` : `\n[verify-version] ${failed} 个包不一致`)
process.exit(failed === 0 ? 0 : 1)
