#!/usr/bin/env node
/**
 * local-gate 退出码三态自测（#875 S1）。
 *
 * 为什么必须以**子进程**形态断言：本文件若直接 import 门禁并读返回值，
 * `node --test` 会把被测文件里任何非零 `process.exit` 一律折成 1
 * （见 scripts/README.md 的 `## test/` 段：判据必须置于 gate/ 才能传出三态）。
 * 折成 1 之后「判红」与「门禁故障」在本进程内**无法区分**——而这两者的处置完全相反。
 * 故这里一律 spawnSync 真子进程、断言真实退出码。
 *
 * 为什么用**注入副本**而不是靠真实门禁偶然触发：真实触发不可复现（读不到事实源、
 * 扫描面为空这类 fail-closed 是偶发的），而不可复现的判据等于没有判据——本轮两次
 * `pnpm gate:pr` exit 1 事故正是「复现不出来」的直接代价。
 *
 * 副本落在 `mkdtempSync` 目录、绝不写进仓库：仓库内任何新增 .mjs 都会被
 * `test/mjs-freeze-guard.test.ts` 判红（「新增 .mjs 不登记即红」，含未 git add 的形态），
 * 而 `test:scripts` 的多个测试文件是并行的——副本落在 scripts/ 下会连累别的用例。
 * 代价是副本里的相对 import 与 ROOT 都失效，故两处都改写成绝对路径（见 patchedSource）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "local-gate.mjs");

interface Step {
  label: string;
  cmd: string;
  args: string[];
}

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

/** 相对说明符 → 仓库内绝对路径。副本在 tmpdir 里，这四处是它全部的仓内依赖。 */
const IMPORTS: readonly (readonly [string, string])[] = [
  ["../ci/ci-matrix.mjs", "scripts/ci/ci-matrix.mjs"],
  ["./gate-steps.mjs", "scripts/gate/gate-steps.mjs"],
  ["./local-scope.mjs", "scripts/gate/local-scope.mjs"],
  ["../lib/gate-exit.mjs", "scripts/lib/gate-exit.mjs"],
];

const ROOT_LINE = 'const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");';
const STEPS_BLOCK = [
  "  const steps = tierSteps(effectiveTier, {",
  "    hitPackages: plan.hitPackages,",
  "    withCoverage,",
  "    base,",
  "    scopeLabel,",
  "  });",
].join("\n");

/**
 * 锚点必须命中且唯一，否则直接抛错。
 * 静默跳过改写会让副本仍跑真实步骤表，于是断言的是「真实门禁全绿」而不是被测语义——
 * 测试恒真而不报错，是这类自测最隐蔽的失败方式。
 */
function replaceOnce(src: string, from: string, to: string, what: string): string {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + 1) !== -1) {
    throw new Error(`锚点「${what}」缺失或不唯一：注入未生效，本用例会断言到未改动的真实门禁`);
  }
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** 真实门禁源码 + 注入步骤表 → 可在 tmpdir 里直跑的探针副本。 */
function patchedSource(steps: Step[]): string {
  let src = readFileSync(SCRIPT, "utf8");
  for (const [spec, rel] of IMPORTS) {
    const abs = pathToFileURL(join(ROOT, rel)).href;
    src = replaceOnce(src, `from "${spec}"`, `from "${abs}"`, spec);
  }
  src = replaceOnce(src, ROOT_LINE, `const ROOT = ${JSON.stringify(ROOT)};`, "ROOT");
  return replaceOnce(src, STEPS_BLOCK, `  const steps = ${JSON.stringify(steps)};`, "steps");
}

