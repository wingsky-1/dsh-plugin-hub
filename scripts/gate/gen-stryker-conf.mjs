#!/usr/bin/env node
/**
 * scripts/gate/gen-stryker-conf.mjs — Stryker 变异测试配置派生与门禁（#572 / #690 S2b）
 *
 * 核心设计（单一事实源 SSOT + 确定性代码生成 + 登记完整性门禁）：
 * 1. 唯一事实源：scripts/data/mutation-topology.json 的 `$testLayers` 与各包 `testLayers`。
 * 2. 派生目标：stryker.conf.d/*.json（全部段配置）+ vitest.stryker.d/<pkg>.config.ts
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
 *   node scripts/gate/gen-stryker-conf.mjs --check [--base <ref>]
 *                                                          # 门禁：磁盘一致 + 登记完整性 + --min 同步
 *                                                          #       + 包级变异面并集棘轮（基准默认 origin/main）
 *   node scripts/gate/gen-stryker-conf.mjs --sync-test-min # 把各包 `--min` 同步为实际文件数
 *
 * `--check` 的判据（#713 T3 + S2b 充分性下限）：
 *   ① 磁盘上有测试的每个包都必须在拓扑登记（漏登即红，不允许「没写进清单就逃逸」），
 *      且该包 `test/` 下每个 `*.test.ts` 都要有层归属；
 *   ② 每条派生 testFiles 与每条豁免条目在磁盘上真实存在；
 *   ③ 每个有测试的包（含未登记变异面的包）`--min` == runner glob 实际文件数；
 *   ④ 充分性：`$testLayers.mutationLayers` 必须含必需层（`test-surface.mjs` 的
 *      `REQUIRED_MUTATION_LAYERS`），且每包变异面非空——防「两行拓扑改动把变异面削掉」；
 *   ⑤ 条目腐烂与锚定（#836 / #848）：每份派生 conf 的每条 `mutate` 条目（含 `!` 排除条目）
 *      必须**锚定在本包（或 shared）**且在**源码世界内命中 ≥1 个文件**——防「排除条目指向一个
 *      从来不存在、也永远不会出现的路径」（历史上 26 份 conf 各带一条这样的 `src/types.ts` 占位，
 *      已由 #836 清除），也防「指向别的包的世界」：广域 glob 会命中他包同名文件而恒绿，
 *      `packages/<pkg>/**` 会被同包构建产物 `lib/**` 满足，字面前缀还能被 `..` 归一化与 brace 展开改写；
 *   ⑥ 有效面非空（#848 维护者评审）：每份 conf 的正向条目命中按 `!` 条目剔除后必须仍有剩余——
 *      ⑤ 只判**单条**条目，一条宽 glob（把某包「逐目录级的 interface.ts 排除」换成包根级整包通配）
 *      能在条数不变、⑤ 全绿的前提下清空整包变异面，而 Stryker 对 0 mutant 不报错（判分与门禁都静默）。
 *   ⑦ 包级变异面并集棘轮（#843 计划项 3-1）：与基准（`--base`，默认 `origin/main`）相比，
 *      同一个包的变异文件**并集**不得收缩。⑤/⑥ 都不看基准，于是「把 `src/config.ts` 从某段
 *      `mutate` 挪进**同段** `excludes` 再重生成 conf」逐条合法、有效面非空，stryker:check 与
 *      verify-dir-imports 双双 exit 0——文件静默退出变异面。判据与实现落在
 *      `mutation-topology.mjs` 的 `mutationFaceRatchetProblems`：段间挪动合法（并集不变）、
 *      文件真被删除算正当收缩、唯一放宽通道是 `scripts/data/gate-exemptions.json` 里
 *      `gate=mutation-face` 的条目；判据自带载体自证（进入比对面的包数 / 候选文件数任一为 0
 *      即判红而不是恒绿）。
 *
 * 环境变量 GEN_STRYKER_ROOT：仓库根覆盖（测试用临时 fixture 根，避免在仓库内造包目录）。
 * 环境变量 GEN_STRYKER_BASE：`--check` 的基准 ref 覆盖（等价于 `--base <ref>`）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLedger } from "../lib/exemption-gate.ts";
import { globFiles, sourceUniverse } from "../lib/glob-files.mjs";
import {
  MUTATION_FACE_GATE,
  collectCoverageExcludePatterns,
  coverageExcludeProblems,
  mutationFaceRatchetProblems,
  mutationPolicyProblems,
  mutationPolicyRatchetProblems,
  effectiveExcludedMutations,
  packageRegistrationProblems,
  segmentTestShapeProblems,
  segmentTestUnionProblems,
} from "./mutation-topology.mjs";
import {
  discoverTestPackages,
  mutationEntryProblems,
  projectTestSurface,
  readTestMin,
  resolveSegmentTestFiles,
  segmentTestUnion,
} from "./test-surface.mjs";
import { failClosed } from "../lib/gate-exit.mjs";

const repoRoot =
  process.env.GEN_STRYKER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOPOLOGY_REL = "scripts/data/mutation-topology.json";
const EXEMPTIONS_REL = "scripts/data/gate-exemptions.json";
const topologyPath = join(repoRoot, TOPOLOGY_REL);
const confDir = join(repoRoot, "stryker.conf.d");
const argv = process.argv.slice(2);
const isCheckMode = argv.includes("--check");
const isSyncMin = argv.includes("--sync-test-min");
/** 判据⑦ 的基准 ref（段面棘轮只与基准比，本地 pr 档与 CI 的默认口径同为 origin/main）。 */
const baseRef = argValue("--base") ?? process.env.GEN_STRYKER_BASE ?? "origin/main";

