/**
 * scripts/test/gate-wiring.test.ts — 门禁「接线」断言（审计 P0-1）。
 *
 * 为什么存在：同一条判据要同时活在 ci.yml 的 repo-gate 与本地档位计划里，而两者此前靠人工同步
 * （实测 12 项恒跑闸只有 1 项有真正的接线钉：注释掉 ci.yml 的 run 行，既有断言仍全绿）。
 *
 * 四族断言，缺一不可（判定逻辑在 scripts/lib/gate-wiring-lib.ts，有独立单测）：
 *   一致性——两侧现场派生「被执行的脚本身份」后双向比对，不维护全量登记表（登记表会退化成又一份
 *     需要同步的副本，而副本的修法永远是「改数据让测试变绿」）。
 *   覆盖性——一致性只是**相对**不变量（两侧同时删掉同一执行点后集合仍相等），绝对不变量只能拿
 *     磁盘上的判据全集比「全部 workflow ∪ 本地档位 ∪ lefthook」的执行点全集。
 *   形态——拦「执行点在、判据也在跑，但退出码到不了步骤」：判据步骤只允许**一条直接的判据命令**，
 *     设计如此的例外登记在 structuredSteps 并用**文本摘要**钉死；步骤与 job 的 if（stepIfs /
 *     jobIfs）逐字登记；有效 env 键（workflow ∪ job ∪ 步骤三层）逐键登记（stepEnvs）；shell 覆盖、
 *     continue-on-error、能改变执行环境的变量、命令引号配对与未登记步骤里的 `#` 硬红且**不设**登记出口；判据别名的
 *     展开必须干净、**指向**逐条登记（judgmentAliases）。
 *   PR 面覆盖（A14）——执行点全部落在非 PR 面（ci.yml 的**默认** PR 路径 job ∪ 本地 **pr** 档）的
 *     判据必须登记 nightly-only 或 tier-only：「这个判据的回归 PR 上拦不住」是一份显式清单。
 *
 * 台账（scripts/data/gate-wiring-exceptions.json）承载主台账与八张逐字登记表（structuredSteps /
 * stepIfs / stepEnvs / priorRunSteps / jobFaces / conditionInputs / jobIfs / judgmentAliases）。张力：主台账刻意只记「设计如此的不对称」，而这八张表就是
 * 全量登记表——「一个 job / 步骤会不会被静默关掉」「一条多命令步骤里还会发生什么」在一般情况下
 * 静态判不出（等于停机问题），登记制是唯一能把**静默开关变成 diff 里显眼一行**的手段。因此八张表
 * 自身也受守卫（悬空 / 预先登记 / 键唯一 / 理由 / 上限 / 摘要相符）——但「已登记」不等于「语义已守住」。
 *
 * 明确的边界（不留给读者猜）：
 *   - 扫描面：A6 / A6b / A6c / A13 / 台账守卫 = 全部 workflow × 全部 job（A13 另把「应扫集合」写成
 *     硬编码契约）；A9 只扫 ci.yml 的 repo-gate；A10 / A12 扫 package.json 的判据别名；A11 只扫
 *     contract-check.ts；lefthook 只进覆盖性，不进形态族。
 *   - 判据面（覆盖性 A8 的全集 G）：`JUDGMENT_DIRS` 列出的目录——`scripts/gate`（门禁本体与判据
 *     专用库）、`scripts/ci`（CI 切片执行位）、`scripts/release`（发布与基线监控执行位）、
 *     `tools`（lint 工具链入口）。口径 =「门禁系统的执行点全集（workflow ∪ 本地档位 ∪ lefthook）
 *     以路径字符串直接执行的脚本所在目录」；`scripts/lib`
 *     （只被 import 的共享库，删改会让 import 方在 tsc / node 解析上响亮失败）、`scripts/build`
 *     （只被各包 package.json 的 build 别名以路径字符串调用；执行点全集不含它——harness 未建模各包
 *     package.json 的别名展开，pnpm 别名只展开根 package.json，实测 0/4 有执行点。这是建模边界，
 *     不是「该目录没人执行」）、
 *     `scripts/maintenance`（README 明示按需手工执行）、`scripts/test`（自测面，执行者是 glob）
 *     不在面内。逐条理由与「收窄 / 放宽要同时改什么」写在 gateSources 的注释里。
 *   - 解析层按 bash 语义而不是裸正则：引号内的 `#` 不是注释（`$'…'` 与反引号一并建模）、`--packages` 的取值
 *     不进身份但它之后的 token 进（否则悬空 token 会把 `|| true` 藏起来）；`env` / `command` / `builtin` 前缀与
 *     `cd <dir> &&` 载体不改变被执行者。
 *   - 「语法上是一条依赖边」≠「目标判据会被执行」：可达库用的是静态具名 import + 名字被引用，严格
 *     判定需要调用图。
 *   - 台账 class 只核对「与当前事实相符」，不核对「这个不对称是否真的出自设计」——把单侧删除包装成
 *     tier-only / ci-only、把登记条件同步改掉，结构上与真实设计无法区分。
 *   - 判据别名有指向登记，**直调判据没有**：把两侧参数同时改掉不会触发任何断言（与别名同族，防疏忽
 *     定位下两处同改概率低，故接受）。
 *   - 环境面按**位置**取闭合集合（判据 job 里、最后一条判据步骤之前的非判据 run 步骤 + 该 job 的整份
 *     `uses:` 面 + job 级 `container` / `defaults`），不按「谁写了 `$GITHUB_ENV`」这类字样判——字样总能
 *     被绕开。边界随之明确：判据步骤**之后**的 run 步骤不登记（它影响不到已经在前面跑完的判据），此时
 *     新加一步仍是常规 diff。
 *   - 「换个环境 / 换个目录跑」都算环境面：job 级 `container`（镜像与 `container.env`）与 `defaults`
 *     整块进 jobFaces 摘要；判据步骤自己声明 `working-directory` 则不设登记出口（直接判红）。
 *   - 另一个步骤改写仓库文件、伪造产物、替换 `uses:` 指向的 action 本体，或直接改判据脚本自身：
 *     都等同「改判据」，不在本套断言的威胁模型内（它是**防漂移**门禁，不是对抗性守卫）。
 *   - 形态判据是**闭合 + 登记**而不是 shell 解释器：登记项内部仍按逐行启发式检查（吞码 / errexit /
 *     死分支 / 判据行控制操作符），启发式之外的可达性静态判不出——彻底闭合要么上 shell 解释器，要么
 *     改成受控 runner（每步只声明「跑哪个脚本 + 什么参数」），属下一批。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { computeCiMatrix } from "../ci/ci-matrix.mjs";
import { tierSteps } from "../gate/gate-steps.mjs";
import {
  dangerousStepEnv,
  disablesErrexit,
  embeddedExecutions,
  hasShellControlOperator,
  hasUnbalancedQuotes,
  leadingAssignmentNames,
  stripCdCarrier,
  endpointOf,
  endpointSet,
  extractJobIf,
  extractJobs,
  extractRunSteps,
  isSafeShellOverride,
  parseIssues,
  shellDefaults,
  stripDeadBranchCommands,
  stripLineComment,
  swallowsExitCode,
  yamlErrors,
} from "../lib/gate-endpoints.mjs";
// 判定逻辑全在库里（有 scripts/test/gate-wiring-lib.test.ts 的独立单测）；本文件只负责把库接到
// 真实仓库上——读哪几个文件、跑哪几档、拿哪些目录当根。
import {
  collectExecutionPoints,
  conditionInputFaceOf,
  coveredGatePaths,
  importedGateTargets,
  isConstantCondition,
  isDeadCondition,
  isJudgment,
  jobFaceOf,
  judgmentKeysIn,
  priorRunStepsOf,
  spawnTargets,
  stepDigest,
  stepsOf,
  stripExt,
  walkRepo as walkRepoAt,
  type Endpoint,
  type PlanStep,
  type StepShape,
} from "../lib/gate-wiring-lib.ts";

type ExceptionEntry = {
  endpoint: string;
  class: string;
  reason: string;
  condition?: string;
  via?: string;
};

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).scripts;
const CI_YML = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
/**
 * 全部 workflow 的文本：**形态判据**的扫描面。
 * 为什么不是只有 ci.yml：判据并不只活在 repo-gate——observe 的夜间班次、release 的发布链路、
 * baseline-overlay 与 health-report 各有一批直接步骤，只看一个 job 时它们能被随意写成吞码形态。
 */
const WORKFLOW_TEXTS = new Map(
  readdirSync(join(ROOT, ".github", "workflows"))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => [f, readFileSync(join(ROOT, ".github", "workflows", f), "utf8")]),
);
const LEDGER = JSON.parse(
  readFileSync(join(ROOT, "scripts", "data", "gate-wiring-exceptions.json"), "utf8"),
) as {
  maxExceptions: number;
  maxStructuredSteps: number;
  maxStepIfs: number;
  maxJobIfs: number;
  maxJudgmentAliases: number;
  exceptions: ExceptionEntry[];
  structuredSteps: { step: string; digest: string; reason: string }[];
  stepIfs: { step: string; condition: string; reason: string }[];
  maxStepEnvs: number;
  stepEnvs: { step: string; keys: string[] }[];
  maxPriorRunSteps: number;
  priorRunSteps: { step: string; digest: string; envKeys: string[] }[];
  maxJobFaces: number;
  jobFaces: { job: string; digest: string }[];
  maxConditionInputs: number;
  conditionInputs: {
    step: string;
    digest: string;
    inputsDigest?: string;
    producersDigest?: string;
    reason?: string;
  }[];
  jobIfs: { job: string; condition: string; reason: string }[];
  judgmentAliases: { alias: string; endpoint: string }[];
};
const EXCEPTIONS: ExceptionEntry[] = LEDGER.exceptions;
const STRUCTURED_STEPS = LEDGER.structuredSteps;
const STEP_IFS = LEDGER.stepIfs;
const STEP_ENVS = LEDGER.stepEnvs;
const PRIOR_RUN_STEPS = LEDGER.priorRunSteps;
const JOB_FACES = LEDGER.jobFaces;
const CONDITION_INPUTS = LEDGER.conditionInputs;
const JOB_IFS = LEDGER.jobIfs;
const JUDGMENT_ALIASES = LEDGER.judgmentAliases;

const exceptionKeys = new Set(EXCEPTIONS.map((e) => e.endpoint));

/**
 * 产物闸的清单：**刻意的硬编码契约**。
 * 退役 / 改名 / 合并其中任一条都要同时改这里与 A9，且这个改动会出现在 diff 里——这正是想要的：
 * 「产物闸只剩一种口径」比「清单多了一项」危险得多。A8 也拿它当载体自证的锚点。
 */
const ARTIFACT_GATES = [
  "scripts/gate/contract-check.ts",
  "scripts/gate/pack-check.ts",
  "scripts/gate/verify-npm-layout.ts",
];

