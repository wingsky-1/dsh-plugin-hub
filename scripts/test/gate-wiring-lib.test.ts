/**
 * scripts/test/gate-wiring-lib.test.ts — 判定层的独立单测（审计 P0-1）。
 *
 * 为什么需要：scripts/lib/gate-wiring-lib.ts 决定「什么算同一个判据」「什么条件算恒假」「一条
 * import 算不算有人依赖」。这些判断原先写在 gate-wiring.test.ts 里，只能靠「仓库当前长什么样」
 * 间接验证——逻辑被改错时表现为断言变绿，而变绿不会引起注意。这里用**构造输入**把每条判据直接
 * 钉住，不依赖仓库形态；gate-wiring.test.ts 只负责把本库接到真实仓库上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dangerousStepEnv,
  envLayers,
  jobLevelFace,
  endpointOf,
  extractJobIf,
  extractJobs,
  extractLefthookSteps,
  extractRunSteps,
  hasUnbalancedQuotes,
  isSafeShellOverride,
  leadingAssignmentNames,
  parseIssues,
  shellDefaults,
  stripLineComment,
  usesSteps,
  swallowsExitCode,
} from "../lib/gate-endpoints.mjs";
import { parseTs } from "../lib/config-matrix-lib.ts";
import {
  collectExecutionPoints,
  collectSpecifiers,
  collectStringLiterals,
  coveredGatePaths,
  importedGateTargets,
  isConstantCondition,
  isJudgment,
  judgmentKeysIn,
  isDeadCondition,
  jobFaceOf,
  priorRunStepsOf,
  spawnTargets,
  stepDigest,
  stepKeyOf,
  stepsOf,
  stripExt,
  walkRepo,
} from "../lib/gate-wiring-lib.ts";

const NO_SCRIPTS: Record<string, string> = {};

test("isJudgment：只有 script / tool 两端点算判据，脚手架与未归一都不算", () => {
  assert.equal(isJudgment("script:scripts/gate/a.mjs"), true);
  assert.equal(isJudgment("tool:prettier|--check,."), true);
  assert.equal(isJudgment("shell:set"), false);
  assert.equal(isJudgment("alias:install"), false);
  assert.equal(isJudgment("pkg-filter:pnpm:flags"), false);
  assert.equal(isJudgment("unknown:some-thing"), false);
});

test("isConstantCondition：白名单命中即非常量，自比与矛盾合取判常量", () => {
  const constant = ["false", "0", "$" + "{{ 0 }}"];
  constant.push(
    "github.event_name != github.event_name",
    "needs.changes.outputs.fullGate == 'true' && needs.changes.outputs.fullGate != 'true'",
  );
  for (const c of constant) assert.equal(isConstantCondition(c), true, c + " 应判为常量");
  const dynamic = [
    "always()",
    "!cancelled()",
    "always() && needs.changes.result == 'success'",
    "github.event_name == 'pull_request'",
    "github.event_name == 'pull_request' && needs.changes.outputs.fullGate == 'true'",
    "needs.changes.outputs.hasMutations == 'true' || failure()",
  ];
  for (const c of dynamic) assert.equal(isConstantCondition(c), false, c + " 应判为动态");
});

test("isConstantCondition：已知边界——上下文与字面量的比较静态判不出，故按动态放行", () => {
  // 这条不是缺陷声明而是**边界声明**：把 github.repository 换成永不匹配的仓库名同样命中白名单。
  // 正因为静态判不出真假，job 级 if 才走「逐字登记」而不是「判定真假」（见 A6c）。
  assert.equal(isConstantCondition("github.repository == 'never/match'"), false);
});

test("stepKeyOf：键 = 文件 + 作业 + 判据路径集合，任一变化都必须改变键", () => {
  const cmds = ["node scripts/gate/a.mjs", "node scripts/gate/b.mjs"];
  const base = stepKeyOf(NO_SCRIPTS, "ci.yml", "repo-gate", cmds);
  assert.equal(base, "ci.yml|repo-gate|script:scripts/gate/a.mjs,script:scripts/gate/b.mjs");
  assert.equal(stepKeyOf(NO_SCRIPTS, "ci.yml", "repo-gate", [...cmds].reverse()), base);
  assert.notEqual(stepKeyOf(NO_SCRIPTS, "observe.yml", "repo-gate", cmds), base);
  assert.notEqual(stepKeyOf(NO_SCRIPTS, "ci.yml", "mutation-gate", cmds), base);
  assert.notEqual(stepKeyOf(NO_SCRIPTS, "ci.yml", "repo-gate", [cmds[0]]), base);
  // 步骤内部多写一行脚手架不改变键（那一层由逐行形态检查接管）
  assert.equal(stepKeyOf(NO_SCRIPTS, "ci.yml", "repo-gate", ["set -e", ...cmds, "echo ok"]), base);
  // 进程替换里的执行位也是判据
  assert.equal(
    stepKeyOf(NO_SCRIPTS, "release.yml", "publish", [
      "done < <(node scripts/release/publish-if-missing.ts)",
    ]),
    "release.yml|publish|script:scripts/release/publish-if-missing.ts",
  );
});

test("stepsOf：按 stepIndex 归组，并认两种合法的步骤写法（换行 run 与行内 run）", () => {
  const twoLine = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: node scripts/gate/a.mjs",
    "      - run: |",
    "          set -e",
    "          node scripts/gate/b.mjs",
    "",
  ].join("\n");
  const steps = stepsOf(twoLine, "demo.yml", "demo", NO_SCRIPTS);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0].cmds, ["node scripts/gate/a.mjs"]);
  assert.deepEqual(steps[1].cmds, ["set -e", "node scripts/gate/b.mjs"]);
  assert.equal(steps[0].key, "demo.yml|demo|script:scripts/gate/a.mjs");
  assert.equal(steps[1].key, "demo.yml|demo|script:scripts/gate/b.mjs");
  // 行内写法：漏认会让整条步骤从解析结果里消失（判据还在跑，却没人管）
  const inline = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - run: node scripts/gate/c.mjs",
    "",
  ].join("\n");
  assert.deepEqual(
    stepsOf(inline, "demo.yml", "demo", NO_SCRIPTS).map((s) => s.cmds),
    [["node scripts/gate/c.mjs"]],
  );
});

test("judgmentKeysIn：恒假分支剥壳后才看得见判据，进程替换里的执行位也收", () => {
  const wrapped = ["if false; then node scripts/gate/a.mjs; fi"];
  assert.deepEqual(judgmentKeysIn(NO_SCRIPTS, wrapped, false), []);
  assert.deepEqual(judgmentKeysIn(NO_SCRIPTS, wrapped, true), ["script:scripts/gate/a.mjs"]);
  assert.deepEqual(judgmentKeysIn(NO_SCRIPTS, ["done < <(node scripts/release/x.ts)"], false), [
    "script:scripts/release/x.ts",
  ]);
  assert.deepEqual(judgmentKeysIn(NO_SCRIPTS, ["set -e", "echo ok"], false), []);
});

test("stripExt：只去脚本扩展名", () => {
  assert.equal(stripExt("scripts/gate/a.mjs"), "scripts/gate/a");
  assert.equal(stripExt("scripts/gate/a.ts"), "scripts/gate/a");
  assert.equal(stripExt("scripts/gate/a.d.ts"), "scripts/gate/a.d");
});

test("collectSpecifiers：收静态 import / export-from，具名绑定，不收动态 import", () => {
  // 注意 esbuild 的 TS 转译会**消除未被使用的 import**，故「具名」这一条必须真的引用它；
  // 这也意味着 importedGateTargets 里的「名字被引用过」检查与转译行为是两层，不是一层。
  const source = [
    'import { a } from "./one.mjs";',
    "a();",
    'import "./two.mjs";',
    'export * from "./three.mjs";',
    'export async function f() { return import("./four.mjs"); }',
  ].join("\n");
  const ast = parseTs(source, "ts") as { body: unknown };
  const edges: { source: string; locals: string[] }[] = [];
  collectSpecifiers(ast.body, edges);
  const bySource = new Map(edges.map((e) => [e.source, e.locals]));
  assert.deepEqual(bySource.get("./one.mjs"), ["a"]);
  assert.deepEqual(bySource.get("./two.mjs"), []);
  assert.deepEqual(bySource.get("./three.mjs"), []);
  assert.equal(bySource.has("./four.mjs"), false, "动态 import 不是模块求值边");
});

test("collectStringLiterals：递归收集子树里的全部字符串字面量", () => {
  const ast = parseTs('const a = { x: ["p", "q", 1, true] };', "ts");
  const out: string[] = [];
  collectStringLiterals(ast, out);
  assert.deepEqual(out.sort(), ["p", "q"]);
});
test("spawnTargets：只认数组形态 argv 的字面量，字符串形态与字符串里的假调用都不算", () => {
  const real = [
    "const r = spawnSync(process.execPath, [",
    '  "scripts/gate/b.mjs",',
    '  "--check",',
    "], { encoding: 'utf8' });",
  ].join("\n");
  // 收的是**数组 argv 里的全部字符串字面量**（含 flag）：调用方按前缀筛选，库不替它做判断。
  assert.deepEqual(spawnTargets(real), ["scripts/gate/b.mjs", "--check"]);
  assert.deepEqual(spawnTargets('spawnSync("node", "scripts/gate/b.mjs");'), []);
  const decoy = 'const s = "spawnSync(process.execPath, [\\"scripts/gate/b.mjs\\"])";';
  assert.deepEqual(spawnTargets(decoy), [], "字符串里写着调用不等于调用");
});

test("importedGateTargets：具名且被引用才算依赖；纯副作用 / 未使用 / 自引用都不算", () => {
  const gateByBase = new Map([
    ["scripts/gate/a", "scripts/gate/a.mjs"],
    ["scripts/gate/b", "scripts/gate/b.mjs"],
  ]);
  const imported = (file: string, lines: string[]): string[] =>
    importedGateTargets(file, lines.join("\n"), gateByBase);
  const A = "scripts/gate/a.ts";
  assert.deepEqual(imported(A, ['import { helper } from "./b.mjs";', "helper();"]), [
    "scripts/gate/b.mjs",
  ]);
  assert.deepEqual(
    imported(A, ['import "./b.mjs";']),
    [],
    "纯副作用 import 没有任何调用点，不构成背书",
  );
  assert.deepEqual(
    imported(A, ['import { helper } from "./b.mjs";']),
    [],
    "导入了却没用，同样不是依赖",
  );
  assert.deepEqual(
    imported(A, ['import type { T } from "./b.mjs";', "const x: T = 1;", "void x;"]),
    [],
    "type-only import 在转译时被丢弃，不构成运行期依赖",
  );
  assert.deepEqual(
    imported("scripts/gate/b.mjs", ['import { helper } from "./b.mjs";', "helper();"]),
    [],
    "自引用不算「被别人执行」",
  );
  assert.deepEqual(
    imported(A, ['import { helper } from "../lib/other.mjs";', "helper();"]),
    [],
    "目标不在判据全集内就不是判据依赖",
  );
});

test("collectExecutionPoints：收全部 job 的执行点、本地档位与 lefthook；进程替换可见", () => {
  const workflowTexts = [
    [
      "jobs:",
      "  demo:",
      "    steps:",
      "      - name: A",
      "        run: node scripts/gate/a.mjs",
      "      - name: B",
      "        run: |",
      "          set -e",
      "          done < <(node scripts/release/x.ts)",
      "",
    ].join("\n"),
  ];
  const lefthookText = [
    "pre-commit:",
    "  jobs:",
    "    - name: lint-staged（仅本次 staged 的源文件）",
    "      run: pnpm exec lint-staged",
    "",
  ].join("\n");
  const prOnly = new Map([
    ["script:scripts/gate/local.mjs", { kind: "script", id: "scripts/gate/local.mjs" }],
  ]);
  const points = collectExecutionPoints({
    workflowTexts,
    scripts: NO_SCRIPTS,
    localEndpoints: (tier) => (tier === "pr" ? prOnly : new Map()),
    lefthookText,
  });
  assert.ok(points.has("script:scripts/gate/a.mjs"), "workflow 里的判据要进全集");
  assert.ok(points.has("script:scripts/release/x.ts"), "进程替换里的执行位也要进全集");
  assert.ok(points.has("script:scripts/gate/local.mjs"), "本地档位的判据要进全集");
  assert.ok(points.has("alias:lint-staged"), "lefthook 的执行点要进全集");
  const covered = coveredGatePaths(points);
  assert.ok(covered.has("scripts/gate/a.mjs"));
  assert.ok(covered.has("scripts/gate/local.mjs"));
  // 库不做目录过滤：脚本路径一律收进来，「是不是判据」由调用方拿判据全集求交（见 A8）。
  assert.ok(covered.has("scripts/release/x.ts"));
});

test("coveredGatePaths：身份摘要带 --package 差异时必须塌缩回路径", () => {
  const points = new Map([
    ["tool:node:test|--test", { kind: "tool", id: "node:test|--test" }],
    ["script:scripts/gate/verify-dir-imports.mjs|a", { kind: "script", id: "x" }],
  ]);
  assert.deepEqual([...coveredGatePaths(points)], ["scripts/gate/verify-dir-imports.mjs"]);
});

test("walkRepo：返回以给定目录为前缀的相对路径，且递归子目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-wiring-lib-"));
  try {
    mkdirSync(join(dir, "scripts", "gate", "sub"), { recursive: true });
    writeFileSync(join(dir, "scripts", "gate", "a.mjs"), "// a\n");
    writeFileSync(join(dir, "scripts", "gate", "sub", "b.ts"), "// b\n");
    writeFileSync(join(dir, "scripts", "gate", "c.txt"), "x\n");
    assert.deepEqual(
      walkRepo(dir, "scripts/gate", (n) => n.endsWith(".mjs")),
      ["scripts/gate/a.mjs"],
    );
    assert.deepEqual(walkRepo(dir, "scripts/gate", (n) => /\.(mjs|ts)$/.test(n)).sort(), [
      "scripts/gate/a.mjs",
      "scripts/gate/sub/b.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("YAML 语义：if / continue-on-error / run 的引号与空格变体都被识别", () => {
  // 独立对抗复核实测的绕过：\"if\": / 'if': / if : 在 GHA 里与 if: 是同一个键，而逐行正则
  // 看不见——判据在 CI 永不执行，全套断言仍绿。真解析器按 YAML 语义处理，不需要枚举写法。
  const yaml = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        \"if\": github.repository == 'never/match'",
    "        run: node scripts/gate/a.mjs",
    "      - name: B",
    "        'continue-on-error': true",
    "        run: node scripts/gate/b.mjs",
    "      - name: C",
    "        run : node scripts/gate/c.mjs",
    "",
  ].join("\n");
  const steps = extractRunSteps(yaml, "demo");
  assert.equal(steps[0].ifCond, "github.repository == 'never/match'");
  assert.equal(steps[1].continueOnError, true);
  assert.deepEqual(
    steps.map((s) => s.cmd),
    ["node scripts/gate/a.mjs", "node scripts/gate/b.mjs", "node scripts/gate/c.mjs"],
  );
});

test("YAML 语义：块标量里的列表符是命令内容，不是新步骤", () => {
  // 复核实测的绕过：手写解析器按「任意缩进的 - 」切步骤，于是续行参数被切出视野——
  // 判据照跑，而参数被悄悄加上（- --soft 让硬判集合降级为软报告，全套断言仍绿）。
  const yaml = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: |",
    "          node scripts/gate/a.mjs --package x \\",
    "          - --soft",
    "",
  ].join("\n");
  const steps = extractRunSteps(yaml, "demo");
  assert.equal(steps.length, 1, "整段是一条步骤");
  assert.deepEqual(
    steps.map((s) => s.cmd),
    ["node scripts/gate/a.mjs --package x - --soft"],
  );
});

test("YAML 语义：折叠标量按 YAML 折叠，缩进指示符与 chomping 都由解析器处理", () => {
  const folded = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: >-",
    "          node scripts/gate/a.mjs",
    "          --package x",
    "",
  ].join("\n");
  assert.deepEqual(
    extractRunSteps(folded, "demo").map((s) => s.cmd),
    ["node scripts/gate/a.mjs --package x"],
  );
  const indented = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: |2-",
    "            node scripts/gate/a.mjs",
    "",
  ].join("\n");
  assert.deepEqual(
    extractRunSteps(indented, "demo").map((s) => s.cmd),
    ["node scripts/gate/a.mjs"],
  );
});

test("YAML 语义：flow 写法被正确理解；未建模的键 / 重复键 / 语法错误一律报出来", () => {
  // flow 写法在真解析器下就是普通映射——不再需要「认不出就报」的兜底，它本来就能读懂。
  const flow = ["jobs:", "  demo:", "    steps:", "      - { name: A, run: node x.mjs }", ""].join(
    "\n",
  );
  assert.deepEqual(parseIssues(flow, "demo"), []);
  assert.deepEqual(
    extractRunSteps(flow, "demo").map((s) => s.cmd),
    ["node x.mjs"],
    "flow 写法的 run 必须被取到（手写正则时代它会整条消失）",
  );
  const unknownKey = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: node x.mjs",
    "        retries: 3",
    "",
  ].join("\n");
  assert.deepEqual(parseIssues(unknownKey, "demo"), ["第 1 个步骤：解析层未建模的键「retries」"]);
  const duplicate = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - name: A",
    "        run: node x.mjs",
    "        run: node y.mjs",
    "",
  ].join("\n");
  assert.ok(parseIssues(duplicate, "demo").length > 0, "重复键必须报出来（GHA 同样拒绝）");
  const broken = ["jobs:", "  demo:", "    steps:", "      - name: A", "       run: x", ""].join(
    "\n",
  );
  assert.ok(parseIssues(broken, "demo").length > 0, "YAML 语法错误必须报出来");
});

test("YAML 语义：job 级 if、job 枚举与 lefthook 都按映射取，不受行形态影响", () => {
  const yaml = [
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    if: needs.changes.result == 'success'",
    "    steps:",
    "      - run: node x.mjs",
    "  other:",
    "    steps:",
    "      - run: node y.mjs",
    "",
  ].join("\n");
  // 顶层 on: 不是 job（手写解析器靠缩进猜时有造出幽灵 job 的风险）
  assert.deepEqual(extractJobs(yaml), ["build", "other"]);
  assert.equal(extractJobIf(yaml, "build"), "needs.changes.result == 'success'");
  assert.equal(extractJobIf(yaml, "other"), null);
  const lefthook = [
    "pre-commit:",
    "  jobs:",
    "    - name: lint-staged",
    "      run: pnpm exec lint-staged",
    "commit-msg:",
    "  jobs:",
    "    - run: |",
    "        pnpm exec commitlint --edit x",
    "",
  ].join("\n");
  assert.deepEqual(
    extractLefthookSteps(lefthook).map((s) => s.cmd),
    ["pnpm exec lint-staged", "pnpm exec commitlint --edit x"],
  );
});

test("YAML 语义：锚点可用，合并键按「未建模」判红（GHA 不支持合并键）", () => {
  // 普通锚点 / 别名 GHA 支持，解析器照常处理。\`<<: *base\` 是 YAML 的**合并键**，GHA 不支持：
  // 按「解析层未建模的键」判红，比我们自己把 \`<<\` 展开更安全——后者会放行「作者以为生效、
  // 实际不生效」的写法。
  const yaml = [
    "jobs:",
    "  demo:",
    "    steps:",
    "      - &base",
    "        name: A",
    "        run: node scripts/gate/a.mjs",
    "      - <<: *base",
    "        if: github.repository == 'never/match'",
    "",
  ].join(String.fromCharCode(10));
  const steps = extractRunSteps(yaml, "demo");
  assert.deepEqual(
    steps.map((s) => s.cmd),
    ["node scripts/gate/a.mjs"],
    "被合并键引用的那一步没有自己的 run，取不到命令",
  );
  assert.equal(steps[0].ifCond, null);
  assert.deepEqual(parseIssues(yaml, "demo"), ["第 2 个步骤：解析层未建模的键「<<」"]);
});

test("isSafeShellOverride：只拦明确削弱 errexit 的 shell 模板", () => {
  // GHA 默认是 bash -e {0}。内建关键字 bash / sh 被展开成更强或同强的模板；自定义 shell 模板
  // 则「写什么就是什么」——不带 -e 就等于关掉 errexit，必须判红。非 shell 家族静态判不了，放行。
  const safe = [
    "",
    "bash",
    "sh",
    "bash -e {0}",
    "bash --noprofile --norc -eo pipefail {0}",
    "python",
    "pwsh",
  ];
  for (const s of safe) assert.equal(isSafeShellOverride(s), true, s + " 应放行");
  const unsafe = ["bash +e {0}", "bash +ex {0}", "bash +o errexit {0}", "bash -x {0}"];
  for (const s of unsafe)
    assert.equal(isSafeShellOverride(s), false, s + " 应判红：它削弱了退出码语义");
});

test("shellDefaults：workflow 级与 job 级 defaults.run.shell 都能读出来", () => {
  // 一行 defaults 就能对所有 run 步骤关掉 errexit，而步骤自己一个 shell: 都没写——只看步骤级
  // 覆盖会让这条旁路完全不可见（独立对抗复核实测）。
  const yaml = [
    "defaults:",
    "  run:",
    "    shell: bash +e {0}",
    "jobs:",
    "  demo:",
    "    defaults:",
    "      run:",
    "        shell: bash -e {0}",
    "    steps:",
    "      - run: node x.mjs",
    "  other:",
    "    steps:",
    "      - run: node y.mjs",
    "",
  ].join(String.fromCharCode(10));
  assert.deepEqual(shellDefaults(yaml, "demo"), { workflow: "bash +e {0}", job: "bash -e {0}" });
  assert.deepEqual(shellDefaults(yaml, "other"), { workflow: "bash +e {0}", job: null });
});

test("isDeadCondition：恒假与恒真都算「不是正常闸」，运行时条件不算", () => {
  assert.equal(isDeadCondition("false"), true);
  assert.equal(isDeadCondition("${{ 0 }}"), true);
  assert.equal(isDeadCondition("github.repository == 'never/match'"), false);
  assert.equal(isDeadCondition("always()"), false);
  assert.equal(isDeadCondition(null), false);
  assert.equal(isDeadCondition(undefined), false);
});

test("stepDigest：钉住步骤文本，行内空白与空行归一，任何一行改动都改变摘要", () => {
  const base = ["set -e", "node scripts/gate/x.mjs"];
  assert.match(stepDigest(base), /^[0-9a-f]{16}$/);
  assert.equal(stepDigest(["set -e", "node scripts/gate/x.mjs"]), stepDigest(base));
  // 空行与行尾空白不改变「逻辑文本」（与解析层切行口径一致）
  assert.equal(stepDigest(["set -e", "", "node scripts/gate/x.mjs  "]), stepDigest(base));
  // 但**多一条命令**必须改变摘要——这正是 `break` / `continue` / `exit 0` 这类改动的可见性来源
  assert.notEqual(stepDigest(["set -e", "break", "node scripts/gate/x.mjs"]), stepDigest(base));
  assert.notEqual(stepDigest(["set +e", "node scripts/gate/x.mjs"]), stepDigest(base));
});

test("stripLineComment：引号感知——引号内的 # 不是注释，未配对引号不切", () => {
  assert.equal(stripLineComment("pnpm lint # 说明"), "pnpm lint");
  assert.equal(stripLineComment("node x.mjs --tag #issue"), "node x.mjs --tag");
  // 对抗复核的 P0：` #` 在双引号内，`|| true` 是**会执行**的代码，不能连同注释一起切掉。
  assert.equal(
    stripLineComment('pnpm lint --packages "" " #" || true'),
    'pnpm lint --packages "" " #" || true',
  );
  assert.equal(stripLineComment("node x.mjs --msg 'a # b'"), "node x.mjs --msg 'a # b'");
  assert.equal(hasUnbalancedQuotes('node x.mjs --msg "abc'), true);
  assert.equal(hasUnbalancedQuotes('node x.mjs --msg "abc"'), false);
});

test("splitCommands：单引号里的反斜杠续行不是续行（两条命令的文本必须区分开）", () => {
  const wrap = (rows: string[]): string =>
    ["jobs:", "  j:", "    steps:", "      - run: |"]
      .concat(rows.map((l) => "          " + l))
      .join("\n");
  const BS = String.fromCharCode(92);
  const flat = extractRunSteps(wrap(["node scripts/gate/x.mjs --msg 'a b'"]), "j").map(
    (s) => s.cmd,
  );
  const continued = extractRunSteps(
    wrap(["node scripts/gate/x.mjs --msg 'a " + BS, "b'"]),
    "j",
  ).map((s) => s.cmd);
  assert.deepEqual(flat, ["node scripts/gate/x.mjs --msg 'a b'"]);
  assert.notDeepEqual(continued, flat, "单引号内的反斜杠 + 换行是字面量，不能被当成续行合并掉");
});

test("splitCommands：续行的前导空白必须保留（bash 只删反斜杠 + 换行，不删空白）", () => {
  const BS = String.fromCharCode(92);
  const wrap2 = (cont: string): string =>
    ["jobs:", "  j:", "    steps:", "      - run: |"]
      .concat(["          pnpm lint --so" + BS, "          " + cont])
      .join("\n");
  const tight = extractRunSteps(wrap2("ft"), "j")[0].cmd;
  const loose = extractRunSteps(wrap2("   ft"), "j")[0].cmd;
  // `--so` + 换行 + `ft` 在 bash 里是一个词（续行反斜杠被删掉）；多几个前导空白就是两个词。
  assert.equal(tight, "pnpm lint --soft");
  assert.equal(loose, "pnpm lint --so   ft");
  // 摘要也一样必须区分：否则两种文本可以互换而不动台账（对抗复核实测的残差）。
  assert.notEqual(
    stepDigest(extractRunSteps(wrap2("   ft"), "j")[0].rawLines),
    stepDigest(extractRunSteps(wrap2("ft"), "j")[0].rawLines),
  );
});

test("endpointOf：env / command 前缀与 `cd … &&` 载体不改变被执行者", () => {
  const scripts = { lint: "node tools/lint/bin/lint.mjs" };
  assert.deepEqual(endpointOf("env FOO=1 node scripts/gate/x.mjs", scripts), {
    kind: "script",
    id: "scripts/gate/x.mjs",
  });
  assert.deepEqual(endpointOf("command node scripts/gate/x.mjs", scripts)?.kind, "script");
  assert.deepEqual(
    endpointOf("cd ./packages/dsh-notifier && node scripts/gate/x.mjs", scripts)?.id,
    "scripts/gate/x.mjs",
  );
  assert.deepEqual(endpointOf("cd . && pnpm lint", scripts), {
    kind: "script",
    id: "tools/lint/bin/lint.mjs",
  });
});

test("isSafeShellOverride：前缀与绝对路径不能绕过家族判定，模板必须把 {0} 交给解释器", () => {
  for (const s of [
    "/bin/bash -e {0}",
    "/usr/bin/env bash -eo pipefail {0}",
    "command bash -e {0}",
  ]) {
    assert.equal(isSafeShellOverride(s), true, s + " 应放行");
  }
  const unsafe = [
    "/bin/bash +e {0}",
    "env bash +e {0}",
    "/usr/bin/env bash +e {0}",
    "/bin/sh +e {0}",
    "/bin/bash -c 'exit 0' {0}",
    "python -c 'exit 0'",
    "/bin/bash",
    "bash --noprofile {0}",
  ];
  for (const s of unsafe) assert.equal(isSafeShellOverride(s), false, s + " 应判红");
});

test("swallowsExitCode：exit $? 传播失败；花括号组与 command 前缀的 exit 0 仍判红", () => {
  assert.equal(swallowsExitCode("node scripts/gate/x.mjs; exit $?"), false);
  assert.equal(swallowsExitCode("node scripts/gate/x.mjs || exit $?"), false);
  assert.equal(swallowsExitCode("node scripts/gate/x.mjs || exit 1"), false);
  assert.equal(swallowsExitCode("{ exit 0; }"), true);
  assert.equal(swallowsExitCode("command exit 0"), true);
  assert.equal(swallowsExitCode("node scripts/gate/x.mjs; exit 0"), true);
});

test("dangerousStepEnv / leadingAssignmentNames：只点名能改变 shell 行为的变量", () => {
  assert.deepEqual(dangerousStepEnv(["BASH_ENV", "FULL_GATE", "bash_func_x", "SHELLOPTS"]), [
    "BASH_ENV",
    "bash_func_x",
    "SHELLOPTS",
  ]);
  assert.deepEqual(leadingAssignmentNames("BASH_ENV=/tmp/n.sh node x.mjs"), ["BASH_ENV"]);
  assert.deepEqual(leadingAssignmentNames("node x.mjs --flag=value"), []);
});

test(`stripLineComment：ANSI-C 与反引号里的 # 不是注释（对抗复核的绕过）`, () => {
  const ansi = "$'a\\' #'";
  assert.equal(
    stripLineComment(`pnpm lint --packages "" ${ansi} || true`),
    `pnpm lint --packages "" ${ansi} || true`,
  );
  assert.equal(
    stripLineComment(`pnpm lint --packages "" \`echo a # b\` || true`),
    `pnpm lint --packages "" \`echo a # b\` || true`,
  );
  assert.equal(hasUnbalancedQuotes(`node x.mjs --msg "It\'s"`), false);
  assert.equal(stripLineComment("node x.mjs;#尾注释"), "node x.mjs;");
  assert.equal(stripLineComment("node x.mjs --tag foo#bar"), "node x.mjs --tag foo#bar");
});

test(`endpointOf：--packages 取值不进身份，但它之后的 token 必须进`, () => {
  const scripts = { lint: "node tools/lint/bin/lint.mjs" };
  const base = endpointOf("pnpm lint", scripts);
  assert.deepEqual(endpointOf("pnpm lint --packages a,b", scripts), base);
  const ansi = "$'a\\' #'";
  assert.notDeepEqual(endpointOf(`pnpm lint --packages "" ${ansi} || true`, scripts), base);
  assert.notDeepEqual(endpointOf(`pnpm lint --packages "" \`echo a # b\` || true`, scripts), base);
});

test(`envLayers / jobLevelFace / dangerousStepEnv：四层 env 与能改变执行环境的键名都可核对`, () => {
  const yaml = [
    "env:",
    "  WORKFLOW_LEVEL: 1",
    "jobs:",
    "  j:",
    "    env:",
    "      JOB_LEVEL: 2",
    "    container:",
    "      image: node:24",
    "      env:",
    "        CONTAINER_LEVEL: 3",
    "    defaults:",
    "      run:",
    "        working-directory: /tmp",
    "    steps:",
    `      - run: echo "BASH_ENV=/tmp/n.sh" >> "$GITHUB_ENV"`,
  ].join(String.fromCharCode(10));
  // `container.env` 是第四层：镜像里挂的 env 同样作用于该 job 的每个 run 步骤（复核实测它不在任何层里）。
  assert.deepEqual(envLayers(yaml, "j"), {
    workflow: ["WORKFLOW_LEVEL"],
    job: ["JOB_LEVEL"],
    container: ["CONTAINER_LEVEL"],
  });
  // job 级 container / defaults 整块进 job 执行面摘要：镜像、container.env、defaults.run.working-directory
  // 都是「改一处即换掉整 job 执行环境」的键。
  assert.deepEqual(jobLevelFace(yaml, "j"), [
    "container.env.CONTAINER_LEVEL=3",
    "container.image=node:24",
    "defaults.run.working-directory=/tmp",
  ]);
  assert.deepEqual(jobLevelFace(yaml, "不存在"), []);
  assert.deepEqual(dangerousStepEnv(["NODE_OPTIONS", "PATH", "FULL_GATE"]), [
    "NODE_OPTIONS",
    "PATH",
  ]);
});

test(`stripLineComment：被转义的空白之后 # 仍是字面量（对抗复核四的绕过）`, () => {
  const esc = "pnpm lint " + String.fromCharCode(92) + " # || true";
  assert.equal(stripLineComment(esc), esc);
  assert.equal(hasUnbalancedQuotes(esc), false);
  assert.equal(stripLineComment("pnpm lint # 说明"), "pnpm lint");
  assert.equal(stripLineComment("pnpm lint;#c"), "pnpm lint;");
});

test(`endpointOf：转义空白后的 token 进身份，与干净命令不同`, () => {
  const scripts = { lint: "node tools/lint/bin/lint.mjs" };
  const esc = "pnpm lint " + String.fromCharCode(92) + " # || true";
  assert.notDeepEqual(endpointOf(esc, scripts), endpointOf("pnpm lint", scripts));
});

test("stepsOf / priorRunStepsOf：working-directory 进形态与摘要（它决定命令在哪个目录里跑）", () => {
  const wrap = (wd: string): string =>
    [
      "jobs:",
      "  j:",
      "    steps:",
      "      - name: Install",
      `        working-directory: ${wd}`,
      "        run: pnpm install",
      "      - run: node scripts/gate/forbid-src-tests.mjs",
    ].join(String.fromCharCode(10));
  assert.equal(stepsOf(wrap("sub/dir"), "ci.yml", "j", {}).at(0)?.workingDirectory, "sub/dir");
  // 换个目录就是换一条命令：摘要必须变（否则一行 working-directory 等于不在任何摘要里）。
  const here = priorRunStepsOf(wrap("."), "ci.yml", "j", {});
  const there = priorRunStepsOf(wrap("sub/dir"), "ci.yml", "j", {});
  assert.equal(here.length, 1);
  assert.notEqual(here[0].digest, there[0].digest);
});

test("jobFaceOf：前序步骤的顺序进摘要（成员相同、顺序不同即是另一个执行面）", () => {
  const wrap = (first: string, second: string): string =>
    [
      "jobs:",
      "  j:",
      "    steps:",
      `      - name: ${first}`,
      "        run: echo " + first,
      `      - name: ${second}`,
      "        run: echo " + second,
      "      - run: node scripts/gate/forbid-src-tests.mjs",
    ].join(String.fromCharCode(10));
  assert.notEqual(
    jobFaceOf(wrap("A", "B"), "ci.yml", "j", {}),
    jobFaceOf(wrap("B", "A"), "ci.yml", "j", {}),
  );
  assert.equal(
    jobFaceOf(wrap("A", "B"), "ci.yml", "j", {}),
    jobFaceOf(wrap("A", "B"), "ci.yml", "j", {}),
  );
});

test(`stepsOf：步骤 id 与 name 都被保留（登记条件靠 id 反查产出步骤）`, () => {
  const yaml = [
    "jobs:",
    "  j:",
    "    steps:",
    "      - id: base",
    "        name: Resolve diff base",
    "        run: echo x",
  ].join(String.fromCharCode(10));
  const step = stepsOf(yaml, "ci.yml", "j", {}).at(0);
  assert.equal(step?.id, "base");
  assert.equal(step?.name, "Resolve diff base");
});

test("stripLineComment：花括号不是 bash 元字符（词内的 # 是字面量）", () => {
  assert.equal(stripLineComment("pnpm lint --packages a{#b"), "pnpm lint --packages a{#b");
  assert.equal(
    stripLineComment("pnpm lint --packages {# || true"),
    "pnpm lint --packages {# || true",
  );
  assert.equal(hasUnbalancedQuotes('pnpm lint --packages "a"'), false);
});

test("splitCommands：续行按 bash 语义拼接（删掉反斜杠 + 换行，不额外插空格）", () => {
  const yaml = [
    "jobs:",
    "  j:",
    "    steps:",
    "      - run: |",
    "          echo x >> $GITHUB_EN" + String.fromCharCode(92),
    "          V",
  ].join(String.fromCharCode(10));
  const cmds = extractRunSteps(yaml, "j").map((s) => s.cmd);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /GITHUB_ENV/);
});

test("usesSteps：登记面是 whole-step 文本（挑几个键列举会漏掉 if / timeout / 未建模键）", () => {
  const yaml = [
    "jobs:",
    "  j:",
    "    steps:",
    "      - uses: actions/upload-artifact@abc",
    "        if: always()",
    "        timeout-minutes: 1",
    "        continue-on-error: true",
    "        with:",
    "          name: shard-report",
    "      - uses: actions/download-artifact@def",
    "        with:",
    "          pattern: mutation-shard-*",
  ].join(String.fromCharCode(10));
  const steps = usesSteps(yaml, "j");
  assert.deepEqual(
    steps.map((s) => s.with),
    [["name=shard-report"], ["pattern=mutation-shard-*"]],
  );
  // 结构化读取仍拿到原始键值；登记面（text）必须把 if / timeout / continue-on-error 一起带上。
  assert.match(steps[0].text, /with\.name=shard-report/);
  assert.match(steps[0].text, /timeout-minutes=1/);
  assert.match(steps[0].text, /continue-on-error=true/);
  // 一处 `if: false` 就能让产出步骤静默不跑：整步文本必须随之改变（对抗复核实测的那条绕过）。
  const swapped = yaml.replace("if: always()", "if: false");
  assert.notDeepEqual(
    usesSteps(swapped, "j").map((s) => s.text),
    steps.map((s) => s.text),
  );
});
