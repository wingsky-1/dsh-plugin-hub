/**
 * scripts/gate/test-surface.mjs — 测试面（层 → 文件清单 → `--min`）的派生纯函数（#690 S2b）。
 *
 * 为什么与 CLI 分开：`gen-stryker-conf.mjs` 是带副作用的一键生成器（顶层读写
 * stryker.conf.d/*.json、package.json），被测试 import 就会写盘；而门禁与测试都需要
 * 复用这些纯函数（层投影、登记完整性判据、`--min` 读取）。故这里只放**无副作用**的
 * 函数与常量，CLI 负责 argv 解析与写盘。
 *
 * 唯一事实源仍是 scripts/data/mutation-topology.json 的 `$testLayers` 与各包 `testLayers`。
 */
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * runner 面 glob：`--min` 与登记完整性判据 ③ 的唯一口径。
 *
 * #722 起 runner 由 `run-tests.mjs` 换成 vitest，本模式不变——`vitest.config.ts` 的
 * unit / integration / e2e / contract 四个 project 的 glob 并集恰好等于 `test/**` 下的
 * `*.test.ts` 全集，故门禁口径无需跟随 runner 实现变动。
 */
export const RUN_TESTS_PATTERN = 'test/**/*.test.ts'

/**
 * 必须留在变异面内的层（#690 S2b 的充分性下限）。
 * 为什么需要：`--check` 只保证「声明 ↔ 派生一致」，若允许把 `unit` 加进
 * `mutationExcludeLayers`，两行拓扑改动就能把变异面从 56 个文件削到 12 个而门禁全绿。
 * 故把「哪些层必须在变异面内」写成代码常量，改它必须过代码评审与测试。
 */
export const REQUIRED_MUTATION_LAYERS = ['unit', 'integration']

/** 包内相对 posix 路径（统一分隔符，供 glob 与清单比较）。 */
export function relPosix(from, to) {
  return relative(from, to).split(sep).join('/')
}

