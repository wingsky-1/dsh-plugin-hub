#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * contract-check — 客户端契约语义校验（浏览器端真实契约的 Node 侧同构模拟）。
 *
 * 核心契约（与 @deepseek-ai/dsh-client-modules 的浏览器半区一致，非自拟）：
 *   1. boot manifest 的 row.id = entry.name = 完整 npm 包名；
 *   2. arrive(row) 拉取 /plugins/<包名>/client.js 后校验 factories.has(包名)；
 *   3. materialize 后 exports.apply 为函数、exports.inject 为数组。
 *
 * 断言实现统一来自 scripts/client-contract-lib.ts（唯一事实源：stub/执行/
 * materialize/断言），本脚本只负责包级联动断言（dsh.client 声明 ⇒
 * exports["./client"] 存在；src/client.ts ⇒ lib/client.js 产物存在）与报告汇总。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertClientContract } from '../lib/client-contract-lib.ts'
import { filterOutRetiredDirs, listPluginDirs, loadManifest } from '../lib/plugins-manifest-lib.ts'
import { runConfigMatrix } from '../lib/config-matrix-gate.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const packagesDir = join(ROOT, 'packages')

// T1（#397）：退役残留目录无 package.json，按 manifest.retired 过滤——残留目录
// 属清理债不参与契约检查（plugins-manifest-lib 方向 B 已豁免并告警）。listPluginDirs
// 保持物理枚举语义不变，此处仅消费侧按 manifest 过滤，不掏空「新目录必须登记」守卫。
let manifest
try {
  manifest = loadManifest(ROOT)
} catch (e) {
  console.log(`FAIL plugins-manifest | ${e.message}`)
  process.exit(1)
}
const { kept: pluginDirs, skipped: retiredDirs } = filterOutRetiredDirs(listPluginDirs(ROOT), manifest)
if (retiredDirs.length > 0) {
  console.warn(`[contract-check] 跳过已退役包残留目录: ${retiredDirs.join(', ')}（manifest.retired 已登记，请清理）`)
}

