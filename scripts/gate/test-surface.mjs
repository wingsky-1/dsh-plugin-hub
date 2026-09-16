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
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { packageEntryProblems } from "./mutation-topology.mjs";
import { globFiles, sourceUniverse } from "../lib/glob-files.mjs";

/**
 * runner 面 glob：`--min` 与登记完整性判据 ③ 的唯一口径。
 *
 * #722 起 runner 由 `run-tests.mjs` 换成 vitest，本模式不变——`vitest.config.ts` 的
 * unit / integration / e2e / contract 四个 project 的 glob 并集恰好等于 `test/**` 下的
 * `*.test.ts` 全集，故门禁口径无需跟随 runner 实现变动。
 *
 * 不作为模块导出：消费者只有已退役的 `run-tests.mjs` 与 `probe-handles.mjs`（#722 阶段五），
 * 现在仅本文件的 runner 面 glob 与包发现使用。
 */
const RUN_TESTS_PATTERN = "test/**/*.test.ts";

/**
 * 必须留在变异面内的层（#690 S2b 的充分性下限）。
 * 为什么需要：`--check` 只保证「声明 ↔ 派生一致」，若允许把 `unit` 加进
 * `mutationExcludeLayers`，两行拓扑改动就能把变异面从 56 个文件削到 12 个而门禁全绿。
 * 故把「哪些层必须在变异面内」写成代码常量，改它必须过代码评审与测试。
 */
export const REQUIRED_MUTATION_LAYERS = ["unit", "integration"];

/** 包内相对 posix 路径（统一分隔符，供 glob 与清单比较）。 */
export function relPosix(from, to) {
  return relative(from, to).split(sep).join("/");
}

/** 展开一条包内相对 glob（仅取文件），返回绝对路径排序数组。 */
export function expandGlob(pkgDir, pattern) {
  return globSync(pattern, { cwd: pkgDir })
    .map((p) => join(pkgDir, p))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .sort();
}

/**
 * 锚定判词；返回 null 表示字面锚定合法。
 *
 * 字面检查只负责**可读判词**，越界的全量核对在下面按命中集合做——「字面前缀合法」与
 * 「实际命中面在本包内」是两件事：`..` 段会被 glob 归一化、brace 会被展开，两者都能让
 * 前缀看着在本包而命中的是他包文件。加了字面拦截后那条核对今天已不可达（复核把该段置空，
 * 测试仍全绿），保留作 glob 语义或字面规则放宽时的兜底。
 */
function unanchoredReason(owner, bare) {
  if (bare.startsWith("./") || bare.startsWith("/")) {
    return "是相对/绝对路径（须写仓库根相对的 packages/<本包>/ 或 shared/ 形式）";
  }
  if (bare.split("/").includes("..")) {
    return "含 .. 上跳段（字面前缀会被 glob 归一化改写，实际命中面可越出本包）";
  }
  if (/[{}]/.test(bare)) {
    return "含 brace 展开（展开后的命中面可能越出本包）";
  }
  if (!bare.startsWith(`packages/${owner}/`) && !bare.startsWith("shared/")) {
    return `不在 packages/${owner}/ 或 shared/ 之下（跨包/广域 pattern 描述的不是本包的源码）`;
  }
  return null;
}

/**
 * 变异面条目判据（#836 / #848）：一份 conf 的每条 `mutate` 条目（含 `!` 前缀的排除条目）
 * 都要过四关，且整份 conf 的正向面被 `!` 条目剔除后必须仍有剩余。
 *
 * 为什么需要：排除条目此前从没被问过「你到底排除了什么」，于是 26 份 conf 各带一条指向
 * `packages/<pkg>/src/types.ts` 的占位排除，而全仓从未存在过该文件——条目腐烂到无人察觉
 * （#836 已清）。只判「命中 ≥1 个物理文件」仍留着三条绕过路径（独立复核实测）：广域 glob
 * 命中他包同名文件即恒绿；`packages/<pkg>/**` 会被同包构建产物 `lib/**` 满足；字面前缀在
 * 本包、实际命中面被 `..` 归一化或 brace 展开改写到他包。
 *
 * 为什么还要判整份 conf 的有效面（#848 维护者评审）：一条条看都合法不等于整份 conf 有意义。
 * 把某包「逐目录级的 interface.ts 排除」换成包根级整包通配，条数不变、上面四关全绿，而该包
 * 9/9 份 conf 的有效面为空——Stryker 对 0 mutant 不报错，判分与门禁都静默。有效面只在四条
 * 逐条判据零问题时判：条目本身不合法时「有效面为空」只是前者的后果，重复报会误导定位。
 *
 * 为什么逐份 conf 判、而不是在 collectMutationSpecs 里：那里把同包所有段的 excludes 聚合成
 * 包级清单，段级幽灵条目会被同包另一段的同名命中掩盖；清除入口与判红入口必须同粒度。
 *
 * `owner` 是这份 conf 所属的包名（由派生侧的 conf 名 → 包映射给出）：锚定判据没有它就无从判起，
 * 故缺省即 fail-closed，而不是静默退化成「任何命中都算合法」。
 *
 * 返回值带 `scanned`：本判据最可能的失效形态不是误判而是**空转**（一条都没扫、恒绿），
 * 故把「实际判过几条」显式交给调用方断言，而不是让调用方从输入长度自证。
 */
