#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * workflow-assert — CI workflow 结构静态断言（#85 v3 F2 防回归条款）。
 *
 * 断言 ci.yml / observe.yml 的关键结构不变量：
 *   - repo-gate 聚合闸：if always()、fail-closed 断言步骤、required check 名不变
 *   - fail-closed 双闸：filter 失败 fallback 全量、空矩阵占位元素
 *   - action 一律 pin commit SHA（供应链纪律，与 health-report.yml 既有惯例一致）
 *   - observe.yml：夜间调度、self-cov --check 与 mutate-scope-guard 执行点在位
 *   - ALL_PACKAGES ↔ packages/ 目录集 ↔ gauntlet mutation.packages 三方一致
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

test('ci.yml: filter 失败 fallback 全量（fail-closed 双闸）', () => {
  assert.ok(/FILTER_OUTCOME.*=.*"failure"|FILTER_OUTCOME" = "failure"/.test(CI) ||
    CI.includes('[ "$FILTER_OUTCOME" = "failure" ]'),
    'filter outcome failure 必须触发全量 fallback')
  assert.ok(/base 置空|按全量处理/.test(CI), 'diff base 不可用时按全量处理（F4）')
})

test('ci.yml: 空矩阵注入占位元素且占位实例全步骤跳过（防空矩阵假绿）', () => {
  assert.ok(CI.includes("EMPTY_MATRIX_PLACEHOLDER: '__none__'"), '占位元素定义')
  assert.ok(/注入占位元素防空矩阵假绿/.test(CI), '空包场景注入占位')
  // 占位实例跳过：matrix.package != '__none__' 条件至少出现在 build-test 各步骤
  const skipCount = (CI.match(/matrix\.package != '__none__'/g) ?? []).length
  assert.ok(skipCount >= 7, `build-test 每个实质步骤都须带占位跳过条件（当前 ${skipCount} 处）`)
})

test('ci.yml/observe.yml: 第三方与官方 action 一律 pin commit SHA', () => {
  for (const [name, text] of [['ci.yml', CI], ['observe.yml', OBSERVE]]) {
    const uses = [...text.matchAll(/uses:\s*(\S+)(?:@\s*(\S+))?/g)].map((m) => m[1] + (m[2] ? `@${m[2]}` : '@'))
    for (const u of uses) {
      const ref = u.split('@')[1] ?? ''
      assert.match(ref, /^[0-9a-f]{40}/, `${name}: ${u} 未 pin 到 40 位 commit SHA`)
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

test('ALL_PACKAGES ↔ packages/ 目录 ↔ gauntlet mutation.packages 三方一致', () => {
  const m = /ALL_PACKAGES: '(\[[^\]]+\])'/.exec(CI)
  assert.ok(m, 'ci.yml 声明 ALL_PACKAGES 清单')
  const declared = JSON.parse(m[1])

  const pkgDir = join(ROOT, 'packages')
  const dirs = readdirSync(pkgDir).sort()
  const declaredSorted = [...declared].sort()
  assert.deepEqual(declaredSorted, dirs,
    `ci.yml ALL_PACKAGES 与 packages/ 目录不一致：ci=${declaredSorted.join(',')} dirs=${dirs.join(',')}`)

  const gauntPkgs = Object.keys(GAUNTLET?.mutation?.packages ?? {}).sort()
  const expectedGaunt = dirs.filter((d) => d !== 'dsh-plugins-all').sort()
  assert.deepEqual(gauntPkgs, expectedGaunt,
    'gauntlet mutation.packages 应覆盖全部功能插件包（聚合包除外）')

  // observe.yml 六包串行清单与 gauntlet 功能包一致
  const loopPkgs = [...OBSERVE.matchAll(/for pkg in ([\w -]+); do/g)]
    .flatMap((m) => m[1].trim().split(/\s+/)).map((s) => `dsh-${s}`).sort()
  assert.deepEqual(loopPkgs, expectedGaunt, 'observe.yml 变异串行清单须与 gauntlet 包集一致')
})

test('gauntlet: mutation.packages 全部带 threshold 字段且 ≥60（阶段一基线）', () => {
  const pkgs = GAUNTLET?.mutation?.packages ?? {}
  assert.ok(Object.keys(pkgs).length > 0, 'mutation.packages 非空')
  for (const [pkg, cfg] of Object.entries(pkgs)) {
    assert.equal(typeof cfg.threshold, 'number', `${pkg}.threshold 已落盘`)
    assert.ok(cfg.threshold >= 60, `${pkg}.threshold=${cfg.threshold} 不低于阶段一基线 60`)
  }
})