/** 跑注入副本并回报真实退出码；副本目录用后即删。 */
function runInjected(steps: Step[]): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "dsh-local-gate-exit-"));
  try {
    const copy = join(dir, "probe.mjs");
    writeFileSync(copy, patchedSource(steps));
    const r = spawnSync(process.execPath, [copy, "--tier", "pr"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一条以给定状态码退出的注入步（用真 node，不靠真实门禁）。 */
function exitStep(label: string, code: number): Step {
  return { label, cmd: process.execPath, args: ["-e", `process.exit(${code})`] };
}

function assertStatus(got: Outcome, want: number) {
  assert.equal(
    got.status,
    want,
    `期望 exit ${want}，实得 ${String(got.status)}（signal=${String(got.signal)}）。判词：\n${got.out}`,
  );
}

test("exit 0：--dry-run 不执行任何步骤即 exit 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--tier", "pr", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `--dry-run 应 exit 0：${r.stderr}`);
});

test("exit 0：注入的全过步骤走完即 exit 0，摘要无故障栏", () => {
  const out = runInjected([
    { label: "注入-通过甲", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
    { label: "注入-通过乙", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
  ]);
  assertStatus(out, 0);
  assert.match(out.out, /exit=0 {2}注入-通过甲/, "摘要应逐条列 exit=0 与步骤名");
  assert.match(out.out, /\[local-gate\] 结果：PASS/, "全过应判 PASS");
  assert.doesNotMatch(out.out, /门禁故障/, "全过时不得出现故障栏");
  assert.doesNotMatch(out.out, /GATE-FAULT/, "全过时不得出现故障判决词");
});

test("exit 1：某步按设计判红 → 整体 1，且判词含 exit=1 与步骤名", () => {
  const out = runInjected([
    exitStep("注入-判红", 1),
    { label: "注入-红路径本不该跑", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
  ]);
  assertStatus(out, 1);
  assert.match(out.out, /exit=1 {2}注入-判红/, "判红步应留在 exit= 列表里并带步骤名");
  assert.match(out.out, /\[local-gate\] 结果：FAIL/, "判红应判 FAIL");
  assert.doesNotMatch(out.out, /门禁故障/, "判红不得被报成门禁故障（验收 h：1 不是 2）");
  assert.doesNotMatch(out.out, /::error::/, "判红不是门禁故障，不该有 ::error:: 注解");
  assert.doesNotMatch(out.out, /GATE-FAULT/, "判红的判决词是 FAIL，不是 GATE-FAULT");
  assert.match(
    out.out,
    /^ {2}exit=skip {2}注入-红路径本不该跑$/m,
    "判红步之后的步骤应记 exit=skip（fail-fast 未被弱化）",
  );
  assert.match(out.out, /因首个失败跳过 1 步/, "判红须照旧打印跳过计数");
});

test("exit 2：子门禁自身 exit 2 → 整体 2，判词含 fault=exit2 与步骤名", () => {
  const out = runInjected([exitStep("注入-子门禁故障", 2)]);
  assertStatus(out, 2);
  assert.match(out.out, /fault=exit2 {2}注入-子门禁故障/, "子门禁故障须在故障栏标出 kind 与步骤名");
  assert.match(out.out, /门禁故障结案（exit 2）/, "须写明该步的语义是门禁故障");
  assert.match(
    out.out,
    /::error::门禁故障（非判据结论）：\[local-gate\] 步骤「注入-子门禁故障」/,
    "收口判词须可检索：带步骤名 + 门禁故障语义",
  );
  assert.doesNotMatch(
    out.out,
    /^ {2}exit=\d+ {2}注入-子门禁故障$/m,
    "故障步不得混进 exit= 列表（子门禁 exit 2 场景）",
  );
  assert.match(out.out, /（记录 code=2）/, "须打出记录里的 code，钉住它不是 null");
  assert.match(
    out.out,
    /\[local-gate\] 结果：GATE-FAULT（不可信 ⇒ 禁止合并/,
    "故障的判决词必须是 GATE-FAULT",
  );
  assert.doesNotMatch(
    out.out,
    /\[local-gate\] 结果：FAIL/,
    "故障时打 FAIL 会把「禁止合并 + 开 P0」读成「改代码」——两者处置方向相反",
  );
});

test("exit 2：spawn 失败（命令不存在）→ 整体 2，判词含 res.error 的 ENOENT", () => {
  const out = runInjected([
    { label: "注入-spawn失败", cmd: "dsh-no-such-command-875-xyz", args: [] },
  ]);
  assertStatus(out, 2);
  assert.match(out.out, /fault=spawn {2}注入-spawn失败/, "spawn 失败须在故障栏标出 kind 与步骤名");
  assert.match(out.out, /ENOENT/, "判词须逐字带上 res.error 的内容（可检索）");
  assert.match(out.out, /::error::门禁故障/, "门禁故障须经 failClosed 收口");
  assert.doesNotMatch(
    out.out,
    /^ {2}exit=\d+ {2}注入-spawn失败$/m,
    "故障步不得混进 exit= 列表（spawn 场景）",
  );
  assert.match(out.out, /（记录 code=2）/, "须打出记录里的 code，钉住它不是 null");
  assert.match(
    out.out,
    /\[local-gate\] 结果：GATE-FAULT（不可信 ⇒ 禁止合并/,
    "故障的判决词必须是 GATE-FAULT",
  );
  assert.doesNotMatch(out.out, /\[local-gate\] 结果：FAIL/, "故障时不得打 FAIL");
});

test(
  "exit 2：被信号杀死 → 整体 2，判词含信号名",
  {
    // Windows 上 process.kill(pid, 'SIGKILL') 语义不同，跳过而不是造一个假红。
    skip: process.platform === "win32" ? "Windows 无 POSIX SIGKILL 语义" : false,
  },
  () => {
    // 让被测子进程自己 SIGKILL 自己：确定性构造，不依赖外部 pgrep / 计时（防 flake 纪律）。
    const out = runInjected([
      {
        label: "注入-信号杀死",
        cmd: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
      },
    ]);
    assertStatus(out, 2);
    assert.match(out.out, /fault=signal {2}注入-信号杀死/, "信号杀死须在故障栏标出 kind 与步骤名");
    assert.match(out.out, /signal=SIGKILL/, "判词须逐字带上 res.signal 的信号名（可检索）");
    assert.doesNotMatch(
      out.out,
      /^ {2}exit=\d+ {2}注入-信号杀死$/m,
      "故障步不得混进 exit= 列表（信号场景）",
    );
    assert.match(out.out, /（记录 code=2）/, "须打出记录里的 code，钉住它不是 null");
    assert.match(
      out.out,
      /\[local-gate\] 结果：GATE-FAULT（不可信 ⇒ 禁止合并/,
      "故障的判决词必须是 GATE-FAULT",
    );
    assert.doesNotMatch(out.out, /\[local-gate\] 结果：FAIL/, "故障时不得打 FAIL");
  },
);

test("门禁故障同样 fail-fast：故障步之后的步骤记 exit=skip 且不执行", () => {
  const out = runInjected([
    { label: "注入-故障首步", cmd: "dsh-no-such-command-875-xyz", args: [] },
    { label: "注入-本不该跑", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
  ]);
  assertStatus(out, 2);
  assert.match(out.out, /^ {2}exit=skip {2}注入-本不该跑$/m, "故障步之后的步骤应记 exit=skip");
  assert.match(out.out, /因首个失败跳过 1 步/, "跳过计数须照旧打印，不因故障而消失");
  assert.doesNotMatch(out.out, /▶ {2}注入-本不该跑/, "故障步之后的步骤不得真的执行");
  assert.match(out.out, /\[local-gate\] 结果：GATE-FAULT/, "故障时判决词为 GATE-FAULT");
});