/** 取 `--flag <value>` / `--flag=<value>` 的参数值；未给出返回 undefined。 */
function argValue(flag) {
  const withEq = argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq !== undefined) return withEq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

/** 派生 vitest 测试面配置的目录（与 stryker.conf.d 并列，同为生成物、入库受 --check 校验）。 */
const VITEST_CONF_DIR = "vitest.stryker.d";

function vitestConfigPath(pkgName) {
  return `${VITEST_CONF_DIR}/${pkgName}.config.ts`;
}

/**
 * P2：段级测试面配置路径（显式段专用）。命名沿用 conf 名算法（D5）：`<pkg>-<seg>.config.ts`，
 * 故跨包拼名碰撞（包 a-b/段 c vs 包 a/段 b-c）与 conf 同理，须走同一碰撞检查。
 */
function vitestSegConfigPath(pkgName, segKey) {
  return `${VITEST_CONF_DIR}/${pkgName}-${segKey}.config.ts`;
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
  const include = testFiles.map((f) => `      '${f}',`).join("\n");
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
`;
}

/**
 * P2：segVitestFile = 该段的 vitest 测试面配置路径（fallback 段指向包级 config，
 * explicit 段指向段级 config）。conf 里永不出现 Stryker `testFiles`（#6144）。
 */
function deriveConfig(sharedDefaults, pkgName, segKey, segDef, pkgDef, segVitestFile) {
  const isSingle = segKey === "_single";
  const confFileName = isSingle ? `${pkgName}.json` : `${pkgName}-${segKey}.json`;
  const reportName = isSingle ? pkgName : `${pkgName}-${segKey}`;
  const shortPkg = pkgName.replace(/^dsh-/, "");
  const incrementalName = isSingle
    ? `incremental-${shortPkg}.json`
    : `incremental-${shortPkg}-${segKey}.json`;

  const mutate = [
    ...segDef.mutate,
    // 段 excludes 必填（#836）：形状判据已保证它是数组（可显式为空），故不再有缺省回退。
    ...segDef.excludes,
    // S0 覆盖断言的存量登记（#710 第二节 / #773 R4 起为 { pattern, reason, kind } 结构化条目）：
    // 门面/声明/资源/有意不度量四类。取值与断言侧同一份 collectCoverageExcludePatterns，
    // 生成器不自己拆条目；追加在段自身 excludes 之后，故不改变既有段的语义。
    ...collectCoverageExcludePatterns(pkgDef),
  ];

  const config = {
    $schema: "../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    mutate,
    testRunner: sharedDefaults.testRunner,
    mutator: {
      excludedMutations: effectiveExcludedMutations(sharedDefaults, pkgDef),
    },
    // runner 包名由 testRunner 派生，避免 SSOT（sharedDefaults.testRunner）与插件清单两处漂移。
    plugins: [`@stryker-mutator/${sharedDefaults.testRunner}-runner`],
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
    vitest: { ...sharedDefaults.vitest, configFile: segVitestFile },
    jsonReporter: {
      fileName: `coverage/mutation/${reportName}.json`,
    },
    incremental: true,
    incrementalFile: `coverage/mutation/${incrementalName}`,
  };

  if (segDef.comment) {
    config._comment = segDef.comment;
  }

  return { confFileName, content: JSON.stringify(config, null, 2) + "\n" };
}

/**
 * 全拓扑的形状问题：包登记本身（`packages.<name>` 必须是对象）与包级覆盖排除面
 * （`testLayers.coverageExcludes` 条目），逐条带包名前缀。
 *
 * 独立成函数而不是内联进 main：main 的认知复杂度已贴着 lint 阈值，形状判据不该再往它身上
 * 加嵌套分支；判词聚合是纯函数，也便于测试直接引用。两类问题合在一个入口，是为了让
 * "形状不对"只有一条判红通道——包登记为 null 时若先去读 `pkgDef.segments` 就是抛栈崩掉。
 */
function topologyShapeProblems(topology) {
  const problems = [...packageRegistrationProblems(topology), ...mutationPolicyProblems(topology)];
  for (const [pkgName, pkgDef] of Object.entries(topology.packages ?? {})) {
    for (const problem of coverageExcludeProblems(pkgDef)) {
      problems.push(`[${pkgName}] ${problem}`);
    }
    // P2：段 testFiles 形状（缺席/非法即红；存在性与成员资格在派生阶段判）。
    for (const [segKey, segDef] of Object.entries(pkgDef?.segments ?? {})) {
      problems.push(...segmentTestShapeProblems(pkgName, segKey, segDef));
    }
  }
  return problems;
}

/**
 * 阶段 1：磁盘上「有测试的包」 ↔ 拓扑登记的对账（判据 ①/② 的输入面）。
 * 为什么遍历磁盘而不是只遍历拓扑：漏登记的包必须能被发现，否则「不写进清单」就是逃逸口。
 * 两个方向都判：磁盘有而清单无（漏登）、清单有而磁盘无（登记条目指向空集）。
 */
/** 单个已登记包的面投影：投影结果 + 登记完整性 ② 判词（testFiles 条目必须真实存在）。 */
function projectRegisteredPackage(topology, pkgName) {
  const projection = projectTestSurface(repoRoot, topology, pkgName);
  const errors = projection.errors.map((e) => `[${pkgName}] ${e}`);
  for (const f of projection.testFiles) {
    if (!existsSync(join(repoRoot, f))) {
      errors.push(`[${pkgName}] 登记完整性 ②：testFiles 条目不存在于磁盘：${f}`);
    }
  }
  return { projection, errors };
}

/** 磁盘上有测试但清单未登记的判词（含「$noMutationPackages 也未说明理由」这一逃逸口）。 */
function missingRegistrationProblem(pkgName) {
  return (
    `[${pkgName}] 磁盘上有测试文件但未在 mutation-topology.json 登记` +
    "（也未在 $noMutationPackages 说明理由）—— 源码覆盖与测试面登记都无法判定（fail-closed）"
  );
}

function reconcileRegistrations(topology, packages, noMutationPackages) {
  const discovered = discoverTestPackages(repoRoot);
  const errors = [];
  const projections = new Map();
  for (const { pkgName } of discovered) {
    if (packages[pkgName] !== undefined) {
      const projected = projectRegisteredPackage(topology, pkgName);
      projections.set(pkgName, projected.projection);
      errors.push(...projected.errors);
    } else if (noMutationPackages[pkgName] === undefined) {
      errors.push(missingRegistrationProblem(pkgName));
    }
  }
  for (const pkgName of Object.keys(packages)) {
    if (!discovered.some((d) => d.pkgName === pkgName)) {
      errors.push(`[${pkgName}] 已在拓扑登记但磁盘上没有 test/ 下的 *.test.ts —— 登记条目指向空集`);
    }
  }
  return { discovered, errors, projections };
}

/**
 * 阶段 2：派生全部配置内容（stryker conf + 每包一份 vitest 测试面 config）。
 * `?? {}` 是纵深防御：形状判据（topologyShapeProblems）已在 main 入口拦下缺 segments 的登记，
 * 但派生函数被单独调用时不该再裸解引用。
 */
function deriveAllConfigs(packages, sharedDefaults, projections) {
  const derivedConfigs = new Map();
  const derivedVitestConfigs = new Map();
  // P2：段级测试面。fallback 段沿用包级面（行为零变），explicit 段派生段级 config。
  // fallback 计数打印给 --check（D3 收敛跟踪：全回落是合法过渡态，但必须可见）。
  const segmentTests = new Map();
  let fallbackSegments = 0;
  // conf 文件名 → 所属包：判据 ⑤ 的锚定与 ⑥ 的有效面都要知道「这份 conf 是谁的」，
  // 而 mutate 里的路径是仓库根相对的裸 glob，只有派生侧知道归属。
  const confOwners = new Map();
  // conf 名只由「包名 + 段名」决定（_single 段即 <pkg>.json），故不同包可能派生出同一个文件名。
  // 相撞时后写者会静默覆盖前者的内容——⑤/⑥ 与磁盘/拓扑一致性判据都看不到被覆盖的包
  // （独立复核实测：还输出「1 份配置 vs 2 份 vitest 配置」的自相矛盾）。故在派生侧 fail-closed。
  const confCollisions = [];
  // P2：段测试面解析（fallback 计数见 D3 收敛跟踪）。vitest 名碰撞与 conf 同算法（D5）。
  const vitestOwners = new Map();
  const vitestCollisions = [];
  for (const [pkgName, pkgDef] of Object.entries(packages)) {
    const packageFace = projections.get(pkgName)?.testFiles ?? [];
    const resolved = {};
    for (const [segKey, segDef] of Object.entries(pkgDef.segments ?? {})) {
      const r = resolveSegmentTestFiles({
        root: repoRoot,
        segDef,
        segLabel: `[${pkgName}:${segKey}]`,
        packageFace,
      });
      resolved[segKey] = r;
      let segVitestFile = vitestConfigPath(pkgName);
      if (r.mode === "explicit") {
        segVitestFile = vitestSegConfigPath(pkgName, segKey);
        derivedVitestConfigs.set(
          segVitestFile,
          deriveVitestConfig(`${pkgName}:${segKey}`, r.files),
        );
        const prev = vitestOwners.get(segVitestFile);
        if (prev !== undefined && prev !== pkgName) {
          vitestCollisions.push(
            `${segVitestFile} 同时由 ${prev} 与 ${pkgName} 派生 —— 包名与段名拼出的文件名相撞`,
          );
        }
        vitestOwners.set(segVitestFile, pkgName);
      } else if (r.mode === "fallback") {
        fallbackSegments++;
      }
      const { confFileName, content } = deriveConfig(
        sharedDefaults,
        pkgName,
        segKey,
        segDef,
        pkgDef,
        segVitestFile,
      );
      const previousOwner = confOwners.get(confFileName);
      if (previousOwner !== undefined && previousOwner !== pkgName) {
        confCollisions.push(
          `${confFileName} 同时由 ${previousOwner} 与 ${pkgName} 派生（段名 ${segKey}）—— ` +
            "包名与段名拼出的文件名相撞，前者的配置会被静默覆盖",
        );
      }
      derivedConfigs.set(confFileName, content);
      confOwners.set(confFileName, pkgName);
    }
    segmentTests.set(pkgName, resolved);
    if (packageFace.length > 0) {
      derivedVitestConfigs.set(vitestConfigPath(pkgName), deriveVitestConfig(pkgName, packageFace));
    }
  }
  return {
    derivedConfigs,
    derivedVitestConfigs,
    confOwners,
    confCollisions,
    segmentTests,
    fallbackSegments,
    vitestCollisions,
  };
}

/**
 * P2：段测试面解析错误聚合＋并集恒等（D2）。返回 { problems, unionCompared }：
 * problems 含各段 resolve 错误（存在性/R3/R6）与并集缺口/越界；unionCompared 为各包
 * 包级面条目数之和（0 即空转，调用方 fail-closed）。纯函数（输入均为已算好的投影与解析）。
 */
function collectSegmentTestProblems(segmentTests, projections) {
  const problems = [];
  let unionCompared = 0;
  for (const [pkgName, resolved] of segmentTests) {
    for (const r of Object.values(resolved)) {
      for (const e of r.errors) problems.push(`段测试面：${e}`);
    }
    const face = projections.get(pkgName)?.testFiles ?? [];
    const { problems: unionProblems, compared } = segmentTestUnionProblems({
      pkgName,
      packageFace: face,
      union: segmentTestUnion(resolved),
    });
    for (const p of unionProblems) problems.push(`测试面并集：${p}`);
    unionCompared += compared;
  }
  return { problems, unionCompared };
}

/** 阶段 3：判据 ③ 的差异集——每个有测试的包 `--min` 与实际 runner 面文件数必须相等。 */
function collectMinMismatches(discovered) {
  const minMismatches = [];
  for (const { pkgName, runFileCount } of discovered) {
    const { min } = readTestMin(repoRoot, pkgName);
    if (min !== runFileCount) minMismatches.push({ pkgName, min, actual: runFileCount });
  }
  return minMismatches;
}

/**
 * `--sync-test-min`：把各包 test 脚本的 `--min` 写为实际值。
 * 只跑 `--sync-test-min` 时也必须对「无法同步」判非零：否则调用方会把未同步当成已完成。
 */
function syncTestMin(minMismatches) {
  let synced = 0;
  let unsyncable = 0;
  for (const { pkgName, min, actual } of minMismatches) {
    if (min === null) {
      console.error(
        `[gen-stryker-conf] ${pkgName} 的 test 脚本缺少 \`--min <n>\`，无法自动同步 —— 请手工补上 --min ${actual}`,
      );
      unsyncable++;
      continue;
    }
    const pkgJsonPath = join(repoRoot, "packages", pkgName, "package.json");
    const raw = readFileSync(pkgJsonPath, "utf8");
    // 与 test-surface.mjs 的 readTestMin 共用同一契约：只锚 test 脚本里的 `--min <n>`，不绑 runner 名。
    writeFileSync(
      pkgJsonPath,
      raw.replace(/("test"\s*:\s*"node [^"]*--min )\d+/, `$1${actual}`),
      "utf8",
    );
    console.log(`[gen-stryker-conf] ${pkgName} --min ${min} → ${actual}`);
    synced++;
  }
  console.log(
    `[gen-stryker-conf] --min 同步完成：${synced} 个包${unsyncable > 0 ? `，${unsyncable} 个无法同步` : ""}`,
  );
  if (unsyncable > 0) process.exitCode = 1;
}

