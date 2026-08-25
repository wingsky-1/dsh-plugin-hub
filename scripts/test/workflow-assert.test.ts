#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * workflow-assert — CI workflow 结构静态断言（#85 v3 F2 防回归条款）。
 *
 * 断言 ci.yml / observe.yml 的关键结构不变量：
 *   - repo-gate 聚合闸：if always()、fail-closed 断言步骤、required check 名不变
 *   - fail-closed 双闸：filter 失败 fallback 全量切片
 *   - build-test 矩阵恒全集构建（repo-gate 全局门禁依赖全量 lib 产物，评审 F1）
 *   - action 一律 pin commit SHA（供应链纪律，与 health-report.yml 既有惯例一致）
 *   - observe.yml：夜间调度、self-cov --check 与 mutate-scope-guard 执行点在位；
 *     六包串行清单 ↔ stryker.conf.d 文件集 ↔ gauntlet mutation.packages 三方一致
 *   - changes 的 case 映射覆盖全部包（防新增包静默漏检，评审 F7）
 *
 * 运行：node --test scripts/test/workflow-assert.test.ts（或 pnpm test:scripts）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const OBSERVE = readFileSync(join(ROOT, '.github/workflows/observe.yml'), 'utf8')
const GAUNTLET = JSON.parse(readFileSync(join(ROOT, 'scripts/data/gauntlet.config.json'), 'utf8'))

const ALL_PACKAGES = [
  'dsh-notifier',
  'dsh-idle-archive',
  'dsh-web-file-preview',
  'dsh-mcp-manager',
  'dsh-provider-usage',
  'dsh-lan-proxy',
  'dsh-plugins-all',
]

test('ci.yml: repo-gate 保持分支保护 required check 名', () => {
  const m = /repo-gate:\s*\n\s*name: (.+)/.exec(CI)
  assert.ok(m, '存在 repo-gate 作业且声明 name')
  assert.equal(m[1].trim(), 'Build / Contract / Smoke / Pack',
    'required check 名必须与旧单作业名一致（维护者分支保护无缝切换）')
})

test('ci.yml: repo-gate if always() 且首步 fail-closed 断言双上游', () => {
  const gate = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(/if: always\(\)/.test(gate), 'repo-gate 必须 always() 运行（上游失败时仍执行判红）')
  assert.ok(gate.includes('needs.changes.result'), '断言 changes 结果')
  assert.ok(gate.includes('needs.build-test.result'), '断言 build-test 结果')
  assert.ok(/Fail-closed gate assertion/.test(gate), 'fail-closed 断言步骤在位')
})

test('ci.yml: filter 失败 fallback 全量切片（fail-closed 双闸）', () => {
  assert.ok(CI.includes('[ "$FILTER_OUTCOME" = "failure" ]'),
    'filter outcome failure 必须触发全量切片 fallback')
  assert.ok(/按全量处理/.test(CI), 'diff base 不可用时按全量处理（F4）')
})