test("产物门禁显式接入 catalog peer 成员与产物校验", () => {
  for (const file of ["scripts/gate/pack-check.ts", "scripts/gate/verify-npm-layout.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(text, /checkMaterializedCatalogPeers/);
    assert.match(text, /manifest\.dshPeerContracts\[p\]/);
  }
});

/** 本地某一档实际会执行的命令行（原样，未经归一）。 */
function planCommands(tier: string): string[] {
  const { allPackages } = computeCiMatrix({ env: {} });
  const plan = tierSteps(tier, {
    hitPackages: allPackages,
    withCoverage: false,
    base: "origin/main",
    scopeLabel: "全仓口径",
  }) as PlanStep[];
  return plan.map((s) => [s.cmd ?? "pnpm", ...s.args].join(" "));
}

/** 本地某一档的判据端点集合。 */
function localEndpoints(tier: string): Map<string, Endpoint> {
  return endpointSet(planCommands(tier), SCRIPTS);
}

/** 从一批命令行里取「被判据执行的脚本路径」（含进程替换里的执行位）。 */
function scriptPathsOf(commands: string[]): Set<string> {
  const out = new Set<string>();
  for (const cmd of commands) {
    const ep = endpointOf(cmd, SCRIPTS);
    if (ep !== null && ep.kind === "script") out.add(ep.id.split("|")[0]);
    for (const path of embeddedExecutions(cmd)) out.add(path);
  }
  return out;
}

/**
 * ci.yml 里跑在**默认 PR 路径**上的 job。
 *
 * 不取「ci.yml 的全部 job」：`coverage` 只在打 `gate:full` 标签时实例化，把它算作 PR 面会留一个反向
 * 漏洞（把判据挪进 coverage job 就成了「已进 PR 面」）。判据取自 jobIfs 台账的条件原文。
 */
function prFaceJobs(): string[] {
  const conditions = new Map(
    JOB_IFS.map((j) => [j.job.split("|").slice(1).join("|"), j.condition]),
  );
  return extractJobs(CI_YML).filter((job) => {
    const cond = conditions.get(job);
    return cond === undefined || !cond.includes("fullGate");
  });
}

/**
 * 一个 workflow 里**活的**执行命令行：跳过「job 级条件恒假」的整个 job 与「步骤级条件恒假」的步骤。
 *
 * 为什么必须过滤：否则加一个 `if: false` 的 decoy 步骤就能同时骗过覆盖性与 PR 面覆盖——判据被删光
 * 了却被认为还有执行点（对抗复查实测的通用配方）。
 */
function liveCommands(yaml: string, file: string, jobs: string[]): string[] {
  const out: string[] = [];
  for (const job of jobs) {
    if (isDeadCondition(extractJobIf(yaml, job))) continue;
    for (const step of stepsOf(yaml, file, job, SCRIPTS)) {
      if (isDeadCondition(step.ifCond)) continue;
      out.push(...step.cmds);
    }
  }
  return out;
}

/** **默认 PR 路径**上的 CI job 的**活**执行点路径（不只是 repo-gate）。 */
function ciAllPaths(): Set<string> {
  return scriptPathsOf(liveCommands(CI_YML, "ci.yml", prFaceJobs()));
}

/** 本地档位的执行点路径（默认 pr ∪ full）。 */
function localPaths(tiers: string[] = ["pr", "full"]): Set<string> {
  const out = new Set<string>();
  for (const tier of tiers) {
    for (const key of localEndpoints(tier).keys()) {
      if (key.startsWith("script:")) out.add(key.slice("script:".length).split("|")[0]);
    }
  }
  return out;
}

/** ci.yml 某个 job 的判据端点集合。 */
function ciEndpoints(job: string): Map<string, Endpoint> {
  return endpointSet(
    extractRunSteps(CI_YML, job).map((s) => s.cmd),
    SCRIPTS,
  );
}

const judgmentKeys = (set: Map<string, Endpoint>): string[] =>
  [...set.keys()].filter(isJudgment).sort();
const diff = (a: string[], b: string[]): string[] => a.filter((k) => !b.includes(k));

/**
 * 台账按**脚本路径**匹配，而不是完整身份。
 * 身份自本批起带判据面摘要（`scripts/gate/x.mjs|--soft,dsh-y`），若台账跟着带摘要，「给判据
 * 加一个无害 flag」就会让整条台账集体悬空——那是误红，而误红的代价是台账被当成噪音删掉。
 * 这几类语义（indirect / ci-only / tier-only / nightly-only）都是按脚本成立的。
 */
const ledgerKey = (key: string): string =>
  key.startsWith("script:") ? "script:" + key.slice("script:".length).split("|")[0] : key;

/** 仓库内遍历的便捷形态（根固定为仓库根；实现在库里，复用 walk-files 的单一遍历）。 */
const walkRepo = (dir: string, predicate: (name: string) => boolean): string[] =>
  walkRepoAt(ROOT, dir, predicate);

/**
 * 一个判据别名在仓库里的**出处**（`pnpm <别名>` 的写法）。
 *
 * `indirect` 的 `via: "package.json"` 原先只核对「有别名指向目标脚本」——那只证明入口存在，不证明
 * 有人走入口：登记一条 indirect + 写一条谁都不执行的别名就是一条**假接线**。出处分两类：可执行面
 * （workflow / lefthook 剥注释后匹配、package.json 的 script 展开文本）与写明人类入口的文档。
 * 台账自身不算出处，否则条目里的理由文本会自证成立。已知边界：文档侧仍是**提及级**判定——它排除
 * 「谁都没提到」，不证明「一定有人跑」。
 */
function aliasCitations(alias: string): string[] {
  const pattern = new RegExp(
    `pnpm\\s+(?:exec\\s+)?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
  const cited: string[] = [];
  // 「会真的执行它的地方」按**可执行面**判定：workflow 与 lefthook 先剥注释再匹配，package.json
  // 只看 script 的展开文本。在注释里写一句 `pnpm gate:pr` 不算出处——那正是「谁都没提到」与
  // 「有人真的会跑」的分界。
  const executable = [
    ...[...WORKFLOW_TEXTS.keys()].map((f) => ".github/workflows/" + f),
    "lefthook.yml",
  ];
  for (const file of executable) {
    const text = readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => stripLineComment(line))
      .join("\n");
    if (pattern.test(text)) cited.push(file);
  }
  const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (Object.values(parsed.scripts ?? {}).some((v) => pattern.test(String(v)))) {
    cited.push("package.json");
  }
  // 文档按**提及**算出处：本地档位的入口本来就是给人敲的，没有别的自动化执行者。
  const docs = [
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    "scripts/README.md",
    ...walkRepo("docs", (n) => n.endsWith(".md")),
    ...walkRepo(".dsh/skills", (n) => n.endsWith(".md")),
    ...walkRepo("agents", (n) => n.endsWith(".md")),
  ].filter((f) => existsSync(join(ROOT, f)));
  for (const file of docs) {
    if (pattern.test(readFileSync(join(ROOT, file), "utf8"))) cited.push(file);
  }
  return cited;
}

// ---------------------------------------------------------------- 一、归一 helper

test("endpoint：pnpm 别名与脚本直调归一到同一身份（两侧形态不同、语义相同）", () => {
  assert.deepEqual(endpointOf("pnpm verify:vendored-binaries", SCRIPTS), {
    kind: "script",
    id: "scripts/gate/verify-vendored-binaries.mjs",
  });
  assert.deepEqual(endpointOf("node scripts/gate/verify-vendored-binaries.mjs", SCRIPTS), {
    kind: "script",
    id: "scripts/gate/verify-vendored-binaries.mjs",
  });
  assert.deepEqual(endpointOf("pnpm test:src-tests", SCRIPTS), {
    kind: "script",
    id: "scripts/gate/forbid-src-tests.mjs",
  });
});

test("endpoint：tool / pkg-filter / shell / unknown 分类互不混淆", () => {
  assert.deepEqual(endpointOf("pnpm format:check", SCRIPTS), {
    kind: "tool",
    id: "prettier|--check,.",
  });
  assert.deepEqual(endpointOf("node --test scripts/test/*.test.ts", SCRIPTS), {
    kind: "tool",
    id: "node:test|--test,scripts/test/*.test.ts",
  });
  assert.deepEqual(endpointOf("pnpm --filter ./packages/x --if-present test", SCRIPTS), {
    kind: "pkg-filter",
    id: "pnpm:flags",
  });
  assert.deepEqual(endpointOf("set -e", SCRIPTS), { kind: "shell", id: "set" });
  assert.deepEqual(endpointOf('STAGING="/tmp/x"', SCRIPTS), {
    kind: "shell",
    id: "shell:statement",
  });
  assert.deepEqual(endpointOf("pnpm $FILTERS build", SCRIPTS), {
    kind: "shell",
    id: "pnpm:variable",
  });
  assert.equal(endpointOf("some-unknown-thing --x", SCRIPTS)?.kind, "unknown");
});

test("endpoint：tool 身份带判据面摘要，收窄扫描对象不再静默等价", () => {
  // 复核实测的两条旁路：(1) 把 test:scripts 换成单文件；(2) 加一个 --test-name-pattern 把用例
  // 全过滤掉（运行期 0 断言、exit 0）。摘要因此收**全部 token**而不只是路径样操作数——能改变
  // 「跑哪些用例」或「降级为不判红」（如 --soft）的写法列举不完，宁可要求对两侧的形式差异写一条
  // 显式登记，也不留一个静默放行的开关。
  assert.notDeepEqual(
    endpointOf("node --test scripts/test/*.test.ts", SCRIPTS),
    endpointOf("node --test scripts/test/gate-wiring.test.ts", SCRIPTS),
    "收窄 glob 必须改变身份",
  );
  // 同一个二进制的两次调用因此不再塌缩成一个身份——这是 B2 扩大扫描面后仍能区分口径的前提。
  // #769 起 cov 面含客户端两层（client-unit / client-dom）——id 变化本身就是登记：
  // 改了跑哪些 project 就会打红这里，逼着改的人显式确认「覆盖率分母变了」。
  assert.deepEqual(endpointOf("pnpm cov", SCRIPTS), {
    kind: "tool",
    id: "vitest|--coverage,--project,client-dom,client-unit,integration,run,unit",
  });
  assert.deepEqual(endpointOf("pnpm test:contract", SCRIPTS), {
    kind: "tool",
    id: "vitest|--project,contract,run",
  });
  assert.notDeepEqual(
    endpointOf("node --test scripts/test/*.test.ts", SCRIPTS),
    endpointOf("node --test --test-name-pattern 'zzz-nope' scripts/test/*.test.ts", SCRIPTS),
    "过滤用例的 flag 必须改变身份（否则运行期 0 断言而断言全绿）",
  );
  assert.notDeepEqual(
    endpointOf("node scripts/gate/verify-dir-imports.mjs --package dsh-provider-usage", SCRIPTS),
    endpointOf(
      "node scripts/gate/verify-dir-imports.mjs --package dsh-provider-usage --soft",
      SCRIPTS,
    ),
    "把硬判降级为软报告的 flag 必须改变身份",
  );
});

test("endpoint：shell 控制关键字之后的执行位仍算执行点（ci.yml 的 if node 形态）", () => {
  // ci.yml:586 是 `if node scripts/gate/mutation-gate.mjs "$pkg"; then`：判据确实在跑，但命令
  // 首词是 if，按首词归类会把它算成脚手架，于是它在执行点全集里彻底消失。
  assert.deepEqual(endpointOf('if node scripts/gate/mutation-gate.mjs "$pkg"; then', SCRIPTS), {
    kind: "script",
    id: "scripts/gate/mutation-gate.mjs|$pkg",
  });
  // 反向：剥掉关键字后不是执行点的，仍必须留在脚手架类，不得被误升成执行点。
  assert.deepEqual(endpointOf('if [ "$FULL_GATE" = "true" ]; then', SCRIPTS), {
    kind: "shell",
    id: "if",
  });
  assert.deepEqual(endpointOf('for dir in "$STAGING"/pkg-*; do', SCRIPTS), {
    kind: "shell",
    id: "for",
  });
});

test("endpoint：脚本身份锚在执行位置，参数里的同名路径不算执行点", () => {
  // ci.yml 里有一条 FILTERS=$(node -e "…import('…/script-test-prereqs.mjs')…")：路径出现在
  // 字符串参数里，是数据引用而非执行入口，不能被算成一个端点。
  const prereq = extractRunSteps(CI_YML, "repo-gate")
    .map((s) => s.cmd)
    .find((c) => c.includes("script-test-prereqs.mjs"));
  assert.ok(prereq, "前提：ci.yml 应存在一条引用 script-test-prereqs.mjs 的 run 行");
  assert.notEqual(endpointOf(prereq, SCRIPTS)?.kind, "script", "参数里的路径不是执行入口");
});

test("stripLineComment：剥行尾注释但不误伤命令内的 #issue", () => {
  assert.equal(stripLineComment("run: pnpm lint  # 注释"), "run: pnpm lint");
  assert.equal(stripLineComment("node x.mjs --issue '#42'"), "node x.mjs --issue '#42'");
});

test("extractRunSteps：单行 run、run 块内逐行、块内注释、if 与 continue-on-error", () => {
  const yaml = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        if: github.event_name == 'pull_request'",
    "        run: pnpm lint",
    "      - name: B",
    "        continue-on-error: true",
    "        run: |",
    "          set -e",
    "          # 说明性注释不是命令",
    "          node scripts/gate/verify-vendored-binaries.mjs",
    "  other:",
    "    steps:",
    "      - run: pnpm nope",
    "",
  ].join("\n");
  const steps = extractRunSteps(yaml, "demo");
  assert.deepEqual(
    steps.map((s) => s.cmd),
    ["pnpm lint", "set -e", "node scripts/gate/verify-vendored-binaries.mjs"],
  );
  assert.equal(steps[0].ifCond, "github.event_name == 'pull_request'");
  assert.equal(steps[2].continueOnError, true);
  assert.equal(steps[2].ifCond, null);
});

// ---------------------------------------------------------------- 二、两侧接线

// 例外只在**方向相符**时才豁免：一条 class 乱填的例外不能同时洗掉两个方向。
// 复核实测过的绕过是「加一条 infra 就能消掉任意单侧缺失」——按方向取 class 后，
// 「本地有、CI 无」只认 tier-only/infra，「CI 有、本地无」只认 ci-only/infra。
const exemptionsFor = (classes: string[]): string[] =>
  EXCEPTIONS.filter((e) => classes.includes(e.class)).map((e) => e.endpoint);

test("接线：本地 pr 档的判据端点在 CI repo-gate 都有执行点", () => {
  const local = judgmentKeys(localEndpoints("pr"));
  const ci = judgmentKeys(ciEndpoints("repo-gate"));
  const allowed = new Set([...ci, ...exemptionsFor(["infra", "tier-only"])]);
  assert.deepEqual(diff(local, [...allowed]), [], "本地判据在 CI 无执行点且未登记方向相符的例外");
});

test("接线：CI repo-gate 的判据端点在本地档位都有执行点", () => {
  const ci = judgmentKeys(ciEndpoints("repo-gate"));
  const localAll = new Set([
    ...judgmentKeys(localEndpoints("pr")),
    ...judgmentKeys(localEndpoints("full")),
  ]);
  const allowed = new Set([...localAll, ...exemptionsFor(["infra", "ci-only"])]);
  assert.deepEqual(diff(ci, [...allowed]), [], "CI 判据在本地无执行点且未登记方向相符的例外");
});

test("接线：本地 pr 档必须含 full 档的全部判据端点（差额按 tier-only 显式登记）", () => {
  // 删除原 local-gate-steps.test.ts 的三条「pr 档必须含某某闸」断言时，这一维没有交接给新断言：
  // A2 的本地侧取 pr ∪ full 的并集，于是「pr 缺、full 有」落进允许集——把阈值单调性闸从
  // collectPrTierSteps 里 filter 掉，全套 24 条仍全绿而 pr 档静默少一条判据（复核实测）。
  // 不重述清单：full 的判据面必须被 pr 覆盖，差额只能显式登记为 tier-only。
  const pr = new Set(judgmentKeys(localEndpoints("pr")).map(ledgerKey));
  const allowed = new Set([...pr, ...exemptionsFor(["tier-only"]).map(ledgerKey)]);
  const missing = judgmentKeys(localEndpoints("full")).filter((k) => !allowed.has(ledgerKey(k)));
  assert.deepEqual(missing, [], "full 档有、pr 档没有且未登记 tier-only：PR 面的判据被单侧摘掉");
});

test("接线：未分类端点（unknown / alias）必须显式登记，不得静默脱管", () => {
  const unclassified = [
    ...localEndpoints("pr").values(),
    ...localEndpoints("full").values(),
    ...ciEndpoints("repo-gate").values(),
  ]
    .filter((e) => e.kind === "unknown" || e.kind === "alias")
    .map((e) => `${e.kind}:${e.id}`)
    .filter((key) => !exceptionKeys.has(key));
  assert.deepEqual(
    [...new Set(unclassified)],
    [],
    "出现无法归一的端点：必须登记到 gate-wiring-exceptions.json 或修正解析",
  );
});

function checkLedgerCeilings(): void {
  const STEP_CEILING = 12;
  const STEP_IF_CEILING = 8;
  const STEP_ENV_CEILING = 20;
  const PRIOR_RUN_STEP_CEILING = 36;
  const JOB_FACE_CEILING = 24;
  const CONDITION_INPUT_CEILING = 6;
  const JOB_IF_CEILING = 10;
  const ALIAS_CEILING = 30;
  assert.ok(
    typeof LEDGER.maxStructuredSteps === "number" && LEDGER.maxStructuredSteps <= STEP_CEILING,
    "maxStructuredSteps 必须存在且不超过测试内硬顶 " + STEP_CEILING,
  );
  assert.ok(
    typeof LEDGER.maxJobIfs === "number" && LEDGER.maxJobIfs <= JOB_IF_CEILING,
    "maxJobIfs 必须存在且不超过测试内硬顶 " + JOB_IF_CEILING,
  );
  assert.ok(
    STRUCTURED_STEPS.length <= LEDGER.maxStructuredSteps,
    "结构化步骤条数超过上限：形态例外在膨胀，说明它在被当成消红工具",
  );
  assert.ok(JOB_IFS.length <= LEDGER.maxJobIfs, "job 级 if 登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxStepIfs === "number" && LEDGER.maxStepIfs <= STEP_IF_CEILING,
    "maxStepIfs 必须存在且不超过测试内硬顶 " + STEP_IF_CEILING,
  );
  assert.ok(STEP_IFS.length <= LEDGER.maxStepIfs, "步骤级 if 登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxStepEnvs === "number" && LEDGER.maxStepEnvs <= STEP_ENV_CEILING,
    "maxStepEnvs 必须存在且不超过测试内硬顶 " + STEP_ENV_CEILING,
  );
  assert.ok(STEP_ENVS.length <= LEDGER.maxStepEnvs, "判据步骤 env 键登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxPriorRunSteps === "number" &&
      LEDGER.maxPriorRunSteps <= PRIOR_RUN_STEP_CEILING,
    "maxPriorRunSteps 必须存在且不超过测试内硬顶 " + PRIOR_RUN_STEP_CEILING,
  );
  assert.ok(PRIOR_RUN_STEPS.length <= LEDGER.maxPriorRunSteps, "前序步骤登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxJobFaces === "number" && LEDGER.maxJobFaces <= JOB_FACE_CEILING,
    "maxJobFaces 必须存在且不超过测试内硬顶 " + JOB_FACE_CEILING,
  );
  assert.ok(JOB_FACES.length <= LEDGER.maxJobFaces, "job 执行面登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxConditionInputs === "number" &&
      LEDGER.maxConditionInputs <= CONDITION_INPUT_CEILING,
    "maxConditionInputs 必须存在且不超过测试内硬顶 " + CONDITION_INPUT_CEILING,
  );
  assert.ok(CONDITION_INPUTS.length <= LEDGER.maxConditionInputs, "条件输入登记条数超过上限");
  assert.ok(
    typeof LEDGER.maxJudgmentAliases === "number" && LEDGER.maxJudgmentAliases <= ALIAS_CEILING,
    "maxJudgmentAliases 必须存在且不超过测试内硬顶 " + ALIAS_CEILING,
  );
  assert.ok(
    JUDGMENT_ALIASES.length <= LEDGER.maxJudgmentAliases,
    "判据别名登记条数超过上限：指向表在膨胀",
  );
}
function checkStepDigest(
  entry: { step: string; digest: unknown },
  actual: Map<string, { cmds: string[]; rawLines: string[] }>,
  cmds: string[] | undefined,
): string[] {
  const bad: string[] = [];
  const digest = cmds === undefined ? null : stepDigest(actual.get(entry.step)?.rawLines ?? []);
  if (digest !== null && entry.digest !== digest) {
    bad.push(`${entry.step} 的步骤文本与登记摘要不符（现场 ${digest}）：登记即钉住这段文本`);
  }
  if (typeof entry.digest !== "string" || !/^[0-9a-f]{16}$/.test(entry.digest)) {
    bad.push(entry.step + " 缺 digest（16 位十六进制）");
  }
  return bad;
}
function checkStepEntry(
  entry: { step: string; reason: unknown; digest: unknown },
  actual: Map<string, { cmds: string[]; rawLines: string[] }>,
): string[] {
  const bad: string[] = [];
  const cmds = actual.get(entry.step)?.cmds;
  if (cmds === undefined) {
    bad.push(entry.step + " 悬空：没有任何 workflow 的判据步骤与这个键相符");
  } else if (cmds.length < 2) {
    // 登记表的用途是「给设计如此的复杂形态开口子」。若被登记的步骤本来就是闭合单命令，
    // 这条登记等于提前把口子开好——之后往该步骤里加一行（exit 0 / set +e）不再有任何阻力。
    bad.push(entry.step + " 登记为形态例外，但它已是闭合单命令：预先登记等于给将来的放宽留后门");
  }
  if (typeof entry.reason !== "string" || entry.reason.length < 10)
    bad.push(entry.step + " 缺理由（下一个读者无法判断它是否仍然成立）");
  // 摘要钉死：步骤键只锁住「这一步有哪些判据」，脚手架行不进键——一行 `break` / `continue`
  // 就能把循环里剩下的判据悄悄跳过而键、执行点、两侧身份全不变（对抗复核实测全绿）。
  // 登记多命令步骤的意义本就是「把这段文本钉住」，故摘要缺失或对不上都判红；报错里带上
  // 现场值，改动者复制过去即完成一次显式更新。
  bad.push(...checkStepDigest(entry, actual, cmds));
  return bad;
}
function checkDupStepsA(): string[] {
  const bad: string[] = [];
  if (new Set(STRUCTURED_STEPS.map((s) => s.step)).size !== STRUCTURED_STEPS.length)
    bad.push("structuredSteps 有重复登记");
  if (new Set(STEP_IFS.map((s) => s.step)).size !== STEP_IFS.length) bad.push("stepIfs 有重复登记");
  if (new Set(JOB_IFS.map((j) => j.job)).size !== JOB_IFS.length) bad.push("jobIfs 有重复登记");
  if (new Set(STEP_ENVS.map((e) => e.step)).size !== STEP_ENVS.length)
    bad.push("stepEnvs 有重复登记");
  return bad;
}
function checkDupStepsB(): string[] {
  const bad: string[] = [];
  if (new Set(PRIOR_RUN_STEPS.map((e) => e.step)).size !== PRIOR_RUN_STEPS.length) {
    bad.push("priorRunSteps 有重复登记");
  }
  if (new Set(JOB_FACES.map((e) => e.job)).size !== JOB_FACES.length) {
    bad.push("jobFaces 有重复登记");
  }
  if (new Set(CONDITION_INPUTS.map((e) => e.step)).size !== CONDITION_INPUTS.length) {
    bad.push("conditionInputs 有重复登记");
  }
  return bad;
}
function checkPriorShapes(): string[] {
  const bad: string[] = [];
  for (const entry of PRIOR_RUN_STEPS) {
    if (!/^[^|]+\|[^|]+\|.+$/.test(entry.step)) {
      bad.push(entry.step + " 不是 `<文件>|<作业>|<步骤名>` 形态");
    }
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{16}$/.test(entry.digest)) {
      bad.push(entry.step + " 缺 digest（16 位十六进制）");
    }
  }
  return bad;
}
function checkFaceShapes(): string[] {
  const bad: string[] = [];
  for (const entry of JOB_FACES) {
    if (!/^[^|]+\|[^|]+$/.test(entry.job)) {
      bad.push(entry.job + " 不是 `<文件>|<作业>` 形态");
    }
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{16}$/.test(entry.digest)) {
      bad.push(entry.job + " 缺 digest（16 位十六进制）");
    }
  }
  return bad;
}
function checkConditionShapes(): string[] {
  const bad: string[] = [];
  for (const entry of CONDITION_INPUTS) {
    if (!/^[^|]+\|[^|]+\|[^|]+$/.test(entry.step)) {
      bad.push(entry.step + " 不是 `<文件>|<作业>|<步骤 id>` 形态");
    }
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{16}$/.test(entry.digest)) {
      bad.push(entry.step + " 缺 digest（16 位十六进制）");
    }
  }
  return bad;
}
function checkEnvKeys(): string[] {
  const bad: string[] = [];
  for (const entry of STEP_ENVS) {
    if (!Array.isArray(entry.keys) || entry.keys.length === 0)
      bad.push(entry.step + " 的 keys 为空");
    if (new Set(entry.keys).size !== entry.keys.length) bad.push(entry.step + " 的 keys 有重复");
  }
  return bad;
}
function checkStepIfReasons(): string[] {
  const bad: string[] = [];
  for (const entry of STEP_IFS) {
    if (typeof entry.condition !== "string" || entry.condition.trim() === "")
      bad.push(entry.step + " 标了步骤级 if 却没写 condition");
    if (typeof entry.reason !== "string" || entry.reason.length < 10)
      bad.push(entry.step + " 缺理由");
  }
  return bad;
}
function checkJobIfReasons(): string[] {
  const bad: string[] = [];
  for (const entry of JOB_IFS) {
    const [file, job] = [entry.job.split("|")[0], entry.job.split("|").slice(1).join("|")];
    if (!WORKFLOW_TEXTS.has(file) || !extractJobs(WORKFLOW_TEXTS.get(file) ?? "").includes(job)) {
      bad.push(entry.job + " 不是 `<workflow>|<job>` 形态，或该 job 不存在");
    }
    if (typeof entry.reason !== "string" || entry.reason.length < 10)
      bad.push(entry.job + " 缺理由");
  }
  return bad;
}
function checkIfReasons(): string[] {
  const bad: string[] = [];
  bad.push(...checkStepIfReasons());
  bad.push(...checkJobIfReasons());
  return bad;
}
function checkEnvShapes(): string[] {
  const bad: string[] = [];
  bad.push(...checkEnvKeys());
  bad.push(...checkIfReasons());
  return bad;
}
function checkStructuredSteps(): string[] {
  const bad: string[] = [];
  const actual = judgmentSteps();
  for (const entry of STRUCTURED_STEPS) {
    bad.push(...checkStepEntry(entry, actual));
  }
  bad.push(...checkDupStepsA());
  bad.push(...checkDupStepsB());
  bad.push(...checkPriorShapes());
  bad.push(...checkFaceShapes());
  bad.push(...checkConditionShapes());
  bad.push(...checkEnvShapes());
  return bad;
}
test("例外台账：无悬空条目，且 class 合法", () => {
  const classes = new Set(["infra", "ci-only", "tier-only", "indirect", "nightly-only"]);
  // seen 用**全部**端点（含 alias / unknown）：例外本身可以登记未归一的形态（如 alias:install），
  // 若这里只取判据端点，这类条目会被误判成「悬空」。
  const seen = new Set(
    [
      ...localEndpoints("pr").keys(),
      ...localEndpoints("full").keys(),
      ...ciEndpoints("repo-gate").keys(),
    ].map(ledgerKey),
  );
  // 覆盖性例外（indirect）描述的是「尚无执行点的判据」，它合法出现的场合是判据全集而不是两侧
  // 比对面。反向也成立：某天它接上了执行点，条目就该消失——这里会立刻判它悬空。
  const coveredByAny = coveredGatePaths(executionPoints());
  for (const g of gateSources()) {
    if (!coveredByAny.has(g)) seen.add("script:" + g);
  }
  // nightly-only / tier-only 描述的**不是**两侧比对面，而是「执行点不在 PR 面」；它们由 A14
  // 正向核对，这里只需确认确实有执行点（否则连这一个 class 都算不上）。其余 class 按比对面判悬空。
  const dangling = EXCEPTIONS.filter((e) => {
    if (e.class === "nightly-only" || e.class === "tier-only") {
      return !coveredByAny.has(e.endpoint.replace(/^script:/, "").split("|")[0]);
    }
    return !seen.has(ledgerKey(e.endpoint));
  }).map((e) => e.endpoint);
  assert.deepEqual(dangling, [], "例外在两侧都不出现（悬空腐烂）：条目描述的事实已不存在");
  const badClass = EXCEPTIONS.filter((e) => !classes.has(e.class)).map((e) => e.endpoint);
  assert.deepEqual(badClass, [], "class 不在值域内");
  const noReason = EXCEPTIONS.filter(
    (e) => typeof e.reason !== "string" || e.reason.length < 10,
  ).map((e) => e.endpoint);
  assert.deepEqual(noReason, [], "例外必须写明理由（否则下一个读者无法判断它是否仍然成立）");
});

test("A4b：indirect 必须真的没有执行点（否则它是一条静默放行通道）", () => {
  // 复核实测的缺口：indirect 只要求 via 成立，不要求「真的没有执行点」。于是「给已覆盖的判据
  // 挂一条 indirect」当时全绿，之后把两侧执行点一起删掉也能全绿——等于用一条数据把 B1 重新打开。
  // local-gate.mjs / mutation-ledger.mjs 都不在执行点全集里，不会被这条误红。
  const visible = coveredGatePaths(executionPoints());
  const phantom = EXCEPTIONS.filter((e) => e.class === "indirect")
    .filter((e) => e.endpoint.startsWith("script:"))
    .filter((e) => visible.has(e.endpoint.slice("script:".length).split("|")[0]))
    .map((e) => e.endpoint);
  assert.deepEqual(
    phantom,
    [],
    "这些判据在执行点全集里可见：indirect 描述的事实不成立（它并不是「没有执行点」）",
  );
});

function checkCiOnly(
  e: { endpoint: string; class: string },
  key: string,
  inLocal: boolean,
  inCi: boolean,
): string[] {
  if (e.class === "ci-only" && (!inCi || inLocal))
    return [`${e.endpoint} 标 ci-only，但事实不是「只在 CI」`];
  return [];
}
function checkTierOnly(
  e: { endpoint: string; class: string },
  key: string,
  localFull: Set<string>,
  inCi: boolean,
): string[] {
  if (e.class === "tier-only" && (!localFull.has(key) || inCi)) {
    return [`${e.endpoint} 标 tier-only，但事实不是「只在本地 full 档」`];
  }
  return [];
}
function checkInfraEntry(e: { endpoint: string; class: string }): string[] {
  if (e.class === "infra" && (e.endpoint.startsWith("script:") || e.endpoint.startsWith("tool:"))) {
    return [
      `${e.endpoint} 标 infra，但指向的是判据端点（infra 只能承载 alias/shell 这类环境准备）`,
    ];
  }
  return [];
}
function checkIndirectEntry(e: { endpoint: string; class: string; via?: unknown }): string[] {
  if (e.class === "indirect" && (typeof e.via !== "string" || e.via.trim() === "")) {
    return [`${e.endpoint} 标 indirect 但没写 via（无法证明它真的被间接执行）`];
  }
  return [];
}
test("例外台账：class 必须与两端事实相符（台账可以说谎就等于没有断言）", () => {
  // 复核的绕过路径：删掉任意一侧的执行点后，往台账加一条 {class:'infra', reason:'…'} 即全绿。
  // 只查值域拦不住它——必须按 class 的**语义**核对方向，并限制 infra 只能落在非判据端点上。
  const localPr = new Set(judgmentKeys(localEndpoints("pr")).map(ledgerKey));
  const localFull = new Set(judgmentKeys(localEndpoints("full")).map(ledgerKey));
  const ci = new Set(judgmentKeys(ciEndpoints("repo-gate")).map(ledgerKey));
  const bad: string[] = [];
  for (const e of EXCEPTIONS) {
    const key = ledgerKey(e.endpoint);
    const inLocal = localPr.has(key) || localFull.has(key);
    const inCi = ci.has(key);
    bad.push(...checkCiOnly(e, key, inLocal, inCi));
    // 与 ci-only 一样用**归一后**的 key：e.endpoint 未必带判据面摘要，而 localFull 只存路径段。
    // 今天 collect-exemptions 无参数所以两者恰好相等，换成带摘要的条目就会误红（独立复核实测）。
    bad.push(...checkTierOnly(e, key, localFull, inCi));
    bad.push(...checkInfraEntry(e));
    bad.push(...checkIndirectEntry(e));
  }
  assert.deepEqual(bad, [], "例外台账的 class 与两端事实不符");
});

test("例外台账：总量上限 + script 例外指向的脚本必须存在", () => {
  const max = JSON.parse(
    readFileSync(join(ROOT, "scripts", "data", "gate-wiring-exceptions.json"), "utf8"),
  ).maxExceptions;
  assert.ok(typeof max === "number" && max > 0, "台账必须声明 maxExceptions（总量上限）");
  // 上限写在被自己守卫的文件里，等于自己给自己发棘轮：把它改成 999 不需要动任何断言（复核实测）。
  // 故再钉一个测试内硬顶——要放宽必须同时改数据与断言，两处都会出现在 diff 里。
  const CEILING = 16;
  assert.ok(
    max <= CEILING,
    `maxExceptions ${max} 超过测试内硬顶 ${CEILING}：放宽上限必须同时改数据与断言`,
  );
  assert.ok(
    EXCEPTIONS.length <= max,
    `例外条数 ${EXCEPTIONS.length} 超过上限 ${max}：台账在膨胀，说明它在被当成消红工具`,
  );
  const missing = EXCEPTIONS.filter((e) => e.endpoint.startsWith("script:"))
    .map((e) => e.endpoint.slice("script:".length).split("|")[0])
    .filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(missing, [], "例外指向了不存在的脚本");
});

test("台账：形态例外（structuredSteps / jobIfs）与现场相符、理由齐全、不超上限", () => {
  // 两张表都是登记制：登记制唯一的价值来源是登记项本身也被守着——悬空（描述的事实已不存在）
  // 会把它变成噪音，噪音的下一步就是被删掉；上限则防止它被当成消红工具而膨胀。
  // 硬顶：数据可以在硬顶以内只改一处放宽容，超过就必须同时改断言（两处 diff）。
  checkLedgerCeilings();
  const bad = checkStructuredSteps();
  assert.deepEqual(bad, [], "形态例外登记与现场不符");
});

test("A5：所有 script 端点指向的脚本必须存在（登记指向不存在的脚本即腐烂）", () => {
  const missing: string[] = [];
  for (const [key, endpoint] of [
    ...localEndpoints("pr"),
    ...localEndpoints("full"),
    ...ciEndpoints("repo-gate"),
  ]) {
    if (endpoint.kind !== "script") continue;
    // id 形如 `<路径>|<--package 值集合>`，存在性只看路径段
    if (!existsSync(join(ROOT, endpoint.id.split("|")[0]))) missing.push(key);
  }
  assert.deepEqual(missing, [], "接线指向了不存在的脚本：读者会被指到空处");
});

/** 登记条件的**操作数来源**及其输入面（产出步骤 / 同 job 的 uses 面 / artifact 产出端）与现场的一致性。 */
function checkOneInputRef(
  id: string,
  file: string,
  job: string,
  yaml: string,
  inputs: Map<string, { digest: string; inputsDigest?: string; producersDigest?: string }>,
  seenInputs: Set<string>,
): string[] {
  const bad: string[] = [];
  const inputKey = `${file}|${job}|${id}`;
  const face = conditionInputFaceOf(yaml, file, job, SCRIPTS, id, WORKFLOW_TEXTS);
  if (face === null) {
    bad.push(`${inputKey}：已登记的条件引用了这个步骤 output，但现场没有 id=${id} 的步骤`);
    return bad;
  }
  const entry = inputs.get(inputKey);
  if (entry === undefined) {
    bad.push(`${inputKey} 是已登记条件的操作数来源，但它的文本未登记`);
    return bad;
  }
  seenInputs.add(inputKey);
  if (entry.digest !== face.digest) {
    bad.push(
      `${inputKey} 的产出步骤文本与登记摘要不符（现场 ${face.digest}）：条件成立与否由它决定`,
    );
  }
  // 输入面：同 job 的 uses 步骤整步（把 download 的 `pattern:` 改一行）与跨 job 的 artifact 产出端
  // （把 upload 的 `name:` / `if:` 改一行）。消费端文本一字未动也能让 output 变 0，故三处一起钉。
  if (entry.inputsDigest !== face.inputsDigest) {
    bad.push(`${inputKey} 的输入步骤（uses 整步面）与登记不符（现场 ${face.inputsDigest}）`);
  }
  if (face.producers !== null) {
    if (face.producers.length === 0) {
      bad.push(
        `${inputKey}：download 的 pattern 匹配不到任何 upload-artifact（artifact 产出端缺失）`,
      );
    } else {
      const producersDigest = stepDigest(face.producers);
      if (entry.producersDigest !== producersDigest) {
        bad.push(`${inputKey} 的 artifact 产出端与登记不符（现场 ${producersDigest}）`);
      }
    }
  }
  return bad;
}
function checkUnknownKeys(step: { unknownKeys: string[] }, where: string): string[] {
  const bad: string[] = [];
  for (const unknown of step.unknownKeys) {
    bad.push(`${where}：步骤里有解析层未建模的键「${unknown}」——它可能是个静默开关`);
  }
  // continue-on-error 与 shell 同理：**不设登记出口**。它不改变执行点、不改变两侧身份，只是让
  // 这一步失败也不再使 workflow 失败——「在跑但永不判红」正是本族要拦的东西。原先只在 ci.yml 的
  // repo-gate 上检查，给 observe.yml 的判据步骤加一行即全绿（对抗复核实测）。
  return bad;
}
function checkShellOverride(step: { shell: unknown }, key: string, where: string): string[] {
  const bad: string[] = [];
  const declaredShell = step.shell ?? shellDefaultOf(key.split("|")[0], key.split("|")[1]);
  if (declaredShell !== null && !isSafeShellOverride(declaredShell)) {
    bad.push(`${where}：判据步骤的 shell 被覆盖成 ${declaredShell}——退出码是否到达步骤不再保证`);
  }
  // `working-directory` 同样不设登记出口：它是「这条命令在哪个目录里跑」的一部分——相对路径的脚本会
  // 变成另一条命令，而步骤键、两侧身份、执行点全都不动（对抗复核实测：给判据步骤加
  // `working-directory: /tmp` 时 73/73 全绿）。要换目录就在命令里 `cd`，那至少留在文本里。
  // job 级 `defaults.run.working-directory` 走的不是这里，而是含判据 job 的执行面摘要（jobFaces）。
  return bad;
}
function checkWorkingDir(step: { workingDirectory: unknown }, where: string): string[] {
  const bad: string[] = [];
  if (step.workingDirectory !== null && step.workingDirectory !== "") {
    bad.push(
      `${where}：判据步骤声明了 working-directory=${step.workingDirectory}——换个目录就是换一条命令`,
    );
  }
  // 未登记的判据步骤里不许出现 `#`：`#` 是不是注释起点取决于「词首」，而词首取决于 bash 的元字符集
  // 与转义规则——自研扫描器与 bash 之间总有分歧（`" #"` / `{#` / `\ #` / `$' #'` 都实测过），
  // 一旦判错就会把 `|| true` 整段切掉。故对**原始 run 文本** fail-closed：整行注释之外的 `#` 即红；
  // 已登记的步骤吃文本摘要，不需要这条（它们本来就有带 `#` 的 echo 与 `${VAR#pat}` 展开）。
  return bad;
}
function checkHashMarks(
  step: { rawLines: string[] },
  key: string,
  registered: Set<string>,
  where: string,
): string[] {
  const bad: string[] = [];
  if (!registered.has(key)) {
    for (const text of step.rawLines) {
      if (text.includes("#")) {
        bad.push(`${where}：判据命令含 #（注释起点与 bash 的判定不可能完全对齐）：${text}`);
      }
    }
  }
  // 引号必须配对：未配对时「注释从哪开始」「反斜杠续行是否成立」都不可静态判定，而这两种判定
  // 正是把 `|| true` 藏起来的入口（`pnpm lint --packages "" " #" || true` 实测全绿）。fail-closed。
  return bad;
}
function checkQuotePairs(cmds: string[], where: string): string[] {
  const bad: string[] = [];
  for (const cmd of cmds) {
    if (hasUnbalancedQuotes(cmd)) {
      bad.push(`${where}：命令含未配对引号（注释与续行的切分不再可靠）：${cmd}`);
    }
  }
  // 能改变 shell 行为的 env：`BASH_ENV=<仓内 exit 0 的文件>` 让整步在跑到判据之前就返回 0。
  // 键名来自步骤级 env 与行首赋值两种写法（值随事件变化，故只核键名）。
  return bad;
}
function checkEnvKeys2(step: { envKeys: string[] }, cmds: string[], where: string): string[] {
  const bad: string[] = [];
  const envKeys = [...step.envKeys, ...cmds.flatMap((c) => leadingAssignmentNames(c))];
  for (const name of dangerousStepEnv(envKeys)) {
    bad.push(`${where}：判据步骤注入了 ${name}——它改变 shell 行为，可让整步在本判据之前结束`);
  }
  // allKeys：把恒假分支的壳剥掉后仍能认出的判据（=「文本上写着会跑」）
  // liveKeys：真的会被执行到的判据。两者之差就是被静默关掉的那些。
  return bad;
}
function checkDeadBranches(cmds: string[], where: string): string[] {
  const bad: string[] = [];
  const allKeys = judgmentKeysIn(SCRIPTS, cmds, true);
  const live = stripDeadBranchCommands(cmds);
  const liveKeys = judgmentKeysIn(SCRIPTS, live, false);
  const dead = allKeys.filter((k) => !liveKeys.includes(k));
  if (dead.length > 0) {
    bad.push(`${where}：${dead.join(", ")} 位于恒假分支（文本上还在，实际永不执行）`);
  }
  return bad;
}
function checkErrexitOff(cmds: string[], where: string): string[] {
  const bad: string[] = [];
  if (disablesErrexit(cmds)) {
    bad.push(`${where}：关掉了 errexit（set +e），判据失败不再使步骤失败`);
  }
  return bad;
}
function checkShellControlOps(
  cmds: string[],
  key: string,
  registered: Set<string>,
  where: string,
): string[] {
  const bad: string[] = [];
  // 控制操作符：判据**命令本身**一行都不许有（`node X || true` / `node X | sed` / `node X; true`）。
  // 未登记的步骤另按闭合形态要求（只有一条命令），于是这一条对它自动覆盖到「整步」。
  // 登记过的步骤里，脚手架行的 `&&` / `||` 是合法写法（release 的 `[ -z "$pkg" ] && continue`、
  // mutation-verdict 的 `… || { echo; exit 1; }`），故不把整步扫一遍——那些行由 swallowsExitCode
  // 单独兜住（`fi || true` 这类改写退出码的形态会被它抓住）。
  for (const cmd of cmds) {
    // `cd X && 判据` 是合法载体：被执行者与退出码都由内层命令决定，先剥一层再判控制操作符。
    const bare = stripCdCarrier(cmd) ?? cmd;
    const ep = endpointOf(cmd, SCRIPTS);
    const isJudgmentCmd = ep !== null && isJudgment(`${ep.kind}:${ep.id}`);
    if ((isJudgmentCmd || !registered.has(key)) && hasShellControlOperator(bare)) {
      bad.push(`${where}：出现 shell 控制操作符：${cmd}`);
    }
  }
  return bad;
}
function checkExitSwallow(cmds: string[], live: string[], where: string): string[] {
  const bad: string[] = [];
  for (const cmd of live) {
    if (swallowsExitCode(stripCdCarrier(cmd) ?? cmd)) bad.push(`${where}：吞掉退出码：${cmd}`);
  }
  return bad;
}
function checkSingleCommand(key: string, cmds: string[]): string[] {
  const bad: string[] = [];
  if (cmds.length !== 1) {
    bad.push(
      `${key} 的步骤含 ${cmds.length} 条命令：判据步骤只允许一条命令——` +
        "多一层 shell 包装（前置 exit 0 / 恒假 if / set +e）就能把判据静默关掉，" +
        "设计如此的形态必须登记到台账的 structuredSteps",
    );
    return bad;
  }
  const only = endpointOf(cmds[0], SCRIPTS);
  if (only === null || !isJudgment(`${only.kind}:${only.id}`)) {
    bad.push(`${key} 不是一条直接的判据命令：${cmds[0]}`);
  }
  return bad;
}
function checkJudgmentStepShape(
  key: string,
  step: ReturnType<typeof judgmentSteps> extends Map<unknown, infer V> ? V : never,
  registered: Set<string>,
): string[] {
  const bad: string[] = [];
  const { cmds } = step;
  const where = key.split("|").slice(0, 2).join(" / ");
  const live = stripDeadBranchCommands(cmds);
  // 未建模的键：解析层看不见的开关等于不存在（`shell: bash +e {0}` 就是关掉 errexit 的一种写法）。
  bad.push(...checkUnknownKeys(step, where));
  if (step.continueOnError) {
    bad.push(`${where}：判据步骤带 continue-on-error——判据失败不再使 workflow 失败`);
  }
  // shell 覆盖按**模板**判，不设登记出口：
  //   - 判据步骤没有任何理由削弱自己的退出码语义，所以「不在白名单」就是硬红；
  //   - 留登记出口反而会与「登记项必须是非闭合形态」的守卫互相打死（单命令步骤永远登记不了，
  //     于是合法写法无路可走）——独立复核把这个死锁实测出来了。
  // workflow / job 级 `defaults.run.shell` 同样算数：一行 defaults 能让所有 run 步骤生效，
  // 只看步骤级覆盖会整条漏掉。
  bad.push(...checkShellOverride(step, key, where));
  bad.push(...checkWorkingDir(step, where));
  bad.push(...checkHashMarks(step, key, registered, where));
  bad.push(...checkQuotePairs(cmds, where));
  bad.push(...checkEnvKeys2(step, cmds, where));
  bad.push(...checkDeadBranches(cmds, where));
  bad.push(...checkErrexitOff(cmds, where));
  bad.push(...checkShellControlOps(cmds, key, registered, where));
  bad.push(...checkExitSwallow(cmds, live, where));
  if (registered.has(key)) return bad;
  bad.push(...checkSingleCommand(key, cmds));
  return bad;
}
function checkStepEnv(
  steps: Array<{ cmds: string[]; envKeys: string[]; key: string }>,
  declared: Map<string, string>,
  priorDeclared: Map<string, unknown>,
  facesDeclared: Map<string, unknown>,
  priorActual: Map<string, { digest: string; envKeys: string[] }>,
  facesActual: Map<string, string>,
  seen: Set<string>,
): string[] {
  const bad: string[] = [];
  for (const step of steps) {
    if (judgmentKeysIn(SCRIPTS, step.cmds, true).length === 0) continue;
    const actual = [...step.envKeys].sort().join(",");
    if (!declared.has(step.key)) {
      // 没有 env 的判据步骤不必登记；有键而没登记即红（三层任一层的键都算）。
      if (actual !== "") bad.push(`${step.key} 的有效 env 键未登记：${actual}`);
      continue;
    }
    seen.add(step.key);
    if (declared.get(step.key) !== actual) {
      bad.push(`${step.key} 的有效 env 键与登记不符：${actual} != ${declared.get(step.key)}`);
    }
  }
  return bad;
}
function conditionInputViolations(): string[] {
  const bad: string[] = [];
  const inputs = new Map(CONDITION_INPUTS.map((e) => [e.step, e]));
  const seenInputs = new Set<string>();
  // 条件原文登记住了，但**操作数来源**也得钉住：把产出 output 的步骤改成 `COUNT=0` 之类，条件永不成立
  // 而条件一字未动（对抗复核实测）。故凡登记条件里出现 `steps.<id>.outputs.<name>`，产出它的步骤必须登记。
  // 输入面的口径（三处摘要怎么算）在 lib 的 conditionInputFaceOf 里——那一层有独立单测。
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    for (const job of extractJobs(yaml)) {
      const conditions = [
        ...STEP_IFS.filter((s) => s.step.startsWith(`${file}|${job}|`)).map((s) => s.condition),
        ...JOB_IFS.filter((j) => j.job === `${file}|${job}`).map((j) => j.condition),
      ];
      const refs = new Set(
        conditions.flatMap((c) =>
          [...String(c).matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\./g)].map((m) => m[1]),
        ),
      );
      for (const id of refs) {
        bad.push(...checkOneInputRef(id, file, job, yaml, inputs, seenInputs));
      }
    }
  }
  for (const key of inputs.keys()) {
    if (!seenInputs.has(key)) bad.push(`${key} 登记为条件输入，但现场没有条件引用它`);
  }
  return bad;
}

