#!/usr/bin/env node
"use strict";

/**
 * 形状规则的**行为**判据（#1174 阶段 1）。
 *
 * 为什么与 lint-toolchain.test.ts 分家：那条断言的是工具链隔离与既有规则接线（#722/#764/#875），
 * 本条断言的是 #1174 新接入的三条形状规则——阈值来自 gauntlet、规则按 error 生效、配置坏了必须
 * fail-closed、存量走官方 bulk 基线。两者改动的动机不同，且本条要跑隔离克隆（拷工具链 +
 * 改坏事实源），放进隔离断言那条只会把它的失败面搅浑。
 *
 * 全部判据走真实执行：ESLint Node API 喂反例、`lint.mjs` 真进程跑 exit 码。反例一律先断言
 * **被真解析**（fatal/parse error 会让三条规则静默不跑，「零命中」会被误读成「守住了」）。
 *
 * 运行：pnpm test:scripts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const requireLint = createRequire(join(ROOT, "tools", "lint", "package.json"));
const CONFIG = join(ROOT, "tools", "lint", "eslint.config.js");
const GAUNTLET_REL = "scripts/data/gauntlet.config.json";
const REGISTRY_REL = "scripts/data/threshold-registry.json";
const RULES = ["max-lines-per-function", "max-lines", "max-depth"] as const;

type Message = { ruleId: string | null; severity: number; message: string; fatal?: boolean };
type LintResult = { messages: Message[] };

/** 以仓库真实配置起一个 ESLint 实例（规则面、ignore 面都与 `pnpm lint` 同源）。 */
function eslintAt() {
  const { ESLint } = requireLint("eslint");
  return new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG });
}

/** 喂一段反例并断言它真被解析：parse/fatal error 会让形状规则静默不跑，必须先排除。 */
async function lintClean(eslint: ReturnType<typeof eslintAt>, source: string, relPath: string) {
  const [result] = (await eslint.lintText(source, { filePath: join(ROOT, relPath) })) as [
    LintResult,
  ];
  const fatal = result.messages.filter((m) => m.fatal);
  assert.deepEqual(
    fatal,
    [],
    `反例必须真被解析（fatal/parse error 会让形状规则静默不跑）：${JSON.stringify(fatal)}`,
  );
  return result;
}

/** 只取三条形状规则的发现——别把无关规则的噪声混进「未报」断言。 */
const shapeOnly = (result: LintResult) =>
  result.messages.filter((m) => (RULES as readonly string[]).includes(String(m.ruleId)));

/** 按物理行数生成低分支函数（无 if/for，圈复杂度恒为 1）——隔离形状规则与复杂度规则。 */
function longFunction(physicalLines: number): string {
  const body = Array.from({ length: physicalLines - 4 }, (_, i) => `  acc += ${i};`).join("\n");
  return `export function p() {\n  let acc = 0;\n${body}\n  return acc;\n}\n`;
}

