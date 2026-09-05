#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * workflow-assert — CI workflow 结构静态断言（#85 v3 F2 防回归条款）。
 *
 * 断言 ci.yml / observe*.yml / release.yml / health-report.yml 的关键结构不变量：
 *   - repo-gate 聚合闸：if always()、fail-closed 断言步骤、required check 名不变
 *   - fail-closed 双闸：filter 失败 fallback 全量切片
 *   - build-test 矩阵恒全集构建（repo-gate 全局门禁依赖全量 lib 产物，评审 F1）
 *   - action 一律 pin commit SHA（供应链纪律，release.yml 为最高风险面——持有
 *     NPM_TOKEN + contents: write，必须纳入断言盲区外全覆盖；health-report.yml 同防回归）
 *   - observe.yml：全量班调度（北京次日 04:00）、self-cov --check 执行点在位；
 *     全量清单 ↔ stryker.conf.d 文件集 ↔ gauntlet mutation.packages 三方一致
 *   - observe-incremental.yml：增量班调度（北京 12/16/20/24）、无日期闸、
 *     有变化即 PR、不跑覆盖校验
 *   - changes 的 case 映射覆盖全部包（防新增包静默漏检，评审 F7）
 *   - #187 触发面收敛：mutation-gate 仅限 pull_request；repo-gate 判定走
 *     scripts/gate/repo-gate-assert.mjs 并以判定表全组合单测锁死
 *   - #217 变异/覆盖解耦：cov 全局单次采集（coverage job）+ stryker 报告
 *     artifact 传递 + mutation-verdict 聚合判分；changes.hasMutations 显式布尔；
 *     mutate-scope-guard 前移进 PR 门禁；needs 连坐语义（coverage 失败 →
 *     verdict 不跑 → repo-gate 红）由结构锚锁死
 *
 * 运行：node --test scripts/test/workflow-assert.test.ts（或 pnpm test:scripts）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, globSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const OBSERVE = readFileSync(join(ROOT, '.github/workflows/observe.yml'), 'utf8')
const OBSERVE_INC = readFileSync(join(ROOT, '.github/workflows/observe-incremental.yml'), 'utf8')
const OVERLAY = readFileSync(join(ROOT, '.github/workflows/baseline-overlay.yml'), 'utf8')
const RELEASE = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
const HEALTH = readFileSync(join(ROOT, '.github/workflows/health-report.yml'), 'utf8')
const GAUNTLET = JSON.parse(readFileSync(join(ROOT, 'scripts/data/gauntlet.config.json'), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'scripts/data/plugins-manifest.json'), 'utf8'))

// 包集合单一事实源（#306 评审）：从 plugins-manifest.json 派生，消除手写漂移。
//  - MATRIX_PACKAGES：build-test 矩阵全集 = active ∪ standalone ∪ 聚合包
//    （build 无条件覆盖所有要发布产物的包，repo-gate 全局门禁依赖全集 lib）
//  - SLICE_PACKAGES：切片清单 = active ∪ 聚合包（standalone 不进聚合、不参与切片）
//  - MUTATION_PACKAGES：变异对象包 = gauntlet mutation.packages（含 standalone）
const AGGREGATE = 'dsh-plugins-all'
const MATRIX_PACKAGES = [...MANIFEST.active, ...(MANIFEST.standalone ?? []), AGGREGATE]
const SLICE_PACKAGES = [...MANIFEST.active, AGGREGATE]
// 变异对象包：gauntlet mutation.packages（含 standalone，不含聚合/纯宿主 skill 包）
const MUTATION_PACKAGES = Object.keys(GAUNTLET?.mutation?.packages ?? {})

// ── 段配置文件名归并（#342 二期：数字段名 s1/s2 废弃，改为功能段名；二者兼容）──
// 包级单段配置 <pkg>.json 与段式配置 <pkg>-<后缀>.json（后缀=功能段名或数字段名）
// 统一归并为基础包名：对已知包集合（gauntlet mutation.packages）做最长前缀匹配。
// 所有需要「conf 文件集 ↔ 包集」一致的断言共用本函数，避免三处漂移（评审 P1-2）。
function basePkgOfConf(f) {
  const name = f.replace(/\.json$/, '')
  const hit = MUTATION_PACKAGES
    .filter((p) => name === p || name.startsWith(`${p}-`))
    .sort((a, b) => b.length - a.length)
  return hit[0]
}
// 段式配置的后缀（如 dsh-notifier-server.json → server；dsh-lan-proxy-1.json → 1）
function segSuffixOfConf(f) {
  const name = f.replace(/\.json$/, '')
  const base = basePkgOfConf(f)
  return base && name !== base ? name.slice(base.length + 1) : undefined
}
// 有 stryker 配置的包集合（conf 文件集归并；段式/包级统一）
function strykerPkgs() {
  return [...new Set(readdirSync(join(ROOT, 'stryker.conf.d'))
    .filter((f) => f.endsWith('.json'))
    .map(basePkgOfConf)
    .filter(Boolean))].sort()
}

test('ci.yml: repo-gate 保持分支保护 required check 名', () => {
  const m = /repo-gate:\s*\n\s*name: (.+)/.exec(CI)
  assert.ok(m, '存在 repo-gate 作业且声明 name')
  assert.equal(m[1].trim(), 'Build / Contract / Smoke / Pack',
    'required check 名必须与旧单作业名一致（维护者分支保护无缝切换）')
})

test('ci.yml: repo-gate if always() 且 fail-closed 断言经判定脚本执行', () => {
  const gate = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(/if: always\(\)/.test(gate), 'repo-gate 必须 always() 运行（上游失败时仍执行判红）')
  assert.ok(/Fail-closed gate assertion/.test(gate), 'fail-closed 断言步骤在位')
  // #187：内联 bash 收敛为可单测的判定脚本，env 三维注入（事件 × 切片 × 结果）
  assert.ok(gate.includes('run: node scripts/gate/repo-gate-assert.mjs'),
    'repo-gate fail-closed 判定必须调用 scripts/gate/repo-gate-assert.mjs')
  for (const env of ['GATE_EVENT', 'GATE_CHANGES', 'GATE_BUILD_TEST', 'GATE_MUTATION', 'GATE_MUTATION_PKGS']) {
    assert.ok(new RegExp(`${env}: \\$\\{\\{`).test(gate), `判定脚本 env ${env} 注入缺失`)
  }
  // 时序约束（run #32800733630 教训）：脚本版断言依赖工作区文件，必须排在
  // Checkout 之后；旧内联 bash 无文件依赖曾掩盖该约束
  const checkoutIdx = gate.indexOf('- name: Checkout')
  const assertIdx = gate.indexOf('Fail-closed gate assertion')
  assert.ok(checkoutIdx > 0, 'repo-gate 存在 Checkout 步骤')
  assert.ok(assertIdx > checkoutIdx,
    'fail-closed 断言步骤必须排在 Checkout 之后（脚本需要工作区存在 scripts/gate/）')
})

test('ci.yml: filter 失败 fallback 全量切片（fail-closed 双闸）', () => {
  assert.ok(CI.includes('[ "$FILTER_OUTCOME" = "failure" ]'),
    'filter outcome failure 必须触发全量切片 fallback')
  assert.ok(/按全量处理/.test(CI), 'diff base 不可用时按全量处理（F4）')
})

