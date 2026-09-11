#!/usr/bin/env node
/**
 * scripts/gate/gen-stryker-conf.mjs — Stryker 变异测试配置派生与门禁校验工具（#572 / #690 S2b）
 *
 * 核心设计（单一事实源 SSOT + 确定性代码生成 + 登记完整性门禁）：
 * 1. 唯一事实源：scripts/data/mutation-topology.json。
 * 2. 派生目标：stryker.conf.d/*.json（全部 31 份分段配置）与各包 `--min`。
 * 3. **测试面不写死**（#713 T2）：拓扑只声明「测试层 glob」（$testLayers），
 *    `tap.testFiles` 由生成时展开的**真实文件清单**派生。为什么不把 glob 直接写进 conf：
 *    #712 已 CI 实证 Stryker 沙箱对整包 glob 失败（`smoke.test.ts` 的 provide 方法面断言）
 *    且 mcp 5 个段 dry run 撞 5 分钟预算。逐文件清单既保留沙箱兼容性，又不需要人手工维护。
 *
 * 用法：
 *   node scripts/gate/gen-stryker-conf.mjs                # 生成/更新全部 stryker.conf.d/*.json
 *   node scripts/gate/gen-stryker-conf.mjs --check         # 门禁：磁盘与派生一致 + 登记完整性 + --min 同步
 *   node scripts/gate/gen-stryker-conf.mjs --sync-test-min # 把各包 `--min` 同步为实际 glob 文件数
 *
 * `--check` 的三项登记完整性判据（#713 T3）：
 *   ① 每个 `test/` 下任意层级的 `*.test.ts` 必须落入某一层 glob 或某条排除 glob —— 没有第三条路；
 *      新增测试文件必须显式决定层归属，不能靠「没写进清单」逃逸。
 *   ② 派生出的每条 testFiles 与每条 unitExemption 在磁盘上真实存在。
 *   ③ 各包 `package.json` 的 `--min` == `test/` 下任意层级 `*.test.ts` 的实际文件数。
 *   反证见 scripts/test/stryker-conf-layers.test.ts（删登记条目 / --min 脱节 / 新文件自动纳入）。
 *
 * 环境变量 GEN_STRYKER_ROOT：仓库根覆盖（测试用临时 fixture 根，避免在仓库内造包目录）。
 */
import { existsSync, globSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUN_TESTS_PATTERN, defaultSegmentExcludes } from './mutation-topology.mjs'

const repoRoot = process.env.GEN_STRYKER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const topologyPath = join(repoRoot, 'scripts', 'data', 'mutation-topology.json')
const confDir = join(repoRoot, 'stryker.conf.d')

if (!existsSync(topologyPath)) {
  console.error(`[gen-stryker-conf] 拓扑文件不存在: ${topologyPath}`)
  process.exit(1)
}

const topology = JSON.parse(readFileSync(topologyPath, 'utf8'))
const { sharedDefaults, packages } = topology
const argv = process.argv.slice(2)
const isCheckMode = argv.includes('--check')
const isSyncMin = argv.includes('--sync-test-min')

/** 包内相对 posix 路径（统一分隔符，供 glob 与清单比较）。 */
function relPosix(from, to) {
  return relative(from, to).split(sep).join('/')
}

/** 展开一条包内相对 glob（仅取文件），返回绝对路径排序数组。 */
function expandGlob(pkgDir, pattern) {
  return globSync(pattern, { cwd: pkgDir })
    .map((p) => join(pkgDir, p))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .sort()
}

/**
 * 从层定义投影一个包的测试面（纯函数，root 参数化以便测试注入 fixture 根）。
 * 返回 { testFiles, runFiles, layerFiles, excludedFiles, errors }，路径均为**仓库根相对 posix**。
 */
