/**
 * scripts/lib/mutation-ledger-lib.mjs —— 变异段实测台账的解析与对账纯函数（#718 S0.2）。
 *
 * 为什么需要它：`observe*.yml` 的变异段逐段耗时只存在于 Actions run 日志里，仓库内没有
 * 任何持久记录；而「最近一次测量」的判据如果取文件 mtime，会被增量班次反复刷新成永远新鲜
 * （段文件被重写但内容并未重测），从而让陈旧基线看起来是新的。故台账的唯一可信来源是
 * **run 日志解析出的真实执行时间**，字段为 `wallSeconds`（段 group 边界的墙钟），
 * 与文件时间戳无任何关系。
 *
 * 为什么是纯函数：CLI 侧（`scripts/gate/mutation-ledger.mjs`）需要网络（拉 run 日志），
 * 不能进 CI；而入库台账的**对账断言**必须在 `test:scripts` 内离线可跑。故这里只放
 * 无副作用的解析与对账函数，两侧共用同一份实现——避免「生成侧一套口径、断言侧一套口径」。
 */

/** Stryker 段在 GHA 日志里的 group 名（`stryker <conf-base-name>`，见 observe*.yml 的循环）。 */
const GROUP_PREFIX = 'stryker '

/** 日志行时间戳（GHA 前缀 `2026-09-11T08:32:48.1054450Z`，小数位不定长）。 */
const TIMESTAMP = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+)Z/

/** ANSI 颜色转义（Stryker 的 reporter 输出带色）。 */
const ANSI = /\u001b\[[0-9;]*m/g

/** `gh run view --log` 的行前缀：`<job>\t<step>\t<timestamp>Z <content>`（时间戳与正文间有一个空格）。 */
export function parseLogLine(line) {
  const parts = line.split('\t')
  if (parts.length < 3) return null
  const rest = parts.slice(2).join('\t')
  const m = TIMESTAMP.exec(rest)
  if (m === null) return null
  // trimStart：时间戳与正文之间的分隔空格必须剥掉，否则 `##[group]` 前缀判定永不成立
  // （实测 gh 日志恒为 `<ts>Z <content>` 单空格形态）。
  const body = rest.slice(m.index + m[0].length).replace(ANSI, '').trimStart()
  return { job: parts[0], step: parts[1], at: m[1], body }
}

/**
 * 解析一段（group 内）的文本，抽取 Stryker 自报的量化字段。
 * 字段全部可选：`Done in` 在段被取消/失败时不会出现，缺失即 null（不得用 0 冒充）。
 */
export function parseSegmentBody(lines) {
  const text = lines.join('\n')
  const mutants = /with (\d+) mutant/.exec(text)
  const dry = /Ran (\d+) tests in (\d+) seconds/.exec(text)
  const reuse = /(\d+) of (\d+) mutant result\(s\) are reused/.exec(text)
  const done = /Done in ([^.]+)\./.exec(text)
  return {
    mutants: mutants === null ? null : Number(mutants[1]),
    dryTests: dry === null ? null : Number(dry[1]),
    dryRunSeconds: dry === null ? null : Number(dry[2]),
    reused: reuse === null ? null : Number(reuse[1]),
    reuseTotal: reuse === null ? null : Number(reuse[2]),
    strykerReported: done === null ? null : done[1].trim(),
  }
}

/**
 * 从 GHA 原始日志解析逐段实测。同一份台账要能读两种日志形态，故按优先级回退：
 *
 *   1. **group 形态**（#718 S1.1 之前的串行班）：`observe.yml` 在循环里用
 *      `echo "::group::stryker <seg>"` 包裹每个 `npx stryker run`，段边界即 group 边界。
 *   2. **矩阵形态**（#718 S1.1 之后）：每段是独立 job、无 group 包裹，见 `parseByShardJob`。
 *
 * 为什么矩阵形态必须支持而不是让它「退化」：矩阵化不改变段语义，只改变日志载体；
 * 解析器只认一种形态会让台账在结构改造后**静默停止更新**（生成侧报「未解析到任何段」，
 * 而断言侧仍绿）——#754 落地后本函数首次实测即命中该缺口。
 *
 * 栈式配对 group 而不是「取下一个 group 起点」：Stryker 自身的输出里也可能出现
 * `##[group]`，用后者会把段边界切错。段被杀导致 group 未闭合时该段不出现在结果里
 * （宁缺勿造，不得用 0 冒充有效测量）。
 */
export function parseSegmentLedger(logText) {
  const byGroup = parseByGroup(logText)
  if (byGroup.length > 0) return byGroup
  return parseByShardJob(logText)
}

/** group 形态：栈式配对 `##[group]stryker <seg>` 与 `##[endgroup]`，段墙钟取两者时间差。 */
function parseByGroup(logText) {
  const raw = logText.split('\n')
  const events = []
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseLogLine(raw[i])
    if (parsed === null) continue
    if (parsed.body.startsWith('##[group]' + GROUP_PREFIX)) {
      events.push({ kind: 'open', line: i, at: parsed.at, seg: parsed.body.slice(('##[group]' + GROUP_PREFIX).length).trim() })
    } else if (parsed.body.startsWith('##[endgroup]')) {
      events.push({ kind: 'close', line: i, at: parsed.at })
    }
  }
  const stack = []
  const out = []
  for (const ev of events) {
    if (ev.kind === 'open') {
      stack.push(ev)
      continue
    }
    const open = stack.pop()
    if (open === undefined) continue
    const body = []
    for (let i = open.line; i <= ev.line; i++) {
      const parsed = parseLogLine(raw[i])
      if (parsed !== null) body.push(parsed.body)
    }
    out.push({
      seg: open.seg,
      startedAt: open.at,
      endedAt: ev.at,
      wallSeconds: secondsBetween(open.at, ev.at),
      ...parseSegmentBody(body),
    })
  }
  return out
}

