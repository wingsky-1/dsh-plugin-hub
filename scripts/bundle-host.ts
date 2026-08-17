#!/usr/bin/env node
// @ts-nocheck
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildClient, copyClientResources } from './build-client.ts'

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

/** 递归收集目录下满足谓词的文件（返回相对路径列表，不含目录）。 */
function walkFiles(dir, predicate) {
  const out = []
  const visit = (cur) => {
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, f.name)
      if (f.isDirectory()) visit(abs)
      else if (predicate(f.name)) out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  visit(dir)
  return out
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

// 1b. 客户端构建（有客户端源码时）：统一走共享预设 build-client
// （注入 load id + 契约外壳生成 wrapper/legacy 双模式 + 内建「load id === 包名」校验）
const clientSrc = existsSync(join(pkgDir, 'src', 'client.ts'))
  ? join(pkgDir, 'src', 'client.ts')
  : existsSync(join(pkgDir, 'src', 'client', 'index.ts'))
    ? join(pkgDir, 'src', 'client', 'index.ts')
    : null
if (clientSrc) {
  const pkgName = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name
  const clientOut = join(libDir, 'client.js')
  // ROUTES 构建期注入（define 方案）：从宿主产物读取 ROUTES 单一来源，经
  // extraDefine 注入 __DSH_ROUTES__ 供新型 client 引用——两端路由构建期强一致。
  // 现有 client 未引用该标识符则零影响（esbuild 只替换自由变量）。
  // 读取失败仅警告不阻断（smoke「两端路由一致性」断言兜底）。
  let extraDefine = {}
  try {
    const mod = await import(pathToFileURL(join(libDir, 'index.js')).href)
    if (mod.ROUTES && typeof mod.ROUTES === 'object') {
      // 传原始对象（build-client 内部做 JSON.stringify 定义为字符串字面量；
      // 勿在此预序列化——会双重转义，注入成字符串而非对象）
      extraDefine = { __DSH_ROUTES__: mod.ROUTES }
      console.log(`[bundle-host] ${process.argv[2]}: ROUTES 已注入 client 构建（${Object.keys(mod.ROUTES).length} 项）`)
    }
  } catch (e) {
    console.warn(`[bundle-host] ${process.argv[2]}: ROUTES 注入跳过（${String(e.message).split('\n')[0]}），由 smoke 兜底`)
  }
  try {
    const { mode } = await buildClient({ src: clientSrc, outfile: clientOut, packageName: pkgName, extraDefine })
    console.log(`[bundle-host] ${process.argv[2]}: 客户端构建完成（${mode} 模式，load id=${pkgName}）`)
  } catch (e) {
    console.error(`[bundle-host] 客户端构建失败: ${e.message}`)
    process.exit(1)
  }
  try { rmSync(join(libDir, 'client.js.map')) } catch { /* 无 map 则跳过 */ }
}

// 1c. 资源文件复制：src/ 下非 TS 文件（如 toast.ps1）→ lib/（运行时从 lib 同目录定位）
const copiedResources = copyClientResources(pkgDir, libDir)
for (const f of copiedResources) {
  console.log(`[bundle-host] ${process.argv[2]}: 资源 ${f} → lib/`)
}

// 1d. 清理游离产物：多模块 src 的 tsc 会逐个 emit lib/*.js + *.js.map，
// 主入口已内联全部模块——删除除 index.js/client.js 外的 .js/.js.map
// （保留 .d.ts：index.d.ts 的类型 re-export 需要）
for (const f of readdirSync(libDir)) {
  if (f.endsWith('.js') && f !== 'index.js' && f !== 'client.js') {
    rmSync(join(libDir, f), { force: true })
  } else if (f.endsWith('.js.map') || (f.endsWith('.map') && f !== 'index.js.map')) {
    rmSync(join(libDir, f), { force: true })
  }
}

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
// 2b. shared/types 声明副本进包（递归：shared/ 下所有 .d.ts，含子目录如 host/）
mkdirSync(join(pkgDir, 'shared'), { recursive: true })
mkdirSync(join(pkgDir, 'types'), { recursive: true })
for (const rel of walkFiles(join(ROOT, 'shared'), (f) => f.endsWith('.d.ts'))) {
  const dest = join(pkgDir, 'shared', rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(ROOT, 'shared', rel), dest)
}
cpSync(join(ROOT, 'types', 'dsh.d.ts'), join(pkgDir, 'types', 'dsh.d.ts'))
console.log(`[bundle-host] ${process.argv[2]}: d.ts X1 完成（shared/、types/ 副本随包）`)

// 3. LICENSE 进包
cpSync(join(ROOT, 'LICENSE'), join(pkgDir, 'LICENSE'))
console.log(`[bundle-host] ${process.argv[2]}: LICENSE 就位`)