/** 文件集双向比对：派生有而磁盘无、磁盘有而派生无，两个方向都是漂移。 */
function fileSetProblems(derivedNames, diskNames, missingLabel, strayLabel) {
  const problems = [];
  for (const f of derivedNames.filter((x) => !diskNames.includes(x))) {
    problems.push(`${missingLabel}: ${f}`);
  }
  for (const f of diskNames.filter((x) => !derivedNames.includes(x))) {
    problems.push(`${strayLabel}: ${f}`);
  }
  return problems;
}

/**
 * 拓扑形状不合法时的判词（fail-closed 的第一道关）。两类形状错误都不该继续派生：
 * 包登记为 null 会让 `pkgDef.segments` 抛栈崩掉；覆盖排除条目形状不对会被取值函数跳过
 * （静默缩小判据面），而 `--check` 只会报「与拓扑派生不一致」——把形状错误误诊成同步问题。
 */
function reportShapeProblems(shapeProblems) {
  console.error(
    "[gen-stryker-conf] 拓扑形状不合法（包登记必须是对象；coverageExcludes 条目须写成" +
      " { pattern, reason, kind }：pattern 含 ! 前缀、reason 不少于 10 字、kind 取" +
      " COVERAGE_EXCLUDE_KINDS 之一）：\n" +
      shapeProblems.map((p) => `  ${p}`).join("\n"),
  );
}