/** 矩阵实例的 job 名 → 段名（`Mutation shard (dsh-notifier-sdk)` → `dsh-notifier-sdk`）。 */
const SHARD_JOB = /^Mutation shard \((.+)\)$/

/**
 * 段内的 Stryker 输出特征（两种形态都要认）：
 *   - logger 行：`08:05:21 (2726) INFO Instrumenter …`
 *   - 进度行：`Mutation testing 64% (elapsed: ~8m…) 322/475 tested`（progress-append-only
 *     reporter，**不带** `(pid) INFO` 前缀）
 * 为什么按内容而不是按步骤名定位：GHA 在部分 job 上会把步骤名解析成 `UNKNOWN STEP`
 * （实测本次 33 个 shard 里有 11 个如此），按步骤名过滤会静默漏段——而漏段正是
 * 「覆盖全部段」断言要防的方向。
 */
const SEGMENT_OUTPUT = /(\(\d+\) INFO |^Mutation testing \d+%)/

/**
 * 矩阵形态（#718 S1.1 之后）：每段是**独立 job**（名为 `Mutation shard (<seg>)`），没有
 * group 包裹，段范围改用该 job 内**以 `Mutation shard` 开头的步骤**（与 job 名同源）。
 *
 * 为什么不取「INFO 行的首末」：Stryker 的进度行来自 progress-append-only reporter，
 * 形如 `Mutation testing 64% (elapsed: ~8m…) 322/475 tested`，**不带 `(pid) INFO` 前缀**；
 * 只认 INFO 会在段被杀的实例上严重低估墙钟（实测 events：真实 10.3 min 被算成 30 s），
 * 而低估正是超时定标最危险的偏差方向。
 *
 * 为什么不取 job 起止：job 还含 checkout / install / build，取它会把固定开销算进
 * 「段执行时间」，与 group 形态不可比（实测同段 job 墙钟比段墙钟多约 20~30 s）。
 * 无该步骤输出的实例（install 阶段就失败）不产出记录——没有可测的执行时间。
 */
function parseByShardJob(logText) {
  const byJob = new Map()
  for (const line of logText.split('\n')) {
    const parsed = parseLogLine(line)
    if (parsed === null) continue
    const m = SHARD_JOB.exec(parsed.job)
    if (m === null) continue
    if (!byJob.has(m[1])) byJob.set(m[1], [])
    byJob.get(m[1]).push(parsed)
  }
  const out = []
  for (const [seg, entries] of byJob) {
    const output = entries.filter((e) => SEGMENT_OUTPUT.test(e.body))
    if (output.length === 0) continue
    const startedAt = output[0].at
    const endedAt = output[output.length - 1].at
    out.push({
      seg,
      startedAt,
      endedAt,
      wallSeconds: secondsBetween(startedAt, endedAt),
      ...parseSegmentBody(output.map((e) => e.body)),
    })
  }
  return out.sort((a, b) => a.seg.localeCompare(b.seg))
}

function secondsBetween(a, b) {
  return Math.round(((Date.parse(b + 'Z') - Date.parse(a + 'Z')) / 1000) * 10) / 10
}

/**
 * 台账「覆盖全部段」对账：实测段集合必须与期望段集合**精确相等**。
 *
 * 为什么必须相等而不是包含：漏段（测量没覆盖某个段）会让 S1.4 的超时分位数与 #742 的
 * wall-clock 上界基于不完整数据；多段（段已改名/删除而台账未更新）说明台账与
 * `stryker.conf.d/` 已脱节。两种都必须判红——拆段/加包后必须重测并更新台账。
 */
export function reconcileLedgerSegments(measuredSegs, expectedSegs) {
  const measured = new Set(measuredSegs)
  const expected = new Set(expectedSegs)
  return {
    missing: [...expected].filter((s) => !measured.has(s)).sort(),
    extra: [...measured].filter((s) => !expected.has(s)).sort(),
    ok: measured.size === expected.size && [...expected].every((s) => measured.has(s)),
  }
}

/**
 * 台账条目字段完整性校验（结构不变量，与具体数值无关）。
 * 返回问题清单（空数组 = 通过）。`wallSeconds` 必须是正数——它是台账的核心量，
 * 取 0 或负数说明解析失败却被当成有效测量写入。
 */
export function checkLedgerEntry(entry) {
  const problems = []
  if (typeof entry?.seg !== 'string' || entry.seg.trim() === '') problems.push('seg 缺失')
  if (typeof entry?.wallSeconds !== 'number' || !(entry.wallSeconds > 0)) problems.push(`${entry?.seg}: wallSeconds 必须是正数`)
  if (entry?.mutants !== null && !(Number.isInteger(entry?.mutants) && entry.mutants > 0)) problems.push(`${entry?.seg}: mutants 缺失或非正整数`)
  if (entry?.reused !== null && entry?.reuseTotal !== null && !(entry.reused >= 0 && entry.reused <= entry.reuseTotal)) {
    problems.push(`${entry?.seg}: reused 必须在 [0, reuseTotal] 内`)
  }
  return problems
}

/** 由 `stryker.conf.d/` 的文件名派生期望段集合（与 ci-matrix / mutation-gate 同源口径）。 */
export function expectedSegsFromConfFiles(confFileNames) {
  return confFileNames
    .filter((f) => f.startsWith('dsh-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}
