#!/usr/bin/env node
/**
 * scripts/gate/local-gate.mjs — 本地门禁分层执行器（#722 门禁分层）。
 *
 * 为什么需要它：AGENTS.md 的提交前最小集原本是「全仓 build + 全仓 test + 全仓 typecheck
 * + contract + pack:check」。全仓口径对单包改动的开发者是纯浪费——CI 早就按 ci.yml 的
 * paths-filter 做了切片（build-test 只对命中包跑 test/typecheck），本地却一律全量。本
 * 脚本把同一份包面归属搬到本地，并统一「PR 也走增量」的口径：
 *
 *   changed  命中包的 build + test + typecheck（迭代快线；命中全局面时自动升到 pr）
 *   pr       快线 + **命中包**产物闸（contract / pack:check / verify:npmlayout 切片）
 *            + 廉价全仓一致性闸（秒级静态检查，不依赖 lib 产物）
 *   full     全仓口径（= 夜间班次口径；发版前或改过构建链时跑）
 *
 * 必须全量的东西（全仓产物闸、覆盖率、变异）不在 PR 口径里：它们归 CI 夜间班次
 * （observe.yml），本地只在 --with-coverage 时按需补覆盖率。
 * 包面归属的唯一事实源是 ci.yml 的 filters 块（见 local-scope.mjs），本脚本不重述路径规则。
 *
 * 用法：
 *   node scripts/gate/local-gate.mjs [--tier changed|pr|full] [--base <ref>] [--dry-run] [--with-coverage]
 * 退出码：0 = 全部通过；1 = 某步失败（首个失败即停，摘要列出全部已跑步骤的 exit code）。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { computeCiMatrix } from '../ci/ci-matrix.mjs'
import { PREREQ_PACKAGES } from '../test/script-test-prereqs.mjs'
import { planChangedScope } from './local-scope.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const TIER_ALIAS = { changed: 'changed', fast: 'changed', pr: 'pr', full: 'full' }

function sh(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
}

function gitLines(args) {
  const res = sh('git', args)
  if (res.status !== 0) return null
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

function resolveChangedFiles(base) {
  const verified = sh('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (verified.status !== 0) return null
  const tracked = gitLines(['diff', '--name-only', '--diff-filter=ACMR', base])
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'])
  if (tracked === null || untracked === null) return null
  return [...new Set([...tracked, ...untracked])]
}

/** 每个步骤 = { label, args }；args 交给 pnpm。 */
function tierSteps(tier, { hitPackages, withCoverage }) {
  const pkgFilters = hitPackages.map((p) => `./packages/${p}`)
  const scopedBuild = hitPackages.map((p) => `@wingsky-1/${p}...`)
  const scopeArg = hitPackages.join(',')

  if (tier === 'changed') {
    const steps = []
    if (hitPackages.length > 0) {
      steps.push({ label: `build（命中包 + 依赖：${hitPackages.join(', ')}）`, args: [...scopedBuild.flatMap((f) => ['--filter', f]), 'build'] })
      for (const filter of pkgFilters) {
        steps.push({ label: `test ${filter}`, args: ['--filter', filter, '--if-present', 'test'] })
      }
      for (const filter of pkgFilters) {
        steps.push({ label: `typecheck ${filter}`, args: ['--filter', filter, '--if-present', 'typecheck'] })
      }
    }
    return steps
  }

  // 廉价全仓一致性闸：不依赖 lib 产物、秒级，恒跑（不是「全量构建」类成本）。
  // test:scripts 不在此列——它有编译面用例依赖声明产物，需先满足前置包（见下方）。
  const cheapGlobal = [
    { label: 'stryker:check（变异配置与拓扑一致）', args: ['stryker:check'] },
    { label: 'aggregate:check（聚合 patch 不漂移）', args: ['aggregate:check'] },
    { label: 'test:src-tests（*.src.test.ts 禁现）', args: ['test:src-tests'] },
    { label: 'gate:homedir（src 禁直连 HOME）', args: ['gate:homedir'] },
    { label: 'docs:check（README/链接）', args: ['docs:check'] },
    { label: 'lint（ESLint 复杂度门禁，阈值见 gauntlet.config.json）', args: ['lint'] },
  ]
  const prereqStep = {
    label: `build 编译面前置包（test:scripts 依赖：${PREREQ_PACKAGES.join(', ')}）`,
    // --filter 与取值必须是两个独立 argv 元素（与本文件其余步骤同写法）；拼成单个
    // 字符串会被 pnpm 当成一个未知选项：Unknown options: 'filter @wingsky-1/<pkg>...'
    args: [...PREREQ_PACKAGES.flatMap((p) => ['--filter', `@wingsky-1/${p}...`]), 'build'],
  }
  const scriptsSelfTest = { label: 'test:scripts（门禁脚本自测）', args: ['test:scripts'] }

  if (tier === 'pr') {
    // PR 增量口径：命中包构建/测试 + **命中包**产物闸 + 廉价全仓一致性闸。
    // 全仓产物闸（无 --packages）与覆盖率/变异归夜间，本地只在 gate:full 跑。
    const steps = []
    if (hitPackages.length > 0) {
      steps.push({ label: `build（命中包 + 依赖：${hitPackages.join(', ')}）`, args: [...scopedBuild.flatMap((f) => ['--filter', f]), 'build'] })
      for (const filter of pkgFilters) {
        steps.push({ label: `test ${filter}`, args: ['--filter', filter, '--if-present', 'test'] })
      }
      for (const filter of pkgFilters) {
        steps.push({ label: `typecheck ${filter}`, args: ['--filter', filter, '--if-present', 'typecheck'] })
      }
    }
    steps.push(
      { label: `contract（切片 ${hitPackages.length} 包）`, cmd: 'node', args: ['scripts/gate/contract-check.ts', '--packages', scopeArg] },
      { label: `pack:check（切片 ${hitPackages.length} 包）`, cmd: 'node', args: ['scripts/gate/pack-check.ts', '--packages', scopeArg] },
      { label: `verify:npmlayout（切片 ${hitPackages.length} 包）`, cmd: 'node', args: ['scripts/gate/verify-npm-layout.ts', '--packages', scopeArg] },
      ...cheapGlobal,
      prereqStep,
      scriptsSelfTest,
    )
    return steps
  }

  const steps = [
    { label: 'build（全仓）', args: ['build'] },
    { label: 'test（全仓）', args: ['test'] },
    { label: 'typecheck（全仓）', args: ['typecheck'] },
    { label: 'contract（全仓）', args: ['contract'] },
    { label: 'pack:check（全仓）', args: ['pack:check'] },
    { label: 'verify:npmlayout（全仓）', args: ['verify:npmlayout'] },
    ...cheapGlobal,
    scriptsSelfTest,
  ]
  if (withCoverage) {
    steps.push({ label: 'cov（vitest 覆盖率，unit + integration 直连 src）', args: ['cov'] })
    // crap 于 #722 阶段五完成 src 口径重建（复杂度取自 ESLint 的 complexity 规则，覆盖率取自
    // 同一份 src 口径产物），与 cov 同批恢复接入。
    steps.push({ label: 'crap（CRAP 热点，strict 见 gauntlet.config.json）', args: ['crap'] })
  }
  return steps
}