/**
 * 单条判据步骤的步骤级 if 登记核对：未登记 / 登记为常量 / 实际与登记不符 / 实际为常量，四种判词。
 * 非判据步骤与无步骤级 if 的步骤不在判定面内，直接跳过。
 */
function checkStepIfRegistration(
  step: StepShape,
  declared: Map<string, string>,
  seen: Set<string>,
  bad: string[],
): void {
  if (judgmentKeysIn(SCRIPTS, step.cmds, true).length === 0) return;
  if (step.ifCond === null) return;
  if (!declared.has(step.key)) {
    bad.push(`${step.key} 的步骤级 if 未登记：${step.ifCond}`);
    return;
  }
  seen.add(step.key);
  const expected = String(declared.get(step.key));
  if (isConstantCondition(expected)) {
    bad.push(`${step.key} 登记的 condition 是常量表达式：等于把判据关掉还宣称它跑`);
  }
  if (step.ifCond !== expected) {
    bad.push(`${step.key} 的 if 与登记不符：${step.ifCond} != ${expected}`);
  } else if (isConstantCondition(step.ifCond)) {
    bad.push(`${step.key} 的实际 if 是常量表达式（恒真/恒假都不是闸的常态）：${step.ifCond}`);
  }
}

test("A6：判据步骤的 `if:` 必须逐字登记在 stepIfs（扫描面 = 全部 workflow）", () => {
  // 为什么要登记制而不是「判条件真假」：`if: github.repository == 'never/match'` 这类条件提到了
  // 运行时上下文，静态判不出永不成立（等于停机问题），而它能让一条判据从此不跑——命令还在、
  // 执行点还在、两侧身份也没变，除了「这一步到底还跑不跑」之外所有断言都无感。
  // 登记制把静默开关变成 diff 里显眼的一行：改一个字即判红，新增一个带 if 的判据步骤同样判红。
  // 扫描面是**全部 workflow**：把 observe.yml 的 crap-check 改成 `if: github.repository == 'never/match'`
  // 时，夜间变异/覆盖率判据同样静默失明（原先只有 ci.yml 的 repo-gate 有人看）。
  const declared = new Map(STEP_IFS.map((s) => [s.step, s.condition]));
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    for (const job of extractJobs(yaml)) {
      for (const step of stepsOf(yaml, file, job, SCRIPTS)) {
        checkStepIfRegistration(step, declared, seen, bad);
      }
    }
  }
  for (const key of declared.keys()) {
    if (!seen.has(key)) bad.push(`${key} 登记了步骤级 if，但现场没有这条带 if 的判据步骤`);
  }
  assert.deepEqual(bad, [], "步骤级 if 是未登记的静默开关：这一步的判据可被一处改动关掉");
  assert.deepEqual(
    conditionInputViolations(),
    [],
    "登记条件的操作数来源 / 输入面与现场不符：条件永不成立的开关不止条件原文一处",
  );
});

