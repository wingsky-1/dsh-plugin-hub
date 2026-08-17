#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * pack-check — 发布打包冒烟：pnpm pack 每个插件 → 解包校验 tarball 内容，
 * 防发布断链（含 lib/.d.ts/README/LICENSE、无 ../../shared 残留、client id 契约、
 * 运行时资源完整性）。
 *
 * client 产物断言复用 scripts/client-contract-lib.ts（唯一 stub/执行实现）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeClient } from './client-contract-lib.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugins = readdirSync(join(ROOT, 'packages')).filter(d => d.startsWith('dsh-') && d !== 'dsh-plugins-all')

let failed = 0
for (const p of plugins) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const name = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8')).name
  try {
    // pnpm pack 到临时目录
    execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'pipe' })
    const tgz = readdirSync(tmp).find(f => f.endsWith('.tgz'))
    const unpack = join(tmp, 'unpack')
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    const pkgRoot = join(tmp, 'package')

    const problems = []
    if (!existsSync(join(pkgRoot, 'lib', 'index.js'))) problems.push('缺 lib/index.js')
    if (!readdirSync(join(pkgRoot, 'lib')).some(f => f.endsWith('.d.ts'))) problems.push('缺 lib/*.d.ts')
    for (const f of ['README.md', 'LICENSE', 'cordis.patch.yml']) {
      if (!existsSync(join(pkgRoot, f))) problems.push(`缺 ${f}`)
    }
    // shared 声明副本（bundle-host d.ts X1 递归复制，含子目录 host/）须随包发布
    if (!existsSync(join(pkgRoot, 'shared', 'host', 'plugin-skeleton.d.ts'))) {
      problems.push('缺 shared/host/plugin-skeleton.d.ts（shared 递归副本）')
    }
    const idx = readFileSync(join(pkgRoot, 'lib', 'index.js'), 'utf8')
    // 只匹配 import 语句中的仓库外相对引用（esbuild 模块注释含路径文本，不算断链）
    const outsideRef = /(?:from|import)\s*["']\.\.\/\.\.\/(?:shared|types)/.test(idx)
    if (outsideRef) problems.push('lib 残留 ../../shared|types 运行时引用')
    if (!idx.includes('isLoopbackRequest')) problems.push('内联后缺 isLoopbackRequest 导出')

    // client id 契约（tarball 内产物）：load id 必须 === 完整包名——浏览器 arrive()
    // 校验 factories.has(包名) 的同构模拟；防「打包/裁剪后产物与包名脱钩」再犯。
    // 执行与 stub 实现来自 client-contract-lib（与 contract-check 同源）。
    const clientPath = join(pkgRoot, 'lib', 'client.js')
    if (existsSync(clientPath)) {
      const { calls, factories, error } = executeClient(readFileSync(clientPath, 'utf8'))
      if (error) {
        problems.push(`client 产物执行失败: ${String(error.message).split('\n')[0]}`)
      } else if (!factories.has(name)) {
        problems.push(`client load id 与包名不一致（注册: ${[...factories.keys()].join(',') || '无'}，期望: ${name}）`)
      }
    }

    // 运行时资源完整性：src/ 下非代码资源（bundle-host 复制进 lib/，如 toast.ps1）
    // 必须随 tarball 发布——files 白名单规范化时最容易静默丢这类资源。
    const srcDir = join(ROOT, 'packages', p, 'src')
    if (existsSync(srcDir)) {
      const missingResources = readdirSync(srcDir)
        .filter((f) => !/\.(ts|tsx|js|mjs|cjs)$/.test(f))
        .filter((f) => !existsSync(join(pkgRoot, 'lib', f)))
      if (missingResources.length > 0) problems.push(`运行时资源未随包发布: ${missingResources.join(', ')}`)
    }

    if (problems.length > 0) failed++
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${name} | ${problems.join('; ') || 'tarball 完整'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name} | ${String(e.message).split('\n')[0]}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
// 聚合包专项：dsh-plugins-all tarball 完整性 + 聚合 patch 与子包一致（防 P6 复发）
{
  const AGG = 'dsh-plugins-all'
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pack-agg-'))
  const aggName = JSON.parse(readFileSync(join(ROOT, 'packages', AGG, 'package.json'), 'utf8')).name
  try {
    execFileSync('pnpm', ['--filter', aggName, 'pack', '--pack-destination', tmp], { cwd: ROOT, stdio: 'pipe' })
    const tgz = readdirSync(tmp).find(f => f.endsWith('.tgz'))
    execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    const pkgRoot = join(tmp, 'package')
    const problems = []
    if (!existsSync(join(pkgRoot, 'lib', 'index.js'))) problems.push('缺 lib/index.js')
    const patch = existsSync(join(pkgRoot, 'cordis.patch.yml')) ? readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8') : ''
    if (!patch) problems.push('缺 cordis.patch.yml')
    // 聚合行 id 必须与对应子包 patch id 一致（且无 config）
    if (patch) {
      const aggRows = [...patch.matchAll(/^\s*- id:\s*(\S+)/gm)].map(m => m[1])
      for (const pd of plugins) {
        if (!aggRows.includes(`ui-${pd}`)) problems.push(`聚合行缺 ui-${pd}（与子包 id 不一致）`)
      }
      if (aggRows.length !== plugins.length) problems.push(`聚合行数 ${aggRows.length} != 子包数 ${plugins.length}`)
      if (/^\s*config:/m.test(patch)) problems.push('聚合行带 config（应走 schema 默认值）')
    }
    // dependencies 完整（开发态为 workspace:*；发布时替换为版本——存在即认可）
    const deps = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).dependencies ?? {}
    for (const pd of plugins) if (!deps[`@wingsky-1/${pd}`]) problems.push(`依赖缺 @wingsky-1/${pd}`)
    if (problems.length > 0) failed++
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${aggName} | ${problems.join('; ') || '聚合 tarball 完整且与子包一致'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${aggName} | ${String(e.message).split('\n')[0]}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log(failed === 0 ? '\npack-check：全部通过' : `\npack-check：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
