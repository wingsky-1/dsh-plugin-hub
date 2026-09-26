/**
 * scripts/gate/mutation-topology.mjs — 变异拓扑的登记形状判据共享模块（#690 S2b / #710 F15 / #836）。
 *
 * 为什么单独成文件：`gen-stryker-conf.mjs` 是带副作用的 CLI（顶层读写配置），
 * 不能被门禁脚本 import；而生成侧与断言侧必须共用**同一份**段登记形状判据——
 * F15 的隐患正是两边各写一份，断言侧漏掉一条派生规则、被覆盖的段成了盲区。
 *
 * #836 起 `segments.<seg>.excludes` 必填，原先「段缺 excludes 就用默认值兜底」的
 * defaultSegmentExcludes 已删除：生产路径上 33 个段全部显式声明 excludes，兜底分支
 * 不可达；而它恰恰就是 F15 描述的分叉面（生成侧注入的排除面 vs 断言侧读到的排除面），
 * 留作死代码等于保留一条永远不会被实测覆盖、却随时可能被重新走通的分叉。段不声明
 * 排除面现在直接在形状判据里判红。
 *
 * 形状之外还判两件事（#848 复核补）：`excludes` 的**每条**必须是非空字符串且以 `!` 开头
 * （缺 `!` 会被原样拼进 conf 的 mutate，从「排除」极性反转为「要变异」），以及 `segments`
 * 不得是空对象（它不派生任何 conf，条目判据永远看不到该包）。
 */

// runner 面（test/**/*.test.ts，与 vitest include 同口径）：`--min` 与登记完整性判据 ③ 的唯一口径。
export const RUN_TESTS_PATTERN = "test/**/*.test.ts";

/** 根 shared 变异面是独立 surface，不伪装成 packages/shared。 */
export const ROOT_SHARED_SURFACE = "$rootShared";
export const ROOT_SHARED_TEST_ROOT = "shared";
export const ROOT_SHARED_TEST_PATTERN = "test/**/*.mutation.test.ts";

