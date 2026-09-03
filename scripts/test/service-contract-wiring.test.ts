#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * mcp-manager-service 契约测试编译面接线（issue #476 service-contract）。
 *
 * 为什么存在：shared/mcp-manager-service.d.ts 是 ctx.mcpManager 服务类型面的
 * 单一事实源，但提供方/消费方包的主 tsconfig（include src/**）不编译 test/，
 * `pnpm typecheck`/`pnpm build` 的 tsc 面到不了契约测试文件；而 `pnpm test`/
 * `pnpm test:scripts` 都是 Node 直跑 TS（type stripping 擦除类型断言）——若只
 * 靠直跑，编译期 Equal/Same 断言是「假锁」（方案评审 P0-A 已实证）。
 *
 * 本文件 = 编译面接线器：spawn 仓库 tsc 以两包 test/tsconfig.json（noEmit，
 * include 全量测试 ts）真实编译契约测试文件，断言退出码 0。类型断言失败 →
 * tsc 非 0 → 本测试红。随 `pnpm test:scripts`（repo-gate 无条件步骤）执行，
 * CI/本地对「shared 类型面 ↔ 契约测试清单」漂移零成本判红。
 *
 * 接线对象：
 *   - packages/dsh-mcp-manager/test/tsconfig.json（既有文件，此前零引用）
 *   - packages/dsh-codegraph/test/tsconfig.json（#476 同构新建）
 * 两包测试文件均无 @ts-nocheck，类型断言真实参与检查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
// tsc 真实 JS 入口（node_modules/.bin/tsc 是 shell shim，不能经 node 执行；
// 用 typescript 包内的 bin 入口，node 直接加载）。
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const SUITES = [
  {
    name: 'dsh-mcp-manager（提供方契约 + apply provide 方法面）',
    tsconfig: join(ROOT, 'packages', 'dsh-mcp-manager', 'test', 'tsconfig.json'),
    expectFiles: ['service-contract.test.ts'],
  },
  {
    name: 'dsh-codegraph（消费方公开入口契约）',
    tsconfig: join(ROOT, 'packages', 'dsh-codegraph', 'test', 'tsconfig.json'),
    expectFiles: ['service-consumer.test.ts'],
  },
]

test('service-contract 编译面接线：契约测试文件被 tsc 真实编译（#476）', () => {
  assert.ok(existsSync(TSC), `仓库 tsc 应存在（${TSC}）——pnpm install 后才有`)
  for (const suite of SUITES) {
    assert.ok(existsSync(suite.tsconfig), `tsconfig 应存在（${suite.tsconfig}）`)
    for (const file of suite.expectFiles) {
      const f = join(suite.tsconfig, '..', file)
      assert.ok(existsSync(f), `契约测试文件应存在（${f}）`)
    }
    const result = spawnSync(process.execPath, [TSC, '-p', suite.tsconfig, '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    })
    assert.strictEqual(
      result.status,
      0,
      `${suite.name}：tsc 编译契约测试失败（exit=${result.status}）——shared 类型面与契约测试清单漂移？\n${result.stdout}\n${result.stderr}`,
    )
    assert.ok(result.stdout.length >= 0)
  }
})
