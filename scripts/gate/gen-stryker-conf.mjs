#!/usr/bin/env node
/**
 * scripts/gate/gen-stryker-conf.mjs — Stryker 变异测试配置派生与门禁（#572 / #690 S2b）
 *
 * 核心设计（单一事实源 SSOT + 确定性代码生成 + 登记完整性门禁）：
 * 1. 唯一事实源：scripts/data/mutation-topology.json 的 `$testLayers` 与各包 `testLayers`。
 * 2. 派生目标：stryker.conf.d/*.json（全部 31 份分段配置）+ vitest.stryker.d/<pkg>.config.ts
 *    （每包一份「变异面测试清单」的 vitest 配置）。
 * 3. **测试面不再由 Stryker 的 `testFiles` 承载**（#722 方案 A 路径一）：该字段非空会让
 *    core 把 static mutant 判成 runtime 激活（上游 #6144，未修），模块级变异体在模块加载
 *    后永久漏判（实测 dsh-web-file-preview 80.49 → 0.00）。故段配置只声明 `vitest.configFile`
 *    指向本包派生的 vitest 配置，测试面 = 该配置的 `include`（层 glob 展开后的显式清单）。
 *    为什么不直接写 glob：Stryker 沙箱对整包 glob 失败（#712 实证）且 mcp 段 dry run
 *    撞 5 分钟预算，故仍展开为显式文件清单。
 *
 * 本文件只做 argv 解析与写盘；纯函数在 scripts/gate/test-surface.mjs（被 import 无副作用，
 * 故测试可以直接 import 它而不会重写 stryker.conf.d/）。
 *
 * 用法：
 *   node scripts/gate/gen-stryker-conf.mjs                # 生成/更新全部 stryker.conf.d/*.json
 *   node scripts/gate/gen-stryker-conf.mjs --check         # 门禁：磁盘一致 + 登记完整性 + --min 同步
 *   node scripts/gate/gen-stryker-conf.mjs --sync-test-min # 把各包 `--min` 同步为实际文件数
 *
 * `--check` 的判据（#713 T3 + S2b 充分性下限）：
 *   ① 磁盘上有测试的每个包都必须在拓扑登记（漏登即红，不允许「没写进清单就逃逸」），
 *      且该包 `test/` 下每个 `*.test.ts` 都要有层归属；
 *   ② 每条派生 testFiles 与每条豁免条目在磁盘上真实存在；
 *   ③ 每个有测试的包（含未登记变异面的包）`--min` == runner glob 实际文件数；
 *   ④ 充分性：`$testLayers.mutationLayers` 必须含必需层（`test-surface.mjs` 的
 *      `REQUIRED_MUTATION_LAYERS`），且每包变异面非空——防「两行拓扑改动把变异面削掉」。
 *
 * 环境变量 GEN_STRYKER_ROOT：仓库根覆盖（测试用临时 fixture 根，避免在仓库内造包目录）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultSegmentExcludes } from './mutation-topology.mjs'
import { discoverTestPackages, projectTestSurface, readTestMin } from './test-surface.mjs'

const repoRoot = process.env.GEN_STRYKER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const topologyPath = join(repoRoot, 'scripts', 'data', 'mutation-topology.json')
const confDir = join(repoRoot, 'stryker.conf.d')
const argv = process.argv.slice(2)
const isCheckMode = argv.includes('--check')
const isSyncMin = argv.includes('--sync-test-min')

/** 派生 vitest 测试面配置的目录（与 stryker.conf.d 并列，同为生成物、入库受 --check 校验）。 */
const VITEST_CONF_DIR = 'vitest.stryker.d'

function vitestConfigPath(pkgName) {
  return `${VITEST_CONF_DIR}/${pkgName}.config.ts`
}