/** workflow / job 级 `defaults.run.shell`（按 file|job 缓存；job 级覆盖 workflow 级）。 */
const shellDefaultCache = new Map<string, string | null>();
function shellDefaultOf(file: string, job: string): string | null {
  const cacheKey = `${file}|${job}`;
  if (shellDefaultCache.has(cacheKey)) return shellDefaultCache.get(cacheKey) ?? null;
  const { workflow, job: jobShell } = shellDefaults(WORKFLOW_TEXTS.get(file) ?? "", job);
  const value = jobShell ?? workflow;
  shellDefaultCache.set(cacheKey, value);
  return value;
}

/** 全部 workflow 里的判据步骤：步骤键 → 该步骤的形态（形态断言与台账守卫共用同一份派生）。 */
function judgmentSteps(): Map<string, StepShape> {
  const out = new Map<string, StepShape>();
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    for (const job of extractJobs(yaml)) {
      for (const step of stepsOf(yaml, file, job, SCRIPTS)) {
        if (judgmentKeysIn(SCRIPTS, step.cmds, true).length === 0) continue;
        out.set(step.key, step);
      }
    }
  }
  return out;
}

test("A6b：全部 workflow 的判据步骤必须是闭合形态，或在台账里登记形态例外", () => {
  // 「在跑但永不判红」比「不跑」更隐蔽：退出码被 || true / | cat / 管道 / 显式 exit 0 吃掉，
  // 或步骤里来一条 set +e 关掉 errexit，或整段被塞进 if false; then … fi。
  // 只看「命令里出现了哪个脚本」的断言对这类改动完全无感（复核实测全部全绿）。
  //
  // 形态判据走**闭合**而不是继续补枚举：`exit "0"` 前置、`if [ ]; then` 包装、
  // `X=1 set +e` 三种写法都能让步骤以 0 结束而判据永不执行（复核实测 24/24 全绿），而这类
  // 写法列举不完。反过来的要求一句话说得清：**判据步骤只允许一条命令，且那条命令就是判据
  // 本身**。产物闸那种设计如此的 if/else 双形态在台账的 structuredSteps 里逐条登记，
  // 登记项照旧吃下面的逐行检查（多写一行仍会被抓）。
  const registered = new Set(STRUCTURED_STEPS.map((s) => s.step));
  const bad: string[] = [];
  for (const [key, step] of judgmentSteps()) {
    bad.push(...checkJudgmentStepShape(key, step, registered));
  }
  // 步骤键必须两两不同：键相同的两条步骤会被同一条 structuredSteps 登记一起豁免
  // （「登记一处、放行一片」）。键里带完整判据身份就是为了这一条。
  const byKey = new Map<string, number>();
  for (const key of judgmentSteps().keys()) byKey.set(key, (byKey.get(key) ?? 0) + 1);
  const duplicated = [...byKey.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
  assert.deepEqual(duplicated, [], "含判据的步骤键重复：一条形态登记会同时豁免多条步骤");
  assert.deepEqual(bad, [], "判据的退出码被吞掉、errexit 被关掉、形态不闭合：它在跑，但永不判红");
});

/** 该 job 的 run 步骤里是否至少有一条判据端点（决定 job 级 if 是否在判定面内）。 */
function jobGuardsJudgment(yaml: string, job: string): boolean {
  return extractRunSteps(yaml, job).some((s) => {
    const e = endpointOf(s.cmd, SCRIPTS);
    return e !== null && isJudgment(`${e.kind}:${e.id}`);
  });
}

/**
 * 单个 job 的 job 级 if 登记核对：不含判据或无 job 级 if 的 job 不在判定面内；
 * 其余核对未登记 / 登记为常量 / 实际与登记不符 / 实际为常量四种判词。
 */
function checkJobIfRegistration(
  file: string,
  yaml: string,
  job: string,
  declared: Map<string, string>,
  seen: Set<string>,
  bad: string[],
): void {
  if (!jobGuardsJudgment(yaml, job)) return;
  const key = `${file}|${job}`;
  const cond = extractJobIf(yaml, job);
  if (cond === null) return;
  if (!declared.has(key)) {
    bad.push(`${key} 的 job 级 if 未登记：${cond}`);
    return;
  }
  seen.add(key);
  const expected = String(declared.get(key));
  if (isConstantCondition(expected)) bad.push(`${key} 登记的 job 级 if 是常量表达式：${expected}`);
  if (cond !== expected) bad.push(`${key} 的 job 级 if 与登记不符：${cond} != ${expected}`);
  else if (isConstantCondition(cond)) bad.push(`${key} 的 job 级 if 是常量表达式：${cond}`);
}

test("A6c：含判据的 job 的 job 级 if 必须逐字登记（扫描面 = 全部 workflow）", () => {
  // job 级 if 比步骤级更彻底：把 repo-gate 的 always() 换成 github.repository == 'never/match'，
  // 该 job 下 20 条判据一次消失，而所有只看步骤内容的断言原封不动（复核实测 24/24 全绿）。
  // 「这个条件会不会成立」静态判不出（等于停机问题），故改**登记制**：非空 job 级 if 必须逐字
  // 登记，改一个字即判红——把静默开关变成 diff 里显眼的一行。GHA 的状态函数
  // （always / success / failure / cancelled）取的是运行时值，不是常量，故不算「常量条件」。
  const declared = new Map(JOB_IFS.map((j) => [j.job, j.condition]));
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    for (const job of extractJobs(yaml)) {
      checkJobIfRegistration(file, yaml, job, declared, seen, bad);
    }
  }
  for (const key of declared.keys()) {
    if (!seen.has(key)) bad.push(`${key} 登记了 job 级 if，但该 job 不存在、不含判据、或已无 if`);
  }
  assert.deepEqual(bad, [], "job 级 if 是未登记的静默开关：整个 job 的判据可被一处改动关掉");
});

