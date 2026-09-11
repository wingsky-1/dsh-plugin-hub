#!/usr/bin/env node
/**
 * run-tests — 各包统一测试入口（issue #690 S2）。
 *
 * 为什么需要这层 wrapper：`node --test` 在**零匹配**时 exit 0（实测：glob 写错、
 * 测试文件被误删，都得到 `pass 0 / fail 0` + exit 0），`exit(0)` 吞失败同理——
 * 两者都会让「绿灯」失去意义（docs/ARCHITECTURE-METHOD.md §8 假绿向量）。
 * 故本入口显式断言：**匹配到的测试文件数 >= 下限**、**无失败条目**、**退出码为 0**。
 *
 * 为什么下限按**文件数**而不是 TAP 的 `1..N`：`1..N` 是测试条目数，含文件内的
 * 子测试（用 node:test 的 test() 注册）——实测 dsh-provider-usage 19 个测试文件
 * 报 39 个条目，按条目设阈值会随子测试增减抖动。文件数由 glob 直接展开，
 * 语义稳定且与「漏跑/误删文件」这一被防对象一一对应。
 *
 * 用 TAP reporter 取失败信息：TAP（`ok` / `not ok`）是稳定协议，不受 node
 * 交互式摘要文案变化影响。
 *
 * 不用 `--test-force-exit`（#690 S2 对抗评审实测的假绿向量）：node 以「模块求值
 * 结束」判定文件测试通过，**不等待顶层悬挂的 promise**；此时 force-exit 会在悬挂
 * 体的断言执行前终止进程，真实失败被吞成 exit 0——本仓两个大 smoke 文件曾是该形态
 * （已改为顶层 `await main()`）。去掉它后进程随事件循环自然收尾，悬挂体的失败会以
 * 未处理拒绝/退出码形式暴露；代价是残留句柄可能挂住运行，故 spawn 带超时兜底（超时判红）。
 * 注意本入口的可判边界：它保证「glob 命中的文件都被求值且没有失败」，**不保证**某个
 * 文件内的断言没有被删空——文件级判据看不到断言数量，那属于断言评审/静态哨兵的职责。
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
 * 退出码：0 = 全部通过且文件数达标；1 = 有失败 / 零匹配 / 低于下限 / 汇总不可解析 / 超时。
 */
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const PATTERN = 'test/**/*.test.ts'
/** 单包测试墙钟上限：CI 上最慢的包（dsh-mcp-manager 含 SDK stdio 端到端）约 6 分钟。 */
const TIMEOUT_MS = 20 * 60 * 1000

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
  ['--test', '--test-isolation=none', '--test-reporter=tap', PATTERN],
  { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: TIMEOUT_MS },
)
const out = spawned.stdout ?? ''
process.stdout.write(out)

const failed = (out.match(/^not ok /gm) ?? []).length
const planned = (out.match(/^1\.\.(\d+)$/m) ?? [])[1]

if (spawned.error?.code === 'ETIMEDOUT' || spawned.signal === 'SIGTERM') {
  console.error(`run-tests: 测试进程超过 ${TIMEOUT_MS / 60000} 分钟未退出（疑似残留句柄），已终止并判红`)
  process.exit(1)
}
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
