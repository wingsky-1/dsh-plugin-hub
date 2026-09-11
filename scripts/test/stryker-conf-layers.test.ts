// @ts-nocheck
'use strict'

/**
 * 变异面登记完整性门禁回归（#690 S2b / #713 T3）。
 *
 * 为什么在临时 fixture 根里跑：`--check` 的判据是「拓扑声明 ↔ 磁盘实际」的派生一致性，
 * 在仓库内造包目录会违反产物零污染纪律（#218）。故用 GEN_STRYKER_ROOT 注入 mkdtemp 根，
 * 与 verify-dir-imports-s0.test.ts 的 fixture 形态一致。
 *
 * 覆盖的判据（每条都有反向用例，防「门禁写得像门禁」）：
 *   ① 单元层文件自动进变异面（新增 test/unit/ 文件零手工步骤）
 *   ② runner 面文件必须落入某一层 glob 或某条逐条豁免（无层归属 → 判红）
 *   ③ 豁免必须带理由且真实存在于 unit 层
 *   ④ `--min` == runner glob 实际文件数（脱节 → 判红；--sync-test-min 可同步）
 *   ⑤ 从派生 conf 删掉一条登记条目 → 判红
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { projectTestSurface } from '../gate/gen-stryker-conf.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const GENERATOR = join(ROOT, 'scripts', 'gate', 'gen-stryker-conf.mjs')
const PKG = 'fixture-pkg'

const TOPOLOGY = {
  $testLayers: {
    layers: {
      unit: 'test/unit/**/*.test.ts',
      integration: 'test/integration/**/*.test.ts',
      client: 'test/client/**/*.test.ts',
      e2e: 'test/e2e/**/*.test.ts',
    },
    mutationLayers: ['unit', 'integration'],
    mutationExcludeLayers: ['client', 'e2e'],
  },
  sharedDefaults: {
    testRunner: 'tap',
    concurrency: 16,
    timeoutMS: 60000,
    dryRunTimeoutMinutes: 5,
    reporters: ['progress'],
    coverageAnalysis: 'perTest',
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
    excludedMutations: [],
    tapNodeArgs: ['-r', './scripts/test/mutation-tap-bridge.cjs', '--import', './scripts/test/mutation-lib-to-src-hook.mjs'],
  },
  packages: {
    [PKG]: {
      testLayers: {},
      segments: {
        only: {
          mutate: [`packages/${PKG}/src/**/*.ts`],
          excludes: [`!packages/${PKG}/src/client/**`],
        },
      },
    },
  },
}

const BASE_FILES = {
  [`packages/${PKG}/src/index.ts`]: 'export const a = 1\n',
  [`packages/${PKG}/src/client/ui.ts`]: 'export const b = 2\n',
  [`packages/${PKG}/test/unit/unit-a.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/unit/unit-b.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/unit/unit-d.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/integration/flow.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/client/client-a.test.ts`]: 'import "../../src/client/ui.ts"\n',
  [`packages/${PKG}/test/e2e/smoke.test.ts`]: 'import "../../src/index.ts"\n',
  [`packages/${PKG}/test/helpers.ts`]: 'export const h = 1\n',
  [`packages/${PKG}/package.json`]: `${JSON.stringify({ name: PKG, scripts: { test: 'node ../../scripts/gate/run-tests.mjs --min 6' } }, null, 2)}\n`,
}