/**
 * 派生「该包变异面」的 vitest 配置（#722 方案 A 路径一）。
 *
 * 为什么要有这个载体：Stryker 的 `testFiles` 是**上游缺陷 #6144 的唯一触发条件**——
 * 它非空时 core 把 static mutant 判成 runtime 激活，模块级变异体在模块加载后永久
 * 漏判（实测 dsh-web-file-preview 从 80.49 掉到 0.00）。把「本次跑哪些测试文件」从
 * Stryker conf 搬到 vitest 的 `include`，测试面逐字不变，而 mutantActivation 回到
 * static。之所以选它而不是 `related: true`（模块图推断）：后者会把测试面变成"涌现"
 * 属性，漏关联即静默少跑测试 → 静默漏判，且反转 #690/#713 的确定性派生契约。
 *
 * 单 project（unit + integration 两个层在本仓库同为 node 环境、60s 超时，合并等价）：
 * runner 侧 `ctx.projects` 只用于 setupFiles/testNamePattern 注入与覆盖度合并，单
 * project 与多 project 行为一致（#722 诊断已实测）。
 */
function deriveVitestConfig(pkgName, testFiles) {
  const include = testFiles.map((f) => `      '${f}',`).join('\n')
  return `// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （${pkgName} 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
${include}
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
`
}