test('ci.yml: build-test 矩阵恒全集且 build 无条件（评审 F1：全局门禁依赖全量产物）', () => {
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  repo-gate:'))
  for (const pkg of MATRIX_PACKAGES) {
    assert.ok(bt.includes(`- ${pkg}\n`), `矩阵含 ${pkg}`)
  }
  // build 步骤不得带切片条件；smoke/typecheck 必须带切片条件且 --if-present（评审 F3）
  const buildStep = /#([^#\n]*)Build package[^\n]*\n(?:.*\n)*?- name: Smoke tests/
  assert.ok(/Build package（无条件[^\n]*\n        run: pnpm --filter/.exec(bt.replace(buildStep, (s) => s)), null)
  const buildBlock = bt.slice(bt.indexOf('- name: Build package'), bt.indexOf('- name: Smoke tests'))
  assert.ok(!buildBlock.includes('if:'), 'build 步骤不允许任何 if 条件（产物全集保障）')
  for (const stepName of ['Smoke tests', 'Typecheck']) {
    const idx = bt.indexOf(`- name: ${stepName}`)
    const block = bt.slice(idx, bt.indexOf('- name:', idx + 10))
    assert.ok(block.includes('contains(fromJSON(needs.changes.outputs.hitPackages), matrix.package)'),
      `${stepName} 步骤须按命中清单切片`)
    assert.ok(block.includes('--if-present'), `${stepName} 须 --if-present（聚合包无该脚本）`)
  }
})

test('ci.yml: changes case 映射覆盖全部包（防新增包静默漏检，评审 F7）', () => {
  const computeBlock = CI.slice(CI.indexOf('Compute hit packages'))
  for (const pkg of SLICE_PACKAGES) {
    assert.ok(computeBlock.includes(`dsh-${pkg.slice(4)})`) || computeBlock.includes(`${pkg}) V=`),
      `case 分支缺 ${pkg} —— 新增包必须同步加映射分支`)
  }
  // 循环遍历清单与 SLICE_PACKAGES 一致（切片面只含 active ∪ 聚合，standalone 不进）
  const loopList = /for pkg in ([\w -]+); do/.exec(computeBlock)?.[1]?.trim().split(/\s+/).sort()
  assert.deepEqual(loopList, [...SLICE_PACKAGES].sort(), 'for 循环清单与切片包集不一致')
})

test('ci.yml/observe*/baseline-overlay/release/health-report.yml: 第三方与官方 action 一律 pin commit SHA', () => {
  for (const [name, text] of [
    ['ci.yml', CI], ['observe.yml', OBSERVE], ['observe-incremental.yml', OBSERVE_INC],
    ['baseline-overlay.yml', OVERLAY], ['release.yml', RELEASE], ['health-report.yml', HEALTH],
  ]) {
    // 逐行解析 uses: 值（避免贪婪 \S+ 吞掉 @ref，评审 F9）
    const lines = text.split('\n').filter((l) => l.trim().startsWith('uses:'))
    assert.ok(lines.length > 0, `${name} 存在 uses 步骤`)
    for (const line of lines) {
      // owner/repo 及其子 action 路径（如 actions/cache/restore，#178 引入）
      const m = /^uses:\s*([\w.-]+(?:\/[\w.-]+)+)(?:@(\S+))?\s*(?:#.*)?$/.exec(line.trim())
      assert.ok(m, `${name}: 无法解析的 uses 行："${line.trim()}"`)
      assert.match(m[2] ?? '', /^[0-9a-f]{40}/, `${name}: ${m[1]} 未 pin 到 40 位 commit SHA`)
    }
  }
})

test('observe.yml: 夜间调度 + 双硬门禁执行点 + issues 写权限', () => {
  assert.ok(OBSERVE.includes('cron:'), 'schedule 触发器在位')
  assert.ok(OBSERVE.includes('workflow_dispatch'), '支持手动 dispatch')
  assert.ok(OBSERVE.includes('issues: write'), '自动建 issue 需要 issues:write')
  assert.ok(OBSERVE.includes('self-cov.mjs --check'), 'self-written 覆盖率阈值校验执行点（#85 v3）')
  assert.ok(OBSERVE.includes('observe-check.mjs'), '阈值校验+回落检测脚本执行点（F1/F6）')
})

test('#220: docs 与 AGENTS.md 不在 ci.yml global 过滤面——文档 PR 不触发变异切片', () => {
  // gate/build/release 脚本均不消费 docs/ 与 AGENTS.md 内容；release-notes 校验
  // 仅在 release.yml。若未来新增消费 docs/AGENTS.md/README 等的门禁脚本，
  // 须把对应路径加回 global 组并同步本断言
  const filterBlock = CI.slice(CI.indexOf('filters: |'), CI.indexOf("dsh-notifier:"))
  assert.ok(!/^.*-\s'docs\/\*\*'/m.test(filterBlock),
    "docs/** 不得出现在 global 过滤组——纯文档 PR 不应触发全量切片")
  assert.ok(!/^.*-\s'AGENTS\.md'/m.test(filterBlock),
    "AGENTS.md 不得出现在 global 过滤组——改根级纯文档不应触发全量切片")
  assert.ok(CI.includes('# docs/** 与 AGENTS.md 刻意不在 global 面'),
    '过滤面旁必须保留理由注释（防后人「好心」加回）')
})

test('#322: 每个带 stryker 配置的包在 path-filter 均有段配置通配映射（防回归）', () => {
  // 有 stryker 配置的包 = stryker.conf.d 文件集归并出的基础包名（段式
  // <pkg>-<后缀>.json 与包级 <pkg>.json 归并到 <pkg>，功能段名/数字段名统一——
  // basePkgOfConf 共享函数），与 #220 段式三方一致测试同一口径
  const basePkgs = strykerPkgs()

  const filtersBlock = CI.slice(CI.indexOf('filters: |'), CI.indexOf('- name: Compute hit packages'))
  for (const pkg of basePkgs) {
    // 定位包面条目：从 `<pkg>:` 到下一个 `            dsh-` 条目（filters 缩进 12 空格）
    const start = filtersBlock.indexOf(`            ${pkg}:`)
    assert.ok(start > 0, `ci.yml path-filter 缺包面条目 ${pkg}（#322：段配置变更需命中该包面）`)
    const after = filtersBlock.indexOf('\n            dsh-', start + pkg.length)
    const entry = filtersBlock.slice(start, after > 0 ? after : undefined)
    // 现有 packages/<pkg>/** 映射必须保留（本断言只追加 stryker 段配置通配，不动 case 结构）
    assert.ok(entry.includes(`- 'packages/${pkg}/**'`),
      `${pkg} 包面必须保留 packages/${pkg}/** 行（#322 只追加不替换）`)
    // stryker.conf.d 通配：包级 <pkg>.json 与段级 <pkg>-<n>.json 均以 <pkg> 前缀被覆盖
    const hasGlob = entry.split('\n').some((l) => {
      const m = /-\s'(stryker\.conf\.d\/[^']+)'/.exec(l.trim())
      return !!m && m[1].startsWith(`stryker.conf.d/${pkg}`)
    })
    assert.ok(hasGlob,
      `${pkg} 包面缺 stryker.conf.d 段配置通配映射（#322：改段配置必须触发该包 mutation，不得全 skip）`)
  }
})

test('#433+#572 调度重设计与孤立分支基线: observe 全量班（北京次日 04:00）+ 增量班四班次（强推孤立分支）', () => {
  // ── 全量班（observe.yml）：每日一次，北京次日 04:00 = UTC 20:00 ──
  assert.ok(OBSERVE.includes("'0 20 * * *'"),
    '全量班 cron 必须为每日一次 UTC 20:00（北京次日 04:00）')
  assert.ok(OBSERVE.includes('Resolve mutation suites'), '全量班 suite-plan 步骤在位')
  assert.ok(OBSERVE.includes('ls stryker.conf.d/dsh-*.json > /tmp/suites.txt'),
    '全量班 suite-plan 必须纯全量（glob conf 目录为单一事实源，无 push 裁剪分支）')
  assert.ok(!OBSERVE.includes('EVENT_NAME'), 'observe 不得再依赖 push/事件类型（#276 方案 A 已移除 push 触发）')
  assert.ok(OBSERVE.includes('steps.suite-plan.outputs.has_suites == \'true\''),
    '全量班变异执行与 push 必须以 has_suites 为前提——空计划不跑 push')
  assert.ok(!OBSERVE.includes('skip_pr=true'), '#572：全量班已迁移至孤立分支，日期闸与 PR 步骤已退役')
  assert.ok(OBSERVE.includes('orphan-baseline.mjs push'), '全量班调用 orphan-baseline.mjs push 提交孤立分支')

  // ── 增量班（observe-incremental.yml）：每日四班次，北京 12/16/20/24 = UTC 04/08/12/16 ──
  assert.ok(OBSERVE_INC.includes("'0 4,8,12,16 * * *'"),
    '增量班 cron 必须为每日四班次（UTC 04/08/12/16 = 北京 12/16/20/次日 0 点）')
  assert.ok(OBSERVE_INC.includes('workflow_dispatch'), '增量班支持手动 dispatch')
  assert.ok(OBSERVE_INC.includes('Resolve mutation suites'), '增量班 suite-plan 步骤在位')
  assert.ok(OBSERVE_INC.includes('orphan-baseline.mjs push'), '增量班调用 orphan-baseline.mjs push 强推孤立分支')
  assert.ok(!OBSERVE_INC.includes('create-pull-request@'), '#572：增量班基线不再建 PR，直接推送孤立分支')
  assert.ok(!OBSERVE_INC.includes('gh pr merge'), '#572：增量班 auto-merge 步骤已退役')
  assert.ok(!OBSERVE_INC.includes('skip_pr=true'), '增量班不得有日期闸')
  assert.ok(!OBSERVE_INC.includes('self-cov.mjs --check'), '增量班不跑覆盖校验（职责收敛到全量班）')
})

