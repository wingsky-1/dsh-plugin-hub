#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * collect-licenses — 第三方 license 归集进发布物（issue #13，合规义务）。
 *
 * 背景：本仓「发布物自包含」——第三方依赖一律构建期由 esbuild 内联进产物，
 * 不以运行时 npm 依赖发布。内联在法律上等于分发该库副本，必须随发布物附
 * 其 license 文本与版权声明。
 *
 * 做法：扫描各包构建产物（lib/index.js / lib/client.js）中 esbuild 的
 * node_modules 模块注释——以真实打进产物的库为准，而非 package.json 清单；
 * 从安装目录读取其 LICENSE 文本，写入发布物 lib/THIRD-PARTY-LICENSES
 * （lib 已在各包 files 白名单内，零额外配置随包分发）。
 *
 * 排除 @deepseek-ai/*：宿主注入模型的宿主侧依赖（peer/inject），运行时由
 * dsh 宿主提供，不构成本包分发物。
 *
 * 用法：node scripts/collect-licenses.ts [packages/<目录> ...]
 *   - 无参数 = 处理全部插件包（plugins-manifest active 集）
 *   - bundle-host 构建链在每包构建完成后自动调用单包模式
 *
 * 门禁：pack-check 对 tarball 断言「有内联 ⇒ THIRD-PARTY-LICENSES 存在、
 * 非空、含 MIT/BSD/Apache 字样且覆盖每个被内联的包名」（见 pack-check.ts）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPluginDirs } from '../lib/plugins-manifest-lib.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 从 esbuild 产物源码提取被内联的第三方模块引用（去重，按包名排序）。
 *
 * esbuild bundle 会在每个模块前插入路径注释，如：
 *   // ../../node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket.js
 *   // ../..../node_modules/highlight.js/lib/core.js
 * 返回 { name, pnpmSeg } 列表：name 为真实包名；pnpmSeg 为 pnpm 布局下的
 * .pnpm 安装段（如 ".pnpm/ws@8.21.3/node_modules/ws"，供精确解析安装目录），
 * 非 pnpm 布局引用时为 null。
 */
export function extractInlinedModuleRefs(source) {
  const re = /node_modules\/((?:\.pnpm\/[^/\s]+\/node_modules\/)?)((?:@[\w.-]+\/)?[\w][\w.-]*)\//g
  const refs = new Map()
  for (const m of source.matchAll(re)) {
    const name = m[2]
    // 宿主注入模型：@deepseek-ai/* 运行时由 dsh 宿主提供（peer/inject），
    // 非本包分发物；其余 node_modules 引用即被内联分发的第三方库。
    if (name.startsWith('@deepseek-ai/')) continue
    if (!refs.has(name)) refs.set(name, m[1] ? m[1].replace(/\/$/, '') + '/' + name : null)
  }
  return [...refs.entries()]
    .map(([name, pnpmSeg]) => ({ name, pnpmSeg }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** extractInlinedModuleRefs 的纯包名视图（门禁断言用）。 */
export function extractInlinedPackages(source) {
  return extractInlinedModuleRefs(source).map(r => r.name)
}

/** 列出某包产物中被内联的第三方模块引用（index.js 与 client.js 并集，同名取首个含 pnpmSeg 者）。 */
export function inlinedRefsForLib(libDir) {
  const byName = new Map()
  for (const f of ['index.js', 'client.js']) {
    const p = join(libDir, f)
    if (!existsSync(p)) continue
    for (const r of extractInlinedModuleRefs(readFileSync(p, 'utf8'))) {
      if (!byName.has(r.name)) byName.set(r.name, r)
      else if (r.pnpmSeg && !byName.get(r.name).pnpmSeg) byName.set(r.name, r)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 在包安装目录内定位 license 文本文件（常见命名逐一尝试）。 */
function findLicenseFile(installDir) {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md', 'LICENSE.txt', 'LICENSE-MIT']
  for (const c of candidates) {
    const p = join(installDir, c)
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8').trim()
      if (text) return { file: c, text }
    }
  }
  return null
}

/** 读取安装目录 package.json 的 name/version/license 元信息（缺失容错）。 */
function pkgMeta(installDir) {
  try {
    const j = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
    return { version: j.version ?? '?', license: j.license ?? 'UNKNOWN' }
  } catch {
    return { version: '?', license: 'UNKNOWN' }
  }
}

/**
 * 为单个插件包归集第三方 license，写 lib/THIRD-PARTY-LICENSES。
 * pkgDir 相对 root 解析（仓库场景传 packages/<目录>）；root 缺省为仓库根
 * （测试注入临时仓库）。返回本次覆盖的被内联第三方包名列表（无内联则
 * 返回 [] 且不写文件）。
 */
export function collectForPackage(pkgDir, root = ROOT) {
  const absPkg = resolve(root, pkgDir)
  const libDir = join(absPkg, 'lib')
  if (!existsSync(libDir)) throw new Error(`${pkgDir}: 缺 lib/（先构建再归集）`)
  const refs = inlinedRefsForLib(libDir)
  if (refs.length === 0) return []

  const sections = []
  for (const { name, pnpmSeg } of refs) {
    // 解析真实安装目录，依次尝试：
    //   1) 包级 node_modules symlink（pnpm 布局直接依赖）
    //   2) 根 node_modules（提升安装）
    //   3) .pnpm 安装段（传递依赖，如 diff2html 的 hogan/diff 不出现在前两级）
    const candidates = [
      join(absPkg, 'node_modules', name),
      join(root, 'node_modules', name),
      ...(pnpmSeg ? [join(root, 'node_modules', ...pnpmSeg.split('/'))] : []),
    ]
    const installDir = candidates.find(d => existsSync(d))
    if (!installDir) {
      sections.push(`\n${'='.repeat(69)}\n${name}\n${'='.repeat(69)}\n\n[警告] 安装目录未找到，license 文本缺收。\n`)
      continue
    }
    const meta = pkgMeta(installDir)
    const head = `${name}@${meta.version} — ${meta.license}`
    const lic = findLicenseFile(installDir)
    const body = lic ? lic.text : `[未找到 license 文件；该库声明许可证为 ${meta.license}]`
    sections.push(`\n${'='.repeat(69)}\n${head}\n来源：https://www.npmjs.com/package/${name}\n${'='.repeat(69)}\n\n${body}\n`)
  }

  const out = [
    'THIRD-PARTY LICENSES',
    '===================',
    '',
    `本发布物遵循「运行时依赖 = 构建期内联」模型，将下列第三方库打包进产物；`,
    '依其许可证条款随附许可文本与版权声明。',
    `生成：scripts/collect-licenses.ts（issue #13）。本仓库自身以 MIT 许可发布。`,
    '',
    ...sections,
  ].join('\n')
  writeFileSync(join(libDir, 'THIRD-PARTY-LICENSES'), out)
  return refs.map(r => r.name)
}

// ---- CLI 入口：无参数 = 全部插件包 ------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : listPluginDirs(ROOT).map(d => `packages/${d}`)
  let failed = 0
  for (const t of targets) {
    try {
      const names = collectForPackage(t)
      console.log(names.length > 0
        ? `PASS ${t} | THIRD-PARTY-LICENSES 已归集（${names.length} 个库: ${names.join(', ')}）`
        : `SKIP ${t} | 产物未内联第三方库`)
    } catch (e) {
      failed++
      console.log(`FAIL ${t} | ${String(e.message).split('\n')[0]}`)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}