function collectA6dActuals(
  declared: Map<string, string>,
  priorDeclared: Map<string, unknown>,
  facesDeclared: Map<string, unknown>,
): {
  priorActual: Map<string, { digest: string; envKeys: string[] }>;
  facesActual: Map<string, string>;
  seen: Set<string>;
  bad: string[];
} {
  const priorActual = new Map<string, { digest: string; envKeys: string[] }>();
  const facesActual = new Map<string, string>();
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    for (const job of extractJobs(yaml)) {
      const steps = stepsOf(yaml, file, job, SCRIPTS);
      bad.push(
        ...checkStepEnv(
          steps,
          declared,
          priorDeclared,
          facesDeclared,
          priorActual,
          facesActual,
          seen,
        ),
      );
      for (const step of priorRunStepsOf(yaml, file, job, SCRIPTS)) {
        if (priorActual.has(step.key)) bad.push(`${step.key} 的登记键在同一 job 内不唯一`);
        priorActual.set(step.key, step);
      }
      const face = jobFaceOf(yaml, file, job, SCRIPTS);
      if (face !== null) facesActual.set(`${file}|${job}`, face);
    }
  }
  return { priorActual, facesActual, seen, bad };
}
function checkA6dPrior(
  priorActual: Map<string, { digest: string; envKeys: string[] }>,
  priorDeclared: Map<string, { digest: string; envKeys?: string[] }>,
  bad: string[],
): void {
  for (const [key, actual] of priorActual) {
    const entry = priorDeclared.get(key);
    if (entry === undefined) {
      bad.push(`${key} 是判据步骤之前的 run 步骤但未登记：它能改变判据的执行环境`);
      continue;
    }
    if (entry.digest !== actual.digest) {
      bad.push(
        `${key} 的整步文本与登记摘要不符（现场 ${actual.digest}）：前序步骤即判据的执行环境`,
      );
    }
    if ((entry.envKeys ?? []).join(",") !== actual.envKeys.join(",")) {
      bad.push(
        `${key} 的 env 键与登记不符：${actual.envKeys.join(",")} != ${(entry.envKeys ?? []).join(",")}`,
      );
    }
  }
  for (const key of priorDeclared.keys()) {
    if (!priorActual.has(key)) {
      bad.push(`${key} 登记为前序步骤，但现场找不到它（已改名 / 已被挪到判据之后 / 已删除）`);
    }
  }
}
function checkA6dFaces(
  facesActual: Map<string, string>,
  facesDeclared: Map<string, { digest: string }>,
  declared: Map<string, string>,
  seen: Set<string>,
  bad: string[],
): void {
  for (const [key, actual] of facesActual) {
    const entry = facesDeclared.get(key);
    if (entry === undefined) {
      bad.push(
        `${key} 含判据但它的执行面（前序步骤序列 / uses 面 / job 级 container·defaults）未登记`,
      );
      continue;
    }
    if (entry.digest !== actual) {
      bad.push(
        `${key} 的执行面与登记不符（现场 ${actual}）：前序步骤顺序、uses 整步文本或 job 级 container / defaults 已变`,
      );
    }
  }
  for (const key of facesDeclared.keys()) {
    if (!facesActual.has(key)) bad.push(`${key} 登记了执行面，但现场没有含判据的 job`);
  }
  for (const key of declared.keys()) {
    if (!seen.has(key)) bad.push(`${key} 登记了 env 键，但现场没有这条判据步骤、或它已无 env`);
  }
}
test("A6d：判据步骤的有效 env 键与环境面步骤（前序 run / uses 面）必须逐条登记", () => {
  // 为什么连键名都登记：`env:` 只改执行环境——不改执行点、不改两侧身份，却能整类关掉判据。三层 env
  // 都算进这一步的有效键，故在 job / workflow 上挂一行 env 会让该 job 下每条判据一起失配。
  // 另一条不看登记的硬红：能改变执行环境的变量名（BASH_ENV / SHELLOPTS / NODE_OPTIONS / PATH /
  // LD_PRELOAD / …，A6b 已查）。同 job 前序步骤改写执行环境这件事**按字样匹配是挡不住的**，故改成
  // 按位置登记整个环境面（priorRunSteps / jobFaces，判定与理由见 lib 里几个函数的注释）。
  const declared = new Map(STEP_ENVS.map((e) => [e.step, [...e.keys].sort().join(",")]));
  const priorDeclared = new Map(PRIOR_RUN_STEPS.map((e) => [e.step, e]));
  const facesDeclared = new Map(JOB_FACES.map((e) => [e.job, e]));
  const { priorActual, facesActual, seen, bad } = collectA6dActuals(
    declared,
    priorDeclared,
    facesDeclared,
  );
  checkA6dPrior(priorActual, priorDeclared, bad);
  checkA6dFaces(facesActual, facesDeclared, declared, seen, bad);
  assert.deepEqual(
    bad,
    [],
    "判据步骤的环境变量与环境面步骤与登记不符：env 与前序步骤是能整类关掉判据的静默开关",
  );
});
/**
 * 逐层展开别名链，返回每一层的原文（自身在前）。只看最后一层会漏掉「前缀组合别名」的脏。
 * 环（chain 自带名字）与非字符串目标都终止展开。
 */