test('#220 段式三方一致：observe 计划 ↔ stryker.conf.d 文件集 ↔ gauntlet 包集', () => {
  // observe 两班（全量班 observe.yml + 增量班 observe-incremental.yml）循环清单
  // 均由各自 suite-plan 步骤产出（#433：全量班即全量、增量班基于基线跑增量但
  // 清单同样 glob 全量——新增配置自动纳入，Stryker 增量模式跳过未变 mutant）；
  // 循环本身从计划文件读取
  for (const [name, wf] of [['observe.yml', OBSERVE], ['observe-incremental.yml', OBSERVE_INC]]) {
    assert.ok(wf.includes('ls stryker.conf.d/dsh-*.json'),
      `${name} suite-plan 的全量清单必须以 glob stryker.conf.d/dsh-*.json 为单一事实源（新增配置自动纳入）`)
    assert.ok(wf.includes('while read -r conf; do'),
      `${name} 变异循环必须从 suite-plan 清单文件逐行消费`)
  }

  // stryker.conf.d 实际文件集 → 基础包名集合（段配置 <pkg>-<后缀>.json 与包级
  // <pkg>.json 统一归并到 <pkg>——功能段名/数字段名兼容，basePkgOfConf 共享函数）
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.ok(confFiles.length > 0, 'stryker.conf.d 非空')
  const basePkgs = strykerPkgs()

  // gauntlet mutation.packages 与基础包名集一致
  const gauntPkgs = Object.keys(GAUNTLET?.mutation?.packages ?? {}).sort()
  assert.deepEqual(gauntPkgs, basePkgs,
    'gauntlet mutation.packages 应覆盖全部带变异配置的功能插件包')

  // jsonReporter / incrementalFile 输出路径与配置文件名自洽
  for (const f of confFiles) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    const out = conf?.jsonReporter?.fileName
    assert.ok(out && out.endsWith(`coverage/mutation/${f}`),
      `${f} 的 jsonReporter 输出应为 coverage/mutation/${f}（mutation-gate.mjs 按此约定读取）`)
    const inc = conf?.incrementalFile ?? ''
    assert.ok(inc.endsWith(`incremental-${f.replace(/^dsh-/, '').replace(/\.json$/, '')}.json`),
      `${f} 的 incrementalFile 应为 incremental-${f.replace(/^dsh-/, '').replace(/\.json$/, '')}.json（CI restore 步骤按此推导）`)
  }

  // packages/ 目录集 ⊇ 基础包名集
  for (const p of basePkgs) {
    assert.ok(existsSync(join(ROOT, 'packages', p)), `packages/${p} 目录存在`)
  }
})

test('#572: stryker 配置生成器与拓扑清单一致性（SSOT + CodeGen 门禁）', () => {
  const topoFile = join(ROOT, 'scripts/data/mutation-topology.json')
  assert.ok(existsSync(topoFile), 'mutation-topology.json 单一事实源在位')
  const topo = JSON.parse(readFileSync(topoFile, 'utf8'))
  assert.ok(topo.sharedDefaults, '包含 sharedDefaults 通用模板')
  assert.ok(topo.packages, '包含 packages 各包分段定义')

  // package.json 脚本在位
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkgJson.scripts['stryker:gen'], 'package.json 包含 stryker:gen 命令')
  assert.ok(pkgJson.scripts['stryker:check'], 'package.json 包含 stryker:check 命令')

  // 执行 gen-stryker-conf.mjs --check 校验磁盘与清单 100% 同步
  const res = spawnSync('node', ['scripts/gate/gen-stryker-conf.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `gen-stryker-conf --check 失败:\n${res.stderr || res.stdout}`)
})

// ── #342 二期 §契约：功能段名唯一 + mutate 面防空段回归 ──
// 段名唯一：combos_for 按 stryker.conf.d/<pkg>-*.json 文件名枚举后缀展开矩阵，
// 段文件名即矩阵实例（功能段名如 dsh-notifier-server.json → seg=server；数字段名
// dsh-lan-proxy-1.json → seg=1 亦兼容）。重名/孤儿段（同时存在 <pkg>.json 与
// <pkg>-*.json）/跳号会让矩阵指向不存在配置或白跑孤儿全量，fail-closed 前先静态拦截。
// 防空段：provider 空段实证（mutate 指向不存在的 adapters/*.ts，0 mutant）——
// 每段 mutate 正向条目必须至少 glob 到 1 个现存文件。
test('#342 二期: 各包 stryker 段文件名唯一且无孤儿段（防矩阵重名/孤儿全量）', () => {
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json'))
  assert.ok(confFiles.length > 0, 'stryker.conf.d 非空')
  // 包级单段配置（<pkg>.json）走 seg="0"，不参与段名序列；段式配置 <pkg>-<后缀>.json 独立成组
  const segSets = new Map() // base-pkg → Set<segName>
  const hasPkgLevel = new Set()
  for (const f of confFiles) {
    const base = basePkgOfConf(f)
    if (!base) continue
    const seg = segSuffixOfConf(f)
    if (seg) {
      assert.ok(/^[a-z0-9-]+$/.test(seg),
        `${f} 段名必须是 kebab-case 字母数字连字符（combos_for 以文件名枚举矩阵，非法字符会破坏路径拼接）`)
      if (!segSets.has(base)) segSets.set(base, new Set())
      segSets.get(base).add(seg)
    } else {
      hasPkgLevel.add(base)
    }
  }
  for (const [base, segs] of segSets) {
    assert.ok(segs.size === [...segs].length,
      `${base} 段名必须唯一（文件名即矩阵实例，重名会让 combo 指向同一配置）`)
    assert.ok(!hasPkgLevel.has(base),
      `${base} 存在段式配置时不得残留包级孤儿 <pkg>.json（v4 §4.1：否则 observe 每班次白跑一段孤儿全量）`)
  }
})

test('#342: 每段 mutate 正向条目至少 glob 到 1 个现存文件（防空段回归）', () => {
  const confDir = join(ROOT, 'stryker.conf.d')
  for (const f of readdirSync(confDir).filter((x) => x.endsWith('.json'))) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    const positives = (conf.mutate ?? []).filter((m) => !m.startsWith('!'))
    assert.ok(positives.length > 0,
      `${f} 无 mutate 正向条目（防空段回归：provider-2 空段即 mutate 指向不存在的 adapters/*.ts，0 mutant）`)
    assert.ok(positives.some((m) => globSync(m, { cwd: ROOT }).length > 0),
      `${f} mutate 正向条目全部 glob 不到现存文件（防空段回归：v4 §4.4）`)
  }
})