function main(argv) {
  const tierArg = valueOf(argv, '--tier') ?? 'changed'
  const tier = TIER_ALIAS[tierArg]
  if (tier === undefined) {
    console.error(`[local-gate] 未知 --tier ${tierArg}（可选 changed / pr / full）`)
    return 2
  }
  const base = valueOf(argv, '--base') ?? 'origin/main'
  const dryRun = argv.includes('--dry-run')
  const withCoverage = argv.includes('--with-coverage')

  const { allPackages } = computeCiMatrix({ env: {} })

  let files = null
  let scopeReason = ''
  if (tier === 'changed') {
    files = resolveChangedFiles(base)
    if (files === null) {
      scopeReason = `取不到 diff 基准 ${base}（或 git 不可用）—— 按全量处理（fail-closed）`
      files = null
    }
  }

  let plan
  if (tier !== 'changed') {
    plan = { hitPackages: [...allPackages], globalHit: false, escalated: false, reason: `--tier ${tier}：全仓口径` }
  } else if (files === null) {
    plan = { hitPackages: [...allPackages], globalHit: true, escalated: false, reason: scopeReason }
  } else {
    plan = planChangedScope({ root: ROOT, files, allPackages })
  }

  // 全局面命中（改 shared/scripts/.github/包管理文件）时，changed 快线不足以覆盖静态闸，升到 pr
  let effectiveTier = tier
  if (tier === 'changed' && plan.globalHit) effectiveTier = 'pr'

  const steps = tierSteps(effectiveTier, { hitPackages: plan.hitPackages, withCoverage })
  const escalated = effectiveTier !== tier

  console.log(`[local-gate] tier=${tier}${escalated ? ` → 升级为 ${effectiveTier}` : ''}  base=${base}  变更文件=${files === null ? 'n/a' : files.length}`)
  console.log(`[local-gate] 包面：${plan.hitPackages.length > 0 ? plan.hitPackages.join(', ') : '（无）'}  —— ${plan.reason}`)
  if (plan.unknown && plan.unknown.length > 0) {
    console.log(`[local-gate] 注意：ci.yml filters 里的 ${plan.unknown.join(', ')} 不在包清单内，已忽略（若为新增包请同步 plugins-manifest.json）`)
  }
  if (steps.length === 0) {
    console.log('[local-gate] 无命中包面且已升级未触发 —— 纯文档/meta 改动，本地无需跑包级门禁（CI 静态闸仍会跑）')
    return 0
  }
  console.log('[local-gate] 计划步骤：')
  for (const s of steps) console.log(`  - ${s.label}`)
  if (dryRun) {
    console.log('[local-gate] --dry-run：未执行')
    return 0
  }

  const results = []
  for (const step of steps) {
    console.log(`\n[local-gate] ▶ ${step.label}\n[local-gate]   ${step.cmd ?? PNPM} ${step.args.join(' ')}`)
    const res = spawnSync(step.cmd ?? PNPM, step.args, { cwd: ROOT, stdio: 'inherit' })
    const code = res.status ?? 1
    results.push({ label: step.label, code })
    if (code !== 0) {
      console.error(`\n[local-gate] ✗ ${step.label} 退出码 ${code} —— 后续步骤不再执行（fail-fast）`)
      break
    }
  }

  console.log('\n[local-gate] 执行摘要：')
  for (const r of results) console.log(`  exit=${r.code}  ${r.label}`)
  const skipped = steps.length - results.length
  for (const s of steps.slice(results.length)) console.log(`  exit=skip  ${s.label}`)
  const failed = results.some((r) => r.code !== 0)
  if (skipped > 0) console.log(`[local-gate] 因首个失败跳过 ${skipped} 步`)
  console.log(failed ? '[local-gate] 结果：FAIL' : '[local-gate] 结果：PASS')
  return failed ? 1 : 0
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

process.exit(main(process.argv.slice(2)))
