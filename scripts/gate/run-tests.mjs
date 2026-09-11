#!/usr/bin/env node
/**
 * run-tests — 各包统一测试入口（issue #690 S2 / S2c）。
 *
 * 为什么需要这层 wrapper：`node --test` 在**零匹配**时 exit 0（实测：glob 写错、
 * 测试文件被误删，都得到 `pass 0 / fail 0` + exit 0），`exit(0)` 吞失败同理——
 * 两者都会让「绿灯」失去意义（docs/ARCHITECTURE-METHOD.md §8 假绿向量）。
 * 故本入口显式断言：**匹配到的文件数 >= 下限**、**每个文件都真的通过**、**没有超时**。
 *
 * 为什么逐文件 spawn（#690 S2c）：
 *   1. node `--test` 会**自行排序**传入的文件参数（实测传 c,a,b 仍按 a,b,c 执行），
 *      于是「打乱文件列表结果不变」这条验收判据无法靠重排参数实现——逐文件 spawn 把执行
 *      顺序拿回 runner 自己手里（`--order lex|reverse|shuffle:<seed>`）。
 *   2. 每个文件独立超时：单个文件挂住不再拖垮整包，且能**点名**到具体文件。
 *   3. per-file 进程隔离成为天然语义（每个文件本来就是独立进程），跨文件全局态不再串味。
 *
 * 为什么超时必须杀**进程组**：per-file 隔离下 node 会为每个文件再派生一个 worker；只杀直接
 * 子进程会留下孤儿——实测孤儿继续持有 `127.0.0.1:19998` 不放，污染后续运行。故 spawn 用
 * `detached: true` 建独立进程组，超时以 `kill(-pid)` 整组回收。
 *
 * 为什么不再用 `--test-isolation=none`（#690 S2c 从 #712 的过渡态回归默认隔离）：同进程串行
 * 是迁移期的历史妥协（固定端口 + fire-and-forget 定时器），代价是整类假绿——跨文件全局态
 * （`untildify` 对 `homedir()` 首调固化）、悬挂 promise、求值顺序耦合，#712 的三个缺陷全部
 * 源自这里。S2c 先把端口动态化、句柄回收，再回归默认隔离。
 * 保 `--test-concurrency=1` 是必要的：实测同一固定端口被 8 个文件并发持有时 7 个
 * `EADDRINUSE`，串行是「不引入新脆弱前提」的最低成本。
 *
 * 不用 `--test-force-exit`（#690 S2 对抗评审实测的假绿向量）：node 以「模块求值结束」判定
 * 文件测试通过，不等待顶层悬挂的 promise；force-exit 会在悬挂体的断言执行前终止进程，真实
 * 失败被吞成 exit 0。逐文件 spawn 后，顶层 unsettled await 由 node 自己判 `not ok`（per-file
 * 专属能力），该向量被封堵在 node 侧。
 *
 * 判据边界：保证「glob 命中的每个文件都被执行且通过」，**不保证**某个文件内的断言没有被删空
 * ——文件级判据看不到断言数量，那属于断言评审/静态哨兵的职责。
 *
 * 用法（在包目录内执行，cwd = 包根）：
 *   node ../../scripts/gate/run-tests.mjs --min <正整数> [--order lex|reverse|shuffle:<seed>]
 * 环境变量 `RUN_TESTS_TIMEOUT_MS`：**单文件**墙钟上限（默认 10 分钟）。门禁自测与本地排查
 * 可收紧，收紧只会更快判红，不能用来伪造绿灯。
 * 退出码：0 = 全部通过且文件数达标；1 = 有失败 / 零匹配 / 低于下限 / 超时；2 = 用法错误。
 *
 * 与变异面的关系（#690 S2b）：本入口的 PATTERN 就是「runner 面」的定义，
 * `pnpm stryker:check` 用它校验各包 `--min` 是否同步（不一致即判红，不会静默放宽），
 * 而变异面由同一份拓扑的测试层派生（见 scripts/gate/gen-stryker-conf.mjs）。
 * 测试文件的分层约定见 docs/DEVELOPMENT.md「测试分层与变异面登记」。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync } from 'node:fs'

import { RUN_TESTS_PATTERN } from './test-surface.mjs'

// 与变异面登记门禁（gen-stryker-conf --check 的判据 ③）同源：不再各写一份字面量。
const PATTERN = RUN_TESTS_PATTERN

/**
 * 单文件墙钟上限。为什么默认 10 分钟：最慢的 `dsh-mcp-manager/test/e2e/smoke.test.ts`
 * （SDK stdio 端到端）实测单跑 328s、并发负载下超过 360s；上限贴着它会把「慢」误判成
 * 「残留句柄」，而两者的区分正是本入口要给出的信号。
 */
