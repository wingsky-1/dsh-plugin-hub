#!/usr/bin/env node
/**
 * probe-handles — 测试文件「残留句柄 / 挂起 / 顺序依赖」分诊探针（#690 S2c / #713 T5 前半）。
 *
 * 为什么需要这层探针：`--test-isolation=none` 下没有 per-file 结束边界，残留句柄只表现为
 * 「整包进程不退出」，由 runner 的 20 分钟 spawn 超时兜底——**无法定位到具体文件**。切默认
 * per-file 隔离前必须先拿到「哪些文件有残留、哪些文件依赖求值顺序」的清单，否则会一次性
 * 暴露大量既有缺陷（#713 风险 2：PR 过大、无法归因）。
 *
 * 四态为什么这样分（本机实测的失败形态，见 PR 正文）：
 *   - `leak`：`--test-force-exit` 对照组能正常退出 —— 测试逻辑跑完了，是残留句柄（定时器 /
 *     socket / watcher）吊住了进程。per-file 隔离下这是会退化成「整包挂起」的形态。
 *   - `stall`：超时/静默且对照组也挂住 —— 探针**无法**区分「句柄残留」与「测试没跑完」，
 *     如实报出交人工复核（成因见下面的对照组局限）。
 *   - `fail`：退出码非零 —— 既可能是真实断言失败，也可能是**顺序依赖**在隔离下暴露
 *     （per-file 让每个文件独占进程，掩盖它的「兄弟文件先跑了什么」不再成立），还可能是
 *     顶层 unsettled await（per-file 下 node 自己判红，而 none 模式下它是静默的 `1..0`）。
 *   - `clean`：按时退出、无失败、且汇总后 graceMs 内收尾。
 *
 * 对照组为什么不总有效：`--test-force-exit` 只对**注册了 node:test 测试**的文件生效。本仓
 * 多数测试文件是脚本式（自研 check / 直接断言，不注册测试），实测给这类文件注入 `setInterval`
 * 后，A（无 force-exit）与对照组 B（有 force-exit）都会 exit 137 且不输出 TAP 汇总。这类文件
 * 既可能是句柄残留、也可能只是慢，探针不去猜——直接报 `stall`。故 `leak` 的检出面主要覆盖
 * 已迁到 node:test 的文件；脚本式文件的超时一律要人工看一眼。
 *
 * 为什么要对照组而不是「看 TAP 汇总有没有输出」：实测 per-file 隔离下子进程不退出时，父进程
 * 根本不会打印顶层汇总与 `1..N`（它在等子进程结束），汇总缺失同时覆盖 leak 与 hang 两种情况，
 * 单靠它无法分诊（首版实现即因此把 `setInterval` 泄漏误判成 hang）。
 *
 * 为什么不用 `--test-timeout` 判残留：实测对模块级句柄无效——该参数只作用于测试函数体内，
 * 泄漏文件仍会跑满超时（`setInterval` 泄漏用例在 none/process 两种模式下都是 exit 137 挂死）。
 *
 * 为什么超时必须杀**进程组**：per-file 隔离下 node 会为每个文件再派生一个 worker，只杀直接
 * 子进程会留下孤儿 worker——实测其继续持有 `127.0.0.1:19998`，污染后续所有运行。故 spawn 用
 * `detached: true` 建独立进程组，超时以 `kill(-pid)` 整组回收。同一机制由 PR-2 的 runner 采用。
 *
 * 为什么串行：本仓测试存在真实固定端口监听（lan-proxy 的 19090/19091/19092），并发探测会
 * 互相 `EADDRINUSE`（实测 8 文件并发抢同一端口 → 7/8 失败），得到的是假阳性而非分诊。
 *
 * 用法（仓库根执行）：
 *   node scripts/gate/probe-handles.mjs [--only <子串>] [--timeout <ms>] [--grace <ms>] [--idle <ms>] [--json]
 * 退出码：0 = 探测完成（探测结果本身不判红，它是分诊输入而非门禁）；2 = 用法错误。
 *
 * 纯函数与 CLI 分离（沿用 test-surface.mjs 的纪律）：`probeFile` / `triage` 可被测试 import，
 * import 时不枚举仓库、不 spawn 任何进程；只有直接执行本文件才跑 CLI。
 */
import { spawn } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUN_TESTS_PATTERN, discoverTestPackages, expandGlob } from './test-surface.mjs'

const DEFAULT_ROOT = join(import.meta.dirname, '..', '..')

/**
 * 单文件墙钟上限。为什么默认 6 分钟：最慢的 `dsh-mcp-manager/test/e2e/smoke.test.ts` 含 SDK
 * stdio 端到端，实测单跑 328s；上限低于它会把「慢」误判成 `hang`，而 hang 与慢的区分正是
 * 本探针要给出的信号，不能用会制造假阳性的默认值。
 */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000
