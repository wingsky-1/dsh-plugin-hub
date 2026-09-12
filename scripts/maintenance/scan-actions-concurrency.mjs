#!/usr/bin/env node
/**
 * scripts/maintenance/scan-actions-concurrency.mjs —— Actions 并发峰值扫描（#718 S0.3）。
 *
 * 为什么需要它：`observe.yml` 把全部变异段串行放在**单个 job** 内，所以夜班日志里看不到
 * 任何并发信息；账户的并发额度只能从**多 job 矩阵**的 run（`ci.yml` 的 build-test 与
 * mutation-gate）反推。S1.1 的「变异矩阵化 + `max-parallel: N`」需要一个实测上界，
 * 而不是推断值——本脚本给出该上界及其饱和特征（额度用满后 job 会呈「一个结束→一个开始」
 * 的严格配对）。
 *
 * 判据（为什么是「峰值 + 配对形态」而不是只看峰值）：单看峰值无法区分「额度上限是 20」
 * 与「恰好同时有 20 个 job 就绪」。额度饱和的特征是峰值处**长时间维持**且新增只会发生在
 * 有 job 结束之后——脚本按事件序列打印该形态，供人工判读。
 *
 * 定位：维护者/本地工具，需 gh 与网络，**不进 CI**（进 CI 属 `.github/` 红线段）。
 *
 * 用法：
 *   node scripts/maintenance/scan-actions-concurrency.mjs [样本数] [--top N] [--run <id>]
 *   例：node scripts/maintenance/scan-actions-concurrency.mjs 100 --top 5
 *       node scripts/maintenance/scan-actions-concurrency.mjs --run 34628767342
 *
 * 退出码：0 = 扫描完成；2 = 环境错误（gh 不可用 / 无样本）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const REPO = 'wingsky-1/dsh-plugin-hub'

function ghJson(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  } catch (e) {
    console.error(`[scan] gh 调用失败：${String(e.message).split('\n')[0]}`)
    return null
  }
}

/**
 * 半开区间扫描：返回同时运行的 job 数峰值、峰值维持区间，以及峰值后的运行数上界。
 *
 * 饱和判据（三者同时成立才说明「峰值＝额度上限」而非「恰好凑巧」）：
 *   1. 峰值在多个相互独立的 run 上完全一致；
 *   2. 峰值维持一段时间（不是瞬时尖峰）；
 *   3. 峰值之后运行数**从未超过**峰值——新 job 只能等旧 job 让位。
 */
export function peakConcurrency(jobs) {
  const events = []
  for (const j of jobs) {
    if (!j.started_at || !j.completed_at) continue
    const s = Date.parse(j.started_at)
    const e = Date.parse(j.completed_at)
    if (!(e > s)) continue // skipped / 零宽度 job 不占并发
    events.push({ at: s, delta: 1, name: j.name })
    events.push({ at: e, delta: -1, name: j.name })
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let cur = 0
  let peak = 0
  let peakAt = null
  let peakUntil = null
  let maxAfterPeak = 0
  for (const ev of events) {
    cur += ev.delta
    if (cur > peak) {
      peak = cur
      peakAt = ev.at
      peakUntil = null
    } else if (peakAt !== null && cur < peak && peakUntil === null) {
      peakUntil = ev.at
    }
    if (peakUntil !== null) maxAfterPeak = Math.max(maxAfterPeak, cur)
  }
  return {
    peak,
    peakAt,
    peakUntil,
    countedJobs: events.filter((e) => e.delta === 1).length,
    maxAfterPeak,
    heldSeconds: peakUntil === null ? 0 : Math.round((peakUntil - peakAt) / 1000),
  }
}

function scanRun(runId) {
  const d = ghJson(['api', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`])
  if (d === null) return null
  const jobs = d.jobs ?? []
  const r = peakConcurrency(jobs)
  console.log(`\n== run ${runId} ==`)
  console.log(`job 总数 ${jobs.length}，计入并发 ${r.countedJobs}`
    + `，峰值 ${r.peak}（首达 ${new Date(r.peakAt).toISOString()}，维持 ${r.heldSeconds}s）`)
  console.log(`峰值后运行数上界 ${r.maxAfterPeak}`
    + `（${r.maxAfterPeak <= r.peak ? '未超过峰值 → 新 job 只能等旧 job 让位，符合额度饱和' : '超过峰值 → 峰值是瞬时尖峰，不能据此定标'}）`)
  return { runId, ...r, totalJobs: jobs.length }
}

function main() {
  const runId = flag('--run')
  if (runId !== undefined) {
    const r = scanRun(runId)
    return r === null ? 2 : 0
  }
  const limit = Number(argv.find((a) => /^\d+$/.test(a)) ?? 40)
  const top = Number(flag('--top') ?? 8)
  const runs = ghJson(['run', 'list', '--repo', REPO, '--limit', String(limit),
    '--json', 'databaseId,name,event,createdAt,conclusion'])
  if (runs === null || runs.length === 0) {
    console.error('[scan] 未取到 run 列表')
    return 2
  }
  console.log(`扫描 ${runs.length} 个 run 的 job 时间线…`)
  const rows = []
  for (const r of runs) {
    const d = ghJson(['api', `repos/${REPO}/actions/runs/${r.databaseId}/jobs?per_page=100`])
    if (d === null) continue
    const { peak, countedJobs, heldSeconds } = peakConcurrency(d.jobs ?? [])
    rows.push({ peak, heldSeconds, runId: r.databaseId, workflow: r.name, event: r.event, createdAt: r.createdAt, countedJobs })
  }
  rows.sort((a, b) => b.peak - a.peak || b.countedJobs - a.countedJobs)
  console.log(`\n${'peak'.padStart(5)} ${'held_s'.padStart(6)} ${'jobs'.padStart(5)}  ${'run_id'.padStart(12)}  event           createdAt`)
  for (const r of rows.slice(0, top)) {
    console.log(`${String(r.peak).padStart(5)} ${String(r.heldSeconds).padStart(6)} ${String(r.countedJobs).padStart(5)}  ${String(r.runId).padStart(12)}  ${r.event.padEnd(15)} ${r.createdAt}`)
  }
  const max = rows.length > 0 ? rows[0].peak : 0
  console.log(`\n实测并发峰值 max=${max}（样本 ${rows.length}）`)
  if (max > 0) {
    const winner = rows[0]
    console.log(`最高样本 run ${winner.runId} —— 用 --run ${winner.runId} 查看饱和形态`)
  }
  return 0
}

// CLI 守卫：被 import 时（argv[1] 不是本文件）不执行 main，便于复用 peakConcurrency。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