test('gauntlet: mutation.packages 全部带 threshold 字段且 ≥60（阶段一基线）', () => {
  const pkgs = GAUNTLET?.mutation?.packages ?? {}
  assert.ok(Object.keys(pkgs).length > 0, 'mutation.packages 非空')
  for (const [pkg, cfg] of Object.entries(pkgs)) {
    assert.equal(typeof cfg.threshold, 'number', `${pkg}.threshold 已落盘`)
    assert.ok(cfg.threshold >= 60, `${pkg}.threshold=${cfg.threshold} 不低于阶段一基线 60`)
  }
})

// ── #178 v2 + #204 + #572：Stryker 增量模式接入（孤立分支基线存储 + PR 增量切片门禁）──
// #572 修订：废除向 main 分支自动建 PR 提交数十万行 JSON（#204 历史方案 A），
// 基线改走独立孤立分支 refs/heads/baseline/mutation，直接存单 commit 纯文本树，
// PR 侧通过 orphan-baseline.mjs restore 浅拉取恢复。

test('#178+#204+#572: observe 两班均使用孤立分支基线——全量班不 restore、增量班 restore 孤立分支', () => {
  for (const [name, wf] of [['observe.yml', OBSERVE], ['observe-incremental.yml', OBSERVE_INC]]) {
    assert.ok(
      !wf.includes('actions/cache/restore'),
      `${name} 严禁出现 restore 缓存步骤——基线走孤立分支（勿"好心"补 actions/cache restore）`,
    )
    assert.ok(
      !wf.includes('actions/cache/save@'),
      `${name} 已改用孤立分支基线（#572），不得出现 cache/save 步骤`,
    )
    assert.ok(
      !wf.includes('create-pull-request@'),
      `${name} #572 已废除基线自动开 PR 合入 main（杜绝 git 树与提交历史膨胀）`,
    )
    const pushIdx = wf.indexOf('Push baseline to orphan branch')
    assert.ok(pushIdx > 0, `${name} push 步骤在位（增量基线 → 孤立分支 baseline/mutation）`)
    const pushBlock = wf.slice(pushIdx, wf.indexOf('- name:', pushIdx + 10))
    assert.ok(pushBlock.includes('if: always()'),
      `${name} push 步骤必须 if: always()（部分失败班次已产出的基线照常收集并强推）`)
    assert.ok(pushBlock.includes('orphan-baseline.mjs push'), `${name} orphan-baseline.mjs push 脚本执行点在位`)
    assert.ok(wf.includes('contents: write'), `${name} permissions 需 contents: write（孤立分支推送需要）`)
    assert.ok(wf.includes('mutation-baseline-sync'), `${name} concurrency 统一为 mutation-baseline-sync（防止覆盖踩踏）`)
  }
  // 增量班刻意 restore 孤立分支基线（通过 orphan-baseline.mjs restore 恢复到 coverage/mutation/）；
  // 全量班刻意不恢复任何基线——无增量基线即天然全量
  assert.ok(OBSERVE_INC.includes('Restore incremental baseline from orphan branch'),
    '增量班 restore 步骤在位（#572：基于孤立分支跑增量变异）')
  assert.ok(OBSERVE_INC.includes('orphan-baseline.mjs restore'),
    '增量班 restore 必须调用 orphan-baseline.mjs restore')
})

test('#276 方案 A: src 级 mutate 退役产物行号机制——ci/observe 两班均不得再出现 sync/guard', () => {
  for (const [name, wf] of [['ci.yml', CI], ['observe.yml', OBSERVE], ['observe-incremental.yml', OBSERVE_INC]]) {
    assert.ok(!wf.includes('sync-mutate-segments.mjs'),
      `${name} 不得再调用 sync-mutate-segments.mjs（src 级 mutate 无产物行号，已退役）`)
    assert.ok(!wf.includes('mutate-scope-guard.mjs'),
      `${name} 不得再调用 mutate-scope-guard.mjs（F5 守卫已随方案 A 退役）`)
  }
  // 退役文件不得残留
  for (const p of [
    'scripts/gate/sync-mutate-segments.mjs',
    'scripts/gate/mutate-scope-guard.mjs',
    'scripts/data/mutation-segments.json',
  ]) {
    assert.ok(!existsSync(join(ROOT, p)), `${p} 应已删除（#276 方案 A 退役清点）`)
  }
  // 全部 conf 的 mutate 必须是源码路径（src/ 各包源码，或 shared/ 共享源码——
  // #378 起 trait 上移 shared/placement-math.js，js+d.ts 双写真源码；均非 lib/ 产物行号）
  const confDir = join(ROOT, 'stryker.conf.d')
  for (const f of readdirSync(confDir).filter((x) => x.endsWith('.json'))) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    for (const m of conf.mutate ?? []) {
      assert.ok((m.includes('/src/') || m.startsWith('shared/')) && !m.includes('lib/index.js'),
        `${f} 的 mutate "${m}" 必须是源码路径（src/ 或 shared/，方案 A：文件 glob 声明，无产物行号）`)
    }
  }
  // #439：根 stryker.config.json 已退役——lib 级 mutate 与 CI 段配置（src 级）口径脱节，
  // 全仓 stryker 配置统一收敛到 stryker.conf.d/。防退役后回归：根配置不得存在、不得被 git 追踪。
  const rootStryker = join(ROOT, 'stryker.config.json')
  assert.ok(!existsSync(rootStryker), '根 stryker.config.json 应已删除（#439 退役：口径统一 src 级 conf.d，禁止裸 stryker run 依赖根配置）')
  const ls = spawnSync('git', ['ls-files', 'stryker.config.json'], { cwd: ROOT, encoding: 'utf8' })
  assert.strictEqual(ls.status, 0, 'git ls-files 应正常退出')
  assert.strictEqual(ls.stdout.trim(), '', 'git ls-files stryker.config.json 应为空（根配置不得重新被版本库追踪，#439 防回归）')
})

test('#423: 变异测试单份维护——禁 *.src.test.ts 回潮 + lib→src hook 注入', () => {
  assert.ok(CI.includes('Forbid legacy src tests'),
    'ci.yml repo-gate 必须含 Forbid legacy src tests 步骤（#423 防双份回潮）')
  assert.ok(CI.includes('run: node scripts/gate/forbid-src-tests.mjs'),
    'Forbid legacy src tests 必须调用 scripts/gate/forbid-src-tests.mjs')
  assert.ok(existsSync(join(ROOT, 'scripts/gate/forbid-src-tests.mjs')),
    'forbid-src-tests.mjs 脚本必须存在')
  assert.ok(existsSync(join(ROOT, 'scripts/test/mutation-lib-to-src-hook.mjs')),
    'mutation-lib-to-src-hook.mjs 必须存在（#423 方案 A 重定向入口）')
  assert.ok(existsSync(join(ROOT, 'scripts/test/mutation-lib-to-src-loader.mjs')),
    'mutation-lib-to-src-loader.mjs 必须存在（#423 方案 A resolve hook）')

  const confDir = join(ROOT, 'stryker.conf.d')
  for (const f of readdirSync(confDir).filter((x) => x.endsWith('.json'))) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    const files = conf.tap?.testFiles ?? []
    for (const tf of files) {
      assert.ok(!tf.includes('.src.test.ts'),
        `${f} 的 testFiles 不得引用 *.src.test.ts（#423 方案 A：复用单份 *.test.ts）`)
    }
    const nodeArgs = conf.tap?.nodeArgs ?? []
    assert.ok(nodeArgs.includes('--import'),
      `${f} 的 tap.nodeArgs 必须含 --import（注入 lib→src hook）`)
    assert.ok(nodeArgs.includes('./scripts/test/mutation-lib-to-src-hook.mjs'),
      `${f} 的 tap.nodeArgs 必须注入 mutation-lib-to-src-hook.mjs`)
  }
})

