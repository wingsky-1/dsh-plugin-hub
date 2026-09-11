#!/usr/bin/env node
/**
 * scripts/test/mutation-probe.mjs — 变异度量可信度探针（#722）。
 *
 * 为什么需要它：变异得分不是绝对指标，它依赖**测试运行器的覆盖分析与变异激活是否正确**。
 * 换 runner、升 vitest、升 Stryker 都可能让得分变化，而得分本身无法区分两种成因：
 *   ① 测试真的退化（缺陷能被测出 → 该杀却没杀，是**真缺口**，补测试有效）
 *   ② 工具的变异没生效（测试其实能杀 → 报 Survived，是**runner 漏判**，补测试无效）
 * #722 的 runner 切换（tap → vitest）实测同时命中这两类，故把分辨手段固化为可执行检查。
 *
 * 做法：抽样报告里状态为 Survived 的变异体，按 location 把 replacement 写回源码，
 * 跑该包测试，再恢复源码——测试失败 ⇒ runner 漏判；测试通过 ⇒ 真缺口。
 *
 * 用法：
 *   node scripts/test/mutation-probe.mjs --report coverage/mutation/<seg>.json [--max 8]
 *        [--run "<命令>"] [--filter <mutatorName 正则>] [--seed <n>] [--list]
 *
 * 退出码：0 = 探针正常完成（结果仅供判读）；1 = 用法/环境错误或未能恢复源码。
 * 加 `--fail-on-miss` 时，出现任一「runner 漏判」即判 1（供工具升级时当回归门禁用）。
 *
 * 前置条件：工作区里待变异文件必须干净（否则拒绝运行，避免覆盖未提交改动）。
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function usage(msg) {
  if (msg) console.error(`mutation-probe: ${msg}`)
  console.error('用法: node scripts/test/mutation-probe.mjs --report <报告路径> [--max 8] [--run "<命令>"] [--filter <正则>] [--seed <n>] [--list] [--fail-on-miss]')
  process.exit(1)
}

const argv = process.argv.slice(2)
function opt(name, fallback = undefined) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}

const reportPath = opt('--report')
if (!reportPath) usage('缺少 --report')
const max = Number(opt('--max', '8'))
const filterSrc = opt('--filter')
const seed = opt('--seed')
const listOnly = argv.includes('--list')
const failOnMiss = argv.includes('--fail-on-miss')
const runOverride = opt('--run')
if (!Number.isInteger(max) || max <= 0) usage(`--max 需要正整数，收到 ${opt('--max')}`)

const absReport = join(ROOT, reportPath)
if (!existsSync(absReport)) usage(`报告不存在：${absReport}`)

/**
 * 按 location 切片。Stryker 报告的 line/column 均为 **1-based**（实测校准：
 * proxy.ts:201:37-201:65 精确切出 `type !== "text/event-stream"`；按 0-based 会错位一列）。
 */
function sliceRange(src, loc) {
  const lines = src.split('\n')
  const { start, end } = loc
  if (start.line === end.line) return lines[start.line - 1].slice(start.column - 1, end.column - 1)
  const parts = [lines[start.line - 1].slice(start.column - 1)]
  for (let l = start.line + 1; l < end.line; l += 1) parts.push(lines[l - 1])
  parts.push(lines[end.line - 1].slice(0, end.column - 1))
  return parts.join('\n')
}

/** 把 location 区间整体替换为 replacement，其余行列保持不动。 */
function applyReplacement(src, loc, replacement) {
  const lines = src.split('\n')
  const { start, end } = loc
  const before = lines[start.line - 1].slice(0, start.column - 1)
  const after = lines[end.line - 1].slice(end.column - 1)
  const replLines = replacement.split('\n')
  const merged = [
    before + replLines[0],
    ...replLines.slice(1, -1),
    replLines[replLines.length - 1] + after,
  ]
  lines.splice(start.line - 1, end.line - start.line + 1, ...merged)
  return lines.join('\n')
}

/** 确定性抽样：给了 --seed 走可复现的伪随机，否则取前 N 个。 */
function sample(items, n, seedValue) {
  if (items.length <= n) return items
  if (seedValue === undefined) return items.slice(0, n)
  let s = Number(seedValue) || 1
  const picked = []
  const pool = [...items]
  for (let i = 0; i < n && pool.length > 0; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648
    picked.push(pool.splice(s % pool.length, 1)[0])
  }
  return picked
}

const report = JSON.parse(readFileSync(absReport, 'utf8'))
const all = []
for (const [file, fd] of Object.entries(report.files ?? {})) {
  for (const m of fd.mutants ?? []) all.push({ ...m, _file: file })
}