export function projectTestSurface(root, topologyDoc, pkgName) {
  const def = topologyDoc?.packages?.[pkgName]
  const empty = { testFiles: [], runFiles: [], layerFiles: {}, excludedFiles: [], errors: [] }
  if (def === undefined) return empty
  const layers = topologyDoc?.$testLayers
  if (layers === undefined) {
    return { ...empty, errors: ['拓扑缺少 $testLayers（测试分层声明）—— 测试面无法派生'] }
  }
  const errors = []
  const pkgDir = join(root, 'packages', pkgName)
  const pkgDef = def.testLayers ?? {}

  // ① runner 面：glob 全集（与 run-tests.mjs 同口径）
  const runFiles = expandGlob(pkgDir, RUN_TESTS_PATTERN).map((p) => relPosix(root, p))

  // ② 各层实际命中文件
  const layerFiles = {}
  for (const [layerName, pattern] of Object.entries(layers.layers ?? {})) {
    if (typeof pattern !== 'string') continue
    const hits = expandGlob(pkgDir, pattern).map((p) => relPosix(root, p))
    layerFiles[layerName] = hits
    // 只对 unit 层要求非空：unit 是每个包的必答项（新单元测试的默认落点）；
    // integration/client/e2e 是可选层，包内不存在该层是正常形态（如 lan-proxy 无集成层）。
    if (hits.length === 0 && layerName === 'unit') {
      errors.push(`层 "unit"（glob=${pattern}）在本包零命中 —— 单元层是每个包的必答项，glob 写错或测试被误删`)
    }
  }

  // ③ 排除层 + 逐条豁免
  const excludeLayers = layers.mutationExcludeLayers ?? []
  for (const layerName of excludeLayers) {
    if (layerFiles[layerName] === undefined) errors.push(`mutationExcludeLayers 声明了未定义的层 "${layerName}"`)
  }
  const exemptions = pkgDef.unitExemptions ?? {}
  for (const [rel, reason] of Object.entries(exemptions)) {
    if (!existsSync(join(root, rel))) errors.push(`unitExemption 指向不存在的文件：${rel}`)
    if (typeof reason !== 'string' || reason.trim() === '') errors.push(`unitExemption ${rel} 缺少理由（必须写明为何不进变异面）`)
    if (!(layerFiles.unit ?? []).includes(rel)) errors.push(`unitExemption ${rel} 不在 unit 层内（豁免只适用于单元层）`)
  }

  // ④ 变异面 = mutationLayers 命中 − 排除层 − 逐条豁免
  const excluded = new Set()
  for (const layerName of excludeLayers) for (const f of layerFiles[layerName] ?? []) excluded.add(f)
  for (const rel of Object.keys(exemptions)) excluded.add(rel)
  const inMutationLayers = new Set()
  for (const layerName of layers.mutationLayers ?? []) {
    for (const f of layerFiles[layerName] ?? []) inMutationLayers.add(f)
  }
  const testFiles = [...inMutationLayers].filter((f) => !excluded.has(f)).sort()

  // ⑤ 登记完整性 ①：runner 面每个文件必须被「某一层」或「某条排除」解释
  const explained = new Set([...inMutationLayers, ...excluded])
  for (const f of runFiles) {
    if (!explained.has(f)) {
      errors.push(`测试文件无层归属：${f} —— 必须落入 $testLayers.layers 的某条 glob，或写进该包 testLayers.unitExemptions`)
    }
  }
  return { testFiles, runFiles, layerFiles, excludedFiles: [...excluded].sort(), errors }
}

/** 读取包级 `--min`（与 runner glob 计数同步的唯一入口）。 */
export function readTestMin(root, pkgName) {
  const pkgJsonPath = join(root, 'packages', pkgName, 'package.json')
  if (!existsSync(pkgJsonPath)) return { path: pkgJsonPath, min: null }
  const m = readFileSync(pkgJsonPath, 'utf8').match(/"test"\s*:\s*"node [^"]*run-tests\.mjs --min (\d+)"/)
  return { path: pkgJsonPath, min: m === null ? null : Number(m[1]) }
}

function deriveConfig(pkgName, segKey, segDef, pkgDef, testFiles) {
  const isSingle = segKey === '_single'
  const confFileName = isSingle ? `${pkgName}.json` : `${pkgName}-${segKey}.json`
  const reportName = isSingle ? pkgName : `${pkgName}-${segKey}`
  const shortPkg = pkgName.replace(/^dsh-/, '')
  const incrementalName = isSingle ? `incremental-${shortPkg}.json` : `incremental-${shortPkg}-${segKey}.json`

  const mutate = [
    ...segDef.mutate,
    ...(segDef.excludes ?? defaultSegmentExcludes(pkgName)),
    // S0 覆盖断言的存量登记（#710 第二节）：门面/声明/资源类，追加在段自身 excludes 之后，
    // 故不触动既有 excludes 数组，也不改变既有段的语义。
    ...((pkgDef.testLayers ?? {}).coverageExcludes ?? []),
  ]

  const config = {
    $schema: '../node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    mutate,
    testRunner: sharedDefaults.testRunner,
    mutator: {
      excludedMutations: sharedDefaults.excludedMutations,
    },
    plugins: [
      '@stryker-mutator/tap-runner',
    ],
    concurrency: pkgDef.concurrency ?? sharedDefaults.concurrency,
    timeoutMS: pkgDef.timeoutMS ?? sharedDefaults.timeoutMS,
    dryRunTimeoutMinutes: sharedDefaults.dryRunTimeoutMinutes,
    reporters: sharedDefaults.reporters,
    coverageAnalysis: sharedDefaults.coverageAnalysis,
    tempDirName: sharedDefaults.tempDirName,
    cleanTempDir: sharedDefaults.cleanTempDir,
    tap: {
      nodeArgs: sharedDefaults.tapNodeArgs,
      testFiles,
    },
    jsonReporter: {
      fileName: `coverage/mutation/${reportName}.json`,
    },
    incremental: true,
    incrementalFile: `coverage/mutation/${incrementalName}`,
  }

  if (segDef.comment) {
    config._comment = segDef.comment
  }

  return { confFileName, content: JSON.stringify(config, null, 2) + '\n' }
}

