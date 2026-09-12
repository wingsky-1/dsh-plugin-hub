#!/usr/bin/env node
/**
 * scripts/gate/mutation-ledger.mjs —— 变异段实测台账的生成与校验（#718 S0.2）。
 *
 * 定位：**维护者/本地工具，不进 CI**。生成模式要拉 Actions run 日志（需要 gh 与网络），
 * 而入库台账的校验（--check）是离线的、由 test:scripts 调用。之所以不做成 CI 采集步骤：
 * 那会改动 `.github/workflows/`（红线段），而本项是零红线的测量任务。
 *
 * 台账的唯一可信量是 `wallSeconds`：**段执行时间**取自 run 日志，而不是段配置文件的时间戳
 * （增量班次会周期性重写这些文件，mtime 永远是「刚刚」，无法区分「真的重测过」与「只是被
 * 重写」）。日志有两种载体形态，解析器都要认（见 `mutation-ledger-lib.mjs`）：
 *   - group 形态（#718 S1.1 之前的串行班）：`##[group]stryker <seg>` 与配对 `##[endgroup]`；
 *   - 矩阵形态（S1.1 之后，每段一个独立 job）：job 名 `Mutation shard (<seg>)` + 段内输出特征。
 *
 * 生成时**排除结论非 success 的 shard**：被杀实例的日志只到中途，采信它会系统性低估耗时
 * （实测 run 34681565987 的 events / server 即如此），而低估是超时定标里最危险的方向。
 *
 * 用法：
 *   node scripts/gate/mutation-ledger.mjs --run <run-id> [--workflow <name>] --scope incremental --write
 *   node scripts/gate/mutation-ledger.mjs --from-log <path> --run <id> [--workflow <n>] --scope <s> --write
 *   node scripts/gate/mutation-ledger.mjs --check      # 离线校验入库台账（覆盖全部段 + 字段完整）
 *
 * 退出码：0 = 通过；1 = 校验失败；2 = 环境/用法错误。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkLedgerEntry,
  expectedSegsFromConfFiles,
  parseSegmentLedger,
  reconcileLedgerSegments,
} from '../lib/mutation-ledger-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONF_DIR = join(ROOT, 'stryker.conf.d')
const LEDGER_PATH = join(ROOT, 'scripts', 'data', 'mutation-segment-ledger.json')
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

function currentSegs() {
  return expectedSegsFromConfFiles(readdirSync(CONF_DIR))
}

/** 台账的段索引：测量值 ∪ 显式登记为「尚未测到」的段（两者共同构成「覆盖全部段」）。 */
export function ledgerCoverage(ledger) {
  const measured = new Set()
  for (const m of ledger.measurements ?? []) for (const s of m.segments ?? []) measured.add(s.seg)
  const unmeasured = new Set(Object.keys(ledger.unmeasured ?? {}))
  return { measured, unmeasured, all: new Set([...measured, ...unmeasured]) }
}

/** 离线校验：覆盖全部段（不漏不重）+ 每条记录字段完整 + unmeasured 必有理由 + 游离段必有 superseded 登记。 */
export function checkLedger(ledger, expected) {
  const problems = []
  const { measured, unmeasured, all } = ledgerCoverage(ledger)
  const expectedSet = new Set(expected)
  const superseded = ledger.superseded ?? {}
  for (const s of expectedSet) if (!all.has(s)) problems.push(`台账未覆盖段：${s}（既无测量值，也未登记进 unmeasured）`)
  for (const s of all) {
    if (expectedSet.has(s)) continue
    // 段被拆分/更名后，历史测量值仍有对照价值，故不要求删除；但必须显式登记取代关系，
    // 否则「段集合与 stryker.conf.d 脱节」这件事会静默存在（漏段的反面同样危险）。
    const sup = superseded[s]
    if (sup === undefined) {
      problems.push(`台账存在游离段：${s}（当前 stryker.conf.d 已无该段；若已被拆分/更名，请在 superseded 登记取代关系）`)
      continue
    }
    if (!Array.isArray(sup.replacedBy) || sup.replacedBy.length === 0) problems.push(`superseded.${s} 缺少 replacedBy`)
    for (const r of sup.replacedBy ?? []) {
      if (!expectedSet.has(r)) problems.push(`superseded.${s}.replacedBy 指向当前不存在的段：${r}`)
    }
    if (typeof sup.reason !== 'string' || sup.reason.trim() === '') problems.push(`superseded.${s} 缺少 reason`)
  }
  for (const s of measured) if (unmeasured.has(s)) problems.push(`段 ${s} 同时出现在测量值与 unmeasured 中（语义冲突）`)
  for (const [s, reason] of Object.entries(ledger.unmeasured ?? {})) {
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`unmeasured.${s} 缺少理由（必须写明为何尚无测量值）`)
  }
  for (const m of ledger.measurements ?? []) {
    if (typeof m.run?.id !== 'number') problems.push('measurements 条目缺少 run.id')
    if (typeof m.scope !== 'string' || m.scope.trim() === '') problems.push(`run ${m.run?.id}: scope 缺失`)
    const segs = m.segments ?? []
    if (segs.length === 0) problems.push(`run ${m.run?.id}: segments 为空`)
    const seen = new Set()
    for (const s of segs) {
      if (seen.has(s.seg)) problems.push(`run ${m.run?.id}: 段 ${s.seg} 重复登记`)
      seen.add(s.seg)
      problems.push(...checkLedgerEntry(s).map((p) => `run ${m.run?.id}: ${p}`))
    }
  }
  return problems
}