/** packages 登记 + 可选 root-shared surface；共享给形状、算子与文件面判据。 */
function mutationSurfaces(topology) {
  const surfaces = Object.entries(topology?.packages ?? {});
  if (topology?.[ROOT_SHARED_SURFACE] !== undefined) {
    surfaces.push([ROOT_SHARED_SURFACE, topology[ROOT_SHARED_SURFACE]]);
  }
  return surfaces;
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
 * 包级变异面并集棘轮的门禁名（#843 计划项 3-1）。
 *
 * 唯一放宽通道是 `scripts/data/gate-exemptions.json` 里 `gate` 等于本常量的条目——与
 * threshold-registry / verify-dir-imports 共用同一份台账与同一个读取器（`loadLedger`），
 * 不另立第二套豁免机制。path 形态是 `<包名>:<仓库根相对文件>`（只豁免那一个文件的收缩）
 * 或 `<包名>:*`（豁免该包全部收缩）；台账里对不上缺口的键一律判红（反向腐烂）。
 */
export const MUTATION_FACE_GATE = "mutation-face";

/**
 * 本仓拓扑的算子值域：Stryker 实际算子名 + 两个存量字面量分类名；不接受拼写错误或任意 override。
 *
 * 例外说明（#847 复核实测，Stryker 10.0.0）：`ArrayLiteral` / `TemplateLiteral` 不是独立算子——
 * 前者实际叫 `ArrayDeclaration`，后者归 `StringLiteral` 管（含模板字面量，见 instrumenter 的
 * `string-literal-mutator`）。Stryker 的 schema 对 excludedMutations 只做 string[] 校验，
 * 未知名静默零匹配（fail-strict 方向：多跑变异，不构成放宽）。留在这里只为兼容存量配置的
 * 字面写法，去名需另起 PR（会改 33 份派生 conf 文本但行为不变），不得在本面顺手改。
 */
const MUTATION_NAMES = new Set([
  "ArithmeticOperator",
  "ArrayDeclaration",
  "ArrayLiteral",
  "ArrowFunction",
  "AssignmentOperator",
  "BlockStatement",
  "BooleanLiteral",
  "CallExpression",
  "ConditionalExpression",
  "EqualityOperator",
  "LogicalOperator",
  "MethodExpression",
  "ObjectLiteral",
  "OptionalChaining",
  "Regex",
  "StringLiteral",
  "TemplateLiteral",
  "UnaryOperator",
  "UpdateOperator",
]);

function mutationNameProblems(values, label) {
  if (!Array.isArray(values)) return [label + " 必须是数组（fail-closed）"];
  const problems = [];
  const seen = new Set();
  for (const value of values) {
    if (!MUTATION_NAMES.has(value)) problems.push(label + " 含非法算子：" + JSON.stringify(value));
    if (seen.has(value)) problems.push(label + " 含重复算子：" + JSON.stringify(value));
    seen.add(value);
  }
  return problems;
}

/** enableMutations 只能从共享排除集合减项，不是包级 excludedMutations 覆写入口。 */
export function mutationPolicyProblems(topology) {
  const defaults = topology?.sharedDefaults?.excludedMutations;
  const problems = mutationNameProblems(defaults, "sharedDefaults.excludedMutations");
  for (const [surfaceName, surfaceDef] of mutationSurfaces(topology)) {
    if (surfaceDef === null || typeof surfaceDef !== "object") continue;
    problems.push(...packageMutationPolicyProblems(surfaceName, surfaceDef, defaults));
  }
  return problems;
}

function packageMutationPolicyProblems(pkgName, pkgDef, defaults) {
  const label = "[" + pkgName + "] enableMutations";
  const problems = [];
  if (Object.hasOwn(pkgDef, "excludedMutations") || Object.hasOwn(pkgDef, "mutator")) {
    problems.push("[" + pkgName + "] 不允许包级排除 override，请使用 enableMutations 减项");
  }
  if (!Object.hasOwn(pkgDef, "enableMutations")) return problems;
  problems.push(...mutationNameProblems(pkgDef.enableMutations, label));
  if (Array.isArray(pkgDef.enableMutations) && Array.isArray(defaults)) {
    for (const name of pkgDef.enableMutations) {
      if (!defaults.includes(name))
        problems.push(label + " 不在共享排除集合中：" + JSON.stringify(name));
    }
  }
  return problems;
}

/** 形状判据通过后才能读取；顺序继承共享默认值，生成物保持确定性。 */
export function effectiveExcludedMutations(sharedDefaults, pkgDef) {
  return sharedDefaults.excludedMutations.filter(
    (name) => !(pkgDef.enableMutations ?? []).includes(name),
  );
}

/** 有效排除集合 E_head(pkg) 必须为 E_base(pkg) 的子集；此收紧面没有豁免通道。 */
export function mutationPolicyRatchetProblems(baseTopology, headTopology) {
  const shape = [...mutationPolicyProblems(baseTopology), ...mutationPolicyProblems(headTopology)];
  if (shape.length > 0) return shape.map((p) => "算子排除棘轮形状错误：" + p);
  const problems = [];
  for (const [surfaceName, baseDef] of mutationSurfaces(baseTopology)) {
    const headDef =
      surfaceName === ROOT_SHARED_SURFACE
        ? headTopology?.[ROOT_SHARED_SURFACE]
        : headTopology?.packages?.[surfaceName];
    if (headDef === undefined) continue; // 整 surface 退出由文件面棘轮负责。
    const base = new Set(effectiveExcludedMutations(baseTopology.sharedDefaults, baseDef));
    const added = effectiveExcludedMutations(headTopology.sharedDefaults, headDef).filter(
      (name) => !base.has(name),
    );
    if (added.length > 0)
      problems.push(
        "[" +
          surfaceName +
          "] 有效算子排除集合相对基准增加：" +
          added.join(", ") +
          "（E_head 必须是 E_base 的子集）",
      );
  }
  return problems;
}

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
    problems.push(...coverageExcludeEntryProblems(entry, seen));
  }
  return problems;
}

/** 单条覆盖排除条目的形状判词；`seen` 记已出现的 pattern，用于重复检测。 */
function coverageExcludeEntryProblems(entry, seen) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [
      "coverageExcludes 含非对象项（裸 glob 已不是合法形状，须写成 { pattern, reason, kind }）",
    ];
  }
  const label = coverageExcludeLabel(entry);
  if (typeof entry.pattern !== "string" || entry.pattern === "") {
    return ["coverageExcludes 条目缺 pattern"];
  }
  return coverageExcludeValueProblems(entry, label, seen);
}

