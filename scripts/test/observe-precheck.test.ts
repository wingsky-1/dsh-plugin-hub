#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * 发版前置判据（#843 R-2 / D4）的回归：`scripts/release/observe-precheck.mjs` + release.yml 的接线。
 *
 * 为什么需要它：这条判据是发版链路上唯一会「拦住维护者」的东西，它有三种失效形态都不可见——
 *   ① 口径走样（把「窗口内至少一次 success」写成「最近一次 run 是 success」）→ 健康形态误伤；
 *   ② 边界走样（`<` 写成 `<=`，或错用 created_at 当收口时刻）→ 判据静默放宽；
 *   ③ 接线走样（job 不 needs、permissions 少 actions: read、override 没接上）→ 加了等于没加。
 * 本文件把三件事都钉死：纯函数逐态断言 + 真实 CLI（离线，不调 gh、不发写请求）+ release.yml 的
 * 结构断言。夹具全是自造合成数据，与本仓「离线 + 断言全覆盖」的测试纪律一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_WORKFLOW,
  evaluateObserveRecency,
  renderVerdictLine,
} from "../release/observe-precheck.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release/observe-precheck.mjs");
const RELEASE_YML = join(ROOT, ".github/workflows/release.yml");
const NOW = "2026-09-16T00:00:00Z";
const SHA = "1659f9ff7668e7f1f7b8e97daa28dbba97b98f53";

/** gh api 的 run 形态（只保留判据消费的字段 + 判词用到的元数据）。 */
function apiRun({
  number = 80,
  conclusion = "success",
  createdAt = "2026-09-15T22:39:37Z",
  updatedAt = "2026-09-15T23:06:39Z",
  event = "schedule",
} = {}) {
  return {
    run_number: number,
    event,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    created_at: createdAt,
    updated_at: updatedAt,
    head_sha: SHA,
    html_url: `https://github.com/wingsky-1/dsh-plugin-hub/actions/runs/${number}`,
  };
}

/** CLI 调用：本文件全部用例都注入 --runs-file / --override / override env，故不会走到 gh。 */
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "observe-precheck-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("默认口径：workflow=observe.yml、窗口=24 h（事实源在本脚本，workflow 侧不重复写字面量）", () => {
  assert.equal(DEFAULT_WORKFLOW, "observe.yml");
  assert.equal(DEFAULT_MAX_AGE_HOURS, 24);
});

