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
import { executeClient } from '../lib/client-contract-lib.ts'
import { AGGREGATE_NAME, filterOutRetiredDirs, listPluginDirs, loadManifest } from '../lib/plugins-manifest-lib.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// T1（#397）：退役残留目录无 package.json，按 manifest.retired 过滤（残留属清理债，
// 不参与布局验证；plugins-manifest-lib 方向 B 已豁免并告警）。listPluginDirs 保持
// 物理枚举语义不变，仅消费侧按 manifest 过滤，不掏空「新目录必须登记」守卫。
let manifest
try {
  manifest = loadManifest(ROOT)
} catch (e) {
  console.log(`FAIL plugins-manifest | ${e.message}`)
  process.exit(1)
}
const { kept: plugins, skipped: retiredDirs } = filterOutRetiredDirs(listPluginDirs(ROOT), manifest)
if (retiredDirs.length > 0) {
  console.warn(`[verify-npm-layout] 跳过已退役包残留目录: ${retiredDirs.join(', ')}（manifest.retired 已登记，请清理）`)
}

let failed = 0

// 0. 发布包禁止携带「安装期脚本」（preinstall / install / postinstall / prepare）。
//    原因：dsh profile 启用 strictDepBuilds，带该类脚本的依赖在 pnpm 安装时会被拦截
//    （需 allowBuilds 放行 = build allowance）。registry 安装虽不跑 prepare，但
//    git/file/link 安装会跑，导致装不上。发布物应预构建，安装即解包；构建只在发布期
//    由 prepublishOnly 跑（不随安装执行）。聚合包 dsh-plugins-all 已对齐此约定。
const FORBIDDEN_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']
// 全部发布包（含聚合包）：目录枚举 + 聚合包名，与 plugins-manifest-lib 同源
const allPackages = [...plugins, AGGREGATE_NAME]
for (const p of allPackages) {
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8'))
  const bad = Object.keys(pkgJson.scripts ?? {}).filter(s => FORBIDDEN_INSTALL_SCRIPTS.includes(s))
  if (bad.length > 0) {
    failed++
    console.log(`FAIL ${pkgJson.name} | 发布包不得携带安装期脚本: ${bad.join(', ')}（构建改用 prepublishOnly）`)
  }
}


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
      // ROUTES 是「客户端路由单一事实源」契约（DEVELOPMENT §3），仅对带客户端半
      // 的包强制；纯事件面插件（无 lib/client.js、无 dsh.client 声明，如 #153）
      // 无路由面，断言不适用（与 pack-check 的围栏跟随 HTTP 面同口径）。
      const declaresClient = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).dsh?.client !== undefined
      if ((existsSync(join(pkgRoot, 'lib', 'client.js')) || declaresClient) && !/ROUTES|route/i.test(modText)) {
        problems.push('宿主入口缺 ROUTES/路由')
      }
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