/** 派生内容 ↔ 磁盘内容逐份严格比对（生成物入库，故不接受任何差异）。 */
function contentProblems(entries, dir, label) {
  const problems = [];
  for (const [file, expectedContent] of entries) {
    const filePath = join(dir, file);
    if (existsSync(filePath) && readFileSync(filePath, "utf8") !== expectedContent) {
      problems.push(`${label}与拓扑派生不一致: ${file} (请运行 pnpm stryker:gen 同步)`);
    }
  }
  return problems;
}

/**
 * conf 不得回退到 Stryker 顶层 `testFiles`：它是上游 #6144 的触发条件（static mutant 被判
 * runtime 激活 → 模块级变异体漏判）。派生内容比对已能拦住，此处显式点名以便定位。
 */
function topLevelTestFilesProblems(derivedConfigs) {
  const problems = [];
  for (const [file, content] of derivedConfigs.entries()) {
    if (JSON.parse(content).testFiles !== undefined) {
      problems.push(
        `${file} 出现了 Stryker 顶层 testFiles —— 该字段会触发上游 #6144（#722 方案 A 已迁至 vitest include）`,
      );
    }
  }
  return problems;
}

/**
 * 判据 ⑤（条目腐烂与锚定）+ ⑥（有效面非空）：判词与口径在 test-surface.mjs 的
 * `mutationEntryProblems`（唯一实现，这里只负责把它接到派生内容与包归属上）。
 *
 * 为什么逐份 conf 判：collectMutationSpecs 把同包所有段的 excludes 聚合成包级清单，
 * 段级幽灵条目会被同包另一段的同名命中掩盖——判红入口必须与「条目写在哪」同粒度。
 * 为什么判派生内容而不是磁盘 conf：派生内容是与拓扑严格比对的唯一事实；磁盘漂移已由
 * contentProblems 单独判红，此处再读磁盘只会把两种失败混成一条判词。
 */
