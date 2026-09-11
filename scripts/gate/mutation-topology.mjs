/**
 * scripts/gate/mutation-topology.mjs — 变异拓扑的派生规则共享模块（#690 S2b / #710 F15）。
 *
 * 为什么单独成文件：`gen-stryker-conf.mjs` 是带副作用的 CLI（顶层读写配置），
 * 不能被门禁脚本 import。但「段未显式写 excludes 时注入默认值」这条派生规则必须
 * 在生成侧与断言侧**同一份实现**——F15 的隐患正是两边各写一份、断言侧漏掉默认值，
 * 于是「靠默认值覆盖的段」在覆盖断言里变成盲区。
 */

/** runner 面（scripts/gate/run-tests.mjs 的 glob）：`--min` 与登记完整性判据 ③ 的唯一口径。 */
export const RUN_TESTS_PATTERN = 'test/**/*.test.ts'

/**
 * 段级 excludes 的默认值：拓扑里未显式声明 excludes 的段，生成时按此注入。
 * 与 packages/<pkg>/src/client/**、src/types.ts 同为「不建议纳入变异面」的默认面。
 */
export function defaultSegmentExcludes(pkgName) {
  return [
    `!packages/${pkgName}/src/client/**`,
    `!packages/${pkgName}/src/types.ts`,
  ]
}

/**
 * 取一个包在**变异面**上的全部 glob：段 mutate ∪ 段 excludes（含默认值兜底）
 * ∪ 包级 testLayers.coverageExcludes（S0 覆盖断言的存量登记）。
 * 覆盖断言与派生器共用本函数，故不存在「一边有默认值、一边没有」的漂移面。
 */
export function collectMutationSpecs(topology, pkgName) {
  const pkgDef = topology?.packages?.[pkgName]
  if (pkgDef === undefined) return null
  const mutate = []
  const excludes = []
  for (const seg of Object.values(pkgDef.segments ?? {})) {
    for (const g of seg.mutate ?? []) mutate.push(g)
    const segExcludes = seg.excludes ?? defaultSegmentExcludes(pkgName)
    for (const g of segExcludes) excludes.push(g.replace(/^!/, ''))
  }
  for (const g of pkgDef.testLayers?.coverageExcludes ?? []) excludes.push(g.replace(/^!/, ''))
  return { mutate, excludes }
}
