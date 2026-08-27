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
 * 2. d.ts X1：lib/*.d.ts 中 `../../shared/` → `../shared/`，
 *    并把 shared/*.d.ts 复制进包内 shared/（纯类型，随包发布）。
 * 3. 复制仓库根 LICENSE 进包（files 白名单含 LICENSE）。
 *
 * 前置：插件已 tsc 编译（tsc -p tsconfig.json），lib/ 含 js + d.ts。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildClient, buildMermaidChunk, copyClientResources } from './build-client.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// 插件目录相对当前工作目录解析（pnpm --filter 场景 cwd=包目录传 .；仓库根场景传 packages/dsh-*）
const pkgDir = resolve(process.cwd(), process.argv[2] ?? '.')
const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const libDir = join(pkgDir, 'lib')

if (!process.argv[2]) {
  console.error('用法：node scripts/bundle-host.mjs <插件目录>（如 packages/dsh-notifier，或包目录内传 .）')
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
// 0a. #215 内置适配器 mjs 化：tsc 只编译 src/**/*.ts，.mjs/.d.mts 不被 emit——
//     在 esbuild bundle 前把 src/adapters/*.{mjs,d.mts} 拷贝进 lib/adapters/
//     （esbuild 需读到 .mjs 内联；.d.mts 随包发布供 lib/index.d.ts 类型解析）。
function copyAdapterModules(pkgDir) {
  const srcAdapters = join(pkgDir, 'src', 'adapters')
  const libAdapters = join(libDir, 'adapters')
  if (!existsSync(srcAdapters)) return 0
  mkdirSync(libAdapters, { recursive: true })
  let n = 0
  for (const f of readdirSync(srcAdapters)) {
    if (/\.(mjs|d\.mts)$/.test(f)) {
      cpSync(join(srcAdapters, f), join(libAdapters, f))
      n += 1
    }
  }
  return n
}
const adapterModulesCopied = copyAdapterModules(pkgDir)
if (adapterModulesCopied > 0) {
  console.log(`[bundle-host] ${process.argv[2]}: 内置适配器 mjs/d.mts 已拷贝进 lib/adapters/（${adapterModulesCopied} 个）`)
}

const tmpBundle = join(libDir, '.index.bundle.js')
// 可选 banner（按包，dsh.bundle.bannerJs）：在 ESM 产物顶部注入代码。用于给内联的
// CJS 库（如 ws）提供 require（createRequire），避免其内部动态 require Node 内置
// 模块在 ESM 顶层报 "Dynamic require ... is not supported"。其余包不设该字段则零影响。
const bannerJs = pkgJson?.dsh?.bundle?.bannerJs
try {
  await build({
    entryPoints: [join(libDir, 'index.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: tmpBundle,
    logLevel: 'warning',
    charset: 'utf8',
    banner: typeof bannerJs === 'string' && bannerJs.length > 0 ? { js: bannerJs } : undefined,
  })
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
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const pkgName = pkgJson.name
  const clientOut = join(libDir, 'client.js')
  // inlineBareImports：包在 dsh.client 显式声明——客户端 bare import 是纯浏览器
  // 第三方库（需内联进产物），而非宿主注入 external（如 React）。见 build-client.ts。
  const inlineBareImports = !!(pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.inlineBareImports)
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
    const { mode } = await buildClient({ src: clientSrc, outfile: clientOut, packageName: pkgName, extraDefine, inlineBareImports })
    console.log(`[bundle-host] ${process.argv[2]}: 客户端构建完成（${mode} 模式，load id=${pkgName}）`)
  } catch (e) {
    console.error(`[bundle-host] 客户端构建失败: ${e.message}`)
    process.exit(1)
  }
  try { rmSync(join(libDir, 'client.js.map')) } catch { /* 无 map 则跳过 */ }

  // 1b-mermaid. Mermaid 懒加载独立 chunk（issue #104，有 mermaid-entry.ts 的包才构建）：
  // ESM 整库内联产物 lib/client-mermaid.js，客户端 md 出现 mermaid 块时才动态 import。
  // 必须在 cleanFreeFloatingJs 之前产出——清理白名单（isTopEntry）已同步放行该文件名，
  // 双保险防「游离产物清理误删新 chunk → 宿主路由 ENOENT」复发。
  const mermaidEntry = join(pkgDir, 'src', 'client', 'mermaid-entry.ts')
  if (existsSync(mermaidEntry)) {
    try {
      const { bytes, refs } = await buildMermaidChunk({ entry: mermaidEntry, outfile: join(libDir, 'client-mermaid.js') })
      // minify 移除产物内 node_modules 注释 → license 归集链失明（详见
      // build-client.buildMermaidChunk 注释）。sidecar 清单随包发布（files 白名单
      // 已含 lib/），collect-licenses / pack-check 以它为该产物的唯一证据源。
      writeFileSync(join(libDir, 'client-mermaid.deps.json'), JSON.stringify(refs, null, 1) + '\n')
      console.log(`[bundle-host] ${process.argv[2]}: mermaid chunk 构建完成（lib/client-mermaid.js，${(bytes / 1024 / 1024).toFixed(2)}MB min，${refs.length} 个内联第三方库清单）`)
    } catch (e) {
      console.error(`[bundle-host] mermaid chunk 构建失败: ${e.message}`)
      process.exit(1)
    }
    try { rmSync(join(libDir, 'client-mermaid.js.map')) } catch { /* 无 map 则跳过 */ }
  }
}

// 1c. 资源文件复制：src/ 下非 TS 文件（如 toast.ps1）→ lib/（运行时从 lib 同目录定位）
const copiedResources = copyClientResources(pkgDir, libDir)
for (const f of copiedResources) {
  console.log(`[bundle-host] ${process.argv[2]}: 资源 ${f} → lib/`)
}

// 1d. 递归清理游离产物：多模块 src（含 src/client/、src/core/ 等子目录）的 tsc 会
// 逐个 emit lib/**/*.js + *.js.map；host 已内联为自包含 lib/index.js（client 由
// build-client 生成 lib/client.js），其余 .js/.js.map（含子目录）均为游离物——
// 保留顶层 index.js/client.js/client-mermaid.js（issue #104 懒加载 chunk，
// P0 白名单：缺它会被当游离产物删除 → 宿主路由 ENOENT 且既有门禁测不出）与
// 全部 .d.ts（类型 re-export 需要）。
function cleanFreeFloatingJs(dir, isRoot) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, f.name)
    if (f.isDirectory()) { cleanFreeFloatingJs(abs, false); continue }
    const isTopEntry = isRoot && (f.name === 'index.js' || f.name === 'client.js' || f.name === 'client-mermaid.js')
    if (f.name.endsWith('.js') && !isTopEntry) {
      rmSync(abs, { force: true })
    } else if (f.name.endsWith('.js.map') || (f.name.endsWith('.map') && !(isRoot && f.name === 'index.js.map'))) {
      rmSync(abs, { force: true })
    }
  }
}
cleanFreeFloatingJs(libDir, true)