test("放行：窗口内有 success；龄按收口时刻（updated_at）算，不看 created_at", () => {
  // created_at 已在窗口外、updated_at 在窗口内：误用 created_at 时这条会判 stale
  const verdict = evaluateObserveRecency({
    runs: [apiRun({ createdAt: "2026-09-14T23:00:00Z", updatedAt: "2026-09-15T01:00:00Z" })],
    now: NOW,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, "fresh");
  assert.equal(verdict.ageHours, 23);
  assert.equal(verdict.run.number, 80);
  const line = renderVerdictLine(verdict);
  assert.match(line, /放行/);
  assert.match(line, /2026-09-15T01:00:00\.000Z/);
});

test("判红：只有陈旧 success（窗口外）——判词点名龄与窗口", () => {
  const verdict = evaluateObserveRecency({
    runs: [
      apiRun({ number: 78, updatedAt: "2026-09-13T22:44:53Z", createdAt: "2026-09-13T22:02:06Z" }),
    ],
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "stale");
  assert.equal(verdict.successCount, 1);
  const line = renderVerdictLine(verdict);
  assert.match(line, /阻断/);
  assert.match(line, /龄 49\.3 h ≥ 窗口 24 h/);
  assert.match(line, /2026-09-13T22:44:53\.000Z/);
});

test("判红：全是 failure / cancelled / 在途，以及一条 run 都没有", () => {
  const failures = evaluateObserveRecency({
    runs: [
      apiRun({ number: 76, conclusion: "failure" }),
      apiRun({ number: 75, conclusion: "cancelled" }),
      apiRun({ number: 74, conclusion: null, event: "workflow_dispatch", updatedAt: null }),
    ],
    now: NOW,
  });
  assert.equal(failures.ok, false);
  assert.equal(failures.status, "no-success");
  assert.equal(failures.successCount, 0);
  assert.equal(failures.run.number, 76, "判词要指向最近一次 run");
  assert.match(renderVerdictLine(failures), /结论 failure/);

  const none = evaluateObserveRecency({ runs: [], now: NOW });
  assert.equal(none.ok, false);
  assert.equal(none.status, "no-runs");
  assert.match(renderVerdictLine(none), /fail-closed/);
});

test("口径覆盖：在途 run（conclusion=null）不是证据；手动 dispatch 的 success 计入", () => {
  const inFlight = evaluateObserveRecency({
    runs: [
      apiRun({ number: 81, conclusion: null, updatedAt: null, createdAt: "2026-09-15T23:50:00Z" }),
    ],
    now: NOW,
  });
  assert.equal(inFlight.ok, false);
  assert.equal(inFlight.status, "no-success", "未收口的 run 不得当成「基线已刷新」");

  // dispatch 跑的是同一条全量管线、同样并集入档基线分支，故是等价证据（不按 event 过滤）
  const dispatched = evaluateObserveRecency({
    runs: [apiRun({ number: 82, event: "workflow_dispatch", updatedAt: "2026-09-15T23:40:00Z" })],
    now: NOW,
  });
  assert.equal(dispatched.status, "fresh");
  // 但窗口外照样判红：口径是「最近一期」，不是「历史上成功过」
  const oldDispatch = evaluateObserveRecency({
    runs: [apiRun({ number: 77, event: "workflow_dispatch", updatedAt: "2026-09-13T11:32:19Z" })],
    now: NOW,
  });
  assert.equal(oldDispatch.status, "stale");
});

test("边界：龄恰好 = 窗口 → 判陈旧（到达上界即拦）；窗口可注入且只改变边界", () => {
  const exact = evaluateObserveRecency({
    runs: [apiRun({ updatedAt: "2026-09-15T00:00:00Z" })],
    now: NOW,
  });
  assert.equal(exact.ageHours, 24);
  assert.equal(exact.status, "stale", "恰好 24 h 视为陈旧：窗口是允许的最大龄");

  const justInside = evaluateObserveRecency({
    runs: [apiRun({ updatedAt: "2026-09-15T00:00:01Z" })],
    now: NOW,
  });
  assert.equal(justInside.status, "fresh");

  const widened = evaluateObserveRecency({
    runs: [apiRun({ updatedAt: "2026-09-15T00:00:00Z" })],
    now: NOW,
    maxAgeHours: 48,
  });
  assert.equal(widened.status, "fresh", "窗口是可配置的：调宽即接受更旧的证据");
});

test("fail-closed：输入损坏一律抛错，不把「看不懂」当成「没有坏消息」", () => {
  const opts = { now: NOW };
  assert.throws(() => evaluateObserveRecency({ ...opts, runs: "nope" }), /不是数组/);
  assert.throws(() => evaluateObserveRecency({ ...opts, runs: [null] }), /不是对象/);
  assert.throws(() => evaluateObserveRecency({ ...opts, runs: ["x"] }), /不是对象/);
  assert.throws(
    () => evaluateObserveRecency({ ...opts, runs: [apiRun({ updatedAt: null })] }),
    /缺可解析的 updated_at/,
  );
  assert.throws(
    () => evaluateObserveRecency({ ...opts, runs: [apiRun({ updatedAt: "not-a-date" })] }),
    /不可解析/,
  );
  assert.throws(() => evaluateObserveRecency({ runs: [], now: "nope" }), /now 不可解析/);
  assert.throws(() => evaluateObserveRecency({ runs: [], now: NOW, maxAgeHours: 0 }), /正数/);
  assert.throws(
    () => evaluateObserveRecency({ runs: [], now: NOW, maxAgeHours: Number.NaN }),
    /正数/,
  );
});

test("override：不碰 run 数据即放行（取数与解析都坏掉时仍可用）", () => {
  const verdict = evaluateObserveRecency({ runs: "损坏", now: "nope", override: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, "overridden");
  assert.equal(verdict.overridden, true);
  assert.match(renderVerdictLine(verdict), /放行（override）/);
});

test("CLI 接线：新鲜放行 / 陈旧判红 / 裸数组也吃 / override 打印 ::warning:: 且不读数据", () => {
  withTmpDir((dir) => {
    const freshPath = join(dir, "fresh.json");
    writeFileSync(freshPath, JSON.stringify({ workflow_runs: [apiRun()] }));
    const fresh = runCli(["--runs-file", freshPath, "--now", NOW]);
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /::error::/);
    assert.match(fresh.stdout, /放行/);

    const stalePath = join(dir, "stale.json");
    writeFileSync(
      stalePath,
      JSON.stringify({ workflow_runs: [apiRun({ updatedAt: "2026-09-13T22:44:53Z" })] }),
    );
    const stale = runCli(["--runs-file", stalePath, "--now", NOW]);
    assert.equal(stale.status, 1, "旧 success 必须阻断发布");
    assert.match(stale.stdout, /^::error::/m);
    assert.match(stale.stdout, /阻断/);

    const barePath = join(dir, "bare.json");
    writeFileSync(barePath, JSON.stringify([apiRun()]));
    assert.equal(runCli(["--runs-file", barePath, "--now", NOW]).status, 0, "裸数组形态也接受");

    // override 刻意给一个读不到的 runs-file：能 exit 0 即证明它确实不取数据
    const over = runCli(["--runs-file", join(dir, "missing.json"), "--override"]);
    assert.equal(over.status, 0);
    assert.match(over.stdout, /^::warning::.*override/m);
    assert.match(over.stdout, /必须在.*写明理由/);

    // 环境变量入口（release.yml 判据步骤走的就是它）：值与 workflow 传入的布尔字面量一致
    const envOver = runCli(["--runs-file", join(dir, "missing.json")], {
      SKIP_OBSERVE_CHECK: "true",
    });
    assert.equal(envOver.status, 0);
    assert.match(envOver.stdout, /^::warning::.*override/m);
    // 只认字面量 "true"：值写歪不生效 ⇒ 落回严格校验（fail-closed 方向）
    const bogus = runCli(["--runs-file", join(dir, "missing.json")], { SKIP_OBSERVE_CHECK: "yes" });
    assert.equal(bogus.status, 1, "无法识别的 override 取值不得当成放行");
    assert.match(bogus.stdout, /^::error::/m);
  });
});

test("CLI fail-closed：取数 / 解析失败一律 exit 1 + 明确报错文本", () => {
  withTmpDir((dir) => {
    const cases = [
      { name: "bad.json", body: "not json", pattern: /不是合法 JSON/ },
      {
        name: "shape.json",
        body: JSON.stringify({ workflow_runs: "nope" }),
        pattern: /缺 workflow_runs 数组/,
      },
      {
        name: "broken.json",
        body: JSON.stringify({ workflow_runs: [apiRun({ updatedAt: null })] }),
        pattern: /缺可解析的 updated_at/,
      },
    ];
    for (const item of cases) {
      const file = join(dir, item.name);
      writeFileSync(file, item.body);
      const result = runCli(["--runs-file", file, "--now", NOW]);
      assert.equal(result.status, 1, `${item.name} 必须 fail-closed`);
      assert.match(result.stdout, /^::error::/m);
      assert.match(result.stdout, /fail-closed/);
      assert.match(result.stdout, item.pattern);
    }
    const missing = runCli(["--runs-file", join(dir, "gone.json"), "--now", NOW]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /读取失败/);
  });
});

test("CLI 参数校验：非法参数 exit 2（与「判据拦下 exit 1」区分）", () => {
  for (const args of [
    ["--max-age-hours", "0"],
    ["--max-age-hours", "abc"],
    ["--per-page", "0"],
    ["--per-page", "101"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(
      result.stderr,
      /^::error::门禁故障（非判据结论）：observe-precheck: --(max-age-hours|per-page)/m,
      `${args.join(" ")} 必须带统一故障注解`,
    );
    assert.equal(result.stdout, "", `${args.join(" ")} 不得污染 stdout`);
  }
});

test("CLI 参数校验：未知 flag / 多余位置参数一律 exit 2，不得静默回落默认值", () => {
  withTmpDir((dir) => {
    const freshPath = join(dir, "fresh.json");
    writeFileSync(freshPath, JSON.stringify({ workflow_runs: [apiRun()] }));
    for (const args of [
      ["--max-age-hour", "1"], // 少个 s：静默回落默认 24 h 就会放行
      ["--per-pag", "30"],
      ["--unknown"],
      ["stray"],
    ]) {
      const result = runCli([...args, "--runs-file", freshPath, "--now", NOW]);
      assert.equal(result.status, 2, `${args.join(" ")} 必须判参数非法`);
      assert.match(
        result.stderr,
        /^::error::门禁故障（非判据结论）：observe-precheck: 未知参数/m,
        `${args.join(" ")} 必须带统一故障注解`,
      );
      assert.equal(result.stdout, "", `${args.join(" ")} 不得污染 stdout`);
    }
    // 夹具本身在默认窗口下放行：上面几条一旦回落默认值就会 exit 0（静默漏网）
    assert.equal(runCli(["--runs-file", freshPath, "--now", NOW]).status, 0);
  });
});

test("release.yml 接线：前置 job 串在 publish 之前、actions: read、override 输入、tag 守卫；发布逻辑原样", () => {
  const yml = readFileSync(RELEASE_YML, "utf8");

  const permissions = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(yml);
  assert.ok(permissions !== null, "release.yml 必须有工作流级 permissions");
  assert.match(permissions[1], /^ {2}contents: write$/m);
  assert.match(
    permissions[1],
    /^ {2}actions: read$/m,
    "查 observe 的 run 列表需要 actions: read（显式声明后未列出的 scope 一律归零）",
  );

  const precheck = yml.indexOf("\n  observe-precheck:");
  const publish = yml.indexOf("\n  publish:");
  assert.ok(precheck !== -1 && publish !== -1, "两个 job 都在位");
  assert.ok(precheck < publish, "前置 job 必须在 publish 之前");

  const publishHead = yml.slice(publish, yml.indexOf("runs-on:", publish));
  assert.match(publishHead, /needs:\s*\[?observe-precheck/, "publish 必须 needs 前置 job");
  assert.match(
    publishHead,
    /if:\s*\$\{\{\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    "publish 必须有 tag 守卫：workflow_dispatch 可作用于任意 ref，缺它则「推 tag 是唯一发布开关」被绕过",
  );

  const precheckBlock = yml.slice(precheck, publish);
  // 工作流级声明了 contents: write，它默认被每个 job 继承；没有 job 级覆盖，最小权限就没落实。
  const jobPerms = /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(precheckBlock);
  assert.ok(jobPerms !== null, "observe-precheck 必须有 job 级 permissions");
  assert.match(jobPerms[1], /^ {6}contents: read$/m, "checkout 需要 contents: read");
  assert.match(jobPerms[1], /^ {6}actions: read$/m, "查 observe 的 run 列表需要 actions: read");
  assert.doesNotMatch(jobPerms[1], /write/, "前置校验不得持有任何写权限");
  assert.match(precheckBlock, /timeout-minutes:/, "job 必须有超时（仓库约定）");
  assert.match(
    precheckBlock,
    /node scripts\/release\/observe-precheck\.mjs/,
    "判据必须来自脚本，不得在 workflow 里另写一段 bash 判据",
  );
  assert.match(
    precheckBlock,
    /SKIP_OBSERVE_CHECK:\s*\$\{\{\s*inputs\.skip_observe_check\s*\}\}/,
    "override 必须由 workflow_dispatch 输入接进执行路径",
  );
  assert.match(
    precheckBlock,
    /^ {8}run: node scripts\/release\/observe-precheck\.mjs$/m,
    "判据步骤必须是「一条直接命令」的闭合形态（多行包装会被 gate-wiring 的形态断言判红）",
  );

  assert.match(yml, /workflow_dispatch:/, "override 逃生口需要可手动派发");
  assert.match(yml, /skip_observe_check:/);
  assert.match(yml, /type:\s*boolean/);
  assert.match(yml, /default:\s*false/, "override 默认必须是关的");

  // 既有发布逻辑不得改动
  assert.match(yml, /tags:\s*\n\s*- 'v\*'/, "tag 触发条件不得改动");
  assert.match(yml, /node scripts\/release\/publish-if-missing\.ts/, "发布步骤不得改动");
  assert.match(yml, /pnpm --filter "\$pkg" publish --no-git-checks/);
  assert.match(yml, /node scripts\/release\/verify-version\.ts/);
});

test("release.yml ref 守卫：分支 ref 派发必须判红，不得以绿色空跑收场", () => {
  const yml = readFileSync(RELEASE_YML, "utf8");
  const precheck = yml.indexOf("\n  observe-precheck:");
  const publish = yml.indexOf("\n  publish:");
  const precheckBlock = yml.slice(precheck, publish);

  const guardAt = precheckBlock.indexOf("Ref guard");
  assert.ok(
    guardAt !== -1,
    "observe-precheck 必须有一条显式的 ref 守卫：publish 被 tag 守卫跳过后，分支 ref 派发会以 success 收场，界面看起来像已发布",
  );
  const guard = precheckBlock.slice(guardAt);
  // 条件必须是 publish tag 守卫的补集：两处若不同源，收紧一处另一处照旧漏。
  assert.match(
    guard,
    /if:\s*\$\{\{\s*!startsWith\(github\.ref, 'refs\/tags\/v'\)\s*\}\}/,
    "ref 守卫只在非 v* tag 上触发，才是 publish 守卫的补集",
  );
  // 绿色空跑的风险高于一次误红：只打 ::warning:: 仍会让 run 以 success 结束。
  assert.match(guard, /::error::/, "分支 ref 派发要能在 run 里直接看到判红注解");
  assert.match(guard, /^\s*exit 1\s*$/m, "ref 守卫必须非 0 退出——告警挡不住「绿色=已发布」的误读");

  // 判据之后：前置校验的判词照旧打印（分支派发仍是可用的演练），run 结论由守卫接管。
  const judgmentAt = precheckBlock.indexOf("node scripts/release/observe-precheck.mjs");
  assert.ok(judgmentAt !== -1 && judgmentAt < guardAt, "ref 守卫必须在判据步骤之后");
});