function mutationEntryRotProblems(derivedConfigs, confOwners) {
  const problems = [];
  let scanned = 0;
  for (const [file, content] of derivedConfigs.entries()) {
    const judge = mutationEntryProblems(
      repoRoot,
      file,
      JSON.parse(content).mutate ?? [],
      confOwners.get(file),
    );
    problems.push(...judge.problems);
    scanned += judge.scanned;
  }
  return { problems, scanned };
}

/**
 * 基准 ref 是否可解析。必须先查它：`git show <ref>:<path>` 对「ref 不存在」与「路径不存在」
 * 都是非零退出，只看退出码会把写错的 ref 读成「基准上还没这个文件」而静默放行。
 * 与 scripts/gate/threshold-monotonic.mjs 的 refExists 同口径。
 */
function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** 读基准 ref 上的拓扑；失败返回 `{ error }`（调用方 fail-closed 到环境故障通道）。 */
function readBaseTopology(ref) {
  let text;
  try {
    text = execFileSync("git", ["show", `${ref}:${TOPOLOGY_REL}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return { error: `读取 ${ref}:${TOPOLOGY_REL} 失败：${String(err.message).split("\n")[0]}` };
  }
  try {
    return { topology: JSON.parse(text) };
  } catch (err) {
    return { error: `${ref}:${TOPOLOGY_REL} 不是合法 JSON：${String(err.message).split("\n")[0]}` };
  }
}

/** 判据⑦ 的豁免台账（唯一放宽通道；文件不存在 = 零豁免，与其余门禁同口径）。 */
function loadFaceExemptions() {
  const path = join(repoRoot, EXEMPTIONS_REL);
  return existsSync(path) ? loadLedger(path, MUTATION_FACE_GATE) : new Map();
}

/**
 * 判据⑦ 的执行：读基准拓扑 → 两侧都在**当前工作区源码世界**里展开 → 比包级并集。
 *
 * 展开口径与判据⑤ 同源（`globFiles` + `sourceUniverse`）：基准侧的条目也在 head 世界展开，
 * 于是「文件已在本分支删除」不会落进基准面——删除即正当收缩由这一条实现，而不是另加一个
 * 「文件是否存在」的判断点。
 *
 * 环境故障（基准 ref / 基准文件读不到、台账坏掉）走 `{ envError }`，由调用方落 exit 2：
 * 把「判据没跑起来」伪装成「有违规」会让这条红线贬值，而伪装成「通过」更糟。
 */
function faceRatchetCheck(topology) {
  if (!refExists(baseRef)) {
    return {
      envError:
        `基准 ref ${baseRef} 不可解析（fetch 了吗？可用 --base <ref> / GEN_STRYKER_BASE 覆盖）` +
        "—— 段面棘轮无法比对",
    };
  }
  const base = readBaseTopology(baseRef);
  if (base.error !== undefined) return { envError: base.error };
  let exemptions;
  try {
    exemptions = loadFaceExemptions();
  } catch (err) {
    return { envError: `豁免台账不可读（${EXEMPTIONS_REL}）：${err.message}` };
  }
  const universe = sourceUniverse(repoRoot);
  const expand = (pattern) => globFiles(repoRoot, pattern).filter((f) => universe.has(f));
  return {
    ...mutationFaceRatchetProblems({
      baseTopology: base.topology,
      headTopology: topology,
      expand,
      exemptions,
    }),
    operatorProblems: mutationPolicyRatchetProblems(base.topology, topology),
    baseRef,
  };
}

/**
 * `--check` 的全部判据：登记完整性 + 条目腐烂/锚定/有效面 + 磁盘 ↔ 派生一致（conf 与 vitest
 * 测试面两份生成物）。
 * 返回值带 `scanned`：判据 ⑤ 实际判过的 mutate 条目数，由调用方落进通过行——否则「一条都没扫」
 * 与「全扫过且全命中」在输出上完全一样。
 */
function checkModeProblems(ctx) {
  const { errors, minMismatches, derivedConfigs, derivedVitestConfigs, confOwners } = ctx;
  const rot = mutationEntryRotProblems(derivedConfigs, confOwners);
  const vitestDir = join(repoRoot, VITEST_CONF_DIR);
  const diskVitest = existsSync(vitestDir)
    ? readdirSync(vitestDir)
        .filter((f) => f.endsWith(".config.ts"))
        .map((f) => `${VITEST_CONF_DIR}/${f}`)
        .sort()
    : [];
  const diskConf = readdirSync(confDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const problems = [
    ...errors.map((e) => `登记完整性：${e}`),
    ...minMismatches.map(
      ({ pkgName, min, actual }) =>
        `登记完整性 ③：${pkgName} 的 --min ${min === null ? "缺失" : min} != 实际测试文件数 ${actual}` +
        " —— 请运行 node scripts/gate/gen-stryker-conf.mjs --sync-test-min 同步",
    ),
    ...fileSetProblems(
      [...derivedConfigs.keys()].sort(),
      diskConf,
      "磁盘缺少以下派生配置文件",
      "磁盘存在未在拓扑中定义的游离配置文件",
    ),
    ...contentProblems(derivedConfigs, confDir, "配置文件内容"),
    ...fileSetProblems(
      [...derivedVitestConfigs.keys()].sort(),
      diskVitest,
      "磁盘缺少派生的 vitest 测试面配置",
      "磁盘存在未在拓扑中定义的游离 vitest 配置",
    ),
    ...contentProblems(derivedVitestConfigs, repoRoot, "vitest 测试面配置"),
    ...topLevelTestFilesProblems(derivedConfigs),
    ...rot.problems,
  ];
  return { problems, scanned: rot.scanned };
}

/** `--check` 通过时的汇总行。`mutateEntriesScanned` 是判据 ⑤ 实际判过的条目数，
 *  `ratchet` 是判据⑦ 实际比过的包数 / 候选文件数——两条判据都自证「真的扫过」，而不是从输入长度自证。 */
function printCheckPassed(ctx, mutateEntriesScanned, ratchet) {
  const {
    derivedConfigs,
    derivedVitestConfigs,
    projections,
    packages,
    noMutationPackages,
    fallbackSegments,
    unionCompared,
  } = ctx;
  const totalFiles = [...projections.values()].reduce((n, p) => n + p.testFiles.length, 0);
  const skipNames = Object.keys(noMutationPackages).filter((k) => !k.startsWith("$"));
  const skipNote =
    skipNames.length > 0 ? `；按 $noMutationPackages 不登记变异面：${skipNames.join(", ")}` : "";
  console.log(
    `[gen-stryker-conf] --check 通过：${derivedConfigs.size} 份配置与拓扑严格一致；` +
      `${derivedVitestConfigs.size} 份 vitest 测试面配置（${VITEST_CONF_DIR}/）与拓扑严格一致；` +
      `${Object.keys(packages).length} 个包共 ${totalFiles} 个测试文件登记进变异面；` +
      `--min 与磁盘上 ${ctx.discovered.length} 个有测试的包全部同步；` +
      `${mutateEntriesScanned} 条 mutate 条目全部命中物理文件；` +
      `变异面并集棘轮对照 ${ratchet.baseRef} 比过 ${ratchet.packagesCompared} 个包 / ` +
      `${ratchet.filesCompared} 个候选文件，无收缩；` +
      `段测试面并集恒等比过 ${unionCompared} 个包级面条目；` +
      `显式回落 "*" 的段 ${fallbackSegments} 个（过渡态，可见即可）${skipNote}`,
  );
}

/** 默认模式：把派生内容写盘，并逐包回显面大小。 */
function writeDerivedConfigs(derivedConfigs, derivedVitestConfigs, projections) {
  for (const [file, content] of derivedConfigs.entries()) {
    writeFileSync(join(confDir, file), content, "utf8");
  }
  mkdirSync(join(repoRoot, VITEST_CONF_DIR), { recursive: true });
  for (const [file, content] of derivedVitestConfigs.entries()) {
    writeFileSync(join(repoRoot, file), content, "utf8");
  }
  console.log(
    `[gen-stryker-conf] 成功派生生成全部 ${derivedConfigs.size} 份 Stryker 配置文件至 stryker.conf.d/`,
  );
  console.log(
    `[gen-stryker-conf] 成功派生生成 ${derivedVitestConfigs.size} 份 vitest 测试面配置至 ${VITEST_CONF_DIR}/`,
  );
  for (const [pkgName, p] of projections) {
    console.log(
      `[gen-stryker-conf]   ${pkgName}: runner 面 ${p.runFiles.length} 个测试文件，变异面 ${p.testFiles.length} 个` +
        `（排除 client/e2e 层与逐条豁免共 ${p.excludedFiles.length} 个）`,
    );
  }
}

function main() {
  if (!existsSync(topologyPath)) {
    console.error(`[gen-stryker-conf] 拓扑文件不存在: ${topologyPath}`);
    return 1;
  }
  const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
  const { sharedDefaults, packages } = topology;
  // 未登记变异面但允许存在的包（如 dsh-verify-isolated 只有 e2e smoke）：必须逐条写明理由，
  // 且仍受判据 ③（--min 同步）约束——「不登记」不等于「不受门禁」。
  const noMutationPackages = topology.$noMutationPackages ?? {};

  // ── 0. 拓扑形状判据（fail-closed，任何模式都先过） ────────────────────
  const shapeProblems = topologyShapeProblems(topology);
  if (shapeProblems.length > 0) {
    reportShapeProblems(shapeProblems);
    return 1;
  }

  // ── 1–3. 登记对账 → 派生配置 → `--min` 差异（各阶段见上方同名函数） ──────
  const { discovered, errors, projections } = reconcileRegistrations(
    topology,
    packages,
    noMutationPackages,
  );
  const {
    derivedConfigs,
    derivedVitestConfigs,
    confOwners,
    confCollisions,
    segmentTests,
    fallbackSegments,
    vitestCollisions,
  } = deriveAllConfigs(packages, sharedDefaults, projections);
  if (confCollisions.length > 0) {
    console.error("[gen-stryker-conf] 派生的 conf 名碰撞（配置名只由包名 + 段名决定）：");
    for (const collision of confCollisions) console.error(`  ${collision}`);
    return 1;
  }
  if (vitestCollisions.length > 0) {
    console.error("[gen-stryker-conf] 派生的段级 vitest 名碰撞（D5，与 conf 同算法）：");
    for (const collision of vitestCollisions) console.error(`  ${collision}`);
    return 1;
  }
  const segTestCheck = collectSegmentTestProblems(segmentTests, projections);
  const minMismatches = collectMinMismatches(discovered);

  if (isSyncMin) syncTestMin(minMismatches);

  if (isCheckMode) {
    const ctx = {
      errors: [...errors, ...segTestCheck.problems],
      minMismatches,
      derivedConfigs,
      derivedVitestConfigs,
      confOwners,
      projections,
      packages,
      noMutationPackages,
      discovered,
      fallbackSegments,
      unionCompared: segTestCheck.unionCompared,
    };
    const check = checkModeProblems(ctx);
    // 判据⑦ 与上面各条独立：环境故障（基准 ref 读不到 / 台账坏）走 exit 2，不伪装成「有违规」。
    const ratchet = faceRatchetCheck(topology);
    if (ratchet.envError !== undefined) {
      failClosed(`[gen-stryker-conf] ${ratchet.envError} —— 环境故障按 fail-closed 处理`);
    }
    if (segTestCheck.unionCompared === 0) {
      check.problems.push(
        "测试面并集空转：所有包的包级变异面条目数之和为 0 —— 判据没有比到任何载体（fail-closed）",
      );
    }
    const problems = [...check.problems, ...ratchet.problems, ...ratchet.operatorProblems];
    for (const p of problems) console.error(`[gen-stryker-conf] ${p}`);
    if (problems.length > 0) {
      console.error(
        "[gen-stryker-conf] --check 失败：配置文件 / 测试面登记 / --min 与单一事实源脱节，" +
          "或变异面并集相对基准收缩",
      );
      return 1;
    }
    printCheckPassed(ctx, check.scanned, ratchet);
    return 0;
  }

  if (!isSyncMin) writeDerivedConfigs(derivedConfigs, derivedVitestConfigs, projections);
  return process.exitCode ?? 0;
}

// CLI 守卫：被测试 import 时（argv[1] 不是本文件）不得执行 main，也不会派生出任何写盘副作用。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