// 2a. d.ts 路径改写（X1，递归且按文件深度感知）：shared 相对引用 → 包内副本。
// 顶层 lib/x.d.ts 引用包内副本为 ../shared/；
// 子目录 lib/a/b.d.ts 引用为 ../../shared/（深度 +1 级）。
function rewriteDtsPaths(dir, depth) {
  const prefix = '../'.repeat(depth + 1)
  // rewriteRelativeImportExtensions 的 d.ts 缺口修正（#276 方案 A）：TS（5.9/7.x
  // 实测一致）只把相对 .ts 后缀 specifier 回写到 JS emit，声明文件不回写——
  // 源码 .ts 后缀原样进入 lib/*.d.ts，会指向发布包内不存在的文件。统一改回 .js。
  // 对未启用该 flag / 未迁移的包无匹配，天然无操作。
  const TS_SUFFIX = /(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"'\s]+)\.ts\2/g
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, f.name)
    if (f.isDirectory()) { rewriteDtsPaths(abs, depth + 1); continue }
    if (!f.name.endsWith('.d.ts')) continue
    const p = join(dir, f.name)
    const t = readFileSync(p, 'utf8')
      .replace(/(?:\.\.\/)+shared\//g, `${prefix}shared/`)
      .replace(TS_SUFFIX, '$1$2$3.js$2')
    writeFileSync(p, t)
  }
}
rewriteDtsPaths(libDir, 0)
// 2b. shared 声明副本进包（递归：shared/ 下所有 .d.ts，含子目录如 host/）
mkdirSync(join(pkgDir, 'shared'), { recursive: true })
for (const rel of walkFiles(join(ROOT, 'shared'), (f) => f.endsWith('.d.ts'))) {
  const dest = join(pkgDir, 'shared', rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(ROOT, 'shared', rel), dest)
}
console.log(`[bundle-host] ${process.argv[2]}: d.ts X1 完成（shared/ 副本随包）`)

// 3. LICENSE 进包
cpSync(join(ROOT, 'LICENSE'), join(pkgDir, 'LICENSE'))
console.log(`[bundle-host] ${process.argv[2]}: LICENSE 就位`)

// 4. 第三方 license 归集（issue #13）：产物内联了第三方库 ⇒ 随发布物附
//    lib/THIRD-PARTY-LICENSES（合规义务：内联 = 分发库副本）。提取与归集
//    逻辑单一来源在 scripts/collect-licenses.ts；无内联则跳过不写文件。
const { collectForPackage } = await import('./collect-licenses.ts')
const licensed = collectForPackage(relative(ROOT, pkgDir))
console.log(licensed.length > 0
  ? `[bundle-host] ${process.argv[2]}: THIRD-PARTY-LICENSES 已归集（${licensed.length} 个第三方库: ${licensed.join(', ')}）`
  : `[bundle-host] ${process.argv[2]}: 无第三方内联，跳过 license 归集`)
