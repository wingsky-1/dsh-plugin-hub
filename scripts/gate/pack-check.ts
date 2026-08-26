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
import { executeClient } from '../lib/client-contract-lib.ts'
import { extractInlinedPackages, readMermaidChunkRefs } from '../build/collect-licenses.ts'
import { AGGREGATE_NAME, checkAggregateConsistency, listPluginDirs, loadManifest, warnUnknownEntries } from '../lib/plugins-manifest-lib.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 插件清单单一来源（issue #36）：枚举走 lib，目录集 == manifest.active ∪ standalone 前置闸
warnUnknownEntries(ROOT)
let manifest
try {
  manifest = loadManifest(ROOT)
} catch (e) {
  console.log(`FAIL plugins-manifest | ${e.message}`)
  process.exit(1)
}
{
  const problems = checkAggregateConsistency({ dirNames: listPluginDirs(ROOT), manifest })
  if (problems.length > 0) {
    for (const p of problems) console.log(`FAIL plugins-manifest | ${p}`)
    process.exit(1)
  }
  console.log('PASS plugins-manifest | 目录集 == manifest.active ∪ standalone 集')
}
const plugins = listPluginDirs(ROOT)

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
    // loopback 围栏断言跟随 HTTP 面存在性：产物注入 webServer（有 RPC/路由面）
    // 才要求 isLoopbackRequest；纯事件面插件（无 webServer，如 #153 模型继承器）
    // 无 HTTP 面，围栏不适用。
    if (idx.includes('webServer') && !idx.includes('isLoopbackRequest')) problems.push('内联后缺 isLoopbackRequest 导出')

    // 第三方 license 归集断言（issue #13）：产物内联了第三方库（esbuild 模块
    // 注释可证）⇒ 必须随包附 lib/THIRD-PARTY-LICENSES——存在、非空、含宽松系
    // 许可字样（MIT/BSD/Apache/ISC，issue #104 补 ISC：mermaid 传递依赖 d3 系
    // 多为 ISC），且覆盖每个被内联的包名。内联 = 分发库副本，
    // 缺清单即合规缺口，fail-loud。
    {
      const inlined = new Set(extractInlinedPackages(idx))
      // client.js 维持注释提取；client-mermaid.js（issue #104）minified 产物注释
      // 已被移除，其内联证据来自构建期 metafile sidecar 清单 client-mermaid.deps.json。
      const clientJsPath = join(pkgRoot, 'lib', 'client.js')
      if (existsSync(clientJsPath)) {
        for (const n of extractInlinedPackages(readFileSync(clientJsPath, 'utf8'))) inlined.add(n)
      }
      const chunkPath = join(pkgRoot, 'lib', 'client-mermaid.js')
      if (existsSync(chunkPath)) {
        // chunk 在而清单缺 = 构建链断链或发布物裁剪 → 覆盖断言会静默失效，fail-loud。
        try {
          for (const r of readMermaidChunkRefs(join(pkgRoot, 'lib'))) inlined.add(r.name)
        } catch (e) {
          problems.push(`client-mermaid.deps.json 校验失败: ${String(e.message).split('\n')[0]}`)
        }
        if (!existsSync(join(pkgRoot, 'lib', 'client-mermaid.deps.json'))) {
          problems.push('存在 lib/client-mermaid.js 但缺 client-mermaid.deps.json（内联清单 sidecar）')
        }
      }
      if (inlined.size > 0) {
        const licPath = join(pkgRoot, 'lib', 'THIRD-PARTY-LICENSES')
        if (!existsSync(licPath)) {
          problems.push(`产物内联第三方库（${[...inlined].join(', ')}）但缺 lib/THIRD-PARTY-LICENSES`)
        } else {
          const lic = readFileSync(licPath, 'utf8')
          if (!lic.trim()) problems.push('THIRD-PARTY-LICENSES 为空')
          if (!/(MIT|BSD|Apache|ISC)/i.test(lic)) problems.push('THIRD-PARTY-LICENSES 缺 MIT/BSD/Apache/ISC 许可字样')
          for (const n of inlined) {
            if (!lic.includes(n)) problems.push(`THIRD-PARTY-LICENSES 未覆盖被内联库 ${n}`)
          }
        }
      }
    }

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
    // 聚合行/依赖与 manifest.active 双向相等（issue #36：deps「多」也会 fail-loud）
    if (patch) {
      const aggRows = [...patch.matchAll(/^\s*- id:\s*(\S+)/gm)].map(m => m[1])
      const deps = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).dependencies ?? {}
      problems.push(...checkAggregateConsistency({ dirNames: plugins, manifest, aggDeps: deps, aggPatchIds: aggRows }))
      if (/^\s*config:/m.test(patch)) problems.push('聚合行带 config（应走 schema 默认值）')
    }
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
