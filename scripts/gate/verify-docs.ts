#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-docs — 文档一致性轻量门禁（EPLAN F-4，web-ui verify-docs 的简化版）。
 *
 * 检查：
 *   1. 每包 README.md 存在；
 *   2. Markdown 相对链接目标存在（判于当前文件目录）；
 *   3. package.json 的 description 无脚手架占位符（__NAME__ 等）；
 *   4. README.en.md 配对：若存在则其同级相对链接也有效（中英配对校验）；
 *      存在性与标题镜像由 README.en 补全后收紧（当前阶段可缺——用 --strict-en
 *      强制）。
 *
 * 砍掉的 web-ui 重型项：词数预算、i18n 结构签名镜像、语言切换行、锚点存在性
 * （本仓 README 规模小，不引入预算与签名镜像）。
 *
 * 用法：node scripts/verify-docs.ts [--strict-en]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STRICT_EN = process.argv.includes('--strict-en')
const failures = []

const isRelLink = (t) => /^\.{1,2}\//.test(t)
// 提取 markdown 中的相对链接目标（[t](target) 与 [t]: target 引用）
function relLinks(md) {
  const out = []
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(m[1])
  for (const m of md.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1])
  return out.filter(isRelLink).filter((t) => !/#/.test(t)) // 锚点链接跳过
}

function checkPkg(pkgDir) {
  const name = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name
  const readme = join(pkgDir, 'README.md')
  if (!existsSync(readme)) {
    failures.push(`${name}: 缺 README.md`)
    return
  }
  const md = readFileSync(readme, 'utf8')
  // 相对链接目标存在
  for (const target of relLinks(md)) {
    const abs = join(dirname(readme), decodeURIComponent(target.split('#')[0]))
    if (!existsSync(abs)) failures.push(`${name}: README 相对链接目标缺失 ${target}`)
  }
  // README.en.md 配对
  const en = join(pkgDir, 'README.en.md')
  if (existsSync(en)) {
    const emd = readFileSync(en, 'utf8')
    for (const target of relLinks(emd)) {
      const abs = join(dirname(en), decodeURIComponent(target.split('#')[0]))
      if (!existsSync(abs)) failures.push(`${name}: README.en 相对链接目标缺失 ${target}`)
    }
  } else if (STRICT_EN) {
    failures.push(`${name}: 缺 README.en.md（--strict-en）`)
  }
  // description 无脚手架占位符
  const desc = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).description ?? ''
  if (/__NAME__|__PLUGIN__|<name>|TODO/.test(desc)) failures.push(`${name}: description 含脚手架占位符`)

  return name
}

const pkgs = readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('dsh-')).sort()
let checked = 0
for (const p of pkgs) {
  const name = checkPkg(join(ROOT, 'packages', p))
  if (name) checked++
}
// 根 README
for (const f of ['README.md']) {
  if (!existsSync(join(ROOT, f))) failures.push(`根缺 ${f}`)
}

const ok = failures.length === 0
console.log(`verify-docs：检查 ${checked} 个包 + 根 README`)
if (!ok) { for (const f of failures) console.error(`  ✘ ${f}`) }
console.log(ok ? '文档一致性：通过' : `文档一致性：${failures.length} 个问题`)
process.exit(ok ? 0 : 1)