function aliasChainLayers(name: string, expansion: string): string[] {
  const layers = [expansion];
  const chain = [name];
  for (;;) {
    const next = /^pnpm\s+(?:exec\s+)?([^-\s][^\s]*)/.exec(layers[layers.length - 1]);
    if (next === null || chain.includes(next[1])) break;
    const deeper = SCRIPTS[next[1]];
    if (typeof deeper !== "string") break;
    chain.push(next[1]);
    layers.push(deeper);
  }
  return layers;
}

test("A10：判据别名的展开结果不得含控制操作符或吞掉退出码（钥匙串自身也要上锁）", () => {
  // A7 锁的是「test:scripts 在两侧都有执行点」，不是「别名本身干净」：给 package.json 的
  // test:scripts 追加 " || true"，判据身份取自工具名之后的 token，追加部分不进身份——两侧仍
  // 相等、A7 仍通过，而 test:scripts 实际永不判红（复核实测 24/24 全绿）。
  // 别名比 workflow 更常被顺手改动（调试完忘了改回），且它是本地档位的真实执行面，故单独判形态。
  const bad: string[] = [];
  for (const [name, expansion] of Object.entries(SCRIPTS)) {
    const endpoint = endpointOf(`pnpm ${name}`, SCRIPTS);
    if (endpoint === null || !isJudgment(`${endpoint.kind}:${endpoint.id}`)) continue;
    // 逐层展开别名链，并检查**每一层**的原文。
    // 只看最后一层会漏掉「前缀组合别名」：`"X": "pnpm <干净别名> && node … || true"` 的脏在 X
    // 自己的展开里，而链式展开会立刻跳到更深一层，X 的原文从此没人看（独立复核实测：
    // `test:scripts = "pnpm lint && node --test scripts/test/*.test.ts || true"` 当时 A10 零命中）。
    for (const layer of aliasChainLayers(name, expansion)) {
      if (hasShellControlOperator(layer)) bad.push(`${name} 的展开含 shell 控制操作符：${layer}`);
      if (swallowsExitCode(layer)) bad.push(`${name} 的展开吞掉退出码：${layer}`);
      if (disablesErrexit(layer.split("\n"))) bad.push(`${name} 的展开关掉了 errexit：${layer}`);
    }
  }
  assert.deepEqual(bad, [], "判据别名本身被写成了吞码形态：两侧身份相等而判据永不判红");
});

test("A12：判据别名的指向必须逐条登记（两侧身份同源派生，别名改脏两侧一起移动）", () => {
  // 一致性断言的**期望身份**同样从 package.json 现场派生：CI 与本地都写 `pnpm <别名>` 时，
  // 把别名本身改脏（`lint → true`、去掉 `aggregate:check` 的 `--check`）会让两侧一起移动、
  // 比对仍然相等（独立对抗复核实测四例全部 29/29 绿：lint→true / aggregate:check 去 --check /
  // docs:check 去 --strict-en / stryker:check 去 --check）。别名是判据面的入口，故在此逐条钉住
  // **完整身份**（含判据面摘要）：改指向或改参数都必须留下一次显式的数据改动。
  const pinned = new Map(JUDGMENT_ALIASES.map((a) => [a.alias, a.endpoint]));
  const used = new Map<string, string>();
  const commands = [
    ...extractRunSteps(CI_YML, "repo-gate").map((s) => s.cmd),
    ...planCommands("pr"),
    ...planCommands("full"),
  ];
  for (const cmd of commands) {
    const m = /^pnpm\s+(?:exec\s+)?([^-\s][^\s]*)/.exec(cmd.trim());
    if (m === null) continue;
    const ep = endpointOf(cmd, SCRIPTS);
    if (ep === null || !isJudgment(`${ep.kind}:${ep.id}`)) continue;
    used.set(m[1], `${ep.kind}:${ep.id}`);
  }
  const bad: string[] = [];
  for (const [alias, endpoint] of used) {
    if (!pinned.has(alias)) {
      bad.push(`${alias} 是被判据用到的别名但未登记指向（实际 ${endpoint}）`);
      continue;
    }
    if (pinned.get(alias) !== endpoint) {
      bad.push(`${alias} 的指向与登记不符：${endpoint} != ${pinned.get(alias)}`);
    }
  }
  for (const [alias, endpoint] of pinned) {
    if (!used.has(alias)) {
      bad.push(`${alias} 登记了指向（${endpoint}）但现场没有把它当判据使用：条目已悬空`);
    }
  }
  assert.deepEqual(bad, [], "判据别名的指向被改动且未登记：两侧身份同源，改一处不会有人发现");
});

test("A13：每个 workflow × job 的 YAML 必须被解析器完整理解（不认识的写法即红）", () => {
  // 解析层换成成熟的 YAML 实现（`yaml` 包）之后，语法正确性由它保证；这里守的是**语义边界**：
  // GHA 若新增第 12 个步骤键、或文件里出现语法 / 重复键错误，必须判红——否则「一个能让判据静默
  // 失明的键」会跟着 workflow 一起进仓库。手写正则时代这一层是「认不出就静默略过」，差别就在这。
  // 载体自证的第一层：扫描面本身。文件被删/改名/权限变化时 readdirSync 只是少列几个文件，
  // 「每个 workflow 都没问题」与「一个 workflow 都没扫到」在断言眼里长得一样。故把**应扫面**
  // 写成硬编码契约：新增/退役 workflow 必须同时改这里，这个改动会出现在 diff 里。
  const EXPECTED_WORKFLOWS = [
    "baseline-overlay.yml",
    "ci.yml",
    "health-report.yml",
    "observe.yml",
    "release.yml",
  ];
  assert.deepEqual(
    [...WORKFLOW_TEXTS.keys()].sort(),
    EXPECTED_WORKFLOWS,
    "workflow 扫描面与契约不符：少扫一个文件，A6/A6b/A6c/A13 就整体空转全绿",
  );
  const bad: string[] = [];
  for (const [file, yaml] of WORKFLOW_TEXTS) {
    // 载体自证的第二层：**文件级**解析。parseIssues 是按 job 调用的，而 `jobs` 本身写坏时
    // extractJobs 返回空数组——循环空转、一条错也报不出来。多文档（`---`）、jobs 非映射、
    // 顶层重复键都属于这一类（对抗复核实测：这三种都能让 jobs=[] 且 issues=[]）。
    const fileErrors = yamlErrors(yaml);
    if (fileErrors.length > 0) {
      bad.push(
        `${file} 整份文件解析失败：${fileErrors.map((e: unknown) => String(e)).join(" / ")}`,
      );
      continue;
    }
    const jobs = extractJobs(yaml);
    assert.ok(jobs.length > 0, `${file} 一个 job 都没解析出来：解析面是否失效？`);
    assert.ok(
      jobs.some((job) => extractRunSteps(yaml, job).length > 0),
      `${file} 的每个 job 都没有 run 步骤：解析面是否失效？`,
    );
    for (const job of jobs) {
      for (const issue of parseIssues(yaml, job)) bad.push(`${file} / ${job}：${issue}`);
    }
  }
  assert.deepEqual(bad, [], "workflow 里有解析层读不懂的内容：它可能是个静默开关");
});

