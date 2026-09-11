#!/usr/bin/env node
/**
 * vitest 运行包装：在 vitest 之上恢复「测试文件数下限」判据（#712 防假绿）。
 *
 * 为什么需要它：vitest 只在「收集到 0 个测试文件」时报错，无法发现 include 配置漂移
 * 导致**部分文件漏收集**的假绿。原 run-tests.mjs 的 `--min N` 正是这道保险，
 * 切换运行器后必须等价保留，否则门禁在无声中变弱。
 *
 * 判据来源：vitest 的 json reporter 里 `testResults` 数组即为「被收集并执行的测试文件」，
 * 其长度与各包 package.json 的 `--min` 语义一一对应（文件数下限）。
 *
 * 用法：node scripts/test/run-vitest.mjs --min <下限> [其余参数原样透传给 vitest]
 * 退出码：vitest 的退出码；文件数不足或报告缺失时判 1（fail-closed）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 直接以 node 执行 vitest 入口，不经 shell：与仓库既有 gate 脚本同款，
// 避免 Windows 下 pnpm.cmd 解析与引号转义问题。
let vitestBin
try {
  vitestBin = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
} catch {
  vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
}
if (!existsSync(vitestBin)) {
  console.error(`run-vitest: 未找到 vitest 入口（${vitestBin}）`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const minIdx = argv.indexOf('--min')
const min = minIdx >= 0 ? Number(argv[minIdx + 1]) : null
if (minIdx >= 0 && (!Number.isInteger(min) || min <= 0)) {
  console.error('run-vitest: --min 需要正整数参数')
  process.exit(2)
}
const passthrough = minIdx >= 0 ? argv.filter((_, i) => i !== minIdx && i !== minIdx + 1) : argv

// 包级调用（cwd 位于 packages/<pkg>）时默认只跑该包：vitest 的过滤参数是路径子串，
// 传相对根的包路径即可。否则 `pnpm -r test` 会让每个包都跑一遍全仓测试。
const relCwd = relative(ROOT, process.cwd()).replaceAll('\\', '/')
const scopeArgs = relCwd && !relCwd.startsWith('..') ? [relCwd] : []

const reportDir = mkdtempSync(join(tmpdir(), 'vitest-report-'))
const reportPath = join(reportDir, 'report.json')

const res = spawnSync(
  process.execPath,
  [vitestBin, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`, ...scopeArgs, ...passthrough],
  { cwd: ROOT, stdio: 'inherit', env: process.env },
)

if (res.error) {
  console.error(`run-vitest: 启动 vitest 失败：${res.error.message}`)
  rmSync(reportDir, { recursive: true, force: true })
  process.exit(1)
}

if (min !== null) {
  let files = null
  try {
    files = JSON.parse(readFileSync(reportPath, 'utf8'))?.testResults?.length ?? null
  } catch {
    // 报告缺失：不猜，按 fail-closed 处理
  }
  if (files === null) {
    console.error('run-vitest: 未能读取 vitest 报告，无法校验文件数下限 —— fail-closed')
    rmSync(reportDir, { recursive: true, force: true })
    process.exit(1)
  }
  if (files < min) {
    console.error(`run-vitest: FAIL —— 收集到 ${files} 个测试文件，低于下限 ${min}（include 配置漂移？）`)
    rmSync(reportDir, { recursive: true, force: true })
    process.exit(1)
  }
  console.log(`run-vitest: 收集到 ${files} 个测试文件（下限 ${min}）`)
}

rmSync(reportDir, { recursive: true, force: true })
process.exit(res.status ?? 1)