const FILE_TIMEOUT_MS = Number(process.env.RUN_TESTS_TIMEOUT_MS) > 0
  ? Number(process.env.RUN_TESTS_TIMEOUT_MS)
  : 10 * 60 * 1000
/**
 * 整包预算：防「多个文件各自挂满单文件上限」把门禁拖成小时级。正常包（含最慢的
 * dsh-mcp-manager 约 6 分钟）远低于它，只有异常才触顶。
 */
const PACKAGE_BUDGET_MS = 20 * 60 * 1000

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}

const min = Number(flag('--min', Number.NaN))
if (!Number.isInteger(min) || min < 1) {
  console.error('run-tests: 用法 node scripts/gate/run-tests.mjs --min <正整数> [--order lex|reverse|shuffle:<seed>]')
  process.exit(2)
}
const order = flag('--order', 'lex')

/** 确定性重排：同一种子恒定产出同一顺序，失败后可按种子逐字复现。 */
function reorder(list, mode) {
  if (mode === 'lex') return list
  if (mode === 'reverse') return [...list].reverse()
  if (mode.startsWith('shuffle')) {
    const seed = mode.includes(':') ? mode.slice(mode.indexOf(':') + 1) : '0'
    let h = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16)
    const out = [...list]
    for (let i = out.length - 1; i > 0; i -= 1) {
      h = (h * 1103515245 + 12345) % 0x7fffffff
      const j = h % (i + 1)
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }
  console.error(`run-tests: 未知 --order "${mode}"（支持 lex / reverse / shuffle:<seed>）`)
  process.exit(2)
}

let files = globSync(PATTERN).sort()
if (files.length < min) {
  console.error(`run-tests: glob "${PATTERN}" 只匹配到 ${files.length} 个文件，低于下限 ${min} —— 零匹配/漏跑必须判红`)
  process.exit(1)
}
files = reorder(files, order)

/** 跑单个文件；返回 { file, code, signal, timedOut, out, err }。 */
function runFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-isolation=process', '--test-concurrency=1', '--test-reporter=tap', file],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    let timedOut = false
    let done = false
    let killFallback = null

    const settle = (code, signal) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (killFallback !== null) clearTimeout(killFallback)
      resolve({ file, code, signal, timedOut, out, err })
    }
    // 整组回收：worker 与父 node 同组（detached 建组），只杀父会留孤儿。
    const hardKill = () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 组已消失 */ }
      // KILL 后仍不触发 exit 说明进程不可中断，兜底 settle 以免 runner 自身挂死。
      killFallback = setTimeout(() => settle(null, 'SIGKILL'), 5000)
    }
    const timer = setTimeout(() => { timedOut = true; hardKill() }, timeoutMs)

    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (e) => { err += `spawn 失败: ${e.message}\n`; settle(null, null) })
    child.on('exit', (code, signal) => settle(code, signal))
  })
}

const startedAt = Date.now()
const results = []
let budgetExhausted = false

for (const file of files) {
  const remaining = PACKAGE_BUDGET_MS - (Date.now() - startedAt)
  if (remaining <= 0) { budgetExhausted = true; break }
  const r = await runFile(file, Math.min(FILE_TIMEOUT_MS, remaining))
  const notOk = (r.out.match(/^not ok /gm) ?? []).length
  results.push({ ...r, notOk, passed: !r.timedOut && r.code === 0 && notOk === 0 })
  // TAP 透传：保持与「一次 spawn 全部文件」时期一致的可读输出与日志形态。
  process.stdout.write(r.out)
  if (r.err !== '') process.stderr.write(r.err)
}

if (budgetExhausted) {
  console.error(`run-tests: 整包预算 ${PACKAGE_BUDGET_MS / 60000} 分钟耗尽（已跑 ${results.length}/${files.length} 个文件）`
    + ' —— 疑似多个文件挂住，判红')
  process.exit(1)
}

const failed = results.filter((r) => !r.passed)
if (failed.length > 0) {
  console.error(`run-tests: ${failed.length}/${results.length} 个文件未通过：`)
  for (const r of failed) {
    const why = r.timedOut
      ? `超过 ${FILE_TIMEOUT_MS / 60000} 分钟未退出（疑似残留句柄），已按进程组终止`
      : `退出码 ${r.code}，not ok ${r.notOk}`
    console.error(`  ${r.file}（${why}）`)
  }
  process.exit(1)
}
console.log(`run-tests: ${results.length} 个测试文件全部通过（文件数下限 ${min}，执行顺序 ${order}）`)