let failed = 0
let checked = 0
for (const p of pluginDirs) {
  const pkgDir = join(packagesDir, p)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const clientPath = join(pkgDir, 'lib', 'client.js')
  const hasClientSource = existsSync(join(pkgDir, 'src', 'client.ts'))
  const declaresClient = !!pkg.dsh?.client

  // 联动断言：dsh.client 声明 ⇒ exports["./client"] 必须存在（宿主 resolveMeta 缺它会整包拒载）
  // exports["./client"] 支持字符串与条件导出对象（{ default, types }）两种形态
  const clientExport = pkg.exports?.['./client']
  const clientExportOk = !declaresClient || (clientExport && (typeof clientExport === 'string' || typeof clientExport === 'object'))
  // 联动断言：有 src/client.ts 必有构建产物
  const productOk = !hasClientSource || existsSync(clientPath)

  if (!declaresClient && !hasClientSource) {
    if (!clientExportOk || !productOk) {
      failed++
      console.log(`FAIL ${pkg.name} | 声明联动断言失败（clientExportOk=${clientExportOk} productOk=${productOk}）`)
    }
    continue
  }
  if (!existsSync(clientPath)) {
    failed++
    console.log(`FAIL ${pkg.name} | 缺 lib/client.js 产物（dsh.client 声明或 src/client.ts 存在）`)
    continue
  }

  checked++
  const code = readFileSync(clientPath, 'utf8')
  const { ok, checks, error } = assertClientContract(pkg.name, code)
  const allChecks = {
    ...checks,
    'dsh.client⇒exports["./client"]声明': clientExportOk,
    'src/client.ts⇒lib/client.js产物': productOk,
  }
  const okAll = ok && clientExportOk && productOk
  if (!okAll) failed++
  console.log(`${okAll ? 'PASS' : 'FAIL'} ${pkg.name} | ${Object.entries(allChecks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)
  if (!okAll && error) console.log(`     执行错误: ${error.message}`)
}

// 件数断言：凡 packages/dsh-* 目录都应被检查覆盖（防漏检）
console.log(`\n检查覆盖：${checked}/${pluginDirs.length} 个客户端插件包（其余为纯宿主包或聚合包）`)
if (checked === 0) {
  console.log('（当前无带客户端插件的包）')
}

// @deepseek-ai/* 官方包与 @wingsky-1/* 工作区包仅允许 import type（issue #16 +
// #329）：值导入会进宿主端 bundle 或被 build-client 内联，破坏发布物自包含。
// 类型擦除由 tsc verbatimModuleSyntax 保证；此门禁防的是「未来有人写成运行时导入」。
// 多行 import 也覆盖：以 import 开头且非 import type 的语句体内出现
// @deepseek-ai|@wingsky-1 模块名即报。
{
  const offenders = []
  for (const p of pluginDirs) {
    const srcDir = join(packagesDir, p, 'src')
    if (!existsSync(srcDir)) continue
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(join(dir, e.name)); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || e.name.endsWith('.d.ts')) continue
        const file = join(dir, e.name)
        const text = readFileSync(file, 'utf8')
        // 去掉行注释与块注释，防文档示例误报
        const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
        // 主形态：静态 import（非 import type）。注意 `import { type X } from` 的
        // inline 修饰符会被命中——这是有意 fail-closed：verbatimModuleSyntax 下该
        // 语句仍保留副作用导入语义，应改写成整句 import type。
        for (const m of code.matchAll(/(^|\n)\s*import\s+(?!type\b)(?:[^;'"]|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")*?from\s*['"](@(?:deepseek-ai|wingsky-1)\/[^'"]+)['"]|(^|\n)\s*import\s+['"](@(?:deepseek-ai|wingsky-1)\/[^'"]+)['"]/g)) {
          const spec = m[2] ?? m[4]
          if (spec) offenders.push(`${p}/src${file.slice(srcDir.length)} → ${spec}`)
        }
        // 补充形态：export ... from / 动态 import() / require()（同样产生运行时引用；
        // export type ... from 为纯类型放行）
        for (const m of code.matchAll(/(?:export\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*|import\(\s*|require\(\s*)['"](@(?:deepseek-ai|wingsky-1)\/[^'"]+)['"]/g)) {
          offenders.push(`${p}/src${file.slice(srcDir.length)} → ${m[1]}`)
        }
      }
    }
    walk(srcDir)
  }
  if (offenders.length > 0) {
    failed++
    console.log('FAIL @deepseek-ai/@wingsky-1 仅类型导入 | 检测到运行时值导入（须改为 import type）:')
    for (const o of offenders) console.log(`     ${o}`)
  } else {
    console.log('PASS @deepseek-ai/@wingsky-1 仅类型导入 | src 下无运行时值导入')
  }
}

// config-matrix（issue #471）：配置平行事实源字段覆盖矩阵门禁。并入本文件内部
// （P0-A 裁决：根 package.json 命令字符串零改动、.github/ 零改动）。复核裁决
// （qa #11）：矩阵段必须位于既有最终汇总行「客户端契约：全部通过/失败」**之后**
// ——旧输出整体逐字节不变、矩阵段成为真正末段。故矩阵失败用独立计数 matrixFailed
// 计数，不并入 failed（并入会改写汇总行文案），仅追加 FAIL config-matrix 行 +
// 末行状态 + exit 1（与既有 FAIL 语义一致）。
// 提取器与矩阵逻辑在 scripts/lib/config-matrix-lib.ts / config-matrix-gate.ts
// （esbuild+acorn AST 提取，零新增依赖；root 参数化供负向副本测试复用）。
console.log(failed === 0 ? '客户端契约：全部通过' : `客户端契约：${failed} 个失败`)
{
  const matrix = runConfigMatrix(ROOT)
  console.log('\nconfig-matrix:')
  for (const line of matrix.lines) console.log(`  ${line}`)
  // 量级 #12（README 键集一致性）：缺/多键仅 warn 不判红（防文档漂移提示）。
  for (const w of matrix.warnings) console.log(`warn config-matrix | ${w}`)
  for (const problem of matrix.problems) {
    console.log(`FAIL config-matrix | ${problem}`)
  }
  // 量级 #13：报错附「四同步清单」指引（不改判红语义）。
  if (matrix.problems.length > 0) {
    console.log('hint config-matrix | 新增/修改配置键请四同步——① 事实源表（lan-proxy Config / notifier DEFAULT_CONFIG）② validators/hints ③ normalize 白名单与透传排除 ④ 客户端渲染/编辑 + smoke 断言 + README 配置节；补齐后重跑 pnpm contract')
  }
  const matrixFailed = matrix.problems.length > 0
  if (matrixFailed) failed++ // 仅用于 exit code（汇总行文案在矩阵段前已打印，不受影响）
  console.log(matrixFailed ? `config-matrix | ${matrix.problems.length} 个失败` : 'config-matrix | PASS')
}
process.exit(failed === 0 ? 0 : 1)
