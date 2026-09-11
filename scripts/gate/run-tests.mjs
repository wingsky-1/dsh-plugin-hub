#!/usr/bin/env node
/**
 * run-tests — 各包统一测试入口（issue #690 S2）。
 *
 * 为什么需要这层 wrapper：`node --test` 在**零匹配**时 exit 0（实测：glob 写错、
 * 测试文件被误删，都得到 `pass 0 / fail 0` + exit 0），`exit(0)` 吞失败同理——
 * 两者都会让「绿灯」失去意义（docs/ARCHITECTURE-METHOD.md §8 假绿向量）。
 * 故本入口显式断言两件事：**匹配到的测试文件数 >= 下限**、**无失败条目**。
 *
 * 为什么下限按**文件数**而不是 TAP 的 `1..N`：`1..N` 是测试条目数，含文件内的
 * 子测试（用 node:test 的 test() 注册）——实测 dsh-provider-usage 有 19 个测试
 * 文件却报 59 个条目，按条目设阈值会随子测试增减抖动。文件数由 glob 直接展开，
 * 语义稳定且与「漏跑/误删文件」这一被防对象一一对应。
 *
 * 用 TAP reporter 取失败信息：TAP（`ok` / `not ok`）是稳定协议，不受 node
 * 交互式摘要文案变化影响。
 *
 * 为什么用 `--test-isolation=none`（而非默认的 per-file 进程隔离）：
 *   1. 本仓测试存在固定端口/共享临时资源的用例（如 dsh-lan-proxy 的 19998/19091），
 *      默认按 CPU 核数并发会 `listen EADDRINUSE`（实测）；此前的 `test/smoke.ts`
 *      聚合入口是 `await import` **同进程严格串行**，迁移必须保持同一语义。
 *   2. 默认隔离会在每个文件跑完后判定「测试结束后是否还有异步活动」，而本仓既有
 *      用例存在 fire-and-forget 的 watcher/定时器（实测 dsh-provider-usage 报
 *      `A resource generated asynchronous activity after the test ended`）。同进程
 *      模式下没有 per-file 结束边界，与迁移前的行为一致。
 *   两条都是「保持语义等价」而非放宽判据：失败仍由 TAP 的 not ok 与退出码兜住。
 *
 * 用法（在包目录内执行，cwd = 包根）：
 *   node ../../scripts/gate/run-tests.mjs --min <正整数>
 * 退出码：0 = 全部通过且文件数达标；1 = 有失败 / 零匹配 / 低于下限 / 汇总不可解析。
 */
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const PATTERN = 'test/**/*.test.ts'

const argv = process.argv.slice(2)
const minIdx = argv.indexOf('--min')
const min = minIdx >= 0 ? Number(argv[minIdx + 1]) : Number.NaN
if (!Number.isInteger(min) || min < 1) {
  console.error('run-tests: 用法 node scripts/gate/run-tests.mjs --min <正整数>')
  process.exit(2)
}

const files = globSync(PATTERN)
if (files.length < min) {
  console.error(`run-tests: glob "${PATTERN}" 只匹配到 ${files.length} 个文件，低于下限 ${min} —— 零匹配/漏跑必须判红`)
  process.exit(1)
}

const spawned = spawnSync(
  process.execPath,
  // --test-force-exit：跑完即退，不等残留句柄（如 SDK 端到端用例 spawn 的 stdio 子进程）。
  // 迁移前由 smoke 入口末尾的 process.exit(0) 承担，但它会连 runner 一起杀掉并吞掉汇总
  // （mcp 实测：无 TAP 计划行、后续文件不执行），故改由 runner 统一收尾。
  ['--test', '--test-isolation=none', '--test-force-exit', '--test-reporter=tap', PATTERN],
  { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
)
const out = spawned.stdout ?? ''
process.stdout.write(out)

const failed = (out.match(/^not ok /gm) ?? []).length
const planned = (out.match(/^1\.\.(\d+)$/m) ?? [])[1]

if (planned === undefined) {
  console.error('run-tests: 无法解析 TAP 计划数（1..N）—— 输出异常或进程被中断')
  process.exit(1)
}
if (failed > 0) {
  console.error(`run-tests: ${failed} 个测试条目失败`)
  process.exit(1)
}
if (spawned.status !== 0) {
  console.error(`run-tests: node --test 退出码 ${spawned.status}（非零即判红，防 exit(0) 吞失败）`)
  process.exit(1)
}
console.log(`run-tests: ${files.length} 个测试文件 / ${planned} 个测试条目全部通过（文件数下限 ${min}）`)
