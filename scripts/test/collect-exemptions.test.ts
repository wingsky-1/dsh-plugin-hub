#!/usr/bin/env node
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
function fixture(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "collect-exemptions-"));
  const dataDir = join(dir, "scripts", "data");
  mkdirSync(dataDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2));
  }
  return dir;
}

function run(dir: string, extraArgs: string[] = []) {
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

test("本仓真实快照：27 条在册（数字变即提示同步台账与 #765）", () => {
  // 7 = coverage.config.json 4（#769 把一条 **/client/** 拆成 per-package 的 pending-project
  //     条目：notifier 的 .tsx 渲染面 + 另外 3 个包的整个 client 面 + shared/client/**；
  //     #840 退役 dsh-web-file-preview 时删掉它那一条，7 → 6；
  //     #883 给 lan-proxy 客户端补直连判据后删掉它那一条，6 → 5 当中的覆盖率部分 5 → 4；
  //     #947 把 mcp-manager 的一条整个 client 面按文件拆成 11 条（panel.ts 与 state.ts 计入分母），覆盖率部分 4 → 14）
  //     + gauntlet.config.json 1（crap.strict 观察期，仅解除条件、无到期日）
  //     + gate-exemptions.json 12（#767 B0：#770 mcp panel 单飞句柄 + #767 lan-proxy unit-apply
  //       + #847 sidebar 客户端单测 10 条，同批 unit-proxy/wfp 两条已随主干演进消除而不登记；
  //       reviewBy + exitCriteria 双全；首登 dsh-jev-decide 两条（#membership+#anchor）随本地实测锚
  //       落定全部删除：#membership 随条目进表先删，#anchor 随 fixedCovered=64.84 本地锚后删）。
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /合计 27 条：已过期 0 /);
  assert.match(r.stdout, /仅解除条件（无到期日）1/);
  // crap.strict 的解除条件必须在台账里（只写日期会逼出「到期了再讨论一次」）
  assert.match(r.stdout, /\$\.crap {2}threshold=16/);
  assert.match(r.stdout, /exitCriteria 超阈 hotspots 计数降为 0/);
  assert.doesNotMatch(r.stdout, /mutation\.packages\.dsh-worktree-sidebar#anchor/);
  // #847 在此快照里是 sidebar 十条 I8 存量的跟踪号（合法出现）；变异回落锚点仍不得出现。
  assert.match(r.stdout, /trackingIssue #847/);

  // #767 B0：扩包后新增的存量豁免同样必须在台账里——只判红不登记，或只登记不进台账，
  // 都会让「到期复核」失去输入（这一条是台账完整性的锚，不是计数装饰）
  assert.match(r.stdout, /\$\.exemptions\[0\] {2}gate=forbid-module-state-src/);
  assert.match(r.stdout, /trackingIssue #770/);
  // #767 B0 切片 3b：I8① 判据上线时跨包存量同样必须进台账（逐条钉住证据键本身，
  // 而不是只钉一个总数：条目被换成人手写的近似路径时先红）。同批 unit-proxy/wfp 两条
  // 已随主干演进消除而不登记，此处只钉幸存的 unit-apply 一条。
  assert.match(r.stdout, /trackingIssue #767/);
  assert.match(
    r.stdout,
    /\$\.exemptions\[1\] {2}gate=verify-dir-imports {2}path=dsh-lan-proxy:test\/unit\/unit-apply\.test\.ts\|src\/index\.ts/,
  );
  // sidebar 十条 I8 存量逐条钉住证据键（#847 跟踪）：换成近似路径先红。索引 [2..11] 与台账顺序一致。
  assert.match(
    r.stdout,
    /\$\.exemptions\[2\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-bindings\.test\.ts\|src\/client\/bindings\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[3\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-index\.test\.ts\|src\/client\/index\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[4\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-index\.test\.ts\|src\/client\/shared\/ports\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[5\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-index\.test\.ts\|src\/client\/takeover\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[6\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-source\.test\.ts\|src\/client\/source\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[7\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-takeover\.test\.ts\|src\/client\/inject\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[8\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-takeover\.test\.ts\|src\/client\/shared\/ports\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[9\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/client-takeover\.test\.ts\|src\/client\/takeover\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[10\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/inject-attach\.test\.ts\|src\/client\/inject\.ts/,
  );
  assert.match(
    r.stdout,
    /\$\.exemptions\[11\] {2}gate=verify-dir-imports {2}path=dsh-worktree-sidebar:test\/unit\/inject-attach\.test\.ts\|src\/client\/shared\/ports\.ts/,
  );
  // 覆盖率面的临时排除项也必须在台账里（它是「到期复核」的输入，不该只活在配置里）
  // 索引 5 = 前五条是 type-only / not-source 的永久事实（d.ts / d.mts / ps1 / md / css），
  // 第六条起才是带 reviewBy 的临时排除项。
  assert.match(
    r.stdout,
    /\$\.exclude\[5\] {2}pattern=packages\/dsh-notifier\/src\/client\/\*\*\/\*\.tsx/,
  );
  assert.match(r.stdout, /reviewBy 2027-03-31/);
});