/** 造 fixture 仓库根（含拓扑与 stryker.conf.d），返回根路径。 */
function makeFixtureRoot(extraFiles = {}, topologyOverride = TOPOLOGY) {
  const root = mkdtempSync(join(tmpdir(), 's2b-fixture-'))
  const files = {
    ...BASE_FILES,
    'scripts/data/mutation-topology.json': `${JSON.stringify(topologyOverride, null, 2)}\n`,
    ...extraFiles,
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  mkdirSync(join(root, 'stryker.conf.d'), { recursive: true })
  return root
}

function runGenerator(root, args = []) {
  const res = spawnSync(process.execPath, [GENERATOR, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GEN_STRYKER_ROOT: root },
  })
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** 生成到磁盘（写模式），返回 conf 路径。 */
function generate(root) {
  const res = runGenerator(root)
  assert.equal(res.status, 0, `生成应成功：\n${res.out}`)
  return join(root, 'stryker.conf.d', `${PKG}-only.json`)
}

test('T2/T3①：runner 面文件全部自动分层，单元/集成层进变异面，client/e2e 层排除', () => {
  const root = makeFixtureRoot()
  try {
    const p = projectTestSurface(root, TOPOLOGY, PKG)
    assert.deepEqual(p.errors, [], `投影不应有错误：${p.errors.join('; ')}`)
    assert.equal(p.runFiles.length, 6, `runner 面应为 6 个文件：${p.runFiles.join(', ')}`)
    assert.deepEqual(
      p.testFiles.map((f) => f.replace(`packages/${PKG}/`, '')),
      ['test/integration/flow.test.ts', 'test/unit/unit-a.test.ts', 'test/unit/unit-b.test.ts', 'test/unit/unit-d.test.ts'],
    )
    assert.deepEqual(
      p.excludedFiles.map((f) => f.replace(`packages/${PKG}/`, '')),
      ['test/client/client-a.test.ts', 'test/e2e/smoke.test.ts'],
      'client/e2e 层必须被排除',
    )
    assert.ok(
      !p.runFiles.includes(`packages/${PKG}/test/helpers.ts`),
      '支撑模块不得进入 runner 测试面',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T2/T3① 反证：往 unit 层丢新文件 → 变异面自动纳入，零手工步骤', () => {
  const root = makeFixtureRoot({ [`packages/${PKG}/test/unit/unit-new.test.ts`]: '// new\n' })
  try {
    const p = projectTestSurface(root, TOPOLOGY, PKG)
    assert.ok(
      p.testFiles.includes(`packages/${PKG}/test/unit/unit-new.test.ts`),
      `新 unit 文件必须自动进变异面：${p.testFiles.join(', ')}`,
    )
    assert.equal(p.runFiles.length, 7, 'runner 面也应自动纳入')
    assert.deepEqual(p.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T3① 反证：runner 面出现无层归属的文件 → 判红并点名', () => {
  const root = makeFixtureRoot({ [`packages/${PKG}/test/loose.test.ts`]: '// 无层归属\n' })
  try {
    const conf = generate(root)
    const res = runGenerator(root, ['--check'])
    assert.equal(res.status, 1, `无层归属必须判红：\n${res.out}`)
    assert.match(res.out, /测试文件无层归属/, '应点名无层归属')
    assert.match(res.out, /test\/loose\.test\.ts/, '应给出文件路径')
    // 无层归属的文件不得被默默收进变异面
    assert.doesNotMatch(readFileSync(conf, 'utf8'), /loose\.test\.ts/, '未决定层归属的文件不得进 conf')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T3②：豁免必须带理由且真实存在于 unit 层', () => {
  const withBadReason = structuredClone(TOPOLOGY)
  withBadReason.packages[PKG].testLayers = {
    unitExemptions: { 'test/unit/unit-b.test.ts': '   ' },
  }
  const root = makeFixtureRoot({}, withBadReason)
  try {
    const p = projectTestSurface(root, withBadReason, PKG)
    assert.ok(p.errors.some((e) => /缺少理由/.test(e)), `空理由必须判红：${p.errors.join('; ')}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const withGhost = structuredClone(TOPOLOGY)
  withGhost.packages[PKG].testLayers = {
    unitExemptions: { 'test/unit/ghost.test.ts': '不存在的文件' },
  }
  const root2 = makeFixtureRoot({}, withGhost)
  try {
    const p = projectTestSurface(root2, withGhost, PKG)
    assert.ok(p.errors.some((e) => /不存在/.test(e)), `幽灵豁免必须判红：${p.errors.join('; ')}`)
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})

test('T3③：--min == runner glob 实际文件数；脱节判红，--sync-test-min 可同步', () => {
  const root = makeFixtureRoot()
  try {
    generate(root)
    assert.equal(runGenerator(root, ['--check']).status, 0, '--min=6 且 runner 面 6 个文件时应通过')

    // 只加文件、不改 --min → 判红（--min 必须随文件数上调）
    writeFileSync(join(root, `packages/${PKG}/test/unit/unit-c.test.ts`), '// c\n')
    generate(root)
    const stale = runGenerator(root, ['--check'])
    assert.equal(stale.status, 1, `--min 脱节必须判红：\n${stale.out}`)
    assert.match(stale.out, /登记完整性 ③/, '应点名 --min 判据')
    assert.match(stale.out, /--min 6 != 实际测试文件数 7/, '应给出两个数字')

    // 显式同步后恢复绿
    const synced = runGenerator(root, ['--sync-test-min'])
    assert.equal(synced.status, 0, `同步应成功：\n${synced.out}`)
    const pkgJson = JSON.parse(readFileSync(join(root, `packages/${PKG}/package.json`), 'utf8'))
    assert.match(pkgJson.scripts.test, /--min 7/, '--min 应被同步为 7')
    assert.equal(runGenerator(root, ['--check']).status, 0, '同步后应通过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T3 反证：从派生 conf 删掉一条登记条目 → --check 判红', () => {
  const root = makeFixtureRoot()
  try {
    const conf = generate(root)
    assert.equal(runGenerator(root, ['--check']).status, 0, '生成后应立即一致')

    const parsed = JSON.parse(readFileSync(conf, 'utf8'))
    assert.ok(parsed.tap.testFiles.length >= 2, 'fixture 应有至少两条登记条目')
    parsed.tap.testFiles = parsed.tap.testFiles.slice(1) // 删掉一条登记
    writeFileSync(conf, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')

    const res = runGenerator(root, ['--check'])
    assert.equal(res.status, 1, `删条目必须判红：\n${res.out}`)
    assert.match(res.out, /内容与拓扑派生不一致/, '应点名 conf 与派生脱节')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T2 幂等：连续两次生成后 --check 仍绿（无静默漂移）', () => {
  const root = makeFixtureRoot()
  try {
    generate(root)
    const first = readFileSync(join(root, 'stryker.conf.d', `${PKG}-only.json`), 'utf8')
    generate(root)
    const second = readFileSync(join(root, 'stryker.conf.d', `${PKG}-only.json`), 'utf8')
    assert.equal(first, second, '两次生成必须逐字一致')
    assert.equal(runGenerator(root, ['--check']).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
