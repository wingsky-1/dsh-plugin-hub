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
 * 覆盖排除面（包级 `testLayers.coverageExcludes`）的形状与取值域。
 *
 * 形状与 vitest 面 `scripts/data/coverage.config.json` **同形同键名**（#773 R4）：
 * `{ pattern, reason, kind }`，reason 长度下限也与之对齐。为什么不共用一份 KINDS：
 * 两个面是两套口径（同一条 glob 可以同时出现在两处），kind 描述的是「这条排除在本面
 * 为什么成立」，混用一份值域会把两个面的语义差抹平。
 *
 * **本面 kind 是本面自有值域**（两处同名不代表同义，逐条说明）：
 *   - `type-only`（与 vitest 面同义）：真无运行时代码——`.d.ts` / `.d.mts` 声明层、
 *     纯类型依赖声明出口。
 *   - `facade`（本面增补）：域门面 `interface.ts`——转译后**可能有运行时代码**
 *     （装配/卸载转调、re-export），只是本身不做裁决；vitest 面对应的 `type-only`
 *     只用在 `.d.ts`/`.d.mts`，同名会把「门面」误读成「无运行时代码」，故另立一值。
 *   - `not-source`（与 vitest 面同义）：src 下的非源码资源（`.ps1` 等随包分发）。
 *   - `not-mutated`（本面增补）：是源码、有运行时实现，但有意不进变异面（重复转发同一
 *     实现的薄 facade、以用户文件形态交付的内置适配器 `.mjs`、带真实默认实现的进程端口）。
 */
export const COVERAGE_EXCLUDE_KINDS = ["type-only", "facade", "not-source", "not-mutated"];

/** reason 的长度下限：与 vitest 面 verify-coverage-scope.mjs 的判据对齐（10）。 */
export const COVERAGE_EXCLUDE_MIN_REASON = 10;

/**
 * 取一个包 `testLayers.coverageExcludes` 的排除 glob 清单（原样，含 `!` 前缀）。
 *
 * 生成侧（gen-stryker-conf）与断言侧（collectMutationSpecs）**唯一**的取值点：
 * 形状从裸字符串改为对象后，两处各写一遍 `.pattern` 就是下一次「一边改、一边漏」的
 * 漂移面。形状不合法的条目在这里**跳过而不是猜测**——判红由 coverageExcludeProblems
 * 承担，跳过是为了让取值函数保持纯读取（不抛栈、不静默猜默认值）。
 */
export function collectCoverageExcludePatterns(pkgDef) {
  const entries = pkgDef?.testLayers?.coverageExcludes;
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (entry !== null && typeof entry === "object" && typeof entry.pattern === "string") {
      out.push(entry.pattern);
    }
  }
  return out;
}

/**
 * 校验覆盖排除面的形状；返回 problems（空数组 = 合法）。
 *
 * fail-closed：调用方必须把 problems 落成判红，**不得**当成「这条不用排除」静默跳过——
 * 静默跳过等于文件悄悄退出度量面而门禁仍绿（本仓已复现的假绿向量）。形状错误必须自己
 * 判红并给出可读判词：旧形状（裸 glob）的失败形态是取值处 `g.replace is not a function`
 * 抛栈崩掉整个 contract 段，那不是判红。
 */
export function coverageExcludeProblems(pkgDef) {
  const entries = pkgDef?.testLayers?.coverageExcludes;
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return ["coverageExcludes 必须是非空数组（形状错误，fail-closed）"];
  }
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(
        "coverageExcludes 含非对象项（裸 glob 已不是合法形状，须写成 { pattern, reason, kind }）",
      );
      continue;
    }
    const label =
      typeof entry.pattern === "string" && entry.pattern !== "" ? entry.pattern : "(缺 pattern)";
    if (typeof entry.pattern !== "string" || entry.pattern === "") {
      problems.push("coverageExcludes 条目缺 pattern");
      continue;
    }
    if (!entry.pattern.startsWith("!")) {
      problems.push(`${label}：pattern 必须以 ! 开头（本条进的是排除面，缺 ! 会把文件加进变异面）`);
    }
    if (seen.has(entry.pattern))
      problems.push(`coverageExcludes 存在重复 pattern：${entry.pattern}`);
    seen.add(entry.pattern);
    if (typeof entry.reason !== "string" || entry.reason.length < COVERAGE_EXCLUDE_MIN_REASON) {
      problems.push(
        `${label}：coverageExcludes 条目缺 reason（排除即缩小判据面，必须写明理由，不少于 ${COVERAGE_EXCLUDE_MIN_REASON} 字）`,
      );
    }
    if (!COVERAGE_EXCLUDE_KINDS.includes(entry.kind)) {
      problems.push(
        `${label}：kind 须为 ${COVERAGE_EXCLUDE_KINDS.join(" / ")} 之一（当前 ${JSON.stringify(entry.kind)}）`,
      );
    }
  }
  return problems;
}

