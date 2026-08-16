#!/usr/bin/env node
'use strict'

/**
 * bundle-host — 宿主端发布构建（内联 shared + d.ts X1 处理）。
 *
 * 用法：node scripts/bundle-host.mjs <插件目录相对路径>   （在仓库根执行）
 *
 * 步骤：
 * 1. esbuild bundle lib/index.js（--platform=node，内置模块自动 external），
 *    把 `../../shared/*` 运行时 import 内联进产物 —— npm 包自包含，不断链。
 * 2. d.ts X1：lib/*.d.ts 中 `../../shared/` → `../shared/`、`../../types/` → `../types/`，
 *    并把 shared/*.d.ts、types/dsh.d.ts 复制进包内 shared/、types/（纯类型，随包发布）。
 * 3. 复制仓库根 LICENSE 进包（files 白名单含 LICENSE）。
 *
 * 前置：插件已 tsc 编译（tsc -p tsconfig.json），lib/ 含 js + d.ts。
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 插件目录相对当前工作目录解析（pnpm --filter 场景 cwd=包目录传 .；仓库根场景传 packages/dsh-*）
const pkgDir = resolve(process.cwd(), process.argv[2] ?? '.')
const esbuildBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
const libDir = join(pkgDir, 'lib')

if (!process.argv[2]) {
  console.error('用法：node scripts/bundle-host.mjs <插件目录>（如 packages/dsh-gzip，或包目录内传 .）')
  process.exit(1)
}
// 路径级校验：插件目录必须位于仓库 packages/ 下（兼容 pnpm --filter 的包目录 cwd 传 .）
const packagesDir = join(ROOT, 'packages')
if (!pkgDir.startsWith(packagesDir + sep) || pkgDir === packagesDir) {
  console.error(`[bundle-host] 插件目录须在 packages/ 下（实际: ${process.argv[2]}）`)
  process.exit(1)
}

// 1. esbuild 内联 shared（tsc 产物 → 自包含单文件，临时文件再替换，避免占用原文件）
const tmpBundle = join(libDir, '.index.bundle.js')
try {
  execFileSync(esbuildBin, [
    join(libDir, 'index.js'),
    '--bundle', '--format=esm', '--platform=node', '--target=node20',
    `--outfile=${tmpBundle}`, '--log-level=warning', '--charset=utf8',
  ], { stdio: 'inherit' })
} catch (e) {
  console.error(`[bundle-host] esbuild 失败: ${e.message}`)
  process.exit(1)
}
renameSync(tmpBundle, join(libDir, 'index.js'))
// tsc 的 sourcemap 在 bundle 后失效（行号已变），一并清理，避免发布失效 map
try { rmSync(join(libDir, 'index.js.map')) } catch { /* map 不存在则跳过 */ }
console.log(`[bundle-host] ${process.argv[2]}: shared 已内联（lib/index.js 自包含）`)

// 2a. d.ts 路径改写（X1）：../../../shared|types → ../shared|types（兼容二级写法）
for (const f of readdirSync(libDir).filter(f => f.endsWith('.d.ts'))) {
  const p = join(libDir, f)
  const t = readFileSync(p, 'utf8')
    .replaceAll('../../../shared/', '../shared/')
    .replaceAll('../../../types/', '../types/')
    .replaceAll('../../shared/', '../shared/')
    .replaceAll('../../types/', '../types/')
  writeFileSync(p, t)
}
// 2b. shared/types 声明副本进包
mkdirSync(join(pkgDir, 'shared'), { recursive: true })
mkdirSync(join(pkgDir, 'types'), { recursive: true })
for (const f of readdirSync(join(ROOT, 'shared')).filter(f => f.endsWith('.d.ts'))) {
  cpSync(join(ROOT, 'shared', f), join(pkgDir, 'shared', f))
}
cpSync(join(ROOT, 'types', 'dsh.d.ts'), join(pkgDir, 'types', 'dsh.d.ts'))
console.log(`[bundle-host] ${process.argv[2]}: d.ts X1 完成（shared/、types/ 副本随包）`)

// 3. LICENSE 进包
cpSync(join(ROOT, 'LICENSE'), join(pkgDir, 'LICENSE'))
console.log(`[bundle-host] ${process.argv[2]}: LICENSE 就位`)
