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
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertClientContract } from './client-contract-lib.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(ROOT, 'packages')

const pluginDirs = readdirSync(packagesDir)
  .filter((d) => d.startsWith('dsh-') && d !== 'dsh-plugins-all')

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
console.log(failed === 0 ? '客户端契约：全部通过' : `客户端契约：${failed} 个失败`)
process.exit(failed === 0 ? 0 : 1)
