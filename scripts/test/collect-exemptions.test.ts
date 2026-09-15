#!/usr/bin/env node
// @ts-nocheck
/** collect-exemptions.mjs 自测：收集面 / 指针定位 / 到期分档 / 恒 exit 0（它是报告不是门禁）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "gate", "collect-exemptions.mjs");

/** fixture 数据目录；files: { 文件名: JSON 值 } */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "collect-exemptions-"));
  const dataDir = join(dir, "scripts", "data");
  mkdirSync(dataDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2));
  }
  return dir;
}

function run(dir, extraArgs = []) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", dir, ...extraArgs], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("收集：嵌套在数组与对象里的 reviewBy 都被收集，并给出 $.a[0].b 形式指针", () => {
  const r = run(
    fixture({
      "x.json": {
        exemptions: [
          { gate: "g", path: "p/a.ts", reason: "r", trackingIssue: "#1", reviewBy: "2027-01-01" },
        ],
        nested: { deep: { package: "dsh-y", reason: "r", reviewBy: "2027-02-01" } },
      },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\$\.exemptions\[0\] {2}gate=g {2}path=p\/a\.ts/);
  assert.match(r.stdout, /\$\.nested\.deep {2}package=dsh-y/);
  assert.match(r.stdout, /合计 2 条/);
});

test("收集：trackingIssue 缺省时不打印该字段（不编造）", () => {
  const r = run(
    fixture({
      "x.json": { pending: [{ package: "dsh-z", reason: "r", reviewBy: "2027-01-01" }] },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("trackingIssue"), `缺 trackingIssue 时不应出现该字样：${r.stdout}`);
});

test("分档：已过期条目点名天数，但退出码仍为 0（报告不是门禁）", () => {
  const r = run(
    fixture({
      "x.json": { e: [{ path: "p/old.ts", reason: "r", reviewBy: "2026-01-01" }] },
    }),
    ["--today", "2026-03-02"],
  );
  assert.equal(r.status, 0, "报告不得因过期而判红");
  assert.match(r.stdout, /已过期 60 天/);
  assert.match(r.stdout, /已过期 1 \/ 90 天内到期 0/);
});

test("分档：90 天内到期单列，其余归入合计", () => {
  const r = run(
    fixture({
      "x.json": {
        soon: [{ path: "p/s.ts", reason: "r", reviewBy: "2026-02-01" }],
        later: [{ path: "p/l.ts", reason: "r", reviewBy: "2027-06-01" }],
      },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /剩 31 天/);
  assert.match(r.stdout, /合计 2 条：已过期 0 \/ 90 天内到期 1 \/ 其余 1/);
});

test("收集：exitCriteria 与 reviewBy 平级入账；只有日期没有解除条件的条目被点名", () => {
  const r = run(
    fixture({
      "x.json": {
        dated: [{ path: "p/a.ts", reason: "r", reviewBy: "2027-01-01" }],
        conditional: [
          { pattern: "**/client/**", reason: "r", exitCriteria: "happy-dom project 落地" },
        ],
      },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /exitCriteria happy-dom project 落地/);
  assert.match(
    r.stdout,
    /合计 2 条：已过期 0 \/ 90 天内到期 0 \/ 其余 1 \/ 仅解除条件（无到期日）1/,
  );
  assert.match(r.stdout, /其中 1 条只有到期日、没有 exitCriteria/);
});

test("既无 reviewBy 也无 exitCriteria 的数据文件不产生条目；空目录给明确说明而非静默", () => {
  const r = run(fixture({ "x.json": { active: ["dsh-a"], retired: [] } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未发现带 reviewBy 或 exitCriteria 的条目（扫描 1 个数据文件）/);
});

test("坏 JSON 只跳过该文件并计数，不影响其余文件的收集", () => {
  const dir = fixture({
    "good.json": { e: [{ path: "p/g.ts", reason: "r", reviewBy: "2027-01-01" }] },
  });
  try {
    writeFileSync(join(dir, "scripts", "data", "bad.json"), "{ 这不是 JSON");
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--today", "2026-01-01"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[跳过\] JSON 解析失败/);
    assert.match(r.stdout, /另有 1 个数据文件无法解析/);
    assert.match(r.stdout, /\$\.e\[0\] {2}path=p\/g\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非 JSON 文件不参与扫描（只看 scripts/data 下的 .json）", () => {
  const dir = fixture({
    "x.json": { e: [{ path: "p/a.ts", reason: "r", reviewBy: "2027-01-01" }] },
  });
  try {
    writeFileSync(join(dir, "scripts", "data", "notes.md"), "reviewBy 2020-01-01 不该被收集");
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--today", "2026-01-01"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /合计 1 条/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("本仓真实快照：6 条在册（数字变即提示同步台账与 #765）", () => {
  // 6 = coverage.config.json 5（#769 把一条 **/client/** 拆成 per-package 的 pending-project
  //     条目：notifier 的 .tsx 渲染面 + 另外 3 个包的整个 client 面 + shared/client/**；
  //     #840 退役 dsh-web-file-preview 时删掉它那一条，7 → 6）
  //     + gauntlet.config.json 1（crap.strict 观察期，仅解除条件、无到期日）。
  // 「按包按面收窄」的代价就是台账条目变多——这是设计而不是噪音：每条都带自己的
  // exitCriteria，某个包的客户端有了直连判据就该删掉它自己那一条。
  // gate-exemptions.json 的 #762 条目已随 #769 阶段 3 清空，该来源也不再出现在报告里；
  // plugins-manifest 的 5 条 configSurfacesPending 已随 #774 全部转为 configSurfaces 声明
  // （含 2 条 surface: "none"），不再产生 reviewBy。
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /合计 6 条：已过期 0 /);
  assert.match(r.stdout, /仅解除条件（无到期日）1/);
  // crap.strict 的解除条件必须在台账里（只写日期会逼出「到期了再讨论一次」）
  assert.match(r.stdout, /\$\.crap {2}threshold=16/);
  assert.match(r.stdout, /exitCriteria 超阈 hotspots 计数降为 0/);
  // 台账已清空：报告不该再点名 gate-exemptions.json 这个来源
  assert.doesNotMatch(r.stdout, /gate-exemptions\.json/);
  // 覆盖率面的临时排除项也必须在台账里（它是「到期复核」的输入，不该只活在配置里）
  // 索引 5 = 前五条是 type-only / not-source 的永久事实（d.ts / d.mts / ps1 / md / css），
  // 第六条起才是带 reviewBy 的临时排除项。
  assert.match(
    r.stdout,
    /\$\.exclude\[5\] {2}pattern=packages\/dsh-notifier\/src\/client\/\*\*\/\*\.tsx/,
  );
  assert.match(r.stdout, /reviewBy 2027-03-31/);
});