test('#517 B5: ci.yml homedir 门禁——Forbid homedir 步骤存在并调 forbid-homedir-src.mjs + 根 scripts 入口', () => {
  assert.ok(CI.includes('Forbid homedir in src'),
    'ci.yml repo-gate 必须含 Forbid homedir in src 步骤（#517 B5 防回归）')
  assert.ok(CI.includes('run: node scripts/gate/forbid-homedir-src.mjs'),
    'Forbid homedir in src 必须调用 scripts/gate/forbid-homedir-src.mjs')
  assert.ok(existsSync(join(ROOT, 'scripts/gate/forbid-homedir-src.mjs')),
    'forbid-homedir-src.mjs 脚本必须存在')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['gate:homedir'], 'node scripts/gate/forbid-homedir-src.mjs',
    '根 package.json 必须含 gate:homedir 本地入口（与 ci.yml 同一命令）')
})

test('#178+#204+#572: ci.yml PR 增量门禁——从孤立分支恢复基线 + 按命中包切片 + 并入 repo-gate', () => {
  // #572：从孤立分支拉取基线，替代旧的读 scripts/gate/baseline/ main 代码树文件
  assert.ok(CI.includes('Restore incremental baseline from orphan branch'), 'mutation-gate 孤立分支基线读取步骤在位')
  assert.ok(CI.includes('orphan-baseline.mjs restore'), 'mutation-gate 调用 orphan-baseline.mjs restore 恢复基线')
  assert.ok(!CI.includes('scripts/gate/baseline/${BASENAME}.json'), 'ci.yml 不得再从 scripts/gate/baseline/ 读取基线')
  assert.ok(!CI.includes('actions/cache/restore@'), 'ci.yml 不得再用 actions/cache/restore（#204 已废弃跨 ref 缓存通道）')
  assert.ok(!CI.includes('actions/cache/save@'), 'ci.yml 禁止 save 缓存（PR 结果绝不回写夜间基线）')
  assert.ok(!CI.includes('actions/cache/@'), 'ci.yml 禁用 actions/cache@ 主 action 形态')

  const gateIdx = CI.indexOf('\n  mutation-gate:')
  assert.ok(gateIdx > 0, 'mutation-gate job 在位')
  // #217 后矩阵只做基线 restore + stryker run + 报告上传，判分收敛到 mutation-verdict
  const mg = CI.slice(gateIdx, CI.indexOf('\n  mutation-verdict:'))
  assert.ok(mg.includes('combo: ${{ fromJSON(needs.changes.outputs.mutationCombos) }}'),
    '动态 matrix ← changes.mutationCombos（#220 段式组合：[{package,seg}]，命中包按段实例化）')
  assert.ok(mg.includes('coverage/mutation/${BASENAME}.json'),
    '读恢复后基线文件路径 coverage/mutation/${BASENAME}.json')
  assert.ok(mg.includes('PKG="${MATRIX_PKG#dsh-}"'), '矩阵包名 dsh-<pkg> → 基线短名的映射在位')
  assert.ok(mg.includes('::notice::'), '基线缺失时须打 notice 标注全量降级（首夜属预期，防误判缺陷）')
  // build 必须全量（run #32790425132 教训）：mutate 区间行号锚定 esbuild 产物分段，
  // 产物结构依赖 workspace 内联链全集一致性
  const mgBuildIdx = mg.indexOf('Build all packages')
  assert.ok(mgBuildIdx > 0, 'mutation-gate 全量构建步骤在位')
  const mgBuildBlock = mg.slice(mgBuildIdx, mg.indexOf('- name:', mgBuildIdx + 10))
  assert.ok(/run: pnpm build\s*$/.test(mgBuildBlock), 'mutation-gate 构建步骤必须为全量 pnpm build')
  assert.ok(!mgBuildBlock.includes('--filter'), 'mutation-gate 构建步骤禁止 --filter 单包切片')

  // 成败并入既有聚合闸，不新增分支保护 required check 名
  assert.ok(/needs: \[changes, build-test, coverage, mutation-gate, mutation-verdict\]/.test(CI),
    'repo-gate needs 纳入 coverage 与 mutation-gate/mutation-verdict（#217 五维聚合）')
  // 聚合闸 fail-closed 判定脚本必须显式引用变异链结果（防聚合闸旁路）
  const rg = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(rg.includes('needs.mutation-gate.result'),
    'repo-gate fail-closed 判定脚本必须检查 needs.mutation-gate.result')
})

test('#572: baseline-overlay.yml 主干合入秒级差量覆盖基线工作流在位', () => {
  assert.ok(OVERLAY.includes('push:'), 'baseline-overlay 必须监听 push 事件')
  assert.ok(OVERLAY.includes('branches:\n      - main'), 'baseline-overlay 仅对 main 分支生效')
  assert.ok(OVERLAY.includes('group: mutation-baseline-sync'), 'baseline-overlay 必须与 observe 同步互斥锁')
  assert.ok(OVERLAY.includes('cancel-in-progress: false'), '互斥锁必须排队执行（不可取消未完任务以防覆盖丢失）')
  assert.ok(OVERLAY.includes('overlay-baseline.mjs'), '调用 overlay-baseline.mjs 脚本')
  assert.ok(CI.includes('Upload incremental baseline artifact'), 'ci.yml 必须在变异成功时上传 incremental artifact')
  assert.ok(CI.includes('mutation-incremental-'), 'artifact 命名格式为 mutation-incremental-<pkg>-<seg>')
})

// ── #187 触发面收敛：mutation-gate 仅限 pull_request，主干变异归夜间全量 ──

test('#187: ci.yml mutation-gate if 收敛至 pull_request（删除或改坏必红）', () => {
  // build-test 不受收敛影响：push 时仍须全集构建（repo-gate 全局门禁依赖产物）
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  mutation-gate:'))
  assert.ok(bt.includes('if: always() && needs.changes.result == \'success\''),
    'build-test 的 if 必须保持 always() 全事件构建语义')

  const mg = CI.slice(CI.indexOf('\n  mutation-gate:'), CI.indexOf('\n  mutation-verdict:'))
  const m = /^    if: (.+)$/m.exec(mg)
  assert.ok(m, 'mutation-gate 声明 job 级 if')
  assert.equal(
    m[1].trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    'mutation-gate 的 if 必须精确为「仅 PR 且 hasMutations 显式布尔」——'
    + '事件限制被删除（退化 push 全量变异）或被改坏（PR 门禁静默缺席）均判红；'
    + '#217 起空切片判定走 changes.hasMutations，禁止 fromJSON|length 或裸 \'[]\' 比较',
  )
})