/** 展开一条包内相对 glob（仅取文件），返回绝对路径排序数组。 */
export function expandGlob(pkgDir, pattern) {
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
  if (def === undefined) {
    return { ...empty, errors: [`包未在变异拓扑登记：${pkgName} —— 源码覆盖与测试面登记都无法判定（fail-closed）`] }
  }
  const layers = topologyDoc?.$testLayers
  if (layers === undefined) {
    return { ...empty, errors: ['拓扑缺少 $testLayers（测试分层声明）—— 测试面无法派生'] }
  }
  const errors = []
  const pkgDir = join(root, 'packages', pkgName)
  const pkgDef = def.testLayers ?? {}

  // ⓪ 充分性：必需层必须都在 mutationLayers 内，且不得被排除层覆盖
  const mutationLayers = layers.mutationLayers ?? []
  const excludeLayers = layers.mutationExcludeLayers ?? []
  for (const required of REQUIRED_MUTATION_LAYERS) {
    if (!mutationLayers.includes(required)) {
      errors.push(`必需层 "${required}" 不在 $testLayers.mutationLayers 内 —— 变异面被静默削减（#690 S2b 充分性下限）`)
    }
    if (excludeLayers.includes(required)) {
      errors.push(`必需层 "${required}" 同时出现在 mutationExcludeLayers 内 —— 声明自相矛盾`)
    }
  }
  if (mutationLayers.length === 0) errors.push('$testLayers.mutationLayers 为空 —— 变异面为零')

  // ① runner 面：glob 全集（与 vitest include 同口径）
  const runFiles = expandGlob(pkgDir, RUN_TESTS_PATTERN).map((p) => relPosix(root, p))
  if (runFiles.length === 0) errors.push('runner 面零命中 —— 包内没有 test/ 下的 *.test.ts')

  // ② 各层实际命中文件
  const layerFiles = {}
  for (const [layerName, pattern] of Object.entries(layers.layers ?? {})) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      errors.push(`层 "${layerName}" 的 glob 不是非空字符串：${JSON.stringify(pattern)}`)
      layerFiles[layerName] = []
      continue
    }
    const hits = expandGlob(pkgDir, pattern).map((p) => relPosix(root, p))
    layerFiles[layerName] = hits
    // 只对 unit 层要求非空：unit 是每个包的必答项（新单元测试的默认落点）；
    // integration/client/e2e 是可选层，包内不存在该层是正常形态（如 lan-proxy 无集成层）。
    if (hits.length === 0 && layerName === 'unit') {
      errors.push(`层 "unit"（glob=${pattern}）在本包零命中 —— 单元层是每个包的必答项，glob 写错或测试被误删`)
    }
  }
  for (const layerName of [...mutationLayers, ...excludeLayers]) {
    if (layerFiles[layerName] === undefined) errors.push(`$testLayers 引用了未定义的层 "${layerName}"`)
  }

  // ③ 逐层逐条豁免（键 = 层名，值 = { 仓库相对路径: 理由 }）
  const exemptions = pkgDef.testMutationExemptions ?? {}
  for (const [layerName, entries] of Object.entries(exemptions)) {
    if (layerFiles[layerName] === undefined) {
      errors.push(`testMutationExemptions 引用了未定义的层 "${layerName}"`)
      continue
    }
    for (const [rel, reason] of Object.entries(entries ?? {})) {
      if (!existsSync(join(root, rel))) errors.push(`testMutationExemptions 指向不存在的文件：${rel}`)
      if (typeof reason !== 'string' || reason.trim() === '') errors.push(`testMutationExemptions 的 ${rel} 缺少理由（必须写明为何不进变异面）`)
      if (!layerFiles[layerName].includes(rel)) errors.push(`testMutationExemptions 的 ${rel} 不在 "${layerName}" 层内（层归属与豁免声明不一致）`)
    }
  }

  // ④ 变异面 = mutationLayers 命中 − 排除层 − 逐条豁免
  const excluded = new Set()
  for (const layerName of excludeLayers) for (const f of layerFiles[layerName] ?? []) excluded.add(f)
  for (const entries of Object.values(exemptions)) for (const rel of Object.keys(entries ?? {})) excluded.add(rel)
  const inMutationLayers = new Set()
  for (const layerName of mutationLayers) {
    for (const f of layerFiles[layerName] ?? []) inMutationLayers.add(f)
  }
  const testFiles = [...inMutationLayers].filter((f) => !excluded.has(f)).sort()
  if (testFiles.length === 0) errors.push('变异面零条目 —— 该包不会产生任何变异分（fail-closed）')

  // ⑤ 登记完整性 ①：runner 面每个文件必须被「某一层」或「某条排除」解释
  const explained = new Set([...inMutationLayers, ...excluded])
  for (const f of runFiles) {
    if (!explained.has(f)) {
      errors.push(`测试文件无层归属：${f} —— 必须落入 $testLayers.layers 的某条 glob，或写进该包 testLayers.testMutationExemptions`)
    }
  }
  return { testFiles, runFiles, layerFiles, excludedFiles: [...excluded].sort(), errors }
}

/**
 * 读取包级 `--min`（与 runner glob 计数同步的唯一入口）。
 *
 * 契约只要求「test 脚本声明 `--min <n>`」，不绑定 runner 实现名。绑定实现名的代价已实测：
 * #722 把 test 脚本切到 `run-vitest.mjs` 后本函数返回 null，判据 ③ 让全部已切换的包判红，
 * 而配置与拓扑本身完全一致——即门禁在换 runner 时静默失效。写回侧的同款替换见
 * `gen-stryker-conf.mjs` 的 `--sync-test-min`，两处必须保持同一契约。
 */
export function readTestMin(root, pkgName) {
  const pkgJsonPath = join(root, 'packages', pkgName, 'package.json')
  if (!existsSync(pkgJsonPath)) return { path: pkgJsonPath, min: null }
  const m = readFileSync(pkgJsonPath, 'utf8').match(/"test"\s*:\s*"node [^"]*--min (\d+)"/)
  return { path: pkgJsonPath, min: m === null ? null : Number(m[1]) }
}

/**
 * 磁盘上与测试面相关的包清单（#690 S2b：门禁必须遍历磁盘，而不是只遍历拓扑声明）。
 * 返回 { pkgName, runFiles } —— 只包含「存在 test/ 下 *.test.ts」的包；
 * dsh-plugins-all 这类聚合包天然没有测试目录，不进清单。
 */
export function discoverTestPackages(root) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return []
  const out = []
  for (const entry of globSync('*/package.json', { cwd: packagesDir }).sort()) {
    const pkgName = dirname(entry)
    const runFiles = expandGlob(join(packagesDir, pkgName), RUN_TESTS_PATTERN)
    if (runFiles.length > 0) out.push({ pkgName, runFileCount: runFiles.length })
  }
  return out
}