const filterRe = filterSrc ? new RegExp(filterSrc) : null
const survived = all
  .filter((m) => m.status === 'Survived' && m.replacement !== undefined)
  .filter((m) => (filterRe ? filterRe.test(m.mutatorName) : true))
  .sort((a, b) => (a._file === b._file ? Number(a.id) - Number(b.id) : a._file.localeCompare(b._file)))

console.log(`mutation-probe: ${reportPath}`)
console.log(`  变异体 ${all.length} 个；Survived ${all.filter((m) => m.status === 'Survived').length} 个；本次抽样 ${Math.min(max, survived.length)} 个`)

const picked = sample(survived, max, seed)
if (picked.length === 0) {
  console.log('  没有可探测的 Survived 变异体')
  process.exit(0)
}

/** 从变异体所在源文件推断包名与测试命令。 */
function pkgOf(file) {
  const m = /^packages\/([^/]+)\//.exec(file)
  return m ? m[1] : null
}

function testCommand(file) {
  if (runOverride) return runOverride
  const pkg = pkgOf(file)
  return pkg ? `npx vitest run packages/${pkg}` : null
}

/** 工作区干净性检查：只针对本次要动的文件，避免覆盖别人的未提交改动。 */
const targets = [...new Set(picked.map((m) => m._file))]
const dirty = execSync('git status --porcelain -- ' + targets.map((f) => `"${f}"`).join(' '), { cwd: ROOT, encoding: 'utf8' }).trim()
if (dirty !== '') {
  console.error('mutation-probe: 下列待变异文件有未提交改动，拒绝运行（避免覆盖你的工作）：')
  console.error(dirty)
  process.exit(1)
}

if (listOnly) {
  for (const m of picked) {
    const loc = `${m._file}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`
    console.log(`  [${m.status}] ${m.mutatorName} ${loc}`)
  }
  process.exit(0)
}

const results = []
let interrupted = false
const restore = () => {
  for (const [file, original] of originals) writeFileSync(join(ROOT, file), original, 'utf8')
}
const originals = new Map()

process.on('SIGINT', () => {
  interrupted = true
  restore()
  console.error('\nmutation-probe: 收到中断，源码已恢复')
  process.exit(1)
})

try {
  for (const [i, m] of picked.entries()) {
    const abs = join(ROOT, m._file)
    if (!originals.has(m._file)) originals.set(m._file, readFileSync(abs, 'utf8'))
    const original = originals.get(m._file)
    const loc = m.location
    const locStr = `${m._file}:${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`

    const mutated = applyReplacement(original, loc, m.replacement)
    const before = sliceRange(original, loc)
    if (mutated === original) {
      console.log(`[${i + 1}/${picked.length}] ${m.mutatorName} ${locStr}\n      SKIP：replacement 与原文一致，无法判定`)
      results.push({ m, verdict: 'skip' })
      continue
    }
    writeFileSync(abs, mutated, 'utf8')

    const cmd = testCommand(m._file)
    let failed = false
    let detail = ''
    try {
      execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 20 * 60_000 })
    } catch (e) {
      failed = e.status !== 0
      detail = e.status === null ? '超时或信号' : `exit ${e.status}`
    }
    writeFileSync(abs, original, 'utf8')

    const verdict = failed ? 'runner-miss' : 'real-gap'
    results.push({ m, verdict })
    console.log(
      `[${i + 1}/${picked.length}] ${m.mutatorName} ${locStr}\n`
      + `      原文 ${JSON.stringify(before).slice(0, 90)}\n`
      + `      替换 ${JSON.stringify(m.replacement).slice(0, 90)}\n`
      + `      ${failed ? `测试失败（${detail}）⇒ runner 漏判：测试其实能杀它，补测试无效` : '测试通过 ⇒ 真缺口：测试确实杀不掉，补测试有效'}`,
    )
  }
} finally {
  restore()
}

const miss = results.filter((r) => r.verdict === 'runner-miss').length
const gap = results.filter((r) => r.verdict === 'real-gap').length
const skip = results.filter((r) => r.verdict === 'skip').length
console.log(`\nmutation-probe 汇总：runner 漏判 ${miss} / 真缺口 ${gap}${skip ? ` / 跳过 ${skip}` : ''}（抽样 ${results.length}）`)
console.log('  漏判占多数 ⇒ 得分被工具低估，补测试无法提升分数，应先修工具链或重定口径')
console.log('  真缺口占多数 ⇒ 得分反映真实测试盲区，补测试是有效手段')

if (interrupted) process.exit(1)
if (failOnMiss && miss > 0) {
  console.error(`mutation-probe: 存在 ${miss} 个 runner 漏判（--fail-on-miss）`)
  process.exit(1)
}
process.exit(0)