test('#217+#187: repo-gate-assert 判定表全组合锁定（事件 × 切片 × coverage × 矩阵 × verdict）', async () => {
  const { evaluateGate } = await import('../gate/repo-gate-assert.mjs')
  const base = {
    event: 'pull_request',
    changes: 'success',
    buildTest: 'success',
    coverage: 'success',
    mutation: 'success',
    verdict: 'success',
    hasMutations: 'true',
    mutationPkgsJson: '["dsh-notifier"]',
  }
  const run = (over) => evaluateGate({ ...base, ...over })
  const RESULTS = ['success', 'failure', 'cancelled', 'skipped']

  // 手写期望表（独立于实现成文，防同义反复；0=绿 1=红）：
  //   - 非 PR：覆盖/变异三段全部 skipped 才绿（触发面收敛不变量）
  //   - PR + hasMutations=true：coverage==success && 矩阵∈{success,failure}
  //     && verdict==success 才绿
  //   - PR + 空切片：coverage==skipped && 矩阵/verdict∈{skipped,failure} 才绿
  const expectOf = (event, hm, cov, mut, verd) => {
    if (event !== 'pull_request') {
      return (cov === 'skipped' && mut === 'skipped' && verd === 'skipped') ? 0 : 1
    }
    if (hm === 'true') {
      return (cov === 'success' && (mut === 'success' || mut === 'failure') && verd === 'success') ? 0 : 1
    }
    return (cov === 'skipped'
      && (mut === 'skipped' || mut === 'failure')
      && (verd === 'skipped' || verd === 'failure')) ? 0 : 1
  }

  // PR 分支：hasMutations × coverage × 矩阵 × verdict 全组合（2×4×4×4 = 128 case）
  for (const hm of ['true', 'false']) {
    const pkgsJson = hm === 'true' ? '["dsh-notifier"]' : '[]'
    for (const cov of RESULTS) {
      for (const mut of RESULTS) {
        for (const verd of RESULTS) {
          const expected = expectOf('pull_request', hm, cov, mut, verd)
          const v = run({ hasMutations: hm, mutationPkgsJson: pkgsJson, coverage: cov, mutation: mut, verdict: verd })
          assert.equal(v.code, expected,
            `PR hasMutations=${hm} coverage=${cov} mutation=${mut} verdict=${verd} 应为 code=${expected}`)
        }
      }
    }
  }

  // 非 PR 分支：三段结果全组合（2 事件 × 4×4×4 = 128 case）；push fail-closed
  // 真实形态（GATE_MUTATION_PKGS 的 push 取值）为非空全集清单，数据校验须放行
  for (const ev of ['push', 'workflow_dispatch']) {
    for (const cov of RESULTS) {
      for (const mut of RESULTS) {
        for (const verd of RESULTS) {
          const expected = expectOf(ev, 'true', cov, mut, verd)
          const v = run({
            event: ev,
            hasMutations: 'true',
            mutationPkgsJson: JSON.stringify(MUTATION_PACKAGES),
            coverage: cov,
            mutation: mut,
            verdict: verd,
          })
          assert.equal(v.code, expected,
            `${ev} coverage=${cov} mutation=${mut} verdict=${verd} 应为 code=${expected}`)
        }
      }
    }
  }

  // ── reason 文案锚：区分「coverage 失败连坐」与「mutation 门禁绕过」（#217）──
  assert.match(run({ coverage: 'failure' }).reason, /coverage 失败连坐/,
    'coverage failure 判词必须点名「失败连坐」而非误报绕过')
  assert.match(run({ coverage: 'cancelled' }).reason, /coverage 失败连坐/,
    'coverage cancelled 同属失败连坐语义')
  assert.match(run({ coverage: 'skipped' }).reason, /缺席/,
    'coverage 缺席是结构性违约（if 契约被改坏），文案须与失败连坐区分')
  assert.match(run({ mutation: 'skipped' }).reason, /门禁绕过/,
    '矩阵该跑没跑判词必须点名「门禁绕过」')
  assert.match(run({ verdict: 'skipped' }).reason, /门禁绕过/,
    'verdict 该跑没跑同样按门禁绕过点名')
  assert.match(run({ verdict: 'failure' }).reason, /双指标|判分未通过/,
    'verdict failure 判词须点名判分未通过')
  assert.match(run({ verdict: 'cancelled' }).reason, /被取消（未完成判分）/,
    'verdict cancelled 判词须单列「被取消」，不得与判分未通过混用（复核小修）')
  assert.match(run({ event: 'push', mutation: 'success' }).reason, /收敛不变量/,
    '非 PR 下变异执行判词须点名收敛不变量')

  // 防回归对照：矩阵 failure 在 hasMutations=true 下不单独判红（报告已下发、
  // 由 verdict 统一裁决），但 verdict 未通过时整体必红
  assert.equal(run({ mutation: 'failure', verdict: 'success' }).code, 0,
    '矩阵实例级 failure + verdict 达标 = 绿（聚合判分语义）')
  assert.equal(run({ mutation: 'success', verdict: 'failure' }).code, 1,
    '矩阵 success 但 verdict 判分未通过 = 红')
  assert.equal(run({ mutation: 'failure', verdict: 'failure' }).code, 1,
    '矩阵与 verdict 双红 = 红')

  // 前提闸：changes / build-test 非 success 一律红（含 cancelled / skipped）
  for (const r of ['failure', 'cancelled', 'skipped']) {
    assert.equal(run({ changes: r }).code, 1, `changes=${r} 必须红`)
    assert.equal(run({ buildTest: r }).code, 1, `build-test=${r} 必须红`)
  }

  // 数据契约破坏：exit 2 —— 清单非法 JSON、hasMutations 非 'true'/'false'、
  // 显式布尔与切片非空性交叉矛盾
  for (const bad of ['not-json', '{"a":1}', '"dsh-notifier"']) {
    assert.equal(run({ mutationPkgsJson: bad }).code, 2, `切片清单非法（${bad}）必须 exit 2`)
  }
  for (const badHm of ['', 'TRUE', '1', 'null']) {
    assert.equal(run({ hasMutations: badHm }).code, 2, `hasMutations="${badHm}" 必须 exit 2`)
  }
  assert.equal(run({ hasMutations: 'true', mutationPkgsJson: '[]' }).code, 2,
    'hasMutations=true 而切片为空 = 数据矛盾 exit 2')
  assert.equal(run({ hasMutations: 'false', mutationPkgsJson: '["dsh-notifier"]' }).code, 2,
    'hasMutations=false 而切片非空 = 数据矛盾 exit 2')
})

test('#217+#187: repo-gate-assert CLI 退出码转发（GitHub Actions 判红依据）', () => {
  const script = join(ROOT, 'scripts/gate/repo-gate-assert.mjs')
  const envOf = (over) => ({
    GATE_EVENT: over.event ?? '',
    GATE_CHANGES: over.changes ?? '',
    GATE_BUILD_TEST: over.buildTest ?? '',
    GATE_COVERAGE: over.coverage ?? '',
    GATE_MUTATION: over.mutation ?? '',
    GATE_VERDICT: over.verdict ?? '',
    GATE_HAS_MUTATIONS: over.hasMutations ?? '',
    GATE_MUTATION_PKGS: over.mutationPkgsJson ?? '',
  })
  // 通过场景 exit 0：push 触发面收敛形态（三段全 skipped + 非空全集清单）
  const okRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'push', changes: 'success', buildTest: 'success',
      coverage: 'skipped', mutation: 'skipped', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: JSON.stringify(MUTATION_PACKAGES),
    }) },
  })
  assert.equal(okRun.status, 0, 'push + 三段全 skipped 场景 CLI 必须 exit 0')
  // 违约场景 exit 1 且输出 ::error:: 可检索的判词：PR 该跑没跑（verdict skipped）
  const failRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'pull_request', changes: 'success', buildTest: 'success',
      coverage: 'success', mutation: 'skipped', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: '["dsh-lan-proxy"]',
    }) },
  })
  assert.equal(failRun.status, 1, 'PR 该跑没跑场景 CLI 必须 exit 1')
  assert.match(failRun.stderr, /::error::/, '违约判词必须带 ::error:: 注解前缀（PR 页面可见）')
  assert.match(failRun.stderr, /绕过/, '判词须点名门禁绕过语义')
  // 连坐场景 exit 1 且判词区分「coverage 失败连坐」（#217 reason 分型）。
  // env 取值贴合并行拓扑真实形态（复核裁决选项 b）：矩阵与 coverage 平行、
  // cov 挂了矩阵照跑 success，verdict 因 if 要求 coverage success 连带 skipped
  const covFailRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'pull_request', changes: 'success', buildTest: 'success',
      coverage: 'failure', mutation: 'success', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: '["dsh-lan-proxy"]',
    }) },
  })
  assert.equal(covFailRun.status, 1, 'coverage 失败连坐场景 CLI 必须 exit 1')
  assert.match(covFailRun.stderr, /::error::/, '连坐判词必须带 ::error:: 注解前缀')
  assert.match(covFailRun.stderr, /coverage 失败连坐/, '连坐场景判词必须点名「coverage 失败连坐」，不得误报为门禁绕过')
})