/** 判词里的定位标签；pattern 缺失时占位，避免判词退化成无定位信息。 */
function coverageExcludeLabel(entry) {
  return typeof entry.pattern === "string" && entry.pattern !== "" ? entry.pattern : "(缺 pattern)";
}

/** 合法形态条目的取值判词（pattern 前缀 / 重复 / reason / kind），重复检测就地更新 seen。 */
function coverageExcludeValueProblems(entry, label, seen) {
  const problems = [];
  if (!entry.pattern.startsWith("!")) {
    problems.push(`${label}：pattern 必须以 ! 开头（本条进的是排除面，缺 ! 会把文件加进变异面）`);
  }
  if (seen.has(entry.pattern)) problems.push(`coverageExcludes 存在重复 pattern：${entry.pattern}`);
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
  return problems;
}

/**
 * 包登记本身的形状判据：`packages.<name>` 必须是对象，其 `segments` 也必须是对象，
 * 且每个段必须自带 `excludes` 数组（允许显式空数组）（#836 起必填）、数组里每条必须是以 `!` 开头的非空字符串。
 *
 * 与 coverageExcludes 的形状判词同族：形状不对时**没有可判定的变异面**，必须给出可读判词，
 * 而不是让调用方在 `pkgDef.segments` 上抛栈崩掉整个 contract 段（已实测：登记为 `null` →
 * `TypeError: Cannot read properties of null (reading 'segments')`；登记为 `{}` 或
 * `{ segments: null }` → `Object.entries` 的 `Cannot convert undefined or null to object`，
 * 门禁红是红了，但不是判红）。
 *
 * 为什么 excludes 必填（而不是继续用默认值兜底）：默认值兜底是死代码——回退分支在生产路径上
 * 从不执行，既得不到实测覆盖，又留着「生成侧注入的面 ≠ 断言侧读到的面」这条分叉（F15 的
 * 隐患本身）。必填后语义变成「段自己声明排除面」，省略即在形状判据处判红，不再静默继承
 * 一份没人复核过的默认面。段不是对象时也必须先判红，否则下一个判据要读的 `seg.excludes`
 * 就是一次裸解引用（抛栈而非判红）。
 */
/** 登记面形状判据的共同前提：非 null、对象、且不是数组。 */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function packageEntryProblems(pkgDef) {
  if (!isPlainObject(pkgDef)) {
    return [
      `包登记必须是对象（当前 ${JSON.stringify(pkgDef)}）——形状不对时没有可判定的变异面，fail-closed`,
    ];
  }
  // 包登记是对象还不够：`segments` 缺失 / null / 标量 / 数组都会让 `Object.entries(pkgDef.segments)`
  // 抛栈（gen-stryker-conf 与 collectMutationSpecs 都读它）。缺了它就没有可判定的变异面，
  // 故与「包登记不是对象」同族判红，而不是留给下游崩栈、或退化成「一堆 uncoveredSrcFiles 噪声」。
  const segments = pkgDef.segments;
  if (!isPlainObject(segments)) {
    return [
      `包登记的 segments 必须是对象（当前 ${JSON.stringify(segments)}）——形状不对时没有可判定的变异面，fail-closed`,
    ];
  }
  // 空对象是「登记了变异面却没有面」：它不派生任何 conf，⑤/⑥ 永远看不到该包，包级幽灵排除
  // 可以安静地留在有效面里。无变异面的包应登记进 $noMutationPackages 并写明理由。
  if (Object.keys(segments).length === 0) {
    return [
      "包登记的 segments 为空对象——没有变异面（无 conf 可判）却登记在 packages 下；" +
        "无变异面的包请登记进 $noMutationPackages 并写明理由",
    ];
  }
  const problems = [];
  for (const [segKey, segDef] of Object.entries(segments)) {
    problems.push(...segmentEntryProblems(segKey, segDef));
  }
  return problems;
}

/**
 * 一个段登记的形状与 excludes 条目判词。
 *
 * 条目形状：excludes 的每条都进排除面，靠 `!` 前缀与 conf 里的正向条目区分。缺 `!` 的条目
 * 会被原样拼进派生 conf 的 mutate，语义从「排除这个文件」**极性反转**成「要变异这个文件」
 * ——而两条路径都真实存在，只判「命中 ≥1 文件」的判据全绿（#848 复核前的实测形态）。
 */
