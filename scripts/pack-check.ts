#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * pack-check — 发布打包冒烟：pnpm pack 每个插件 → 解包校验 tarball 内容，
 * 防发布断链（含 lib/.d.ts/README/LICENSE、无 ../../shared 残留）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const idx = readFileSync(join(pkgRoot, 'lib', 'index.js'), 'utf8')
    // 只匹配 import 语句中的仓库外相对引用（esbuild 模块注释含路径文本，不算断链）
    const outsideRef = /(?:from|import)\s*["']\.\.\/\.\.\/(?:shared|types)/.test(idx)
    if (outsideRef) problems.push('lib 残留 ../../shared|types 运行时引用')
    if (!idx.includes('isLoopbackRequest')) problems.push('内联后缺 isLoopbackRequest 导出')

    if (problems.length > 0) failed++
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${name} | ${problems.join('; ') || 'tarball 完整'}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name} | ${String(e.message).split('\n')[0]}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log(failed === 0 ? '\npack-check：全部通过' : `\npack-check：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