test('#306: ci.yml 静态包名出现处 == MATRIX_PACKAGES（防清单漂移，替代旧 #178 全包名断言）', () => {
  // 动态化后 ci.yml 的静态包名只应出现在显式清单：build-test matrix、for/case 切片分支。
  // 全量列表（fallback/GLOBAL_HIT）与 547 产物断言已改为从 plugins-manifest.json 动态
  // 驱动（见 #306 单一事实源），不再出现在静态文本中。故只约束剩余显式处：
  //   - matrix 包名 == MATRIX_PACKAGES（active ∪ standalone ∪ 聚合）
  //   - for/case 包名 == SLICE_PACKAGES（active ∪ 聚合）
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  repo-gate:'))
  const matrixNames = [...bt.matchAll(/^\s*- (dsh-[a-z0-9-]+)\s*$/gm)].map((m) => m[1]).sort()
  assert.deepEqual(matrixNames, [...MATRIX_PACKAGES].sort(),
    `build-test matrix 包名与 MATRIX_PACKAGES 不一致：matrix=${matrixNames.join(',')} expected=${MATRIX_PACKAGES.join(',')}`)
  const computeBlock = CI.slice(CI.indexOf('Compute hit packages'))
  const loopList = /for pkg in ([\w -]+); do/.exec(computeBlock)?.[1]?.trim().split(/\s+/).sort()
  assert.deepEqual(loopList, [...SLICE_PACKAGES].sort(),
    `for 循环包名与 SLICE_PACKAGES 不一致：loop=${loopList?.join(',')} expected=${SLICE_PACKAGES.join(',')}`)
})

test('#306: repo-gate 产物断言必须动态驱动且空清单 fail-closed（防静默漏检）', () => {
  const restoreBlock = CI.slice(CI.indexOf('- name: Restore package outputs'))
  // 产物断言从 needs.changes.outputs.allPackages 驱动（manifest 单一事实源）
  assert.ok(/ALL_PACKAGES: \${{ needs\.changes\.outputs\.allPackages }}/.test(restoreBlock),
    '产物断言必须注入 needs.changes.outputs.allPackages')
  assert.ok(/for pkg in \$\(printf '%s' "\$ALL" \| jq -r '\.\[\]'\)/.test(restoreBlock),
    '产物断言必须从 allPackages 动态循环（禁止静态包名清单）')
  // 禁止回归为静态包名清单（评审发现：曾漏 verify-isolated 与 standalone）
  assert.ok(!/for pkg in dsh-[a-z0-9-]+ dsh-[a-z0-9-]+/.test(restoreBlock),
    '产物断言不得出现静态包名列表（曾漏 verify-isolated）')
  // 空清单 fail-closed：禁止零断言假绿
  assert.ok(/allPackages 为空（fail-closed/.test(restoreBlock),
    '产物断言必须显式防空清单（fail-closed，防零断言通过）')
})

test('#306: 全量列表动态化——fallback/GLOBAL_HIT 从 manifest 派生且空清单 fail-closed', () => {
  const computeBlock = CI.slice(CI.indexOf('Compute hit packages'))
  // 单一事实源：从 plugins-manifest.json 读 active 集
  assert.ok(/read_manifest_active/.test(computeBlock), '必须存在从 manifest 读 active 集的函数')
  assert.ok(/plugins-manifest\.json/.test(computeBlock), '必须读 plugins-manifest.json')
  assert.ok(/dsh-plugins-all/.test(computeBlock), '聚合包手工补入清单')
  // fallback / GLOBAL_HIT 都用动态清单，不得再出现静态全量列表
  const fallbackIdx = computeBlock.indexOf('fallback 全量切片')
  const globalIdx = computeBlock.indexOf('全局路径命中 → 全量切片')
  for (const idx of [fallbackIdx, globalIdx]) {
    const after = computeBlock.slice(idx, idx + 120)
    assert.ok(/emit_outputs "\$ALL_PACKAGES"/.test(after), '全量列表必须 emit_outputs "$ALL_PACKAGES"（动态）')
  }
  // 空清单 fail-closed（防 manifest 读失败 → 空切片 → 假绿）
  assert.ok(/包清单为空（fail-closed/.test(computeBlock), '空清单必须显式 fail-closed')
})

test('#306: 切片面真静默防回归——每个 active/standalone 包都有切片消费路径', () => {
  // 评审发现：verify-isolated 无 stryker 配置且不在切片 for/case 时，smoke 永不跑且
  // 无下游校验（真静默）。约束：for/case 切片必须覆盖 SLICE_PACKAGES（active ∪ 聚合），
  // 且每个 SLICE_PACKAGES 包在 for/case 中有分支；standalone 包（不进聚合）至少进
  // build matrix（由 #306 静态包名测试覆盖）。此处锁「切片面不漏 active 包」。
  const computeBlock = CI.slice(CI.indexOf('Compute hit packages'))
  const loopList = /for pkg in ([\w -]+); do/.exec(computeBlock)?.[1]?.trim().split(/\s+/).sort()
  for (const pkg of SLICE_PACKAGES) {
    assert.ok(loopList?.includes(pkg), `切片 for 循环缺 ${pkg} —— smoke/typecheck 将永不执行（真静默）`)
    assert.ok(computeBlock.includes(`${pkg}) V=`) || computeBlock.includes(`dsh-${pkg.slice(4)})`),
      `切片 case 分支缺 ${pkg}`)
  }
})

test('#178: 六份 stryker 配置开增量且 incrementalFile 无点前缀', () => {
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.ok(confFiles.length > 0, 'stryker.conf.d 非空')
  for (const f of confFiles) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    assert.equal(conf.incremental, true, `${f} 未开启 incremental`)
    const inc = typeof conf.incrementalFile === 'string' ? conf.incrementalFile : ''
    assert.match(inc, /^coverage\/mutation\/incremental-[a-z0-9-]+\.json$/,
      `${f} incrementalFile 必须落在 coverage/mutation/ 下且命名 incremental-<pkg>.json`)
    assert.ok(!basename(inc).startsWith('.'), `${f} incrementalFile 不得为 dotfile（upload-artifact v4 默认排除 hidden files，评审 P2#1）`)
    const pkgShort = f.replace(/^dsh-/, '').replace(/\.json$/, '')
    assert.ok(inc.endsWith(`incremental-${pkgShort}.json`), `${f} incrementalFile 包名段与配置文件名一致`)
  }
})

test('#178: 变异统计口径单一事实源——observe-check 与 mutation-gate 共用 lib', () => {
  for (const f of ['scripts/gate/observe-check.mjs', 'scripts/gate/mutation-gate.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(src.includes("from '../lib/mutation-report-lib.mjs'"),
      `${f} 须 import scripts/lib/mutation-report-lib.mjs 共享统计函数（防两处 covered 口径漂移）`)
  }
})

// ── #217 变异/覆盖解耦：cov 全局单次采集 + artifact 跨 job 传递 + 聚合判分 ──
// 三段式：coverage（全局单进程 cov+self-cov+guard 前移）∥ mutation-gate 矩阵
// （仅基线+stryker+报告上传，needs 仅 changes、与 coverage 平行无依赖——复核
// 裁决选项 b，wall-clock = max）→ mutation-verdict（artifact 汇合后逐包判分，
// if 要求 coverage success：cov 失败时 verdict 连带缺席，repo-gate 判红兜底）。
// flake 根因（矩阵 6 路并行各自全仓 smoke 的端口竞争与时序漂移）随剥离消除。

test('#217: changes 输出显式布尔 hasMutations（禁止脆弱空切片判定形态）', () => {
  assert.ok(CI.includes('hasMutations: ${{ steps.pkgs.outputs.hasMutations }}'),
    'changes outputs 必须声明并透传 hasMutations')
  assert.ok(CI.includes("jq -c 'length > 0'"),
    'hasMutations 必须由 mutationPackages 清单推导为显式布尔')
  // 下游一律精确比较布尔字符串；GHA 表达式无 length/管道，两种脆弱形态禁用
  assert.ok(!/\|\s*length/.test(CI), 'ci.yml 禁止 fromJSON(...)|length 判空形态')
  assert.ok(!CI.includes("'[]'"), 'ci.yml 禁止裸字符串比较 \'[]\' 判空形态')
})

