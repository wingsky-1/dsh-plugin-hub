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
import { join } from 'node:path'

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
      const m = /^uses:\s*([\w.-]+\/[\w.-]+)(?:@(\S+))?\s*(?:#.*)?$/.exec(line.trim())
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