/**
 * 包登记本身的形状判据：`packages.<name>` 必须是对象，且其 `segments` 也必须是对象。
 *
 * 与 coverageExcludes 的形状判词同族：形状不对时**没有可判定的变异面**，必须给出可读判词，
 * 而不是让调用方在 `pkgDef.segments` 上抛栈崩掉整个 contract 段（已实测：登记为 `null` →
 * `TypeError: Cannot read properties of null (reading 'segments')`；登记为 `{}` 或
 * `{ segments: null }` → `Object.entries` 的 `Cannot convert undefined or null to object`，
 * 门禁红是红了，但不是判红）。
 */
export function packageEntryProblems(pkgDef) {
  if (pkgDef === null || typeof pkgDef !== "object" || Array.isArray(pkgDef)) {
    return [
      `包登记必须是对象（当前 ${JSON.stringify(pkgDef)}）——形状不对时没有可判定的变异面，fail-closed`,
    ];
  }
  // 包登记是对象还不够：`segments` 缺失 / null / 标量 / 数组都会让 `Object.entries(pkgDef.segments)`
  // 抛栈（gen-stryker-conf 与 collectMutationSpecs 都读它）。缺了它就没有可判定的变异面，
  // 故与「包登记不是对象」同族判红，而不是留给下游崩栈、或退化成「一堆 uncoveredSrcFiles 噪声」。
  const segments = pkgDef.segments;
  if (
    segments === undefined ||
    segments === null ||
    typeof segments !== "object" ||
    Array.isArray(segments)
  ) {
    return [
      `包登记的 segments 必须是对象（当前 ${JSON.stringify(segments)}）——形状不对时没有可判定的变异面，fail-closed`,
    ];
  }
  return [];
}

/** 全拓扑的包登记形状问题（带包名前缀，供生成侧与断言侧共用判词）。 */
export function packageRegistrationProblems(topology) {
  const packages = topology?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    return [`packages 必须是对象（当前 ${JSON.stringify(packages)}）`];
  }
  const problems = [];
  for (const [pkgName, pkgDef] of Object.entries(packages)) {
    for (const problem of packageEntryProblems(pkgDef)) {
      problems.push(`[${pkgName}] ${problem}`);
    }
  }
  return problems;
}

/**
 * 取一个包在**变异面登记**上的三态（#773 批 B / #710 §2-2）：
 *
 *   - `{ noMutation: false, mutate, excludes, problems }`：登记在 `topology.packages`，覆盖断言可判定。
 *     面 = 段 mutate ∪ 段 excludes（含默认值兜底）∪ 包级 testLayers.coverageExcludes
 *     （S0 覆盖断言的存量登记，条目形状 `{ pattern, reason, kind }`、形状判词见
 *     coverageExcludeProblems；取值只经 collectCoverageExcludePatterns 一处）；覆盖断言
 *     与派生器共用本函数，故不存在「一边有默认值、一边没有」的漂移面。
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
  // 包登记形状错误（null / 非对象）：不给可判定的面，但必须**可读判红**而不是在
  // `pkgDef.segments` 上抛栈——空 mutate/excludes 会让未覆盖清单全亮，problems 则由调用方落红。
  const entryProblems = pkgDef === undefined ? [] : packageEntryProblems(pkgDef);
  if (entryProblems.length > 0) {
    return { noMutation: false, mutate: [], excludes: [], problems: entryProblems };
  }
  if (pkgDef !== undefined) {
    const mutate = [];
    const excludes = [];
    for (const seg of Object.values(pkgDef.segments ?? {})) {
      for (const g of seg.mutate ?? []) mutate.push(g);
      const segExcludes = seg.excludes ?? defaultSegmentExcludes(pkgName);
      for (const g of segExcludes) excludes.push(g.replace(/^!/, ""));
    }
    for (const g of collectCoverageExcludePatterns(pkgDef)) excludes.push(g.replace(/^!/, ""));
    // 覆盖排除面的形状问题随 spec 一起交给调用方（fail-closed）：这里不抛栈、不静默跳过，
    // 由 verify-dir-imports 落成硬违规、gen-stryker-conf 落成启动判红。
    return { noMutation: false, mutate, excludes, problems: coverageExcludeProblems(pkgDef) };
  }
  if (pkgName.startsWith("$")) return null;
  const reason = topology?.$noMutationPackages?.[pkgName];
  if (reason === undefined) return null;
  return { noMutation: true, reason: String(reason) };
}