function deriveConfig(sharedDefaults, pkgName, segKey, segDef, pkgDef) {
  const isSingle = segKey === '_single'
  const confFileName = isSingle ? `${pkgName}.json` : `${pkgName}-${segKey}.json`
  const reportName = isSingle ? pkgName : `${pkgName}-${segKey}`
  const shortPkg = pkgName.replace(/^dsh-/, '')
  const incrementalName = isSingle ? `incremental-${shortPkg}.json` : `incremental-${shortPkg}-${segKey}.json`

  const mutate = [
    ...segDef.mutate,
    ...(segDef.excludes ?? defaultSegmentExcludes(pkgName)),
    // S0 覆盖断言的存量登记（#710 第二节）：门面/声明/资源类。追加在段自身 excludes 之后，
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
    // runner 包名由 testRunner 派生，避免 SSOT（sharedDefaults.testRunner）与插件清单两处漂移。
    plugins: [
      `@stryker-mutator/${sharedDefaults.testRunner}-runner`,
    ],
    concurrency: pkgDef.concurrency ?? sharedDefaults.concurrency,
    timeoutMS: pkgDef.timeoutMS ?? sharedDefaults.timeoutMS,
    dryRunTimeoutMinutes: sharedDefaults.dryRunTimeoutMinutes,
    reporters: sharedDefaults.reporters,
    coverageAnalysis: sharedDefaults.coverageAnalysis,
    tempDirName: sharedDefaults.tempDirName,
    cleanTempDir: sharedDefaults.cleanTempDir,
    // 测试面限定迁到 vitest 侧（#722 方案 A 路径一，见 deriveVitestConfig）：
    // **conf 里不得再出现 `testFiles`**——只要它非空，core 的
    // `mutantActivation: testFilter ? 'runtime' : 'static'` 就会把 static mutant
    // 判成 runtime 激活（上游 #6144，未修），模块级变异体在模块加载后永久漏判。
    // 等价表达 = 段专用 vitest config 的 `include`（本包拓扑投影的变异面清单），
    // 故测试面与今天逐字相同、确定性不变。`related` 固定 false：不把「哪个段跑
    // 哪些测试」交给 vitest 的模块图推断（否则随导入关系漂移，与派生清单冲突）。
    vitest: { ...sharedDefaults.vitest, configFile: vitestConfigPath(pkgName) },
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

function main() {
  if (!existsSync(topologyPath)) {
    console.error(`[gen-stryker-conf] 拓扑文件不存在: ${topologyPath}`)
    return 1
  }
  const topology = JSON.parse(readFileSync(topologyPath, 'utf8'))
  const { sharedDefaults, packages } = topology
  // 未登记变异面但允许存在的包（如 dsh-verify-isolated 只有 e2e smoke）：必须逐条写明理由，
  // 且仍受判据 ③（--min 同步）约束——「不登记」不等于「不受门禁」。
  const noMutationPackages = topology.$noMutationPackages ?? {}

  // ── 1. 遍历磁盘上有测试的包（不是只遍历拓扑声明） ────────────────
  const discovered = discoverTestPackages(repoRoot)
  const errors = []
  const projections = new Map()
  for (const { pkgName } of discovered) {
    if (packages[pkgName] !== undefined) {
      const p = projectTestSurface(repoRoot, topology, pkgName)
      projections.set(pkgName, p)
      for (const e of p.errors) errors.push(`[${pkgName}] ${e}`)
      for (const f of p.testFiles) {
        if (!existsSync(join(repoRoot, f))) errors.push(`[${pkgName}] 登记完整性 ②：testFiles 条目不存在于磁盘：${f}`)
      }
    } else if (noMutationPackages[pkgName] === undefined) {
      errors.push(
        `[${pkgName}] 磁盘上有测试文件但未在 mutation-topology.json 登记`
        + '（也未在 $noMutationPackages 说明理由）—— 源码覆盖与测试面登记都无法判定（fail-closed）',
      )
    }
  }
  for (const pkgName of Object.keys(packages)) {
    if (!discovered.some((d) => d.pkgName === pkgName)) {
      errors.push(`[${pkgName}] 已在拓扑登记但磁盘上没有 test/ 下的 *.test.ts —— 登记条目指向空集`)
    }
  }

  // ── 2. 派生全部配置文件（stryker conf + 每包一份 vitest 测试面 config）──
  const derivedConfigs = new Map()
  const derivedVitestConfigs = new Map()
  for (const [pkgName, pkgDef] of Object.entries(packages)) {
    const testFiles = projections.get(pkgName)?.testFiles ?? []
    for (const [segKey, segDef] of Object.entries(pkgDef.segments)) {
      const { confFileName, content } = deriveConfig(sharedDefaults, pkgName, segKey, segDef, pkgDef)
      derivedConfigs.set(confFileName, content)
    }
    if (testFiles.length > 0) {
      derivedVitestConfigs.set(vitestConfigPath(pkgName), deriveVitestConfig(pkgName, testFiles))
    }
  }

  // ── 3. `--min` 同步（判据 ③，覆盖所有有测试的包） ────────────────
  const minMismatches = []
  for (const { pkgName, runFileCount } of discovered) {
    const { min } = readTestMin(repoRoot, pkgName)
    if (min !== runFileCount) minMismatches.push({ pkgName, min, actual: runFileCount })
  }

  if (isSyncMin) {
    let synced = 0
    let unsyncable = 0
    for (const { pkgName, min, actual } of minMismatches) {
      if (min === null) {
        console.error(`[gen-stryker-conf] ${pkgName} 的 test 脚本缺少 \`--min <n>\`，无法自动同步 —— 请手工补上 --min ${actual}`)
        unsyncable++
        continue
      }
      const pkgJsonPath = join(repoRoot, 'packages', pkgName, 'package.json')
      const raw = readFileSync(pkgJsonPath, 'utf8')
      // 与 test-surface.mjs 的 readTestMin 共用同一契约：只锚 test 脚本里的 `--min <n>`，不绑 runner 名。
      writeFileSync(pkgJsonPath, raw.replace(/("test"\s*:\s*"node [^"]*--min )\d+/, `$1${actual}`), 'utf8')
      console.log(`[gen-stryker-conf] ${pkgName} --min ${min} → ${actual}`)
      synced++
    }
    console.log(`[gen-stryker-conf] --min 同步完成：${synced} 个包${unsyncable > 0 ? `，${unsyncable} 个无法同步` : ''}`)
    // 只跑 --sync-test-min 时也必须对「无法同步」判非零：否则调用方会把未同步当成已完成。
    if (unsyncable > 0) process.exitCode = 1
  }

  if (isCheckMode) {
    let hasError = false
    for (const e of errors) {
      console.error(`[gen-stryker-conf] 登记完整性：${e}`)
      hasError = true
    }
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
    for (const f of derivedFileNames.filter((x) => !diskFiles.includes(x))) {
      console.error(`[gen-stryker-conf] 磁盘缺少以下派生配置文件: ${f}`)
      hasError = true
    }
    for (const f of diskFiles.filter((x) => !derivedFileNames.includes(x))) {
      console.error(`[gen-stryker-conf] 磁盘存在未在拓扑中定义的游离配置文件: ${f}`)
      hasError = true
    }
    for (const [file, expectedContent] of derivedConfigs.entries()) {
      const filePath = join(confDir, file)
      if (existsSync(filePath) && readFileSync(filePath, 'utf8') !== expectedContent) {
        console.error(`[gen-stryker-conf] 配置文件内容与拓扑派生不一致: ${file} (请运行 pnpm stryker:gen 同步)`)
        hasError = true
      }
    }

    // vitest 测试面配置：磁盘 ↔ 派生一致（生成物同样入库，故同样受严格比对）
    const vitestDir = join(repoRoot, VITEST_CONF_DIR)
    const diskVitest = existsSync(vitestDir)
      ? readdirSync(vitestDir).filter((f) => f.endsWith('.config.ts')).map((f) => `${VITEST_CONF_DIR}/${f}`).sort()
      : []
    const derivedVitestNames = [...derivedVitestConfigs.keys()].sort()
    for (const f of derivedVitestNames.filter((x) => !diskVitest.includes(x))) {
      console.error(`[gen-stryker-conf] 磁盘缺少派生的 vitest 测试面配置: ${f}`)
      hasError = true
    }
    for (const f of diskVitest.filter((x) => !derivedVitestNames.includes(x))) {
      console.error(`[gen-stryker-conf] 磁盘存在未在拓扑中定义的游离 vitest 配置: ${f}`)
      hasError = true
    }
    for (const [file, expectedContent] of derivedVitestConfigs.entries()) {
      const filePath = join(repoRoot, file)
      if (existsSync(filePath) && readFileSync(filePath, 'utf8') !== expectedContent) {
        console.error(`[gen-stryker-conf] vitest 测试面配置与拓扑派生不一致: ${file} (请运行 pnpm stryker:gen 同步)`)
        hasError = true
      }
    }
    // conf 不得回退到 Stryker 顶层 testFiles：它是上游 #6144 的触发条件（static mutant
    // 被判 runtime 激活 → 模块级变异体漏判）。派生内容比对已能拦住，此处显式点名以便定位。
    for (const [file, content] of derivedConfigs.entries()) {
      if (JSON.parse(content).testFiles !== undefined) {
        console.error(`[gen-stryker-conf] ${file} 出现了 Stryker 顶层 testFiles —— 该字段会触发上游 #6144（#722 方案 A 已迁至 vitest include）`)
        hasError = true
      }
    }

    if (hasError) {
      console.error('[gen-stryker-conf] --check 失败：配置文件 / 测试面登记 / --min 与单一事实源脱节')
      return 1
    }
    const totalFiles = [...projections.values()].reduce((n, p) => n + p.testFiles.length, 0)
    const skipNames = Object.keys(noMutationPackages).filter((k) => !k.startsWith('$'))
    const skipNote = skipNames.length > 0 ? `；按 $noMutationPackages 不登记变异面：${skipNames.join(', ')}` : ''
    console.log(
      `[gen-stryker-conf] --check 通过：${derivedConfigs.size} 份配置与拓扑严格一致；`
      + `${derivedVitestConfigs.size} 份 vitest 测试面配置（${VITEST_CONF_DIR}/）与拓扑严格一致；`
      + `${Object.keys(packages).length} 个包共 ${totalFiles} 个测试文件登记进变异面；`
      + `--min 与磁盘上 ${discovered.length} 个有测试的包全部同步${skipNote}`,
    )
    return 0
  }

  if (!isSyncMin) {
    let written = 0
    for (const [file, content] of derivedConfigs.entries()) {
      writeFileSync(join(confDir, file), content, 'utf8')
      written++
    }
    const vitestDir = join(repoRoot, VITEST_CONF_DIR)
    mkdirSync(vitestDir, { recursive: true })
    for (const [file, content] of derivedVitestConfigs.entries()) {
      writeFileSync(join(repoRoot, file), content, 'utf8')
    }
    console.log(`[gen-stryker-conf] 成功派生生成全部 ${written} 份 Stryker 配置文件至 stryker.conf.d/`)
    console.log(`[gen-stryker-conf] 成功派生生成 ${derivedVitestConfigs.size} 份 vitest 测试面配置至 ${VITEST_CONF_DIR}/`)
    for (const [pkgName, p] of projections) {
      console.log(
        `[gen-stryker-conf]   ${pkgName}: runner 面 ${p.runFiles.length} 个测试文件，变异面 ${p.testFiles.length} 个`
        + `（排除 client/e2e 层与逐条豁免共 ${p.excludedFiles.length} 个）`,
      )
    }
  }
  return process.exitCode ?? 0
}

// CLI 守卫：被测试 import 时（argv[1] 不是本文件）不得执行 main，也不会派生出任何写盘副作用。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