test('ci.yml: build-test 矩阵恒全集且 build 无条件（评审 F1：全局门禁依赖全量产物）', () => {
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  repo-gate:'))
  for (const pkg of ALL_PACKAGES) {
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
  for (const pkg of ALL_PACKAGES) {
    assert.ok(computeBlock.includes(`dsh-${pkg.slice(4)})`) || computeBlock.includes(`${pkg}) V=`),
      `case 分支缺 ${pkg} —— 新增包必须同步加映射分支`)
  }
  // 循环遍历清单与 ALL_PACKAGES 一致
  const loopList = /for pkg in ([\w -]+); do/.exec(computeBlock)?.[1]?.trim().split(/\s+/).sort()
  assert.deepEqual(loopList, [...ALL_PACKAGES].sort(), 'for 循环清单与包全集不一致')
})

test('ci.yml/observe.yml: 第三方与官方 action 一律 pin commit SHA', () => {
  for (const [name, text] of [['ci.yml', CI], ['observe.yml', OBSERVE]]) {
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
  assert.ok(OBSERVE.includes('mutate-scope-guard.mjs'), 'mutate 面守卫执行点（F5）')
  assert.ok(OBSERVE.includes('observe-check.mjs'), '阈值校验+回落检测脚本执行点（F1/F6）')
})

test('六包变异三方一致：observe 清单 ↔ stryker.conf.d 文件集 ↔ gauntlet 包集', () => {
  // observe.yml 循环名单
  const loopPkgs = [...OBSERVE.matchAll(/for pkg in ([\w -]+); do/g)]
    .flatMap((m) => m[1].trim().split(/\s+/)).map((s) => `dsh-${s}`).sort()

  // stryker.conf.d 实际文件集（评审 F2：配置文件缺失会让夜间循环首夜必红）
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(loopPkgs, confFiles.map((f) => f.replace(/\.json$/, '')),
    `observe 变异循环与 stryker.conf.d 文件集不一致：loop=${loopPkgs.join(',')} conf=${confFiles.join(',')}`)

  // gauntlet mutation.packages 与 conf 文件集一致（不含 .json 后缀）
  const gauntPkgs = Object.keys(GAUNTLET?.mutation?.packages ?? {}).sort()
  assert.deepEqual(gauntPkgs, confFiles.map((f) => f.replace(/\.json$/, '')).sort(),
    'gauntlet mutation.packages 应覆盖全部带变异配置的功能插件包')

  // jsonReporter 输出路径 ↔ observe-check 读的报告名一致
  for (const f of confFiles) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    const out = conf?.jsonReporter?.fileName
    assert.ok(out && out.endsWith(`coverage/mutation/${f}`),
      `${f} 的 jsonReporter 输出应为 coverage/mutation/${f}（observe-check 按此约定读取）`)
  }

  // packages/ 目录集 ⊇ conf 文件集对应目录
  for (const f of confFiles) {
    const dir = join(ROOT, 'packages', f.replace(/\.json$/, ''))
    assert.ok(existsSync(dir), `packages/${f.replace(/\.json$/, '')} 目录存在`)
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

// ── #178 v2：Stryker 增量模式接入（夜间全量落缓存 + PR 增量切片门禁）──

test('#178: observe.yml 夜间保持全量——只落缓存不读缓存', () => {
  assert.ok(OBSERVE.includes('actions/cache/save@'), '夜间全量运行末尾须保存 incremental 基线缓存')
  assert.ok(
    !OBSERVE.includes('actions/cache/restore'),
    'observe.yml 严禁出现 restore 缓存步骤——无基线即天然全量（v2 架构定案，勿"好心"补 restore）',
  )
  const idx = OBSERVE.indexOf('Save incremental baseline cache')
  assert.ok(idx > 0, 'save 步骤在位')
  const block = OBSERVE.slice(idx, OBSERVE.indexOf('- name:', idx + 10))
  assert.ok(block.includes('if: always()'), 'save 步骤必须 if: always()（部分失败夜已产出的基线照常落盘，评审 P1#3）')
  assert.ok(block.includes('observe-incremental-${{ github.run_id }}'), '缓存 key = 单条目 observe-incremental-<run_id>（v2 P2#2 偏离定案）')
  assert.ok(block.includes('coverage/mutation/incremental-*.json'), 'save path 用 glob 收六份基线文件')
})

test('#178: ci.yml PR 增量门禁——restore-only + 按命中包切片 + 并入 repo-gate', () => {
  // 只读不回写：允许 cache/restore，禁止 cache/save（防 PR 结果污染夜间基线源）
  assert.ok(CI.includes('actions/cache/restore@'), 'PR 侧 restore-only 读缓存')
  assert.ok(!CI.includes('actions/cache/save@'), 'ci.yml 禁止 save 缓存（PR 结果绝不回写夜间基线）')

  const gateIdx = CI.indexOf('\n  mutation-gate:')
  assert.ok(gateIdx > 0, 'mutation-gate job 在位')
  const mg = CI.slice(gateIdx, CI.indexOf('\n  repo-gate:'))
  assert.ok(mg.includes('package: ${{ fromJSON(needs.changes.outputs.mutationPackages) }}'),
    '动态 matrix ← changes.mutationPackages（命中包天然切片，未触包不实例化）')
  assert.ok(mg.includes('restore-keys:'), '精确 key 必 miss 后走前缀兜底（命中最近一夜基线）')
  assert.ok(mg.includes('observe-incremental-'), 'restore-keys 前缀与夜间 save key 同源')
  // 主 action 形态自带 save 后置步骤即回写，一律禁用（只允许 restore/save 子 action）
  assert.ok(!CI.includes('actions/cache/@'), 'ci.yml 禁用 actions/cache@ 主 action 形态（自带回写）')
  assert.ok(!CI.includes('actions/cache/save@'), 'ci.yml 禁止 save 缓存（PR 结果绝不回写夜间基线）')
  assert.ok(/timeout-minutes: 45/.test(mg), 'mutation-gate timeout ≥45 分钟（miss 首夜全量变异 + cov 全仓 smoke 的悬崖余量）')
  assert.ok(mg.includes('cache-matched-key'), 'restore 步骤须暴露 cache-matched-key 供 hit/miss 审计')
  assert.ok(mg.includes('::notice::'), '缓存 miss 时须打 notice 标注全量降级（首夜属预期，防误判缺陷）')
  assert.ok(mg.includes('scripts/gate/mutation-gate.mjs'), '双指标判分脚本执行点在位')
  assert.ok(mg.includes('scripts/gate/self-cov.mjs'), '覆盖率指标数据源执行点在位')
  // build 必须全量（run #32790425132 教训）：pnpm cov = c8 包裹全仓 smoke，
  // 单包构建会让其余包 lib/index.js 缺失而 ERR_MODULE_NOT_FOUND
  const mgBuildIdx = mg.indexOf('Build all packages')
  assert.ok(mgBuildIdx > 0, 'mutation-gate 全量构建步骤在位')
  const mgBuildBlock = mg.slice(mgBuildIdx, mg.indexOf('- name:', mgBuildIdx + 10))
  assert.ok(/run: pnpm build\s*$/.test(mgBuildBlock), 'mutation-gate 构建步骤必须为全量 pnpm build')
  assert.ok(!mgBuildBlock.includes('--filter'), 'mutation-gate 构建步骤禁止 --filter 单包切片')

  // 成败并入既有聚合闸，不新增分支保护 required check 名
  assert.ok(/needs: \[changes, build-test, mutation-gate\]/.test(CI), 'repo-gate needs 纳入 mutation-gate')
  // 聚合闸 fail-closed 判定脚本必须显式引用 mutation-gate 结果（防聚合闸旁路）
  const rg = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(rg.includes('needs.mutation-gate.result'),
    'repo-gate fail-closed 判定脚本必须检查 needs.mutation-gate.result')
})

test('#178: ci.yml 包名全集 ≡ gauntlet 变异六包 ∪ {dsh-plugins-all}（防清单漂移）', () => {
  const mentioned = [...new Set(CI.match(/dsh-[a-z0-9-]+/g) ?? [])].sort()
  const expected = [...new Set([
    ...Object.keys(GAUNTLET?.mutation?.packages ?? {}),
    'dsh-plugins-all',
  ])].sort()
  assert.deepEqual(mentioned, expected,
    `ci.yml 出现的包名集合与 gauntlet mutation.packages ∪ {dsh-plugins-all} 不一致：`
    + `ci=${mentioned.join(',')} gauntlet+all=${expected.join(',')}——新增包须同步全部清单`)
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