function ghRunMeta(runId) {
  try {
    return JSON.parse(execFileSync('gh', ['run', 'view', String(runId), '--repo', 'wingsky-1/dsh-plugin-hub',
      '--json', 'databaseId,name,event,conclusion,createdAt,headSha'], { encoding: 'utf8' }))
  } catch (e) {
    console.error(`[ledger] 读取 run ${runId} 元数据失败：${String(e.message).split('\n')[0]}`)
    process.exit(2)
  }
}

/**
 * 该 run 里结论非 success 的 shard 段名集合（其日志只到中途，耗时不可作实测）。
 * 对 group 形态（#718 S1.1 之前的单 job 串行班）job 名不匹配，返回空集——旧路径不受影响。
 */
function incompleteShardSegs(runId) {
  try {
    const d = JSON.parse(execFileSync('gh', ['api',
      `repos/wingsky-1/dsh-plugin-hub/actions/runs/${runId}/jobs?per_page=100`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    const out = new Set()
    for (const j of d.jobs ?? []) {
      if (j.conclusion === 'success') continue
      const m = /^Mutation shard \((.+)\)$/.exec(j.name ?? '')
      if (m !== null) out.add(m[1])
    }
    return out
  } catch (e) {
    console.error(`[ledger] 读取 run ${runId} 的 job 列表失败：${String(e.message).split('\n')[0]}`)
    process.exit(2)
  }
}

function main() {
  const isCheck = argv.includes('--check')
  if (isCheck) {
    if (!existsSync(LEDGER_PATH)) {
      console.error(`[ledger] 台账不存在：${LEDGER_PATH}`)
      return 2
    }
    const problems = checkLedger(JSON.parse(readFileSync(LEDGER_PATH, 'utf8')), currentSegs())
    for (const p of problems) console.error(`[ledger] ${p}`)
    if (problems.length > 0) {
      console.error(`[ledger] --check 失败：${problems.length} 项（拆段/加包后必须重测并更新台账）`)
      return 1
    }
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
    const { measured, unmeasured } = ledgerCoverage(ledger)
    const cur = new Set(currentSegs())
    const historical = [...measured].filter((s) => !cur.has(s))
    console.log(`[ledger] --check 通过：覆盖全部 ${cur.size} 段`
      + `（已测 ${[...measured].filter((s) => cur.has(s)).length} + 待测 ${unmeasured.size}）`
      + (historical.length > 0 ? `；历史段 ${historical.length} 条已在 superseded 登记取代关系` : ''))
    return 0
  }

  const runId = opt('--run')
  const fromLog = opt('--from-log')
  if (runId === undefined || fromLog === undefined) {
    console.error('用法：--run <id> --from-log <path> [--workflow <name>] --scope <full|incremental> --write')
    return 2
  }
  const scope = opt('--scope')
  if (scope !== 'full' && scope !== 'incremental') {
    console.error('[ledger] --scope 必须是 full 或 incremental（口径必须显式，否则耗时不可比）')
    return 2
  }
  const logText = readFileSync(fromLog, 'utf8')
  const parsed = parseSegmentLedger(logText)
  if (parsed.length === 0) {
    console.error(`[ledger] 日志中未解析到任何 stryker 段：${fromLog}（run 未跑变异，或日志格式已变）`)
    return 2
  }
  const meta = ghRunMeta(runId)
  // 未完成的段不得当实测写入：被 timeout 杀掉的 shard 也会留下日志（跑到 N% 就断），
  // 直接采信会把「未跑完的时间」当成该段的耗时，系统性**低估**——而这正是超时定标里
  // 最危险的方向（实测 run 34681565987 的 events / server 即如此）。故按 job 结论过滤。
  const incomplete = incompleteShardSegs(runId)
  const segments = parsed.filter((s) => !incomplete.has(s.seg))
  for (const s of parsed) {
    if (incomplete.has(s.seg)) {
      console.error(`[ledger] 排除未完成段 ${s.seg}（job 非 success：日志只到中途，时间不可作为实测）`)
    }
  }
  const entry = {
    run: {
      id: meta.databaseId,
      workflow: opt('--workflow') ?? meta.name,
      event: meta.event,
      conclusion: meta.conclusion,
      createdAt: meta.createdAt,
      headSha: meta.headSha,
    },
    scope,
    measuredAt: new Date().toISOString(),
    logSource: `gh run view ${runId} --log`,
    segments,
  }
  const ledger = existsSync(LEDGER_PATH)
    ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
    : { $comment: '', measurements: [], unmeasured: {} }
  ledger.measurements = (ledger.measurements ?? []).filter((m) => m.run?.id !== entry.run.id)
  ledger.measurements.push(entry)
  const covered = new Set(segments.map((s) => s.seg))
  for (const s of covered) delete ledger.unmeasured[s]
  ledger.measurements.sort((a, b) => (a.run?.id ?? 0) - (b.run?.id ?? 0))
  if (argv.includes('--write')) {
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
    console.log(`[ledger] 已写入 ${LEDGER_PATH}：run ${entry.run.id} ${segments.length} 段（scope=${scope}）`)
  } else {
    console.log(JSON.stringify(entry, null, 2))
  }
  const problems = checkLedger(ledger, currentSegs())
  for (const p of problems) console.error(`[ledger] ${p}`)
  return problems.length === 0 ? 0 : 1
}

// CLI 守卫：被测试 import 时（argv[1] 不是本文件）不得执行 main，避免测试进程被 exit 带走。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