test('#217: coverage job 全局单次采集——if 精确、步骤链与 artifact 上传契约', () => {
  const covIdx = CI.indexOf('\n  coverage:')
  assert.ok(covIdx > 0, 'coverage job 在位（非矩阵单实例）')
  const cov = CI.slice(covIdx, CI.indexOf('\n  mutation-gate:'))
  assert.ok(!cov.includes('matrix:'), 'coverage job 不得使用 matrix（全局单次语义）')
  assert.equal(
    /^    if: (.+)$/m.exec(cov)?.[1]?.trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    'coverage if 必须精确为「仅 PR 且 hasMutations」',
  )
  // 步骤链顺序：build → cov → self-cov → upload
  const buildIdx = cov.indexOf('- name: Build all packages')
  const covRunIdx = cov.indexOf('run: pnpm cov')
  const selfCovIdx = cov.indexOf('node scripts/gate/self-cov.mjs')
  const upIdx = cov.indexOf('Upload self-coverage artifact')
  for (const [name, idx] of [['Build all packages', buildIdx],
    ['pnpm cov', covRunIdx], ['self-cov.mjs', selfCovIdx], ['upload artifact', upIdx]]) {
    assert.ok(idx > 0, `coverage 步骤 ${name} 在位`)
  }
  assert.ok(buildIdx < covRunIdx && covRunIdx < selfCovIdx && selfCovIdx < upIdx,
    'coverage 步骤链必须按 build → cov → self-cov → upload 排布（guard 已退役，self-cov 读 c8 产物）')
  assert.ok(!cov.slice(0, upIdx).includes('--check'), 'PR coverage 只落盘不判红（--check 阈值硬校验归 observe 四班次）')

  // artifact 上传契约（fail-closed）
  const uploadBlock = cov.slice(upIdx)
  assert.ok(uploadBlock.includes('name: self-coverage'), 'artifact 名必须精确为 self-coverage（下游同名精确下载）')
  assert.ok(uploadBlock.includes('path: coverage/self-coverage.json'), '上传路径为固定产物路径')
  assert.ok(uploadBlock.includes('if-no-files-found: error'), '产物缺失必须 error（防下游静默空判分）')
  assert.ok(uploadBlock.includes('retention-days: 1'), '跨 job 传递产物 retention 收敛为 1 天')
})

test('#217: mutation-gate 剥离 cov——与 coverage 平行（needs 仅 changes）、if 精确锁定', () => {
  const mg = CI.slice(CI.indexOf('\n  mutation-gate:'), CI.indexOf('\n  mutation-verdict:'))
  // 复核裁决选项 b：矩阵与 coverage 平行无依赖（wall-clock = max）；
  // cov 失败时矩阵照常跑完，由 verdict 缺席 + repo-gate 判定表兜底整体红
  assert.ok(/^    needs: changes$/m.test(mg),
    'mutation-gate needs 必须恰为 changes（不得挂 coverage 连坐——拓扑已裁决为并行）')
  assert.ok(!mg.includes('needs: [changes, coverage'), '禁止恢复 mutation-gate → coverage 串行连坐拓扑')
  const m = /^    if: (.+)$/m.exec(mg)
  assert.ok(m, 'mutation-gate 声明 job 级 if')
  assert.equal(
    m[1].trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    '矩阵 if 必须精确锁定事件面与显式布尔切片',
  )
  // cov 已剥离出矩阵（每实例重复全仓 smoke 是 flake 根因）
  assert.ok(!mg.includes('run: pnpm cov'), '矩阵不得再跑 pnpm cov（已收敛至 coverage job 单次）')
  assert.ok(!mg.includes('self-cov.mjs'), '矩阵不得再跑 self-cov.mjs')
  // 报告上传契约：失败实例的报告也下发聚合判分
  const upIdx = mg.indexOf('Upload stryker report artifact')
  assert.ok(upIdx > 0, 'stryker 报告上传步骤在位')
  const upBlock = mg.slice(upIdx)
  assert.ok(/if: always\(\)/.test(upBlock), '报告上传必须 if: always()（实例非零退出时报告照常下发统一判分）')
  assert.ok(upBlock.includes('name: mutation-report-${{ matrix.combo.package }}-${{ matrix.combo.seg }}'),
    '报告 artifact 名含 matrix.combo（package+seg）保证段实例唯一（pattern 下游可枚举）')
  assert.ok(upBlock.includes('if-no-files-found: error'), '报告缺失必须 error（verdict 缺报告 fail-closed 的前提）')
})

test('#217: mutation-verdict 聚合收尾——artifact 汇合 + 逐包双指标判分', () => {
  const mv = CI.slice(CI.indexOf('\n  mutation-verdict:'), CI.indexOf('\n  repo-gate:'))
  assert.ok(mv.length > 0, 'mutation-verdict job 在位')
  assert.ok(/needs: \[changes, coverage, mutation-gate\]/.test(mv),
    'verdict needs 三元：切片清单 + 覆盖产物 + 变异报告缺一不可')
  assert.equal(
    /^    if: (.+)$/m.exec(mv)?.[1]?.trim(),
    "always() && needs.coverage.result == 'success' && needs.mutation-gate.result != 'skipped'",
    'verdict if 必须精确为「always() 且 coverage success 且矩阵非 skipped」——'
    + '矩阵 failure 时仍聚合判分（缺报告包 exit 2 fail-closed）；coverage 非 success 或矩阵 skipped 时连带缺席',
  )
  // artifact 下载：精确名 + pattern 双通道；download self-coverage 步骤块逐项精确断言
  const dlIdx = mv.indexOf('- name: Download self-coverage artifact')
  assert.ok(dlIdx > 0, 'self-coverage 下载步骤在位')
  const dlBlock = mv.slice(dlIdx, mv.indexOf('- name:', dlIdx + 10))
  assert.ok(dlBlock.includes('name: self-coverage'),
    'download 必须用精确 name self-coverage（pattern 匹配 0 个不报错，精确名缺失才报错）')
  assert.ok(/path: coverage\s*$/m.test(dlBlock),
    'download path 必须恰为 coverage/（单文件 zip 根层级 = 文件本身，解压即还原 coverage/self-coverage.json）')
  assert.ok(mv.includes('pattern: mutation-report-*'), '各包 stryker 报告经 pattern 枚举下载')
  assert.ok(mv.includes('node scripts/gate/mutation-gate.mjs'), '逐包判分脚本调用在位')
  assert.ok(mv.includes("SLICE: ${{ needs.changes.outputs.mutationPackages }}"),
    'verdict 以 changes 切片清单驱动逐包判分')
})

test('#217: repo-gate 五维聚合 needs + 判定脚本 env 全维注入', () => {
  const rg = CI.slice(CI.indexOf('\n  repo-gate:'))
  for (const env of ['GATE_EVENT', 'GATE_CHANGES', 'GATE_BUILD_TEST',
    'GATE_COVERAGE', 'GATE_MUTATION', 'GATE_VERDICT', 'GATE_HAS_MUTATIONS', 'GATE_MUTATION_PKGS']) {
    assert.ok(new RegExp(`${env}: \\$\\{\\{`).test(rg), `判定脚本 env ${env} 注入缺失`)
  }
  // 判定表实现侧同维锁定（env ↔ evaluateGate 输入一一对应）
})

test('#217+#572: observe 两班 Mutation suites id + push 区分整套 skip 与部分失败', () => {
  for (const [name, wf] of [['observe.yml', OBSERVE], ['observe-incremental.yml', OBSERVE_INC]]) {
    const sIdx = wf.indexOf('- name: Mutation suites')
    assert.ok(sIdx > 0, `${name} Mutation suites 步骤在位`)
    const sBlock = wf.slice(sIdx, wf.indexOf('- name:', sIdx + 10))
    assert.ok(sBlock.includes('id: mutation-suites'), `${name} Mutation suites 必须声明 id 供下游引用 outcome`)
    const pIdx = wf.indexOf('- name: Push baseline to orphan branch')
    assert.ok(pIdx > 0, `${name} Push baseline to orphan branch 步骤在位`)
    const pBlock = wf.slice(pIdx, wf.indexOf('- name:', pIdx + 10))
    assert.ok(pBlock.includes("if: always() && steps.mutation-suites.outcome != 'skipped'"),
      `${name} push 条件必须区分整套 skip（无产物不推送）与部分失败（记账班次照常提交）`)
  }
})
