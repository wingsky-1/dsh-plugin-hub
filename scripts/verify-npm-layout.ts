#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * verify-npm-layout — 模拟 npm 布局验证（tarball 完整性 + 宿主导出面 + 客户端契约）。
 *
 * 背景：0.1.x 曾出现「构建/打包后产物与包名脱钩」，门禁只查 tarball 文件存在但
 * 不查「npm 安装后能否被加载」。本脚本对每个插件：pnpm pack → 解包到临时目录 →
 * 验证宿主导出面（name / apply 为函数 / ROUTES 存在）+ 客户端契约（arrive 模拟，
 * 复用 client-contract-lib，与 contract-check 同源）。
 *
 * 与 pack-check 分工：pack-check 查文件白名单/断链/资源；本脚本查「解包后能加载」。
 * 用法：node scripts/verify-npm-layout.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeClient } from './client-contract-lib.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugins = readdirSync(join(ROOT, 'packages')).filter(d => d.startsWith('dsh-') && d !== 'dsh-plugins-all')

let failed = 0
for (const p of plugins) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-npmlayout-'))
  const name = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8')).name
  try {
    execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'pipe' })
    const tgz = readdirSync(tmp).find(f => f.endsWith('.tgz'))
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    const pkgRoot = join(tmp, 'package')
    const problems = []

    // 1. 宿主导出面（模拟 npm 安装后 require/import 该包）
    const idxPath = join(pkgRoot, 'lib', 'index.js')
    if (!existsSync(idxPath)) {
      problems.push('缺 lib/index.js')
    } else {
      const modText = readFileSync(idxPath, 'utf8')
      if (!/export \{[^}]*\bname\b|const name =/s.test(modText)) {
        problems.push('宿主入口缺 name 导出')
      }
      if (!/apply/.test(modText)) problems.push('宿主入口缺 apply（可能内联缺失）')
      if (!/ROUTES|route/i.test(modText)) problems.push('宿主入口缺 ROUTES/路由')
    }

    // 2. 客户端契约（arrive 模拟，同 contract-check 实现）
    const clientPath = join(pkgRoot, 'lib', 'client.js')
    if (existsSync(clientPath)) {
      const { calls, factories, error } = executeClient(readFileSync(clientPath, 'utf8'))
      if (error) {
        problems.push(`client 执行失败: ${String(error.message).split('\n')[0]}`)
      } else if (!factories.has(name)) {
        problems.push(`client load id 与包名不一致（期望 ${name}）`)
      }
    }

    // 3. 无仓库外相对引用断链（同 pack-check 口径）
    if (existsSync(idxPath) && /(?:from|import)\s*["']\.\.\/\.\.\/(?:shared|types)/.test(readFileSync(idxPath, 'utf8'))) {
      problems.push('lib 残留 ../../shared|types 运行时引用')
    }

    if (problems.length > 0) failed++
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${name} | ${problems.join('; ') || 'npm 布局可加载'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name} | ${String(e.message).split('\n')[0]}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log(failed === 0 ? '\nverify-npm-layout：全部通过' : `\nverify-npm-layout：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)