/** 按物理行数生成只含顶层常量声明的长文件（每条语句一行，无嵌套块）。 */
function longFile(physicalLines: number): string {
  return `${Array.from({ length: physicalLines }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;
}

/** 嵌套 depth 层 if 的短函数——max-depth 只数控制流块，行数远低于行数阈值。 */
function nestedBlocks(depth: number): string {
  const pad = (k: number) => "  ".repeat(k);
  const lines = ["export function p(x) {"];
  for (let k = 0; k < depth; k++) lines.push(`${pad(k + 1)}if (x > ${k}) {`);
  lines.push(`${pad(depth + 1)}return x;`);
  for (let k = depth - 1; k >= 0; k--) lines.push(`${pad(k + 1)}}`);
  lines.push("  return x;", "}");
  return `${lines.join("\n")}\n`;
}

test("#1174：三条形状规则在 TS 与 JS 两个面都按 error 真报错（不是「配置里写了」）", async () => {
  const eslint = eslintAt();
  // 路径取**落在真实 files 匹配面内**的位置（scripts/ 下 TS 与 MJS 各一）：规则按 files
  // 模式生效，路径落到面外时解析到的配置与门禁不一致，判据会空转。文件本身不必真实存在——
  // lintText 只借它的路径决定用哪套配置。
  const cases: Array<{ rule: (typeof RULES)[number]; source: string; expect: RegExp }> = [
    {
      rule: "max-lines-per-function",
      source: longFunction(121),
      expect: /has too many lines \(121\)\. Maximum allowed is 120\./,
    },
    {
      rule: "max-lines",
      source: longFile(601),
      expect: /has too many lines \(601\)\. Maximum allowed is 600\./,
    },
    {
      rule: "max-depth",
      source: nestedBlocks(5),
      expect: /Blocks are nested too deeply \(5\)\. Maximum allowed is 4\./,
    },
    {
      // 超长 IIFE：默认 IIFEs:false 会让立即执行体逃出行数门禁。
      rule: "max-lines-per-function",
      source: `export const a = 1;\nvoid (() => {\n${Array.from({ length: 200 }, (_, i) => `  acc += ${i};`).join("\n")}\n})();\n`,
      expect: /Arrow function has too many lines \(202\)/,
    },
  ];
  for (const face of ["scripts/gate/shape-probe.ts", "scripts/gate/shape-probe.mjs"]) {
    for (const c of cases) {
      const result = await lintClean(eslint, c.source, face);
      const hit = result.messages.find((m) => m.ruleId === c.rule && m.severity === 2);
      assert.ok(hit, `${face}：${c.rule} 必须报 error（实际 ${JSON.stringify(result.messages)}）`);
      assert.match(hit.message, c.expect, `${face}：判词须含实测行数与阈值`);
    }
  }
});

test("#1174：阈值恰好等于上限不报（120 / 600 / 深度 4 三个下界档，语义是 > 而非 >=）", async () => {
  const eslint = eslintAt();
  const cases = [
    {
      rule: "max-lines-per-function",
      source: longFunction(120),
      rel: "scripts/gate/shape-edge.ts",
    },
    { rule: "max-lines", source: longFile(600), rel: "scripts/gate/shape-edge.ts" },
    { rule: "max-depth", source: nestedBlocks(4), rel: "scripts/gate/shape-edge.mjs" },
  ];
  for (const c of cases) {
    const result = await lintClean(eslint, c.source, c.rel);
    assert.deepEqual(
      shapeOnly(result),
      [],
      `${c.rule} 恰好等于阈值不得报：${JSON.stringify(shapeOnly(result))}`,
    );
  }
});

test("#1174：注释档与空行档各超 600 物理行时都不计入（两个 skip 选项分别真生效）", async () => {
  const eslint = eslintAt();
  // 两档**各自**超过 600 物理行：只把 skipComments 或 skipBlankLines 其中一个改成 false，
  // 对应那档就会越阈报错。两档合一（各 400 行）会让任一选项失效仍然绿，失去判别力。
  const head = ["export function p() {", "  let acc = 0;"];
  const tail = ["  acc += 1;", "  return acc;", "}"];
  const commentHeavy = `${[...head, ...Array.from({ length: 610 }, (_, i) => `  // 注释 ${i}`), ...tail].join("\n")}\n`;
  const blankHeavy = `${[...head, ...Array.from({ length: 610 }, () => ""), ...tail].join("\n")}\n`;
  for (const [label, source] of [
    ["注释档", commentHeavy],
    ["空行档", blankHeavy],
  ] as const) {
    assert.ok(
      source.split("\n").length - 1 > 600,
      `${label}反例必须物理超 600 行才有判别力（实得 ${source.split("\n").length - 1} 行）`,
    );
    const result = await lintClean(eslint, source, "scripts/gate/shape-pad.ts");
    assert.deepEqual(
      shapeOnly(result),
      [],
      `${label}：纯${label === "注释档" ? "注释" : "空行"}不得计入（skip 选项未生效）：${JSON.stringify(shapeOnly(result))}`,
    );
  }
});

test("#1174：超长低分支函数只命中行数规则（证明不是被复杂度规则顺带挡下的）", async () => {
  const eslint = eslintAt();
  // longFunction 无任何分支：complexity 10 / cognitive 15 都不会命中它。两条复杂度规则
  // 同时被摘掉时本测仍绿，而把 max-lines-per-function 关掉时本测转红——这才是行为判据。
  const result = await lintClean(eslint, longFunction(140), "scripts/gate/shape-low-branch.ts");
  assert.deepEqual(
    shapeOnly(result).map((m) => m.ruleId),
    ["max-lines-per-function"],
    "低分支长函数只该命中行数规则",
  );
  const complexityHits = result.messages.filter((m) => String(m.ruleId).includes("complexity"));
  assert.deepEqual(
    complexityHits,
    [],
    `夹具必须真的是低分支（否则复杂度规则会顺带命中，判据失去指向性）：${JSON.stringify(complexityHits)}`,
  );
});

/**
 * 隔离克隆：把 lint 工具链与阈值事实源拷进 mkdtemp 目录，让入口的 exit 2 分支能在
 * **写坏配置**的条件下实跑。
 *
 * 为什么必须克隆而不是改共享工作树里的 gauntlet：反例要求配置非法，而共享树同时是其它门禁
 * 的读取源（测试纪律 #218）。node_modules 用软链指回真实安装，避免复制依赖进临时目录。
 */
function cloneLintToolchain(mutate?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-shape-"));
  mkdirSync(join(dir, "scripts", "data"), { recursive: true });
  mkdirSync(join(dir, "tools", "lint", "bin"), { recursive: true });
  for (const rel of [
    "tools/lint/eslint.config.js",
    "tools/lint/package.json",
    "tools/lint/bin/lint.mjs",
  ]) {
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  symlinkSync(
    join(ROOT, "tools", "lint", "node_modules"),
    join(dir, "tools", "lint", "node_modules"),
    "dir",
  );
  cpSync(join(ROOT, GAUNTLET_REL), join(dir, GAUNTLET_REL));
  // 空基线：让「超 count」与「stale」两档的反例不被既有条目干扰。
  writeFileSync(join(dir, "eslint-suppressions.json"), "{}\n", "utf8");
  mutate?.(dir);
  return dir;
}

/** 改写克隆仓 gauntlet 的 lint 段（保留其余段，避免触发无关的 fail-closed 分支）。 */
function mutateLintThresholds(dir: string, mutate: (lint: Record<string, unknown>) => void): void {
  const path = join(dir, GAUNTLET_REL);
  const gauntlet = JSON.parse(readFileSync(path, "utf8"));
  mutate(gauntlet.lint as Record<string, unknown>);
  writeFileSync(path, JSON.stringify(gauntlet, null, 2), "utf8");
}

/** 在克隆仓里跑入口；cwd 为克隆根，使 LINT_PKG / REPO_ROOT 解析都落在克隆内。 */
function runClonedLint(dir: string, args: string[] = ["probe.ts"]) {
  return spawnSync(process.execPath, ["tools/lint/bin/lint.mjs", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("#1174：形状阈值缺失 / 坏类型 / 非正整数一律 exit 2（不得静默回退默认值）", () => {
  // 逐键五档 × 三条规则：缺键、字符串、0、负数、小数。任一档静默放行都等于「阈值坏了就退回
  // ESLint 默认」——而默认是 max-lines 300 / max-lines-per-function 50，回退后门禁看起来
  // 在跑、实际口径已经漂移。0 尤其关键：非正整数会让规则对每个文件都报或完全不报。
  const badValues: Array<[string, unknown]> = [
    ["缺键", undefined],
    ["字符串", "120"],
    ["0", 0],
    ["负数", -1],
    ["小数", 120.5],
  ];
  for (const key of ["maxLinesPerFunction", "maxLines", "maxDepth"]) {
    for (const [label, value] of badValues) {
      const dir = cloneLintToolchain((d) => {
        mutateLintThresholds(d, (lint) => {
          if (value === undefined) delete lint[key];
          else lint[key] = value;
        });
        writeFileSync(join(d, "probe.ts"), "export const a = 1;\n", "utf8");
      });
      try {
        const r = runClonedLint(dir);
        assert.equal(
          r.status,
          2,
          `lint.${key} 为「${label}」必须 fail-closed exit 2（实际 ${r.status}）：${r.stdout}${r.stderr}`,
        );
        assert.match(
          r.stderr,
          new RegExp(`lint\\.${key}`),
          `判词须点明坏的是哪个阈值（实际：${r.stderr}）`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("#1174：事实源损坏（JSON 不可解析 / 整个 lint 段消失）exit 2", () => {
  // 与「阈值非法」分开：这里坏的是**文件与段**本身。两类故障修法不同（前者改数值，
  // 后者查写入路径），判红时必须能区分。
  // complexity 档：形状阈值读得到但 complexity 段缺了，入口必须仍按「事实源不可读」判红。
  // 缺这一档时预检会跳过、异常一路落到 ESLint 加载配置上，退出码从 2 退化成 1——故障
  // 分类被错报成判红，读日志的人会去查代码而不是查事实源。
  const cases: Array<[string, (dir: string) => void]> = [
    ["JSON 不可解析", (dir) => writeFileSync(join(dir, GAUNTLET_REL), "{ not json", "utf8")],
    [
      "整个 lint 段消失",
      (dir) => {
        const path = join(dir, GAUNTLET_REL);
        const gauntlet = JSON.parse(readFileSync(path, "utf8"));
        delete gauntlet.lint;
        writeFileSync(path, JSON.stringify(gauntlet, null, 2), "utf8");
      },
    ],
    [
      "complexity 段消失",
      (dir) => {
        const path = join(dir, GAUNTLET_REL);
        const gauntlet = JSON.parse(readFileSync(path, "utf8"));
        delete gauntlet.complexity;
        writeFileSync(path, JSON.stringify(gauntlet, null, 2), "utf8");
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const dir = cloneLintToolchain((d) => {
      mutate(d);
      writeFileSync(join(d, "probe.ts"), "export const a = 1;\n", "utf8");
    });
    try {
      const r = runClonedLint(dir);
      assert.equal(
        r.status,
        2,
        `${label}必须 fail-closed exit 2（实际 ${r.status}）：${r.stdout}${r.stderr}`,
      );
      if (label === "complexity 段消失") {
        assert.match(r.stderr, /complexity/, `须点明坏的是 complexity 段（实际：${r.stderr}）`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("#1174：--max-warnings= 不得绕过形状阈值预检（覆盖参数也须 exit 2）", () => {
  // 回归防线：入口曾按 `--max-warnings=` 覆盖预算并整段跳过事实源读取，于是「用覆盖参数调用」
  // +「阈值已坏」会落成 exit 1/0 而不是 exit 2——故障分类被绕过。覆盖参数只服务本地排查与
  // 用例，不得成为读阈值事实源的旁路。
  const dir = cloneLintToolchain((d) => {
    mutateLintThresholds(d, (lint) => {
      lint.maxDepth = 0;
    });
    writeFileSync(join(d, "probe.ts"), "export const a = 1;\n", "utf8");
  });
  try {
    const r = runClonedLint(dir, ["--max-warnings=0", "probe.ts"]);
    assert.equal(
      r.status,
      2,
      `--max-warnings= 覆盖不得跳过形状阈值校验（实际 ${r.status}）：${r.stdout}${r.stderr}`,
    );
    assert.match(r.stderr, /maxDepth/, "判词须点明坏的是形状阈值");
    assert.doesNotMatch(r.stderr, /max-warnings=/, "不得报成预算参数错误——那是另一类故障");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1174：bulk 基线四档——新文件红 / 恰好绿 / stale 红 / prune 后绿", () => {
  // 三档都靠「文件 + 规则 + count」记账，故探针用**合成固件**（新文件）而不是任何业务文件：
  // 业务存量数会随阶段 2 清理归零，探针禁止绑定它，否则清一次债就要改一次测试。
  const rule = "max-lines";
  const dir = cloneLintToolchain((d) => {
    writeFileSync(join(d, "probe.ts"), longFile(601), "utf8");
  });
  try {
    // 档 1：无基线 → 新文件违规必须现形（exit 1，不是 exit 2：这是判红不是故障）。
    const noBaseline = runClonedLint(dir);
    assert.equal(
      noBaseline.status,
      1,
      `无基线的新文件违规必须判红 exit 1（实际 ${noBaseline.status}）：${noBaseline.stdout}`,
    );
    assert.match(noBaseline.stdout, /error 1/, "该文件 1 处超限错误应报出");
    assert.match(noBaseline.stdout, new RegExp(rule), "输出须点名规则");

    // 档 2：基线恰好 1 条 → 放行。
    const base = join(dir, "eslint-suppressions.json");
    writeFileSync(base, JSON.stringify({ "probe.ts": { [rule]: { count: 1 } } }), "utf8");
    const exact = runClonedLint(dir);
    assert.equal(
      exact.status,
      0,
      `基线恰好应放行（实际 ${exact.status}）：${exact.stdout}${exact.stderr}`,
    );

    // 档 3：违规已修（文件变短）但基线仍留着 → stale 棘轮判红，并给出可照抄的 prune 命令。
    writeFileSync(join(dir, "probe.ts"), "export const a = 1;\n", "utf8");
    const stale = runClonedLint(dir);
    assert.equal(
      stale.status,
      1,
      `存量已修但基线未收缩必须判红（实际 ${stale.status}）：${stale.stdout}${stale.stderr}`,
    );
    assert.match(stale.stderr, /已经失效/, "须报为「条目已失效」而不是「超基线错误」");
    assert.match(stale.stderr, /--prune-suppressions/, "须给出可照抄的收缩命令");

    // 档 4：走**官方 CLI 的 --prune-suppressions**（不是手写 {}）收缩基线，再重跑同一份代码
    // 必须恢复通过——证明上一档红的是「基线没收缩」而不是代码本身，且官方 CLI 这条收缩路径
    // 真的可用（Node API 侧只应用基线，创建/修剪只能走 CLI，见 tools/lint/bin/lint.mjs 注释）。
    const pruned = spawnSync(
      process.execPath,
      [
        "tools/lint/node_modules/eslint/bin/eslint.js",
        "--config",
        "tools/lint/eslint.config.js",
        "--prune-suppressions",
        "--suppressions-location",
        "eslint-suppressions.json",
        "probe.ts",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(
      pruned.status,
      0,
      `官方 prune 必须可用（实际 ${pruned.status}）：${pruned.stderr}`,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(base, "utf8")),
      {},
      "官方 prune 必须把已失效的条目从基线里删掉（而不是留一条 count:0）",
    );
    const afterPrune = runClonedLint(dir);
    assert.equal(
      afterPrune.status,
      0,
      `基线经官方 prune 收缩后必须恢复通过（实际 ${afterPrune.status}）：${afterPrune.stdout}${afterPrune.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1174：同文件同规则违规数超出基线 count 判红（挂账只认文件+规则+数量）", () => {
  // bulk 的记账粒度是「文件 + 规则 + count」，不是「违规处数」。同文件两个超长函数、
  // 基线只登记 1 条时，第二处必须现形——否则「挂 1 条就等于这个文件安全了」。
  const second = longFunction(121).replace("export function p", "export function q");
  const dir = cloneLintToolchain((d) => {
    writeFileSync(join(d, "probe.ts"), `${longFunction(121)}${second}`, "utf8");
    writeFileSync(
      join(d, "eslint-suppressions.json"),
      JSON.stringify({ "probe.ts": { "max-lines-per-function": { count: 1 } } }),
      "utf8",
    );
  });
  try {
    const r = runClonedLint(dir);
    assert.equal(
      r.status,
      1,
      `实际 2 处而基线 1 条必须判红（实际 ${r.status}）：${r.stdout}${r.stderr}`,
    );
    assert.match(r.stdout, /error 2/, "两处违规都须报出（挂 1 条不等于整个文件安全）");
    assert.match(r.stdout, /max-lines-per-function/, "输出须点名规则");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1174：bulk 基线只挂形状规则，不得把无关规则的错误一并吞掉", () => {
  // 定向挂账的纪律：--suppress-all 会把同一次运行里**所有**规则的错误写进基线，于是一条
  // 无关的 correctness error 被悄悄挂账。本测用「基线只列形状规则 + 文件另有无关违规」证明
  // 无关违规仍现形。
  const dir = cloneLintToolchain((d) => {
    // no-var + max-lines 两条违规同文件：基线只登记 max-lines。
    const filler = Array.from({ length: 599 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    writeFileSync(join(d, "probe.ts"), `${filler}\nvar x = 1;\nexport { x };\n`, "utf8");
    writeFileSync(
      join(d, "eslint-suppressions.json"),
      JSON.stringify({ "probe.ts": { "max-lines": { count: 1 } } }),
      "utf8",
    );
  });
  try {
    const r = runClonedLint(dir);
    assert.equal(r.status, 1, `基线外的违规必须仍判红（实际 ${r.status}）：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /no-var/, "输出须点名未被挂账的规则");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1174：形状阈值必须来自 gauntlet 事实源（配置不得硬编码数字）", () => {
  // 消费关系用**行为**证明而不是 grep 配置文本：把 gauntlet 的三个键各放宽 1，
  // 原本刚好越线的三个探针（121 行函数 / 601 行文件 / 深度 5）必须全部转为放行。
  // 配置若硬编码 120/600/4，改事实源不会改变任何判定，这一测就会红。
  const dir = cloneLintToolchain((d) => {
    mutateLintThresholds(d, (lint) => {
      lint.maxLinesPerFunction = 121;
      lint.maxLines = 601;
      lint.maxDepth = 5;
    });
    writeFileSync(join(d, "probe-fn.ts"), longFunction(121), "utf8");
    writeFileSync(join(d, "probe-file.ts"), longFile(601), "utf8");
    writeFileSync(join(d, "probe-depth.mjs"), nestedBlocks(5), "utf8");
  });
  try {
    const r = runClonedLint(dir, ["probe-fn.ts", "probe-file.ts", "probe-depth.mjs"]);
    assert.equal(
      r.status,
      0,
      `阈值放宽 1 后原本越线的三个探针必须放行（实际 ${r.status}）：${r.stdout}${r.stderr}`,
    );
    assert.match(r.stdout, /error 0/, "不得残留 error（事实源没被真正消费）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 事实源里三个键都必须是正整数（配置层校验是第一道，事实源本身也要有独立判据）。
  const gauntlet = JSON.parse(readFileSync(join(ROOT, GAUNTLET_REL), "utf8"));
  for (const key of ["maxLinesPerFunction", "maxLines", "maxDepth"]) {
    const value = gauntlet.lint?.[key];
    assert.ok(
      Number.isInteger(value) && value >= 1,
      `gauntlet.config.json 的 lint.${key} 必须是正整数（实际 ${JSON.stringify(value)}）`,
    );
  }
});

test("#1174：事实源文件整体缺失 exit 2（不可读即 fail-closed，不得当「无基线」放行）", () => {
  // lint 入口中「段缺失」与「文件缺失」都走 exit 2（入口只读一个文件，读不到即不可读）；
  // 此处单独证明**文件本身不在**时不会被当成「无阈值配置」而静默放行。阈值差分那条
  // exit 1 的判据在 threshold-monotonic.test.ts（工作区叶子被移除属判红，不是故障）。
  const dir = cloneLintToolchain((d) => {
    rmSync(join(d, GAUNTLET_REL));
    writeFileSync(join(d, "probe.ts"), "export const a = 1;\n", "utf8");
  });
  try {
    const r = runClonedLint(dir);
    assert.equal(
      r.status,
      2,
      `事实源文件缺失必须 fail-closed exit 2（实际 ${r.status}）：${r.stdout}${r.stderr}`,
    );
    assert.match(r.stderr, /gauntlet\.config\.json/, "判词须点明缺的是哪个文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1174：既有阈值护栏不因形状阈值而松动（maxWarnings 仍 0、四条 guard 均登记）", () => {
  // 接入三条新规则时最容易顺手做的事：把 maxWarnings 调大让新错误「进预算」。本测把
  // 「预算仍为 0」钉成事实——它是 #764 A2 的口径，不属于 #1174 可动的范围。
  const gauntlet = JSON.parse(readFileSync(join(ROOT, GAUNTLET_REL), "utf8"));
  assert.equal(
    gauntlet.lint?.maxWarnings,
    0,
    "形状规则按 error 接入，警告预算必须保持 0（不得为消化存量而调大）",
  );
  const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY_REL), "utf8"));
  const guardIds = (registry.guards ?? []).map((g: { id: string }) => g.id);
  for (const id of [
    "lint.maxWarnings",
    "lint.maxLinesPerFunction",
    "lint.maxLines",
    "lint.maxDepth",
  ]) {
    assert.ok(guardIds.includes(id), `threshold-registry 必须登记 ${id}（未登记即不受单调守卫）`);
  }
  // 不允许出现「退役/字段批准」类自授权键（#875 H11 已整体删除，重建即判红）。
  assert.equal(
    Object.hasOwn(registry, "retired") || Object.hasOwn(registry, "contractApprovals"),
    false,
    "声明表不得重建自授权通道",
  );
});

test("#1174：shared 的 emit 产物 JS 不参与 lint，同位置 TS/TSX 源码仍参与且真判红", async () => {
  // `pnpm build` 原地 emit 出 shared/*.js（与 .ts 同目录，#1028 起 shared 已 TS 化，版本库
  // 只允许 .ts，冻结守卫见 scripts/test/shared-ts-shape.test.ts）。忽略这三条是为了**不重复
  // 检查一份 emit 产物**，不是消化源码存量——所以判据必须同时钉住两侧：产物被忽略，
  // 而同位置的 TS 源码仍在 lint 面内且超限时照样报 shape。
  const eslint = eslintAt();
  const emitted = ["shared/sse-hub.js", "shared/client/i18n.js", "shared/client/ui/index.js"];
  for (const rel of emitted) {
    assert.equal(
      await eslint.isPathIgnored(join(ROOT, rel)),
      true,
      `${rel} 是 tsc emit 产物，必须留在 lint 面之外（否则同一份逻辑被检查两次）`,
    );
  }
  // 反向钉住：同位置源码不得被连坐。写宽成 shared/** 时这三条会全部变 true。
  const sources = ["shared/sse-hub.ts", "shared/client/i18n.ts", "shared/client/ui/index.tsx"];
  for (const rel of sources) {
    assert.equal(
      await eslint.isPathIgnored(join(ROOT, rel)),
      false,
      `${rel} 是源码，必须参与 lint——忽略面只覆盖同位置的 emit 产物`,
    );
  }
  // 行为层：把 601 行源码喂进这三个真实路径，必须报 max-lines（证明它们确实在规则面内，
  // 且 ignore 只按扩展名与目录层级生效，不会因为路径前缀相同就把源码一起跳过）。
  for (const rel of sources) {
    const result = await lintClean(eslint, longFile(601), rel);
    assert.ok(
      result.messages.some((m) => m.ruleId === "max-lines" && m.severity === 2),
      `${rel}：601 行源码必须报 max-lines（实际 ${JSON.stringify(result.messages)}）`,
    );
  }
  // scripts/lib 是门禁源码而非产物（#722 阶段五已钉「**/lib/** 会吞掉它」），不得被这次
  // 收窄顺带影响。
  assert.equal(
    await eslint.isPathIgnored(join(ROOT, "scripts", "lib", "threshold-registry.mjs")),
    false,
    "scripts/lib 是门禁源码，必须参与 lint",
  );
});
