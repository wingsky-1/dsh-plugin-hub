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
  assert.match(r.stdout, /合计 2 条待办：已过期 0 \/ 90 天内到期 1 \/ 其余 1/);
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
    /合计 2 条待办：已过期 0 \/ 90 天内到期 0 \/ 其余 1 \/ 仅解除条件（无到期日）1/,
  );
  assert.match(r.stdout, /其中 1 条只有到期日、没有 exitCriteria/);
});

test("既无排除形状也无待办字段的数据文件不产生条目；空目录给明确说明而非静默", () => {
  const r = run(fixture({ "x.json": { active: ["dsh-a"], retired: [] } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未发现待办条目（结构性 0 条；扫描 1 个数据文件/);
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

test("本仓真实快照：15 条在册（数字变即提示同步台账与 #765）", () => {
  // 7 = coverage.config.json 4（#769 把一条 **/client/** 拆成 per-package 的 pending-project
  //     条目：notifier 的 .tsx 渲染面 + 另外 3 个包的整个 client 面 + shared/client/**；
  //     #840 退役 dsh-web-file-preview 时删掉它那一条，7 → 6；
  //     #883 给 lan-proxy 客户端补直连判据后删掉它那一条，6 → 5 当中的覆盖率部分 5 → 4；
  //     #947 把 mcp-manager 的一条整个 client 面按文件拆成 11 条（panel.ts 与 state.ts 计入分母），覆盖率部分 4 → 14）
  //     + gauntlet.config.json 1（crap.strict 观察期，仅解除条件、无到期日）
  //     + gate-exemptions.json 1（#770 mcp panel 单飞句柄）
  // #875 4c：gate-exemptions.json 的 12 → 1——#767 lan-proxy unit-apply 1 条与 #847 sidebar
  //   客户端单测 10 条的 I8① 证据全部清零（迁 test/client-unit / 改直连域门面 / 入口契约
  //   判据迁集成层），11 条随证据消失按反向腐烂校验删除，27 → 16。
  // #T1A：mcp-manager 客户端 core/session.ts 那条已陈旧（实测 lines 100% / branches 95.45%，
  //   且其 reason「尚无直连判据」为假——test/client-unit/client-context-s2.test.ts:19 直接导入
  //   bindSession / rebindSession），随删除消失，覆盖率部分 14 → 13，16 → 15。同批评的 9 条
  //   只改 exitCriteria 措辞、不增删条目，故台账数不再变。
  // 本 PR：**台账数不变（15）**。处理了 4 条 pending-project 但一条未删——
  //   settings-card.tsx 那条水位与变异探针均已达标，只缺第二条件（未进 mutate 面），故保留；
  //   notifier .tsx 与 provider-usage 客户端两条按文件收窄（各出 3 个文件进分母）；
  //   shared/client/** 只改 reason 与 exitCriteria。收窄与改写都不增删条目。
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /合计 8 条待办：已过期 0 /);
  assert.match(r.stdout, /仅解除条件（无到期日）1/);
  // crap.strict 的解除条件必须在台账里（只写日期会逼出「到期了再讨论一次」）
  assert.match(r.stdout, /\$\.crap {2}threshold=16/);
  assert.match(r.stdout, /exitCriteria 超阈 hotspots 计数降为 0/);
  assert.doesNotMatch(r.stdout, /mutation\.packages\.dsh-worktree-sidebar#anchor/);
  // #875 4c：#767 lan-proxy 那一条与 #847 sidebar 十条 I8① 证据已全部清零
  //   （迁 test/client-unit / 改直连域门面 / 入口契约判据迁集成层），11 条随证据消失
  //   按反向腐烂校验删除。本快照改为**反向**钉住：verify-dir-imports 通道在册数必须
  //   为 0 —— 零豁免是目标，台账里再出现任何一条都说明有人重新登记了同一处越界。
  assert.doesNotMatch(r.stdout, /gate=verify-dir-imports/);
  assert.doesNotMatch(r.stdout, /trackingIssue #847/);
  assert.doesNotMatch(r.stdout, /trackingIssue #767/);
  // keep-mounted 两条已随测试迁出 unit 面，证据与 exemption 一并删除。
  // 覆盖率面的临时排除项也必须在台账里（它是「到期复核」的输入，不该只活在配置里）
  // 索引 5 = 前五条是 type-only / not-source 的永久事实（d.ts / d.mts / ps1 / md / css），
  // 第六条起才是带 reviewBy 的临时排除项。
  // 本 PR 把 notifier .tsx 那条按文件收窄（pattern 由 **/*.tsx 通配改为逐文件枚举，
  // 三个已过变异探针的文件出分母），索引不变、pattern 变，故这里跟到新 pattern 的前缀。
  assert.match(
    r.stdout,
    /\$\.exclude\[5\] {2}pattern=packages\/dsh-notifier\/src\/client\/\{index\.tsx,/,
  );
  assert.match(r.stdout, /reviewBy 2027-03-31/);
});

/** 排除面条目 fixture：形状（pattern + reason）+ kind，字段按用例给。 */
function exclusion(pattern: string, kind: string, extra: Record<string, unknown> = {}) {
  return { pattern, kind, reason: `理由：${pattern} 按 ${kind} 分类`, ...extra };
}

test("反证：删掉 pending-project 的 reviewBy/exitCriteria，它仍在台账里（按 kind 分桶）", () => {
  // 旧口径下这条会随字段一起消失：计数 0 → 台账里什么都没有、exit 0、无判词。
  const r = run(
    fixture({
      "coverage.config.json": {
        exclude: [
          exclusion("packages/dsh-fake/src/client/**", "pending-project"), // 无 reviewBy / exitCriteria
          exclusion("**/*.ps1", "not-source"),
        ],
      },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /待办（依据 kind=pending-project \/ kind）/);
  assert.match(r.stdout, /合计 1 条待办/);
  assert.match(r.stdout, /结构性 1 条（不计入待办）：not-source×1/);
});

test("反证：结构性 kind（not-source / type-only / facade / not-mutated）一条都不计入待办", () => {
  const r = run(
    fixture({
      "coverage.config.json": {
        exclude: [
          exclusion("**/*.d.ts", "type-only"),
          exclusion("**/*.ps1", "not-source"),
          exclusion("packages/dsh-fake/src/server/interface.ts", "facade"),
          exclusion("packages/dsh-fake/src/port.ts", "not-mutated"),
        ],
      },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未发现待办条目（结构性 4 条/);
  assert.match(
    r.stdout,
    /结构性 4 条（不计入待办）：facade×1、not-mutated×1、not-source×1、type-only×1/,
  );
});

test("认面按形状而非键名：非排除面的 kind 节点（CI 面 / 阈值声明面）不收进台账", () => {
  // 形状同源于 scripts/lib/exemption-kind.ts 的实测：ci-face-registry 有 26 个 kind 节点、
  // threshold-registry 有 12 个，按键名发现会凭空多出 38 条待办。
  const r = run(
    fixture({
      "ci-face-registry.json": { faces: [{ kind: "indirect", face: "gate" }] },
      "threshold-registry.json": { guards: [{ kind: "value", paths: ["a.b"], why: "阈值守卫" }] },
    }),
    ["--today", "2026-01-01"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未发现待办条目（结构性 0 条/);
});

test("未识别 kind 落待办兜底并点名依据（多算不少算，漂移可见）", () => {
  const r = run(fixture({ "x.json": { exclude: [exclusion("**/vendor.ts", "brand-new")] } }), [
    "--today",
    "2026-01-01",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /待办（依据 kind=brand-new \/ unknown-kind）/);
  assert.match(r.stdout, /合计 1 条待办/);
});

test("本仓真实快照：排除面按 kind 分为 6 + 16 结构性，合计待办 8 条", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--today", "2026-09-28"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  // 覆盖率面：13 条 type-only / not-source 不计入待办（本仓实测值，数字变即提示同步判词）
  assert.match(r.stdout, /结构性 13 条（不计入待办）：not-source×11、type-only×2/);
  // 变异面 coverageExcludes：16 条全是结构性的（facade / not-mutated / type-only / not-source）
  assert.match(
    r.stdout,
    /结构性 16 条（不计入待办）：facade×4、not-mutated×4、not-source×1、type-only×7/,
  );
  // 6 条 pending-project + gauntlet 1 + gate-exemptions 1 = 8 条待办
  // （已删 mcp-manager core/i18n.ts、client/locales.ts、core/dom.ts、core/constants.ts、core/api.ts、
  //  进 mutation-topology mutate 面 + 变异探针打红；一条豁免一次落地）
  assert.match(r.stdout, /合计 8 条待办/);
  assert.match(r.stdout, /结构性（按设计不计入待办）29/);
});