test("A14：只在非 PR 面跑的判据必须显式登记（nightly-only / tier-only）", () => {
  // 覆盖性只要求「至少一处执行点」，那个点可能在 observe.yml 里——于是「把判据挪到夜间班次」不会有
  // 任何断言反应。这里把「执行点全部落在非 PR 面」变成**显式清单**（新增要登记、删掉悬空）。
  //
  // PR 面精确到「默认 PR 路径」，两侧都收窄：CI 侧 = 未按 gate:full 标签实例化的 job（coverage 不算，
  // 否则挪进 coverage job 就成了已进 PR 面）；本地侧 = 只有 **pr** 档（gate:full 与标签一样是可选档，
  // 算进来等于放行「只在 full 档跑」的判据）。这一族的 class 有两种——执行点在夜间班次（nightly-only）
  // 与只在本地 full 档（tier-only）——清单只问「PR 面覆盖得到吗」。
  assert.ok(prFaceJobs().includes("repo-gate"), "repo-gate 是 PR 默认路径，必须在 PR 面内");
  assert.ok(
    !prFaceJobs().includes("coverage"),
    "coverage 只在 gate:full 标签下实例化，不算 PR 面（jobIfs 台账里有它的条件原文）",
  );
  const inPrFace = new Set([...ciAllPaths(), ...localPaths(["pr"])]);
  const offPrFace = new Set(
    [...coveredGatePaths(executionPoints())].filter(
      (p) => p.startsWith("scripts/gate/") && !inPrFace.has(p),
    ),
  );
  const declared = new Map(
    EXCEPTIONS.filter((e) => e.class === "nightly-only" || e.class === "tier-only").map((e) => [
      e.endpoint.replace(/^script:/, "").split("|")[0],
      e.class,
    ]),
  );
  const bad: string[] = [];
  for (const p of offPrFace) {
    if (!declared.has(p)) {
      bad.push(`script:${p} 的执行点全部在非 PR 面，但没登记 nightly-only / tier-only`);
    }
  }
  for (const [p, cls] of declared) {
    if (!offPrFace.has(p)) {
      bad.push(
        `script:${p} 登记为 ${cls}，但现场在 PR 面（ci 默认 PR 路径 ∪ 本地 pr 档）也有执行点`,
      );
    }
  }
  assert.deepEqual(bad, [], "非 PR 面判据的清单与现场不符：PR 面覆盖不到的判据必须逐条可见");
});

// ---------------------------------------------------------------- 三、载体自证

test("A7：pnpm test:scripts 在 CI 与本地 pr 档都有执行点，且别名仍指向全套脚本自测", () => {
  // 期望身份从 package.json 现场派生而不硬编码：tool 身份带判据面摘要，硬编码的 id 会在摘要
  // 口径调整时把这条断言变成假红，而「被假红逼着改断言」正是弱化的起点。
  const expected = endpointOf("pnpm test:scripts", SCRIPTS);
  assert.ok(expected !== null, "前提：package.json 应声明 test:scripts");
  const key = `${expected.kind}:${expected.id}`;
  assert.ok(
    [...ciEndpoints("repo-gate").keys()].includes(key),
    `ci.yml repo-gate 缺 ${key} 执行点：本文件与全部脚本自测会在 CI 静默消失`,
  );
  assert.ok([...localEndpoints("pr").keys()].includes(key), `本地 pr 档缺 ${key} 执行点`);

  // 上面两条是**相对**断言：期望键也取自同一份 package.json，别名一改两侧同步改变，它们照样成立。
  // 独立复核实测：把 test:scripts 改成 `pnpm lint`，A7/A1/A2 全绿，而脚本自测在 CI 与本地一起
  // 消失——被关掉的恰是守护 workflow 的这套测试自身。故补一条**性质**断言：别名必须仍然指向
  // 「跑 scripts/test 下全套用例」这件事。用性质而不是硬编码整串，避免判据面摘要口径调整时假红。
  const expansion = SCRIPTS["test:scripts"] ?? "";
  assert.match(expansion, /\bnode\b[^\n]*\s--test\b/, "test:scripts 必须仍是 node --test 形态");
  assert.match(expansion, /scripts\/test\//, "test:scripts 必须仍覆盖 scripts/test 下的用例面");
  // 用例面必须**由目录派生**（glob 或目录），不得逐文件枚举：枚举会腐烂，更会被静默收窄——
  // 独立复核实测「把 test:scripts 改成只跑 gate-wiring.test.ts 自己」，全套断言照样全绿，
  // 而那正是这套断言赖以生效的证据面。
  assert.ok(
    /scripts\/test\/\*/.test(expansion) || /scripts\/test\/\s*$/.test(expansion),
    "test:scripts 的用例面必须由 scripts/test 目录派生（glob 或目录形态）",
  );
  for (const flag of ["--test-name-pattern", "--test-skip-pattern", "--test-only"]) {
    assert.ok(
      !expansion.includes(flag),
      `test:scripts 不得带 ${flag}：它会把用例面收窄到 0 而退出码仍是 0`,
    );
  }
});

// ---------------------------------------------------------------- 四、孤儿接线

test("孤儿接线：被当作子进程执行的判据必须有可见执行点或登记 indirect", () => {
  // 只认「执行形态」的引用：spawnSync / execFileSync 调用附近出现的脚本路径。
  // 为什么不用「文件里出现过该路径」：注释、文档字符串与 import 都会命中，前者是误报源，
  // 后者是模块依赖而非执行点——把它们算进来会让这条断言变成噪音，然后被弱化掉。
  const refs = new Map<string, Set<string>>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(mjs|cjs|ts)$/.test(entry.name)) continue;
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const call of text.matchAll(/(?:spawnSync|execFileSync)\s*\(/g)) {
        const window = text.slice(call.index, call.index + 800);
        for (const m of window.matchAll(/scripts\/gate\/[\w.-]+\.(?:mjs|ts)/g)) {
          const callers = refs.get(m[0]) ?? new Set<string>();
          callers.add(rel);
          refs.set(m[0], callers);
        }
      }
    }
  };
  for (const dir of ["scripts/gate", "scripts/lib", "scripts/ci", "scripts/build"]) walk(dir);

  const reachable = new Set([
    ...localEndpoints("pr").keys(),
    ...localEndpoints("full").keys(),
    ...ciEndpoints("repo-gate").keys(),
  ]);
  // indirect 例外必须用 via 证明「谁间接执行了它」，且该调用者确实出现在引用集里。
  // 不能把 exceptionKeys 整个并入 reachable——那样 indirect 就成了孤儿断言的万能消音器
  // （复核实测：登记一条假 indirect 即全绿）。
  const indirectVia = new Map(
    EXCEPTIONS.filter((e) => e.class === "indirect").map((e) => [e.endpoint, e.via]),
  );
  const orphans = [...refs.keys()]
    // 自引用（脚本在自己体内 spawnSync 自己）不算「被别人执行」
    .filter((script) => [...(refs.get(script) ?? [])].some((caller) => caller !== script))
    .filter((script) => !reachable.has(`script:${script}`))
    .filter((script) => {
      const via = indirectVia.get(`script:${script}`);
      if (typeof via !== "string") return true;
      return !(refs.get(script) ?? new Set()).has(via);
    })
    .map((script) => `${script}（被 ${[...(refs.get(script) ?? [])].sort().join(", ")} 引用）`)
    .sort();
  assert.deepEqual(orphans, [], "这些判据被引用却没有任何可见执行点：接线断言的盲区就是从这里来的");
});

