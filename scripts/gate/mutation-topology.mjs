/**
 * scripts/gate/mutation-topology.mjs — 变异拓扑的派生规则共享模块（#690 S2b / #710 F15）。
 *
 * 为什么单独成文件：`gen-stryker-conf.mjs` 是带副作用的 CLI（顶层读写配置），
 * 不能被门禁脚本 import。但「段未显式写 excludes 时注入默认值」这条派生规则必须
 * 在生成侧与断言侧**同一份实现**——F15 的隐患正是两边各写一份、断言侧漏掉默认值，
 * 于是「靠默认值覆盖的段」在覆盖断言里变成盲区。
 */

// runner 面（test/**/*.test.ts，与 vitest include 同口径）：`--min` 与登记完整性判据 ③ 的唯一口径。
export const RUN_TESTS_PATTERN = "test/**/*.test.ts";

/**
 * 段级 excludes 的默认值：拓扑里未显式声明 excludes 的段，生成时按此注入。
 * 与 packages/<pkg>/src/client/**、src/types.ts 同为「不建议纳入变异面」的默认面。
 */
export function defaultSegmentExcludes(pkgName) {
  return [`!packages/${pkgName}/src/client/**`, `!packages/${pkgName}/src/types.ts`];
}

/**
 * 取一个包在**变异面登记**上的三态（#773 批 B / #710 §2-2）：
 *
 *   - `{ noMutation: false, mutate, excludes }`：登记在 `topology.packages`，覆盖断言可判定。
 *     面 = 段 mutate ∪ 段 excludes（含默认值兜底）∪ 包级 testLayers.coverageExcludes
 *     （S0 覆盖断言的存量登记）；覆盖断言与派生器共用本函数，故不存在「一边有默认值、
 *     一边没有」的漂移面。
 *   - `{ noMutation: true, reason }`：登记在 `$noMutationPackages`——该包**无变异面**，
 *     源码全覆盖断言**不适用**（不是「通过」）。调用方必须把这件事显式声明出来，
 *     不得因「没有可判定的面」而静默判绿：该包在 dir-imports-baseline 里的
 *     `uncoveredSrcFiles: []` 是「未登记拓扑时该字段恒为空」的已知假绿，不是全覆盖的证据。
 *   - `null`：两处都未登记 → 调用方 fail-closed。这是**对调用方的契约**，前提是调用方
 *     真的读到了拓扑文件：文件整份缺失时本函数同样返回 `null`（入参不可用），
 *     但「包未登记」与「拓扑不可用」不是同一件事，调用方须自行区分（见
 *     verify-dir-imports.mjs 头部对缺失态的说明）。
 *
 * `$noMutationPackages` 的 `$comment` 元键不算登记（与 gen-stryker-conf 的过滤口径一致）；
 * 同时登记两处时以 `packages` 为准——只有它带得出可判定的 mutate/excludes 面。
 */
export function collectMutationSpecs(topology, pkgName) {
  const pkgDef = topology?.packages?.[pkgName];
  if (pkgDef !== undefined) {
    const mutate = [];
    const excludes = [];
    for (const seg of Object.values(pkgDef.segments ?? {})) {
      for (const g of seg.mutate ?? []) mutate.push(g);
      const segExcludes = seg.excludes ?? defaultSegmentExcludes(pkgName);
      for (const g of segExcludes) excludes.push(g.replace(/^!/, ""));
    }
    for (const g of pkgDef.testLayers?.coverageExcludes ?? []) excludes.push(g.replace(/^!/, ""));
    return { noMutation: false, mutate, excludes };
  }
  if (pkgName.startsWith("$")) return null;
  const reason = topology?.$noMutationPackages?.[pkgName];
  if (reason === undefined) return null;
  return { noMutation: true, reason: String(reason) };
}