export function mutationEntryProblems(root, confFileName, patterns, owner) {
  if (typeof owner !== "string" || owner === "") {
    return {
      problems: [
        `[${confFileName}] 判据缺少 owner（该 conf 所属包名）—— 锚定判据无从判定，fail-closed`,
      ],
      scanned: 0,
    };
  }
  const universe = sourceUniverse(root);
  const problems = [];
  const positive = new Set();
  const negative = new Set();
  let scanned = 0;
  let entryProblems = 0;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern === "") {
      problems.push(
        `[${confFileName}] mutate 条目不是非空字符串（fail-closed）：${JSON.stringify(pattern)}`,
      );
      entryProblems += 1;
      continue;
    }
    scanned += 1;
    // `!` 只是「本条进的是排除面」的语义标记，命中判据与正向条目同口径。
    const bare = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    const unanchored = unanchoredReason(owner, bare);
    if (unanchored !== null) {
      problems.push(`[${confFileName}] mutate 条目${unanchored}（判据⑤ 锚定）：${pattern}`);
      entryProblems += 1;
      continue;
    }
    // 命中面锚在**源码世界**：不锚的话 `packages/<pkg>/**` 会被同包构建产物 `lib/**` 满足
    // （实测 lib 字面命中 107 个文件），判据就变成「描述了另一个真实的世界」。
    const hits = globFiles(root, bare).filter((f) => universe.has(f));
    if (hits.length === 0) {
      problems.push(
        `[${confFileName}] mutate 条目腐烂：在源码世界内命中 0 个文件（判据⑤ 存在性）：${pattern}`,
      );
      entryProblems += 1;
      continue;
    }
    const escaped = hits.filter(
      (f) => !f.startsWith(`packages/${owner}/`) && !f.startsWith("shared/"),
    );
    if (escaped.length > 0) {
      problems.push(
        `[${confFileName}] mutate 条目命中了本包与 shared 之外的文件（${escaped.length} 个，如 ${escaped[0]}）` +
          `—— 字面前缀不足以证明锚定（判据⑤ 越界，兜底）：${pattern}`,
      );
      entryProblems += 1;
    }
    for (const hit of hits) (pattern.startsWith("!") ? negative : positive).add(hit);
  }
  if (entryProblems === 0) {
    const effective = [...positive].filter((hit) => !negative.has(hit));
    if (effective.length === 0) {
      problems.push(
        `[${confFileName}] 正向条目命中 ${positive.size} 个源码文件，按 ! 条目剔除后一个不剩` +
          `（! 条目去重命中 ${negative.size} 个）—— 该 conf 会派生出 0 个变异体，Stryker 对 0 mutant` +
          " 不报错（判据⑥ 有效面为空）：请收窄排除面",
      );
    }
  }
  return { problems, scanned };
}

/**
 * 从层定义投影一个包的测试面（纯函数，root 参数化以便测试注入 fixture 根）。
 * 返回 { testFiles, runFiles, layerFiles, excludedFiles, errors }，路径均为**仓库根相对 posix**。
 */