// ── 1. 逐包投影测试面（含登记完整性 ①/②） ────────────────────────
const projections = new Map()
const projectionErrors = []
for (const pkgName of Object.keys(packages)) {
  const p = projectTestSurface(repoRoot, topology, pkgName)
  projections.set(pkgName, p)
  for (const e of p.errors) projectionErrors.push(`[${pkgName}] ${e}`)
  for (const f of p.testFiles) {
    if (!existsSync(join(repoRoot, f))) projectionErrors.push(`[${pkgName}] 登记完整性 ②：testFiles 条目不存在于磁盘：${f}`)
  }
}

// ── 2. 派生全部配置文件 ──────────────────────────────────────────
const derivedConfigs = new Map()
for (const [pkgName, pkgDef] of Object.entries(packages)) {
  const testFiles = projections.get(pkgName).testFiles
  for (const [segKey, segDef] of Object.entries(pkgDef.segments)) {
    const { confFileName, content } = deriveConfig(pkgName, segKey, segDef, pkgDef, testFiles)
    derivedConfigs.set(confFileName, content)
  }
}

// ── 3. `--min` 同步（判据 ③） ────────────────────────────────────
const minMismatches = []
for (const pkgName of Object.keys(packages)) {
  const { min } = readTestMin(repoRoot, pkgName)
  const actual = projections.get(pkgName).runFiles.length
  if (min !== actual) minMismatches.push({ pkgName, min, actual })
}

if (isSyncMin) {
  let synced = 0
  for (const { pkgName, min, actual } of minMismatches) {
    if (min === null) {
      console.error(`[gen-stryker-conf] ${pkgName} 的 test 脚本缺少 \`--min <n>\`，无法自动同步 —— 请手工补上 --min ${actual}`)
      continue
    }
    const pkgJsonPath = join(repoRoot, 'packages', pkgName, 'package.json')
    const raw = readFileSync(pkgJsonPath, 'utf8')
    writeFileSync(pkgJsonPath, raw.replace(/(run-tests\.mjs --min )\d+/, `$1${actual}`), 'utf8')
    console.log(`[gen-stryker-conf] ${pkgName} --min ${min} → ${actual}`)
    synced++
  }
  console.log(`[gen-stryker-conf] --min 同步完成：${synced} 个包`)
}

if (isCheckMode) {
  let hasError = projectionErrors.length > 0

  for (const e of projectionErrors) console.error(`[gen-stryker-conf] 登记完整性：${e}`)

  // 判据 ③：--min 必须等于 test/ 下任意层级 *.test.ts 的实际文件数
  for (const { pkgName, min, actual } of minMismatches) {
    console.error(
      `[gen-stryker-conf] 登记完整性 ③：${pkgName} 的 --min ${min === null ? '缺失' : min} != 实际测试文件数 ${actual}`
      + ' —— 请运行 node scripts/gate/gen-stryker-conf.mjs --sync-test-min 同步',
    )
    hasError = true
  }

  // 磁盘 ↔ 派生一致性
  const diskFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  const derivedFileNames = [...derivedConfigs.keys()].sort()

  const missingFiles = derivedFileNames.filter((f) => !diskFiles.includes(f))
  const extraFiles = diskFiles.filter((f) => !derivedFileNames.includes(f))

  if (missingFiles.length > 0) {
    console.error(`[gen-stryker-conf] 磁盘缺少以下派生配置文件: ${missingFiles.join(', ')}`)
    hasError = true
  }
  if (extraFiles.length > 0) {
    console.error(`[gen-stryker-conf] 磁盘存在未在拓扑中定义的游离配置文件: ${extraFiles.join(', ')}`)
    hasError = true
  }

  for (const [file, expectedContent] of derivedConfigs.entries()) {
    const filePath = join(confDir, file)
    if (existsSync(filePath)) {
      const diskContent = readFileSync(filePath, 'utf8')
      if (diskContent !== expectedContent) {
        console.error(`[gen-stryker-conf] 配置文件内容与拓扑派生不一致: ${file} (请运行 pnpm stryker:gen 同步)`)
        hasError = true
      }
    }
  }

  if (hasError) {
    console.error('[gen-stryker-conf] --check 失败：配置文件 / 测试面登记 / --min 与单一事实源脱节')
    process.exit(1)
  }

  const totalFiles = [...projections.values()].reduce((n, p) => n + p.testFiles.length, 0)
  console.log(
    `[gen-stryker-conf] --check 通过：${derivedConfigs.size} 份配置与拓扑严格一致；`
    + `${Object.keys(packages).length} 个包共 ${totalFiles} 个测试文件登记进变异面，--min 全部同步`,
  )
} else if (!isSyncMin) {
  // 写模式：同步生成到磁盘
  let written = 0
  for (const [file, content] of derivedConfigs.entries()) {
    writeFileSync(join(confDir, file), content, 'utf8')
    written++
  }
  console.log(`[gen-stryker-conf] 成功派生生成全部 ${written} 份 Stryker 配置文件至 stryker.conf.d/`)
  for (const [pkgName, p] of projections) {
    console.log(
      `[gen-stryker-conf]   ${pkgName}: runner 面 ${p.runFiles.length} 个测试文件，变异面 ${p.testFiles.length} 个`
      + `（排除 client/e2e 层与逐条豁免共 ${p.excludedFiles.length} 个）`,
    )
  }
}
