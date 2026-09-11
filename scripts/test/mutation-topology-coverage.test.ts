// @ts-nocheck
'use strict'

/**
 * 变异拓扑派生规则共享模块的回归（#710 F15：覆盖断言必须复用「段无 excludes 用默认值」的派生逻辑）。
 *
 * 为什么单独测：F15 的隐患是「生成侧注入默认 excludes、断言侧只读段内显式值」——
 * 段一旦省略 excludes，覆盖断言就会出现盲区（源文件既不在 mutate 也不在断言的 excludes 里，
 * 却不报未覆盖）。本用例直接对共享函数做正反断言，并额外锚定「落盘 conf 与断言口径同源」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { collectMutationSpecs, defaultSegmentExcludes } from '../gate/mutation-topology.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const GENERATOR = join(ROOT, 'scripts', 'gate', 'gen-stryker-conf.mjs')
const TOPOLOGY_PATH = join(ROOT, 'scripts', 'data', 'mutation-topology.json')

test('F15：段未显式写 excludes 时，collectMutationSpecs 仍返回默认排除面', () => {
  const topology = {
    packages: {
      'fixture-pkg': {
        segments: {
          noExcludes: { mutate: ['packages/fixture-pkg/src/a.ts'] },
          withExcludes: { mutate: ['packages/fixture-pkg/src/b.ts'], excludes: ['!packages/fixture-pkg/src/skip/**'] },
        },
      },
    },
  }
  const specs = collectMutationSpecs(topology, 'fixture-pkg')
  assert.deepEqual(specs.excludes.sort(), [
    'packages/fixture-pkg/src/client/**',
    'packages/fixture-pkg/src/skip/**',
    'packages/fixture-pkg/src/types.ts',
  ].sort(), `默认值必须与显式值一起进断言口径：${JSON.stringify(specs.excludes)}`)
  assert.deepEqual(specs.excludes, [...new Set(specs.excludes)], '口径内不得重复')
})

test('F15：未登记包返回 null（调用方 fail-closed），默认值随包名派生', () => {
  assert.equal(collectMutationSpecs({ packages: {} }, 'unknown-pkg'), null)
  assert.deepEqual(defaultSegmentExcludes('dsh-x'), [
    '!packages/dsh-x/src/client/**',
    '!packages/dsh-x/src/types.ts',
  ])
})

test('F15 反证：落盘 conf 的 mutate 面与断言口径同源（含 coverageExcludes 追加）', () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf8'))
  const specs = collectMutationSpecs(topology, 'dsh-mcp-manager')
  const conf = JSON.parse(readFileSync(join(ROOT, 'stryker.conf.d', 'dsh-mcp-manager-entry.json'), 'utf8'))
  const confExcludes = conf.mutate.filter((g) => g.startsWith('!')).map((g) => g.replace(/^!/, ''))
  for (const g of specs.excludes) {
    assert.ok(confExcludes.includes(g), `段 conf 缺少断言口径里的排除 glob：${g}`)
  }
  // coverageExcludes（S0 存量登记）必须真的落到 conf，否则覆盖断言与生成器再次脱节
  for (const g of topology.packages['dsh-mcp-manager'].testLayers.coverageExcludes) {
    assert.ok(conf.mutate.includes(g), `coverageExcludes 未落盘到 conf：${g}`)
  }
})

test('F15 反证：段省略 excludes 时生成器注入默认值（fixture 最小仓库）', () => {
  const root = mkdtempSync(join(tmpdir(), 'f15-fixture-'))
  try {
    const pkg = 'fixture-pkg'
    const files = {
      [`packages/${pkg}/src/a.ts`]: 'export const a = 1\n',
      [`packages/${pkg}/src/client/ui.ts`]: 'export const b = 2\n',
      [`packages/${pkg}/test/unit/unit-a.test.ts`]: 'import "../../src/a.ts"\n',
      'scripts/data/mutation-topology.json': `${JSON.stringify({
        $testLayers: {
          layers: { unit: 'test/unit/**/*.test.ts', integration: 'test/integration/**/*.test.ts', client: 'test/client/**/*.test.ts', e2e: 'test/e2e/**/*.test.ts' },
          mutationLayers: ['unit', 'integration'],
          mutationExcludeLayers: ['client', 'e2e'],
        },
        sharedDefaults: {
          testRunner: 'vitest', concurrency: 1, timeoutMS: 1000, dryRunTimeoutMinutes: 5,
          reporters: ['progress'], coverageAnalysis: 'perTest', tempDirName: '.stryker-tmp',
          cleanTempDir: true, excludedMutations: [], vitest: { related: false },
        },
        packages: {
          [pkg]: {
            testLayers: {},
            segments: { only: { mutate: [`packages/${pkg}/src/a.ts`] } },
          },
        },
      }, null, 2)}\n`,
      [`packages/${pkg}/package.json`]: `${JSON.stringify({ name: pkg, scripts: { test: 'node ../../scripts/gate/run-tests.mjs --min 1' } }, null, 2)}\n`,
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    }
    mkdirSync(join(root, 'stryker.conf.d'), { recursive: true })

    const res = spawnSync(process.execPath, [GENERATOR], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GEN_STRYKER_ROOT: root },
    })
    assert.equal(res.status, 0, `生成应成功：\n${res.stdout}${res.stderr}`)
    const conf = JSON.parse(readFileSync(join(root, 'stryker.conf.d', `${pkg}-only.json`), 'utf8'))
    for (const g of defaultSegmentExcludes(pkg)) {
      assert.ok(conf.mutate.includes(g), `段省略 excludes 时应注入默认值：${g}\n${JSON.stringify(conf.mutate)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