export function projectTestSurface(root, topologyDoc, pkgName) {
  const def = topologyDoc?.packages?.[pkgName];
  const empty = { testFiles: [], runFiles: [], layerFiles: {}, excludedFiles: [], errors: [] };
  if (def === undefined) {
    return {
      ...empty,
      errors: [`包未在变异拓扑登记：${pkgName} —— 源码覆盖与测试面登记都无法判定（fail-closed）`],
    };
  }
  // 形状不对（null / 数组 / 标量，或 segments 缺失/null/非对象）时不能直接读 def.testLayers：
  // 那是第二条与第三条裸解引用路径（#773 R4 复核实测 packages.<name>=null 抛栈、segments 缺失
  // 退化成「一堆 uncoveredSrcFiles 噪声」）。判词复用 mutation-topology.mjs 的包登记判据，
  // 一处定义、两处同源。
  const entryProblems = packageEntryProblems(def);
  if (entryProblems.length > 0) {
    return { ...empty, errors: entryProblems };
  }
  const layers = topologyDoc?.$testLayers;
  if (layers === undefined) {
    return { ...empty, errors: ["拓扑缺少 $testLayers（测试分层声明）—— 测试面无法派生"] };
  }
  const errors = [];
  const pkgDir = join(root, "packages", pkgName);
  const { mutationLayers, excludeLayers } = layerNames(layers);

  // ⓪ 充分性：必需层必须都在 mutationLayers 内，且不得被排除层覆盖
  collectSufficiencyErrors(errors, mutationLayers, excludeLayers);

  // ① runner 面：glob 全集（与 vitest include 同口径）
  const runFiles = expandGlob(pkgDir, RUN_TESTS_PATTERN).map((p) => relPosix(root, p));
  if (runFiles.length === 0) errors.push("runner 面零命中 —— 包内没有 test/ 下的 *.test.ts");

  // ② 各层实际命中文件
  const layerFiles = collectLayerFiles({
    root,
    pkgDir,
    layers,
    mutationLayers,
    excludeLayers,
    errors,
  });

  // ③ 逐层逐条豁免（键 = 层名，值 = { 仓库相对路径: 理由 }）
  const exemptions = mutationExemptions(def);
  collectExemptionErrors({ root, layerFiles, exemptions, errors });

  // ④ 变异面 = mutationLayers 命中 − 排除层 − 逐条豁免
  const { testFiles, excluded, explained } = collectMutationFace({
    layerFiles,
    mutationLayers,
    excludeLayers,
    exemptions,
    errors,
  });

  // ⑤ 登记完整性 ①：runner 面每个文件必须被「某一层」或「某条排除」解释
  collectUnattributedErrors(runFiles, explained, errors);

  return { testFiles, runFiles, layerFiles, excludedFiles: [...excluded].sort(), errors };
}

/** 层名清单：缺声明的层退化为空表，调用方据此走原有的 fail-closed 判据。 */
function layerNames(layers) {
  return {
    mutationLayers: layers.mutationLayers ?? [],
    excludeLayers: layers.mutationExcludeLayers ?? [],
  };
}

/** 包级逐条豁免登记；未声明 testLayers 的包等同于没有豁免。 */
function mutationExemptions(def) {
  return def.testLayers?.testMutationExemptions ?? {};
}

/** ⓪ 必需层必须在变异层内、且不得被排除层覆盖（#690 S2b 的充分性下限）。 */
function collectSufficiencyErrors(errors, mutationLayers, excludeLayers) {
  for (const required of REQUIRED_MUTATION_LAYERS) {
    if (!mutationLayers.includes(required)) {
      errors.push(
        `必需层 "${required}" 不在 $testLayers.mutationLayers 内 —— 变异面被静默削减（#690 S2b 充分性下限）`,
      );
    }
    if (excludeLayers.includes(required)) {
      errors.push(`必需层 "${required}" 同时出现在 mutationExcludeLayers 内 —— 声明自相矛盾`);
    }
  }
  if (mutationLayers.length === 0) errors.push("$testLayers.mutationLayers 为空 —— 变异面为零");
}

/** ② 逐层展开 glob 得层内文件表，并核对 mutationLayers / excludeLayers 引用的层都已定义。 */
function collectLayerFiles({ root, pkgDir, layers, mutationLayers, excludeLayers, errors }) {
  const layerFiles = {};
  for (const [layerName, pattern] of Object.entries(layers.layers ?? {})) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      errors.push(`层 "${layerName}" 的 glob 不是非空字符串：${JSON.stringify(pattern)}`);
      layerFiles[layerName] = [];
      continue;
    }
    const hits = expandGlob(pkgDir, pattern).map((p) => relPosix(root, p));
    layerFiles[layerName] = hits;
    // 只对 unit 层要求非空：unit 是每个包的必答项（新单元测试的默认落点）；
    // integration/client/e2e 是可选层，包内不存在该层是正常形态（如 lan-proxy 无集成层）。
    if (hits.length === 0 && layerName === "unit") {
      errors.push(
        `层 "unit"（glob=${pattern}）在本包零命中 —— 单元层是每个包的必答项，glob 写错或测试被误删`,
      );
    }
  }
  for (const layerName of [...mutationLayers, ...excludeLayers]) {
    if (layerFiles[layerName] === undefined)
      errors.push(`$testLayers 引用了未定义的层 "${layerName}"`);
  }
  return layerFiles;
}

