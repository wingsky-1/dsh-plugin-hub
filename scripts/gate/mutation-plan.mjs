#!/usr/bin/env node
/**
 * scripts/gate/mutation-plan.mjs —— 夜间变异矩阵的段清单与逐段超时派生（#718 S1.1 / S1.4）。
 *
 * 为什么单独成脚本：GHA 的动态 matrix 只能引用 needs 的 output（不能读工作区文件），
 * 而「哪些段要跑」的唯一事实源是 `stryker.conf.d/*.json`（段集合随拆段/加包自动演进）。
 * 故由一个秒级 plan job 把「文件系统事实」翻译成 matrix 可消费的 JSON。
 *
 * 为什么超时按段派生而不是取一个全局值：#718 的两次事故都是**单段擦边超时**
 * （run 34536263640 的 mcp-manager-runtime 21.2 min 对 90 min 的整班预算）。矩阵化后
 * 每段独立 job，超时若仍取全局值，长段会把短段的风险预算一并吃掉；按段取实测 P95
 * 才能让「单段异常」只影响单段。
 *
 * 超时取值（口径必须随数字一起引用）：
 *   - 有 `scope=full` 实测的段：`ceil(实测最长 wallSeconds / 60 × 1.5) + 构建开销`（1.5 为安全系数）；
 *   - 无实测的段：`DEFAULT_TIMEOUT_MINUTES`（保守值，与 ci.yml 的 mutation-gate 同源）；
 *   - 一律不低于 `TIMEOUT_FLOOR_MINUTES`（#718 整合版规定的下限）。
 * 之所以只用 `scope=full` 的实测：全量冷跑的段耗时可达同段增量耗时（有基线复用）的数倍
 * （实测 mcp-manager-supervisor：全量 10.19 min 对增量 104 s，约 5.9 倍），拿增量值定超时会
 * 造成系统性擦边。
 *
 * 用法：node scripts/gate/mutation-plan.mjs        # 打印 matrix JSON（供 GITHUB_OUTPUT）
 * 退出码：0 = 成功；2 = 环境错误（conf 目录为空 / 台账不可解析）。
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONF_DIR = join(ROOT, 'stryker.conf.d')
const LEDGER_PATH = join(ROOT, 'scripts', 'data', 'mutation-segment-ledger.json')

/** 无全量实测时的保守超时（与 ci.yml 的 mutation-gate 一致，该 job 已覆盖过最坏冷跑）。 */
export const DEFAULT_TIMEOUT_MINUTES = 30
/** #718 整合版规定的下限：低于它会让短段在正常的 runner 抖动下擦边。 */
/**
 * 超时下限。取值依据（2026-09-12 实测 run 34681565987）：
 *
 * 整合版 S1.4 规定「下限 10 分钟」，但实测证明 10 分钟**不够**——`dsh-notifier-events`
 * 与 `dsh-notifier-server` 都卡在下限被杀，其中 events 被杀时只跑到 67%（336/475，
 * elapsed ~9m / remaining ~4m），即该段实际需要约 13 分钟。根因是台账里的 full 实测
 * 来自两天前的 run，而主干测试面已增长（#748 等），1.5 倍安全系数不足以吸收。
 *
 * 为什么提到 20：13 分钟实测 + 约 7 分钟余量吸收 runner 抖动与后续增长。GHA 的
 * `timeout-minutes` 是**上限**——放宽不影响正常执行，只影响卡死时多久放弃；而误杀的
 * 代价（基线丢段 + 报告缺失导致整班判红）远大于多等几分钟。整合版给的是下限的
 * **最小值要求**，提高不违反。
 */
export const TIMEOUT_FLOOR_MINUTES = 20
/** checkout + pnpm install + 全量 build 的墙钟开销（矩阵实例每段都要付一次）。 */
export const SETUP_OVERHEAD_MINUTES = 4
/** 实测值的放大系数：runner 抖动 + 主干代码增长。 */
export const SAFETY_FACTOR = 1.5

/** 段清单：`stryker.conf.d/dsh-*.json` 的文件名去 `.json`（与 ci-matrix / mutation-gate 同源口径）。 */
export function listSegments(confDir = CONF_DIR) {
  return readdirSync(confDir)
    .filter((f) => f.startsWith('dsh-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

/** 从台账抽取每段在 `scope=full` 下的最长实测墙钟（秒）；无实测的段不出现在结果里。 */
export function fullScopePeaks(ledger) {
  const peaks = new Map()
  for (const m of ledger?.measurements ?? []) {
    if (m.scope !== 'full') continue
    for (const s of m.segments ?? []) {
      if (typeof s.wallSeconds !== 'number' || !(s.wallSeconds > 0)) continue
      const prev = peaks.get(s.seg) ?? 0
      if (s.wallSeconds > prev) peaks.set(s.seg, s.wallSeconds)
    }
  }
  return peaks
}

/** 单段超时（分钟）：有全量实测则按其放大 + 构建开销，否则取保守默认；一律不低于下限。 */
export function timeoutForSegment(seg, peaks) {
  const measured = peaks.get(seg)
  if (measured === undefined) return DEFAULT_TIMEOUT_MINUTES
  const minutes = Math.ceil((measured / 60) * SAFETY_FACTOR + SETUP_OVERHEAD_MINUTES)
  return Math.max(TIMEOUT_FLOOR_MINUTES, minutes)
}

/** 生成 matrix：`[{ seg, timeoutMinutes }]`，按段名字典序（与 conf 目录顺序一致，便于比对）。 */
export function buildShardMatrix(segs, peaks) {
  return segs.map((seg) => ({ seg, timeoutMinutes: timeoutForSegment(seg, peaks) }))
}

function main() {
  const segs = listSegments()
  if (segs.length === 0) {
    console.error(`[mutation-plan] ${CONF_DIR} 下无 dsh-*.json —— 段集合为空（fail-closed）`)
    return 2
  }
  let ledger = null
  if (existsSync(LEDGER_PATH)) {
    try {
      ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'))
    } catch (e) {
      console.error(`[mutation-plan] 台账不可解析：${LEDGER_PATH} —— ${String(e.message).split('\n')[0]}`)
      return 2
    }
  }
  const peaks = fullScopePeaks(ledger)
  const matrix = buildShardMatrix(segs, peaks)
  const measured = matrix.filter((m) => peaks.has(m.seg)).length
  const json = JSON.stringify(matrix)
  // 诊断走 stderr：stdout 只放 matrix JSON，避免污染 GITHUB_OUTPUT
  console.error(`[mutation-plan] ${matrix.length} 段；其中 ${measured} 段有全量实测超时，`
    + `${matrix.length - measured} 段用保守默认 ${DEFAULT_TIMEOUT_MINUTES} min；`
    + `超时区间 ${Math.min(...matrix.map((m) => m.timeoutMinutes))}~${Math.max(...matrix.map((m) => m.timeoutMinutes))} min`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `shards=${json}\n`, 'utf8')
    console.log(`shards 已写入 GITHUB_OUTPUT（${matrix.length} 项）`)
  } else {
    console.log(`shards=${json}`)
  }
  return 0
}

// CLI 守卫：被测试 import 时不执行 main（纯函数可离线复用）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