export function segmentEntryProblems(segKey, segDef) {
  if (!isPlainObject(segDef)) {
    return [
      `段 "${segKey}" 必须是对象（当前 ${JSON.stringify(segDef)}）——形状不对时该段没有可判定的变异面，fail-closed`,
    ];
  }
  if (!Array.isArray(segDef.excludes)) {
    return [
      `段 "${segKey}" 的 excludes 必须是数组（可显式为空）（当前 ${JSON.stringify(segDef.excludes)}）——` +
        "段必须自己声明排除面（#836 起缺省回退已删除），否则会把排除面静默收敛成空集",
    ];
  }
  const problems = [];
  for (const [i, entry] of segDef.excludes.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(
        `段 "${segKey}" 的 excludes[${i}] 必须是非空字符串（当前 ${JSON.stringify(entry)}）`,
      );
    } else if (!entry.startsWith("!")) {
      problems.push(
        `段 "${segKey}" 的 excludes[${i}] 缺 ! 前缀（当前 ${entry}）—— ` +
          "该条目会被原样拼进 conf 的 mutate，从「排除」极性反转成「要变异这个文件」",
      );
    }
  }
  return problems;
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

/** root-shared 形状：固定测试根/模式与 0–100 阈值，段形状沿用 package 的严格口径。 */
/** threshold 必须是 0–100 的有限数字。 */
export function isThresholdNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

/** root-shared 的固定字段（testRoot / testPattern / threshold / coverageExcludes）判词。 */
function rootSharedFixedProblems(rootShared) {
  const problems = [];
  if (rootShared.testRoot !== ROOT_SHARED_TEST_ROOT) {
    problems.push(
      `${ROOT_SHARED_SURFACE}.testRoot 必须是 "${ROOT_SHARED_TEST_ROOT}"（当前 ${JSON.stringify(rootShared.testRoot)}）`,
    );
  }
  if (rootShared.testPattern !== ROOT_SHARED_TEST_PATTERN) {
    problems.push(
      `${ROOT_SHARED_SURFACE}.testPattern 必须是 "${ROOT_SHARED_TEST_PATTERN}"（当前 ${JSON.stringify(rootShared.testPattern)}）——` +
        "node:test 标准入口不得混入 Vitest 变异面",
    );
  }
  if (!isThresholdNumber(rootShared.threshold)) {
    problems.push(
      `${ROOT_SHARED_SURFACE}.threshold 必须是 0–100 的有限数字（当前 ${JSON.stringify(rootShared.threshold)}）`,
    );
  }
  if (rootShared.testLayers?.coverageExcludes !== undefined) {
    problems.push(`${ROOT_SHARED_SURFACE} 不支持 coverageExcludes；只允许段级 excludes 精确登记`);
  }
  return problems;
}

export function rootSharedEntryProblems(rootShared) {
  if (!isPlainObject(rootShared)) {
    return [
      `${ROOT_SHARED_SURFACE} 必须是对象（当前 ${JSON.stringify(rootShared)}）——形状不对时没有可判定的 root-shared 变异面，fail-closed`,
    ];
  }
  const problems = rootSharedFixedProblems(rootShared);
  for (const problem of packageEntryProblems(rootShared)) {
    problems.push(problem.replaceAll("包登记", `${ROOT_SHARED_SURFACE} 登记`));
  }
  return problems;
}

/** 可选 root-shared surface 的全拓扑形状判词。 */
export function rootSharedRegistrationProblems(topology) {
  if (topology?.[ROOT_SHARED_SURFACE] === undefined) return [];
  return rootSharedEntryProblems(topology[ROOT_SHARED_SURFACE]).map(
    (problem) => `[${ROOT_SHARED_SURFACE}] ${problem}`,
  );
}