/** ③ 逐层逐条豁免：层须已定义，条目须真实存在、带非空理由、且确实落在声明的层内。 */
function collectExemptionErrors({ root, layerFiles, exemptions, errors }) {
  for (const [layerName, entries] of Object.entries(exemptions)) {
    if (layerFiles[layerName] === undefined) {
      errors.push(`testMutationExemptions 引用了未定义的层 "${layerName}"`);
      continue;
    }
    for (const [rel, reason] of Object.entries(entries ?? {})) {
      errors.push(...exemptionEntryProblems({ root, layerName, rel, reason, layerFiles }));
    }
  }
}

function exemptionEntryProblems({ root, layerName, rel, reason, layerFiles }) {
  const problems = [];
  if (!existsSync(join(root, rel)))
    problems.push(`testMutationExemptions 指向不存在的文件：${rel}`);
  if (typeof reason !== "string" || reason.trim() === "")
    problems.push(`testMutationExemptions 的 ${rel} 缺少理由（必须写明为何不进变异面）`);
  if (!layerFiles[layerName].includes(rel))
    problems.push(
      `testMutationExemptions 的 ${rel} 不在 "${layerName}" 层内（层归属与豁免声明不一致）`,
    );
  return problems;
}

/** ④ 变异面 = mutationLayers 命中 − 排除层 − 逐条豁免；同时给出「被解释过」全集供 ⑤ 用。 */
function collectMutationFace({ layerFiles, mutationLayers, excludeLayers, exemptions, errors }) {
  const excluded = new Set();
  addLayerFiles(excluded, excludeLayers, layerFiles);
  for (const entries of Object.values(exemptions))
    for (const rel of Object.keys(entries ?? {})) excluded.add(rel);
  const inMutationLayers = new Set();
  addLayerFiles(inMutationLayers, mutationLayers, layerFiles);
  const testFiles = [...inMutationLayers].filter((f) => !excluded.has(f)).sort();
  if (testFiles.length === 0) errors.push("变异面零条目 —— 该包不会产生任何变异分（fail-closed）");
  return { testFiles, excluded, explained: new Set([...inMutationLayers, ...excluded]) };
}

/** 把若干层命中的文件并进目标集合；层未展开时按空表处理。 */
function addLayerFiles(target, layerNames, layerFiles) {
  for (const layerName of layerNames) for (const f of layerFiles[layerName] ?? []) target.add(f);
}

/** ⑤ 登记完整性 ①：runner 面每个文件必须被「某一层」或「某条排除」解释。 */
function collectUnattributedErrors(runFiles, explained, errors) {
  for (const f of runFiles) {
    if (!explained.has(f)) {
      errors.push(
        `测试文件无层归属：${f} —— 必须落入 $testLayers.layers 的某条 glob，或写进该包 testLayers.testMutationExemptions`,
      );
    }
  }
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
  const pkgJsonPath = join(root, "packages", pkgName, "package.json");
  if (!existsSync(pkgJsonPath)) return { path: pkgJsonPath, min: null };
  const m = readFileSync(pkgJsonPath, "utf8").match(/"test"\s*:\s*"node [^"]*--min (\d+)"/);
  return { path: pkgJsonPath, min: m === null ? null : Number(m[1]) };
}

/**
 * 磁盘上与测试面相关的包清单（#690 S2b：门禁必须遍历磁盘，而不是只遍历拓扑声明）。
 * 返回 { pkgName, runFiles } —— 只包含「存在 test/ 下 *.test.ts」的包；
 * dsh-plugins-all 这类聚合包天然没有测试目录，不进清单。
 */
export function discoverTestPackages(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const out = [];
  for (const entry of globSync("*/package.json", { cwd: packagesDir }).sort()) {
    const pkgName = dirname(entry);
    const runFiles = expandGlob(join(packagesDir, pkgName), RUN_TESTS_PATTERN);
    if (runFiles.length > 0) out.push({ pkgName, runFileCount: runFiles.length });
  }
  return out;
}