/** 汇总输出后允许的退出延迟。正常文件在汇总后 <100ms 内退出，给 2s 余量吸收调度抖动。 */
const DEFAULT_GRACE_MS = 2000
/**
 * 静默窗口：仅在显式传 `--idle <ms>` 时启用，**默认关闭**。
 * 为什么默认关闭：它是纯启发式——把「测试跑起来过、又连续静默这么久」当作「跑完被句柄吊住」。
 * 实测 mcp-manager 的两个文件（e2e/smoke 与 unit/unit-middleware）在等待真实子进程时有约 30s
 * 的中间静默，30s 窗口把它们误判成 leak。分诊表的「干净」结论必须零假阳性，故默认不用启发式；
 * 需要快速扫一遍时再显式开它，并接受个别慢测试可能被误报（结果里 `stalled` 字段可用于识别）。
 */
const DEFAULT_IDLE_MS = 0

function usage(msg) {
  if (msg !== undefined) console.error(`probe-handles: ${msg}`)
  console.error('用法: node scripts/gate/probe-handles.mjs [--only <子串>] [--timeout <ms>] [--grace <ms>] [--idle <ms>] [--json]')
  process.exit(2)
}

function readFlag(argv, name, fallback) {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const raw = argv[i + 1]
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) usage(`${name} 需要一个非负整数，收到 "${raw}"`)
  return n
}

const argv = process.argv.slice(2)

/** 跑一次单文件探测（per-file 隔离）；返回原始证据，不做四态判定。 */
function runOnce(pkgDir, relFile, timeout, { forceExit = false, idleMs = 0 } = {}) {
  return new Promise((resolve) => {
    const args = ['--test', '--test-isolation=process', '--test-concurrency=1', '--test-reporter=tap']
    // `--test-force-exit` 只在探针的**对照组**里用。为什么不能只靠「TAP 汇总是否输出」判 leak：
    // 实测 per-file 隔离下子进程不退出时，父进程根本不会打印顶层汇总与 `1..N`（它在等子进程结束），
    // 所以汇总缺失既可能是 leak 也可能是 hang。force-exit 让「测试逻辑跑完即退出」，于是
    // A 超时而 B 正常退出 = 测试跑完、是句柄吊住了进程（leak）；A/B 都超时 = 测试本身没跑完（hang）。
    // 注意这与 runner 禁用该 flag 并不矛盾：那里它是假绿载体（截断悬挂 main 的断言），这里只作对照。
    if (forceExit) args.push('--test-force-exit')
    args.push(relFile)

    // 剔除 node:test 的 IPC 上下文：探针自身若跑在 `node --test` 内（回归测试就是这样调它的），
    // 子进程继承 NODE_TEST_CONTEXT 后会把测试事件上报给**外层** runner、stdout 不再是 TAP，
    // 探针的汇总/计划解析会全部落空（run-tests-runner.test.ts 记了同一坑）。
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_TEST_WORKER_ID

    const child = spawn(process.execPath, args, { cwd: pkgDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })

    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let summaryAt = null
    let timedOut = false
    let stalled = false
    let killFallback = null
    let done = false

    const settle = (code, signal) => {
      if (done) return
      done = true
      clearTimeout(hardTimer)
      if (idleTimer !== null) clearTimeout(idleTimer)
      if (killFallback !== null) clearTimeout(killFallback)
      const endedAt = Date.now()
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stalled,
        hasOutput: stdout.length > 0,
        elapsedMs: endedAt - startedAt,
        exitDelayMs: summaryAt === null ? null : endedAt - summaryAt,
        notOk: (stdout.match(/^not ok /gm) ?? []).length,
        plan: (stdout.match(/^1\.\.(\d+)$/m) ?? [])[1],
        stderrTail: stderr.trim().split('\n').slice(-6).join('\n'),
      })
    }

    // 整组回收：worker 与父 node 在同一进程组（detached 建组），只杀父会留孤儿。
    const hardKill = () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 组已消失 */ }
      // KILL 后仍不触发 exit 说明进程处于不可中断状态，兜底 settle 以免探针自身挂死。
      killFallback = setTimeout(() => settle(null, 'SIGKILL'), 10 * 1000)
    }

    const hardTimer = setTimeout(() => { timedOut = true; hardKill() }, timeout)

    /**
     * 静默判定：测试跑起来过（有输出）却长时间不再产出，说明它已经跑完、被残留句柄吊住。
     * 为什么必须要求「有过输出」：纯计算型测试可能长时间无输出，直接判 stall 会把「慢」误判成 leak。
     * 提前 kill 只是省时间，**结论仍以对照组为准**（对照组也超时即判 hang，误判会被兜回）。
     */
    let idleTimer = null
    const armIdle = () => {
      if (idleMs <= 0) return
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (stdout.length === 0) return
        stalled = true
        hardKill()
      }, idleMs)
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      // TAP 顶层汇总块以 `# duration_ms ` 结尾；子测试里的 `duration_ms:` 带缩进与冒号，不匹配。
      if (summaryAt === null && /^# duration_ms /m.test(stdout)) summaryAt = Date.now()
      armIdle()
    })
    child.stderr.on('data', (chunk) => { stderr += chunk; armIdle() })
    child.on('error', (err) => { stderr += `\nspawn 失败: ${err.message}`; settle(null, null) })
    child.on('exit', (code, signal) => settle(code, signal))
    armIdle()
  })
}