/**
 * 取一个包在**变异面登记**上的三态（#773 批 B / #710 §2-2）：
 *
 *   - `{ noMutation: false, mutate, excludes, problems }`：登记在 `topology.packages`，覆盖断言可判定。
 *     面 = 段 mutate ∪ 段 excludes（#836 起每段必填，没有默认值兜底）∪ 包级
 *     testLayers.coverageExcludes（S0 覆盖断言的存量登记，条目形状 `{ pattern, reason, kind }`、
 *     形状判词见 coverageExcludeProblems；取值只经 collectCoverageExcludePatterns 一处）；
 *     覆盖断言与派生器共用本函数，故不存在「一边读段声明、一边读另一份清单」的漂移面。
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
    const { mutate, excludes } = collectMutationGlobs(pkgDef);
    // 覆盖排除面的形状问题随 spec 一起交给调用方（fail-closed）：这里不抛栈、不静默跳过，
    // 由 verify-dir-imports 落成硬违规、gen-stryker-conf 落成启动判红。
    return { noMutation: false, mutate, excludes, problems: coverageExcludeProblems(pkgDef) };
  }
  if (pkgName.startsWith("$")) return null;
  const reason = topology?.$noMutationPackages?.[pkgName];
  if (reason === undefined) return null;
  return { noMutation: true, reason: String(reason) };
}

/** 条目去掉 `!` 极性别：`!` 只是「本条进的是排除面」的语义标记，不是 glob 语法的一部分。 */
function barePattern(pattern) {
  return pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

/** 逐条展开 glob 并并入目标集合；非字符串 / 空串条目由形状判据负责判红，这里跳过不猜。 */
function expandInto(target, patterns, expand) {
  for (const pattern of patterns ?? []) {
    if (typeof pattern !== "string" || pattern === "") continue;
    for (const hit of expand(barePattern(pattern))) target.add(hit);
  }
}

/**
 * 一个包的变异文件**并集**与「候选文件」集（#843 计划项 3-1 棘轮的两个输入）。
 *
 * face = Σ段（段正向命中 − 段 excludes − 包级 coverageExcludes）：逐段算完再并，不是把所有正向
 * 条目合成一个集合统一剔除——段与段各自派生 conf、Stryker 逐份求值，拿 A 段的 `!` 条目去剔除
 * B 段的正向条目会算出一个比真实变异面更小的集合，棘轮于是可能把「段间挪动」误判成收缩。
 *
 * candidates = 段正向命中的并集（不剔排除面）：它是「本次比对面里真的出现过哪些文件」的载体。
 * 为什么不拿 face 当载体做空转自证：一个**有意**把正向面排除光的登记（判据⑥ 的合法判红形态）
 * 会让 face 归零，把正常的判红误诊成「判据空转」——两种红的判词就会互相打架。
 *
 * `expand(pattern)` 必须返回该 glob 在**当前工作区源码世界**里命中的文件（仓库根相对 posix）。
 * 基准侧的条目也用它展开，故「文件已从本分支删除」自然从基准面里消失——这正是「真删除即正当
 * 收缩」的实现方式，不需要额外的存在性分支（也就没有第二条判断文件是否存在的口径）。
 */
/** 一个段的 keep/drop 展开：正向 mutate 进 keep，`!` 前缀的 mutate 与段 excludes 进 drop。 */
function segmentFaces(seg, coverageDrop, expand) {
  const keep = new Set();
  const drop = new Set(coverageDrop);
  for (const pattern of seg.mutate ?? []) {
    if (typeof pattern !== "string" || pattern === "") continue;
    expandInto(pattern.startsWith("!") ? drop : keep, [pattern], expand);
  }
  expandInto(drop, seg.excludes, expand);
  return { keep, drop };
}

/** 一个段的变异面（keep 剔 drop）并进总面；候选集不剔排除面，故两个集各记各的。 */
function absorbSegmentFace(seg, coverageDrop, face, candidates, expand) {
  if (seg === null || typeof seg !== "object" || Array.isArray(seg)) return;
  const { keep, drop } = segmentFaces(seg, coverageDrop, expand);
  for (const hit of keep) {
    candidates.add(hit);
    if (!drop.has(hit)) face.add(hit);
  }
}

function faceAndCandidates(pkgDef, expand) {
  const coverageDrop = new Set();
  expandInto(coverageDrop, collectCoverageExcludePatterns(pkgDef), expand);
  const face = new Set();
  const candidates = new Set();
  for (const seg of Object.values(pkgDef?.segments ?? {})) {
    absorbSegmentFace(seg, coverageDrop, face, candidates, expand);
  }
  return { face, candidates };
}

/** 一个包的变异文件并集（跨全部段，已剔段 excludes 与包级 coverageExcludes）。 */
export function packageMutationFace(pkgDef, expand) {
  return faceAndCandidates(pkgDef, expand).face;
}

/**
 * 包级变异面并集棘轮（#843 计划项 3-1）：与基准（origin/main）相比，同一包的变异文件**并集**
 * 不得收缩。
 *
 * 为什么需要它：判据⑤/⑥ 只保证「条目锚定在本包且命中 ≥1 文件」「整份 conf 剔 `!` 后仍有剩余」，
 * **都不看基准**——把 `src/config.ts` 从某段 `mutate` 挪进**同段** `excludes` 再重生成 conf，
 * 逐条条目都合法（它确实命中了真实文件）、有效面也非空（同段还有别的文件），于是
 * `pnpm stryker:check` 与 `verify-dir-imports` 双双 exit 0——文件就这样静默退出变异面。
 *
 * 语义（逐条按裁决，不要在这里另立第三种）：段之间挪动合法（并集不变）；挪出变异面到任何段的
 * `excludes` / 包级 `coverageExcludes` 非法；文件在本分支已被真正删除（head 源码世界里不存在）
 * 不算违规——删除即正当收缩。
 *
 * 载体自证：返回 `packagesCompared` / `filesCompared`（进入比对面的包数与候选文件数），
 * 任一为 0 即判红而不是恒绿——本判据最危险的失效形态是一条没比却全绿（包集合被清空、
 * 基准的 mutate 条目被换成不命中任何现存文件的形式）。**这是判红而不是跳过**：
 * 「没有载体」与「比对过且没收缩」必须能被区分开。
 *
 * `exemptions` 是 `loadLedger(..., MUTATION_FACE_GATE)` 的结果（Map，键 = path）。
 */
export function mutationFaceRatchetProblems({
  baseTopology,
  headTopology,
  expand,
  exemptions = new Map(),
}) {
  const problems = [];
  const used = new Set();
  const headFaces = new Map();
  for (const [surfaceName, surfaceDef] of mutationSurfaces(headTopology)) {
    headFaces.set(surfaceName, faceAndCandidates(surfaceDef, expand).face);
  }
  let packagesCompared = 0;
  let filesCompared = 0;
  for (const [surfaceName, surfaceDef] of mutationSurfaces(baseTopology)) {
    const base = faceAndCandidates(surfaceDef, expand);
    packagesCompared += 1;
    filesCompared += base.candidates.size;
    problems.push(...surfaceShrinkProblems(surfaceName, base.face, headFaces, exemptions, used));
  }
  problems.push(...staleExemptionProblems(exemptions, used));
  problems.push(...ratchetCarrierProblems(packagesCompared, filesCompared));
  return { problems, packagesCompared, filesCompared };
}

/**
 * 一个 surface 的收缩缺口判词；整面豁免（`<surface>:*`）优先于单文件豁免（`<surface>:<file>`）。
 * 用到的豁免键记进 `used`，供台账反向腐烂判据对账。
 */
function surfaceShrinkProblems(surfaceName, baseFace, headFaces, exemptions, used) {
  const problems = [];
  const headFace = headFaces.get(surfaceName) ?? new Set();
  const wholeSurfaceKey = `${surfaceName}:*`;
  for (const file of [...baseFace].sort()) {
    if (headFace.has(file)) continue;
    if (exemptions.has(wholeSurfaceKey)) {
      used.add(wholeSurfaceKey);
      continue;
    }
    const key = `${surfaceName}:${file}`;
    if (exemptions.has(key)) {
      used.add(key);
      continue;
    }
    problems.push(
      `[${surfaceName}] 变异面并集相对基准收缩：${file} 在基准的变异面内，本分支却不在了` +
        "——段之间挪动合法，挪进任何段的 excludes / coverageExcludes 非法；" +
        "文件在本分支已真正删除才算正当收缩（判据⑦ surface 并集棘轮）",
    );
  }
  return problems;
}

/**
 * 台账反向腐烂：豁免还在、缺口已消失（或键形态认不出来）一律判红——否则台账会长期挂着一堆
 * 其实什么也没豁免的条目。与 threshold-registry 的同名判据同形。
 */
function staleExemptionProblems(exemptions, used) {
  const problems = [];
  for (const key of exemptions.keys()) {
    if (used.has(key)) continue;
    problems.push(
      `变异面棘轮：台账里的 ${key} 没有对应的收缩缺口（无法识别的键或反向腐烂）—— 请删除该条目`,
    );
  }
  return problems;
}

/** 载体自证：比对面为空是 fail-closed 判红，不是恒绿。 */
function ratchetCarrierProblems(packagesCompared, filesCompared) {
  if (packagesCompared > 0 && filesCompared > 0) return [];
  return [
    `变异面棘轮空转：进入比对面的包 ${packagesCompared} 个、候选文件 ${filesCompared} 个` +
      "—— 判据没有比到任何载体（基准拓扑无包登记、或基准的 mutate 面不命中任何现存文件）。" +
      "这是 fail-closed 判红而不是恒绿：请确认基准 ref 是否正确、拓扑是否被整体清空",
  ];
}
/**
 * 段 testFiles 的形状判据（P2：`segments.<seg>.testFiles`）。
 *
 * 取值域：缺席（undefined）判红——缺席是“忘了登记”，与显式回落 `"*"` 必须能区分开
 * （D3）；`" *"` 合法；数组须全为非空字符串（存在性与变异面成员资格由 test-surface 的
 * resolveSegmentTestFiles 在有 root 时判定，这里只做无副作用的形状检查）。
 */
export function segmentTestShapeProblems(pkgName, segKey, segDef) {
  const label = `[${pkgName}:${segKey}]`;
  const raw = segDef?.testFiles;
  if (raw === undefined) return [`${label} 缺 testFiles 声明（须显式写 "*" 或清单，缺席≠回落）`];
  if (raw === "*") return [];
  if (!Array.isArray(raw)) return [`${label} 的 testFiles 须是数组或 "*"`];
  const problems = [];
  raw.forEach((rel, i) => {
    if (typeof rel !== "string" || rel.trim() === "")
      problems.push(`${label} 的 testFiles[${i}] 不是非空字符串`);
  });
  return problems;
}

/**
 * 测试面并集恒等判据（P2-D2：补 ⑦ 看不见的测试面收缩）。
 *
 * `union` = 包内各段 testFiles 的并集（fallback 段按包级面展开，由调用方算好传入）；
 * `packageFace` = 包级变异面投影。两者必须**集合相等**：
 *   - face − union 非空 → 测试还在变异层、却没有任何段认领：删文件式收缩（⑦恒绿）或
 *     新测试未落位（⑨），一律判红；文件在磁盘已删时它自然退出 packageFace，不在此列；
 *   - union − face 非空 → 段清单含包外面文件（拼写漂移/层外混入），判红。
 * 全回落包（union 与 face 同源）恒等，天然通过——plumbing 期零行为变更。
 *
 * 载体自证：返回 compared（包级面条目数），调用方在 0 时判红（防空转恒绿）。
 */
export function segmentTestUnionProblems({ pkgName, packageFace, union }) {
  const problems = [];
  const face = new Set(packageFace);
  const uni = new Set(union);
  for (const file of [...face].sort()) {
    if (!uni.has(file))
      problems.push(
        `[${pkgName}] 测试面并集缺口：${file} 在包级变异面内，却没有任何段的 testFiles 认领` +
          "——从段清单摘除（杀灭力静默下降）或新测试未落位；删文件请删磁盘文件本身",
      );
  }
  for (const file of [...uni].sort()) {
    if (!face.has(file))
      problems.push(
        `[${pkgName}] 测试面并集越界：${file} 不在包级变异面内 —— 段清单不得含层外/豁免文件`,
      );
  }
  return { problems, compared: face.size };
}

/** 段 mutate/excludes（段缺 excludes 时由 packageEntryProblems 判红，不再注入默认值）
 *  + 包级覆盖排除面，合成 spec 的 glob 清单。 */
function collectMutationGlobs(pkgDef) {
  const mutate = [];
  const excludes = [];
  for (const seg of Object.values(pkgDef.segments ?? {})) {
    for (const g of seg.mutate ?? []) mutate.push(g);
    // 段缺 excludes 时 packageEntryProblems 已判红并在上方提前返回，此处不必再兜底。
    for (const g of seg.excludes) excludes.push(g.replace(/^!/, ""));
  }
  for (const g of collectCoverageExcludePatterns(pkgDef)) excludes.push(g.replace(/^!/, ""));
  return { mutate, excludes };
}