test("A11：contract-check 内不得再以 spawnSync/execFileSync 数组 argv 内嵌判据", () => {
  // 4 条判据原先内嵌在 contract-check.ts 里以 spawnSync 执行——判据确实在跑，但任何 workflow
  // 与本地档位计划里都看不到它，于是「每条判据至少一个可见执行点」对它们恒为假。迁成直接步骤
  // 后由 A8 覆盖性守护；此处反向钉住「不得塞回去」。**不逐条列举**这 4 条：原实现只给
  // verify-shared-fanin 加了反向钉（verify-shared-fanin.test.ts），另外三条不对称——
  // 一条通用规则比四份互相抄的清单更难腐烂。
  const contract = readFileSync(join(ROOT, "scripts", "gate", "contract-check.ts"), "utf8");
  const embedded = [
    ...new Set(
      spawnTargets(contract)
        .map((p) => p.replace(/^\.\//, ""))
        .filter((p) => p.startsWith("scripts/gate/")),
    ),
  ];
  assert.deepEqual(
    embedded,
    [],
    "判据被内嵌进 contract-check：执行点重新变成不可见，接线断言再也看不见它",
  );
});

// ---------------------------------------------------------------- 五、覆盖性

/**
 * 执行点全集 E：全部 workflow 的全部 job ∪ 本地 pr/full 档 ∪ lefthook。
 *
 * 为什么要扩到全部 workflow：判据不只活在 repo-gate（observe / release / baseline-overlay /
 * health-report 各有执行点），只看 repo-gate 时脚本会「看起来没有任何执行点」（边界 B2）。lefthook
 * 用另一套缩进形状，理由见 extractLefthookSteps。除端点身份外还收命令内部的执行位：release.yml 的
 * `done < <(node …publish-if-missing.ts)` 主身份是 shell:done。
 */
let execPointsCache: Map<string, Endpoint> | null = null;
/** 执行点全集：把现场注入库函数（库只认参数，不认仓库）。 */
function executionPoints(): Map<string, Endpoint> {
  if (execPointsCache !== null) return execPointsCache;
  execPointsCache = collectExecutionPoints({
    workflowTexts: [...WORKFLOW_TEXTS.values()],
    scripts: SCRIPTS,
    localEndpoints,
    lefthookText: readFileSync(join(ROOT, "lefthook.yml"), "utf8"),
  });
  return execPointsCache;
}

const isSource = (name: string): boolean => /\.(mjs|cjs|ts)$/.test(name) && !name.endsWith(".d.ts");

/**
 * 判据面的**目录口径**（#843 M9 / #845 收口）：判据面 = 门禁系统以路径字符串直接执行的
 * 脚本所在目录，即：
 *   scripts/gate    —— 门禁本体与判据专用库（local-scope / gate-steps / test-surface …）；
 *   scripts/ci      —— CI 切片的执行位（ci-matrix / changed-test-packages）；
 *   scripts/release —— 发布与基线监控执行位（verify-version / publish-if-missing /
 *                      baseline-staleness / health-report-body）；
 *   tools           —— lint 判据的工具链入口（tools/lint/bin/lint.mjs）。
 *
 * 为什么口径是「会执行的脚本所在目录」而不是整棵 scripts/：这条绝对不变式问的是「磁盘上
 * 有没有一个判据既没人跑、也不被会跑的判据可达」。它只对**以路径字符串被调用**的脚本有
 * 说服力（取消调用只需删一行字符串，编译期看不见）；被 import 的库解不开这个局——
 * 删掉它，import 方会在 tsc 与 node 解析上响亮失败。据此分三类：
 *   - 进面：上列目录。#843 M9 实测的缺口正是本条：扩面之前 scripts/release/verify-version.ts
 *     与 health-report-body.mjs 有执行点却不在任何断言面内——删掉 release.yml 第 46 行或
 *     health-report.yml 第 72 行，全仓没有一条断言会红（其余 release / ci 脚本各有
 *     structuredSteps / stepEnvs / stepIfs 的悬空守卫兜住，这两条没有）。
 *   - 不进面：`scripts/lib`。除了「只被 import」这条普遍理由，它还有一条结构性原因：本面用
 *     **具名 import 可达**判定库，可达根是脚本执行点；`scripts/test/*.test.ts` 是
 *     `node --test <glob>` 的 tool 端点、没有逐文件身份，于是 test-only 库
 *     （gate-endpoints.mjs / gate-wiring-lib.ts）会恒判「无人依赖」；而把测试 import 当依赖
 *     又会打开「判据的偶然 import 即免死」的侧门（见 REACHABLE_LIBRARIES 注释）。该面另有一条
 *     不靠本面的兜底：`packageScopeDrift`（#853 引入）由 gate-scope-registry.test.ts 的确定性
 *     反例逐方向钉住——差集实现改成恒返回空也会失配，不脱管。
 *   - 不进面：`scripts/build` / `scripts/maintenance` / `scripts/test`。`scripts/build` 是**会
 *     被执行**的：各包 package.json 的 build 别名以路径字符串直调它（`node ../../scripts/build/clean-lib.ts`），
 *     形式上正是本面口径要覆盖的那种调用。它进不了面的原因在 harness 侧——执行点全集只来自 workflow ∪ 本地档位 ∪
 *     lefthook，而其中的 pnpm 别名展开也只覆盖根 package.json（`SCRIPTS`），**未建模各包
 *     package.json 的别名展开**，故实测 0/4 有执行点。这是建模边界，既不是「该目录没人执行」，
 *     也不能拿它当「已脱管」的证据。维护脚本按需手工执行，自测面的执行者是 glob。这三处是
 *     **已登记的口径边界**；「各包 build 必须含 clean-lib + bundle-host」要的是另一条形断言
 *     （#843 M9 的另一半），不在本面的论域内。
 *
 * 判据全集 G 机械派生自文件系统、不建登记表。收窄或放宽本口径 = 改 JUDGMENT_DIRS 这一行
 * 再加本段注释，是一次显式 diff（不是静默少扫一个目录）。
 */
const JUDGMENT_DIRS = ["scripts/gate", "scripts/ci", "scripts/release", "tools"];
function gateSources(): string[] {
  return JUDGMENT_DIRS.flatMap((dir) => walkRepo(dir, isSource)).sort();
}

const GATE_BY_BASE = new Map(gateSources().map((g) => [stripExt(g), g]));

/**
 * 「库」判定：从**有执行点的判据**与**台账 indirect 根**出发，沿 G 内部 import 边可达。
 * 四重收紧扣着四类洗白路径：
 *   1. 边只在 G 内部——外部文件的一句 import 不构成背书（E6e：追加到 scripts/lib/walk-files.ts）；
 *   2. 根必须是真正被执行的东西，或台账里 via 已被验证的 indirect；
 *   3. 传递闭包而不是一跳——避免「库 A 被库 B 引用、B 却没人跑」；
 *   4. import 必须**具名且该名字在文件里被引用**——纯副作用 import 只是免死金牌。
 * 残留边界：仍是语法级判定，不证明目标脚本的判据入口会被跑（彻底闭合需要调用图，属下一批）。
 */
const REACHABLE_LIBRARIES = ((): Set<string> => {
  const covered = coveredGatePaths(executionPoints());
  const indirectRoots = new Set(
    EXCEPTIONS.filter((e) => e.class === "indirect")
      .map((e) => e.endpoint.replace(/^script:/, "").split("|")[0])
      .filter((p) => GATE_BY_BASE.has(stripExt(p))),
  );
  // 根 = 真有执行点的判据 ∪ 台账里 via 已被验证的 indirect。注意不能把「未覆盖的判据」也当根，
  // 那样 seen 会被自己的根清空（实现时踩过：一度返回空集，六个库全被判成脱管）。
  const roots = new Set([...covered, ...indirectRoots]);
  const seen = new Set<string>();
  const queue = [...roots];
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i];
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const target of importedGateTargets(file, text, GATE_BY_BASE)) {
      if (seen.has(target) || roots.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
})();

test("A8：覆盖性——判据面（JUDGMENT_DIRS）每个判据要么有执行点，要么是库，要么登记 indirect", () => {
  // 「库」的判据不是「有谁 import 过它」，而是「它被某个**真的会跑的东西**可达」
  // （REACHABLE_LIBRARIES 的注释写了三重收紧与残留边界）。测试文件的偶然 import 尤其不能算：
  // 那会让判据看起来仍有依赖，B1 就从侧门复现。
  const sources = gateSources();
  // 载体自证：遍历失效会让这条断言在空集上静默全绿。
  // 用**锚点成员**而不是「文件数 ≥ N」：规模下限同时惩罚诚实的退役（删几个判据文件就假红），
  // 而它想拦的其实只有「遍历整体失效」。锚点取自本文件其它断言已经点名依赖的判据与台账条目——
  // 那两处数据本身受守卫，所以锚点集不会悄悄缩水。遍历失效会一次全掉，退役几个无关文件不受影响。
  const anchorSources = [
    ...ARTIFACT_GATES,
    ...EXCEPTIONS.map((e) => e.endpoint.replace(/^script:/, "").split("|")[0]).filter((p) =>
      JUDGMENT_DIRS.some((dir) => p.startsWith(dir + "/")),
    ),
  ];
  const missingAnchors = [...new Set(anchorSources)].filter((a) => !sources.includes(a));
  assert.deepEqual(
    missingAnchors,
    [],
    "判据全集里缺锚点文件：JUDGMENT_DIRS 的目录遍历是否失效？（" + sources.length + " 个文件）",
  );
  const coveredPaths = coveredGatePaths(executionPoints());
  const covered = sources.filter((g) => coveredPaths.has(g));
  // 执行点扫描同样钉锚点：产物闸与判定脚本都在 repo-gate 恒跑段，扫描失效会一次全掉。
  const missingCovered = [
    ...new Set([
      ...ARTIFACT_GATES,
      "scripts/gate/repo-gate-assert.mjs",
      "scripts/gate/threshold-monotonic.mjs",
    ]),
  ].filter((a) => !coveredPaths.has(a));
  assert.deepEqual(
    missingCovered,
    [],
    "有执行点的判据集合里缺锚点：执行点扫描是否失效？（当前 " + covered.length + " 个有执行点）",
  );
  const exempt = new Set(
    EXCEPTIONS.filter((e) => e.class === "indirect").map(
      (e) => e.endpoint.replace(/^script:/, "").split("|")[0],
    ),
  );
  const unclassified = sources.filter(
    (g) => !coveredPaths.has(g) && !REACHABLE_LIBRARIES.has(g) && !exempt.has(g),
  );
  assert.deepEqual(
    unclassified,
    [],
    "下列判据既无执行点、又不被（会跑的）判据可达地 import、也未登记 indirect——" +
      "它们可以静默脱管（两侧同时删掉执行点即全绿）：\n" +
      unclassified.join("\n"),
  );
});

/**
 * via=package.json 的间接执行核对：先证「有别名指向该判据」，再证「有人真的引用这个别名」。
 * 判词全部由调用方累积，命中即返回（本分支不落到下面的文件级 import / spawn 核对）。
 */
function checkPackageJsonVia(e: { endpoint: string }, target: string, bad: string[]): void {
  const aliases = Object.entries(SCRIPTS)
    .filter(([, cmd]) => endpointOf(cmd, SCRIPTS)?.id?.split("|")[0] === target)
    .map(([name]) => name);
  if (aliases.length === 0) {
    bad.push(e.endpoint + " 声称由 package.json 的别名执行，但没有别名指向它");
    return;
  }
  // 「有别名指向它」只证明**入口存在**，不证明有人走这个入口：把别名登记进 package.json
  // 而仓库里没有任何 workflow / hook / 文档提到它，等于一条谁都不执行的假接线
  // （对抗复核实测：这类 indirect 条目原先只查指向，删掉全部执行者仍然全绿）。
  // 出处取「会真的跑它的地方」+「写明人类入口的文档」；台账自身与 package.json 不算出处，
  // 否则条目里的理由文本会自证成立。
  const cited = aliases.filter((a) => aliasCitations(a).length > 0);
  if (cited.length === 0) {
    bad.push(
      e.endpoint +
        ` 的别名（${aliases.join(", ")}）在仓库里没有任何出处：workflow / hook / 文档都没提到它` +
        "——它是一条谁都不执行的假接线",
    );
  }
}

test("A8b：indirect 的 via 必须真的能到达该判据（台账可以说谎就等于没有断言）", () => {
  const bad: string[] = [];
  for (const e of EXCEPTIONS.filter((x) => x.class === "indirect")) {
    const via = e.via;
    if (typeof via !== "string" || via.trim() === "") {
      bad.push(e.endpoint + " 标 indirect 却没写 via");
      continue;
    }
    if (!e.endpoint.startsWith("script:")) continue;
    const target = e.endpoint.slice("script:".length).split("|")[0];
    if (via === "package.json") {
      checkPackageJsonVia(e, target, bad);
      continue;
    }
    if (!existsSync(join(ROOT, via))) {
      bad.push(e.endpoint + " 的 via 指向不存在的文件：" + via);
      continue;
    }
    // 「能到达」必须是代码里的引用，不是文字里的提及：先把注释与字符串都排掉，再要求
    // spawnSync / execFileSync 的 **argv 字面量**里精确出现目标路径。
    // 原实现是「spawnSync 之后 800 字符内文本包含路径」——注释、模板字符串、恰好路过的变量名
    // 都能满足（复核连续两轮各给了一条）。
    const text = readFileSync(join(ROOT, via), "utf8");
    const imported = importedGateTargets(via, text, GATE_BY_BASE).includes(target);
    const spawned = spawnTargets(text).some(
      (arg) => arg.replace(/^\.\//, "") === target || arg.endsWith("/" + target.split("/").pop()),
    );
    if (!imported && !spawned) {
      bad.push(e.endpoint + " 声称由 " + via + " 间接执行，但该文件既未 import 也未 spawn 它");
    }
  }
  assert.deepEqual(bad, [], "indirect 例外的 via 无法成立");
});

test("A8c：命令内部的执行位（进程替换）也必须可见", () => {
  // release.yml 的 `done < <(node scripts/release/publish-if-missing.ts)`：主身份是 shell:done，
  // 执行位藏在进程替换里。补上 embeddedExecutions 之前它被归成脚手架，于是「判据在跑」与
  // 「判据不存在」在执行点全集里没有区别。
  // 下面这条路径是**刻意的硬编码契约**：release.yml 的发布链路就这一个进程替换执行位，
  // 换脚本要同时改这里——一次可见的摩擦换「这条形态被真的钉住」。
  assert.deepEqual(embeddedExecutions("done < <(node scripts/release/publish-if-missing.ts)"), [
    "scripts/release/publish-if-missing.ts",
  ]);
  assert.ok(
    executionPoints().has("script:scripts/release/publish-if-missing.ts"),
    "本仓真实快照：release.yml 的进程替换执行位必须进执行点全集",
  );
  // 反向：字符串参数里的路径是数据引用而不是执行位——ci.yml 的
  // FILTERS=$(node -e "import('scripts/test/script-test-prereqs.mjs')") 不能被算成执行点。
  assert.deepEqual(embeddedExecutions("FILTERS=$(node -e \"import('scripts/test/x.mjs')\")"), []);
});

test("A8d：恒假的 job / 步骤不算执行点（decoy 不能顶替被删掉的判据）", () => {
  // 死条件过滤是**独立**的不变量，故用合成 workflow 直接钉住：
  //   - 若把死代码算作执行点，删掉真实执行点后加一个 `if: false` 的步骤即可让覆盖性与 A14 同时满足；
  //   - 恒真（`if: true`）同样不是闸的常态（它在任何事件下都跑），一并剔除。
  // 语法级的 decoy（非恒假但永不成立的上下文比较）静态判不出，由 stepIfs / jobIfs 的逐字登记兜住。
  const yaml = [
    "jobs:",
    "  dead-job:",
    "    if: false",
    "    steps:",
    "      - run: node scripts/gate/crap-check.mjs",
    "  dead-step:",
    "    steps:",
    "      - if: ${{ 0 }}",
    "        run: node scripts/gate/observe-check.mjs",
    "      - run: node scripts/gate/mutation-plan.mjs",
  ].join("\n");
  const points = collectExecutionPoints({
    workflowTexts: [yaml],
    scripts: SCRIPTS,
    localEndpoints: () => new Map(),
    lefthookText: "",
  });
  assert.deepEqual(
    [...points.keys()].sort(),
    ["script:scripts/gate/mutation-plan.mjs"],
    "恒假 job / 恒假步骤里的判据不得进执行点全集",
  );
  assert.equal(isDeadCondition("false"), true);
  assert.equal(isDeadCondition("${{ 0 }}"), true);
  assert.equal(isDeadCondition("success()"), false);
  assert.equal(isDeadCondition(null), false);
});

test("A9：产物闸在 CI 侧必须同时存在切片与全仓两种形态（#722 口径不被单侧删掉）", () => {
  // 为什么 --packages 的取值不进身份：CI 默认走切片、本地 gate:pr/full 走全仓，这是**真实的
  // 口径差异**而不是缺陷；把取值纳入身份只会产生一批「合法例外」，把台账变成消音器。
  // 改为形态断言：两种口径必须都在——删掉 else 分支（切片路径消失）或删掉 if 分支（全仓路径
  // 消失）都判红，而这两种删法都不会让任何一条只比对脚本路径的断言变红。
  // 恒假分支里的调用不算形态：把全仓调用换成一段 if false; then … fi 之后，文本上「两种形态
  // 都在」而实际一种都不跑（复核实测）。可达性判定与 A6b 共用同一套行级跟踪。
  const cmds: string[] = [];
  for (const [key, step] of judgmentSteps()) {
    if (!key.startsWith("ci.yml|repo-gate|")) continue;
    cmds.push(...stripDeadBranchCommands(step.cmds));
  }
  const bad: string[] = [];
  for (const gate of ARTIFACT_GATES) {
    const callers = cmds.filter((c) => endpointOf(c, SCRIPTS)?.id.split("|")[0] === gate);
    if (callers.length === 0) {
      bad.push(gate + " 在 CI repo-gate 没有任何调用点");
      continue;
    }
    if (!callers.some((c) => c.includes("--packages"))) {
      bad.push(gate + " 没有带 --packages 的切片调用：默认增量路径消失");
    }
    if (!callers.some((c) => !c.includes("--packages"))) {
      bad.push(gate + " 没有不带 --packages 的全仓调用：gate:full 路径消失");
    }
  }
  assert.deepEqual(bad, [], "产物闸口径只剩一种：CI 会悄悄退化成全仓或只剩切片");
});