/** 探测单个文件；返回四态之一与计时/计数证据。 */
export async function probeFile(pkgDir, relFile, timeout, grace, idleMs = 0) {
  const a = await runOnce(pkgDir, relFile, timeout, { idleMs })
  let status
  let control = null

  if (a.timedOut || a.stalled) {
    // 对照组：A 被提前 kill 时按它已耗时给余量，避免对照组本身也跑满长超时。
    const controlTimeout = a.stalled && !a.timedOut
      ? Math.min(timeout, Math.max(a.elapsedMs * 2, 60 * 1000))
      : timeout
    control = await runOnce(pkgDir, relFile, controlTimeout, { forceExit: true, idleMs })
    if (!control.timedOut && !control.stalled) {
      status = control.exitCode !== 0 ? 'fail' : 'leak'
    } else {
      // 对照组也挂住：`--test-force-exit` 只对**注册了 node:test 测试**的文件生效，脚本式文件
      // （本仓多数）下它与 A 一样挂死——实测给脚本式文件注入 `setInterval` 后 A/B 都 exit 137
      // 且无 TAP 汇总。此时探针**无法**区分「句柄残留」与「测试没跑完」（连「有无输出」都区分
      // 不了：node --test 对任何文件都会先输出框架行），用静默启发式去猜会把慢测试的中间静默
      // 误报成 leak（mcp-manager 两个文件实测如此）。故如实报 stall，交人工看 stdout 定性。
      status = 'stall'
    }
  } else if (a.exitCode !== 0) {
    status = 'fail'
  } else if (a.exitDelayMs !== null && a.exitDelayMs > grace) {
    // 测试跑完但拖了很久才退出：句柄最终自行结束（如未清理的 setTimeout），仍属残留。
    status = 'leak'
  } else {
    status = 'clean'
  }

  return {
    file: relFile,
    status,
    exitCode: a.exitCode,
    signal: a.signal,
    timedOut: a.timedOut,
    stalled: a.stalled,
    hasOutput: a.hasOutput,
    elapsedMs: a.elapsedMs,
    exitDelayMs: a.exitDelayMs,
    controlElapsedMs: control === null ? null : control.elapsedMs,
    notOk: a.notOk,
    plan: a.plan === undefined ? null : Number(a.plan),
    stderrTail: status === 'clean' ? '' : a.stderrTail,
  }
}

/** 枚举仓库内（或注入的 fixture 根内）全部测试文件并**串行**探测。返回逐文件结果数组。 */
export async function triage(root, { only, timeoutMs, graceMs, idleMs = 0, onResult } = {}) {
  const targets = []
  for (const { pkgName } of discoverTestPackages(root)) {
    const pkgDir = join(root, 'packages', pkgName)
    for (const abs of expandGlob(pkgDir, RUN_TESTS_PATTERN)) {
      const rel = relative(pkgDir, abs).split(sep).join('/')
      if (only !== undefined && !`${pkgName}/${rel}`.includes(only)) continue
      targets.push({ pkgName, pkgDir, rel })
    }
  }
  const results = []
  for (const { pkgName, pkgDir, rel } of targets) {
    const r = { pkgName, ...(await probeFile(pkgDir, rel, timeoutMs, graceMs, idleMs)) }
    results.push(r)
    // 进度回调在探测**过程中**触发：leak 文件会占用数十秒到数分钟，没有进度就无法判断
    // 探针是在推进还是已经挂死（首版即因此盲等过一轮）。
    onResult?.(r, results.length, targets.length)
  }
  return results
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
  const timeoutMs = readFlag(argv, '--timeout', DEFAULT_TIMEOUT_MS)
  const graceMs = readFlag(argv, '--grace', DEFAULT_GRACE_MS)
  const idleMs = readFlag(argv, '--idle', DEFAULT_IDLE_MS)
  const asJson = argv.includes('--json')

  const results = await triage(DEFAULT_ROOT, {
    only,
    timeoutMs,
    graceMs,
    idleMs,
    onResult: (r, i, total) => {
      const delay = r.exitDelayMs === null ? '-' : `${r.exitDelayMs}ms`
      console.error(`[${i}/${total}] ${r.status.padEnd(5)} ${String(r.elapsedMs).padStart(8)}ms  汇总后 ${delay.padStart(8)}  ${r.pkgName}/${r.file}`)
      if (r.stderrTail !== '') console.error(r.stderrTail.split('\n').map((l) => `        | ${l}`).join('\n'))
    },
  })
  if (results.length === 0) usage(`--only "${only}" 没有匹配到任何测试文件`)

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  } else {
    const counts = {}
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
    console.log(`\n分诊汇总（${results.length} 个文件）: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    for (const status of ['leak', 'stall', 'fail']) {
      const hit = results.filter((r) => r.status === status)
      if (hit.length === 0) continue
      console.log(`\n[${status}] ${hit.length} 个：`)
      for (const r of hit) console.log(`  ${r.pkgName}/${r.file}`)
    }
  }
}
