#!/usr/bin/env node
/**
 * verify-prose-counts 自测（#767 P6 试点）：config 三形态解析 + scope 段数词 + 失配判红 +
 * 未知形态 fail-closed（exit 2）+ 空段 fail-closed + 本地接线。
 *
 * 每条判据都有正反例：三形态的文法边界（非法区间、空项、不配平、多组括号）与 scope 只看段首小节
 * 的规则是本次新增的约定，约定只有写成断言才不会被下一个人无意改掉。断言一律对动态段数——
 * 不写死任何包的当前段数（拓扑加段时测试不跟着改，只有散文忘了改时才红）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkPackage,
  parseConfigProse,
  parseCountNumeral,
  parseEnumProse,
  parseRangeProse,
  parseScopeCount,
  segmentSetMismatch,
} from "../gate/verify-prose-counts.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-prose-counts.mjs");

/** 构造最小 fixture 仓库：只写两份数据文件（gauntlet 散文面 + topology 事实源）。 */
function fixture(gauntletPkgs: Record<string, unknown>, topoPkgs: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), "prose-counts-"));
  mkdirSync(join(root, "scripts", "data"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "data", "gauntlet.config.json"),
    JSON.stringify({ mutation: { packages: gauntletPkgs } }, null, 2),
  );
  const segments: Record<string, unknown> = {};
  for (const [pkg, keys] of Object.entries(topoPkgs)) {
    segments[pkg] = { segments: Object.fromEntries(keys.map((k) => [k, {}])) };
  }
  writeFileSync(
    join(root, "scripts", "data", "mutation-topology.json"),
    JSON.stringify({ packages: segments }, null, 2),
  );
  return root;
}

function run(root: string, extra: string[] = []) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PKG = "dsh-fake";

// ---------- 一、config 三形态解析（纯函数） ----------

test("枚举 {a,b,c}：解析出段名清单", () => {
  assert.deepEqual(parseConfigProse("stryker.conf.d/dsh-fake-{api,channels,config}.json（注）"), {
    kind: "enum",
    segments: ["api", "channels", "config"],
    reason: "",
  });
});

test("区间 {1..4}：展开为十进制字符串序列", () => {
  assert.deepEqual(parseConfigProse("stryker.conf.d/dsh-fake-{1..4}.json（注）"), {
    kind: "range",
    segments: ["1", "2", "3", "4"],
    reason: "",
  });
});

test("无括号：单段形态（不断言段名）", () => {
  assert.deepEqual(parseConfigProse("stryker.conf.d/dsh-fake.json"), {
    kind: "single",
    segments: [],
    reason: "",
  });
});

test("未知形态一律 unknown（非数字区间/不配平/多组括号/空项/空组）", () => {
  for (const bad of [
    "stryker.conf.d/dsh-fake-{a..z}.json",
    "stryker.conf.d/dsh-fake-{4..1}.json",
    "stryker.conf.d/dsh-fake-{a,b.json",
    "stryker.conf.d/dsh-fake-{a}{b}.json",
    "stryker.conf.d/dsh-fake-{a,,b}.json",
    "stryker.conf.d/dsh-fake-{}.json",
  ]) {
    assert.equal(parseConfigProse(bad).kind, "unknown", bad);
  }
});

// ---------- 二、scope 段数词（纯函数） ----------

test("scope 段数词：九段/十二段/阿拉伯数字", () => {
  assert.equal(parseScopeCount("src 级九段（…）：…").count, 9);
  assert.equal(parseScopeCount("src 级十二段（…）：…").count, 12);
  assert.equal(parseScopeCount("src 级9段：…").count, 9);
});

test("scope 只看段首小节：括号后的历史注记不看", () => {
  // "旧三段"是变更历史，"二段"才是当前段数——看错位置会把一致判成失配
  assert.equal(parseScopeCount("src 级二段（旧三段拆分）：a / b").count, 2);
});

test("scope 无段数词（如全量）即跳过，不断言", () => {
  assert.equal(parseScopeCount("src 级全量（…）；…").kind, "absent");
});

test("中文数字解析：十/百位组合", () => {
  assert.equal(parseCountNumeral("四"), 4);
  assert.equal(parseCountNumeral("十二"), 12);
  assert.equal(parseCountNumeral("二十五"), 25);
});

// ---------- 三、比对语义（纯函数） ----------

test("集合比对与顺序无关（散文顺序 ≠ 拓扑键序仍一致）", () => {
  const { problems, fatals } = checkPackage(
    PKG,
    "stryker.conf.d/dsh-fake-{entry,apply}.json",
    "src 级二段：entry / apply",
    ["apply", "entry"],
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(fatals, []);
});

test("空段即 fail-closed（没有可比对的事实源）", () => {
  const { fatals } = checkPackage(PKG, "stryker.conf.d/dsh-fake-{a}.json", "src 级一段：a", []);
  assert.equal(fatals.length, 1);
});

// ---------- 四、退出码三态（子进程，真实 exit code） ----------

test("正例三形态：枚举/区间/单段各 exit 0", () => {
  let r = run(
    fixture(
      { [PKG]: { config: "x-{a,b}.json", scope: "src 级二段：a / b" } },
      { [PKG]: ["a", "b"] },
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify-prose-counts: OK/);

  r = run(
    fixture(
      { [PKG]: { config: "x-{1..3}.json", scope: "src 级三段" } },
      { [PKG]: ["1", "2", "3"] },
    ),
  );
  assert.equal(r.status, 0, r.stderr);

  r = run(fixture({ [PKG]: { config: "x.json", scope: "src 级全量" } }, { [PKG]: ["_single"] }));
  assert.equal(r.status, 0, r.stderr);
});

test("失配判红 exit 1（config 清单 + scope 段数词各一条）", () => {
  const r = run(
    fixture(
      { [PKG]: { config: "x-{a,b}.json", scope: "src 级二段：a / b" } },
      { [PKG]: ["a", "b", "c"] },
    ),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config 段清单与拓扑不一致/);
  assert.match(r.stderr, /scope 段数词 2段 与拓扑 3 段不一致/);
});

test("未知形态 exit 2 且带门禁故障注解（不读成通过/不达标）", () => {
  const r = run(
    fixture(
      { [PKG]: { config: "x-{a..z}.json", scope: "src 级三段" } },
      { [PKG]: ["a", "b", "c"] },
    ),
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /::error::门禁故障（非判据结论）/);
});

test("空段 exit 2（拓扑无事实源可比）", () => {
  const r = run(fixture({ [PKG]: { config: "x-{a}.json", scope: "src 级一段" } }, { [PKG]: [] }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /::error::门禁故障（非判据结论）/);
});

test("--help exit 0 且说明三态", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /用法：/);
  assert.match(r.stdout, /退出码：0 = 全部一致；1 = 散文与拓扑失配；2 = 门禁故障/);
});

test("真实仓库自跑 exit 0（只断言一致性，不写死段数）", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify-prose-counts: OK/);
});

// ---------- 五、本地接线：local-gate 可跑到 + package.json 有入口 ----------

test("接线：local-gate 的 pr 计划含该闸（标签与 args 耦合）+ package.json script", () => {
  const plan = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "gate", "local-gate.mjs"), "--tier", "pr", "--dry-run"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(
    plan.stdout,
    /\n {2}- verify:prose-counts（散文段数：config\/scope 与拓扑一致） {2}→ {2}\S+ verify:prose-counts$/m,
    "local-gate 的 cheapGlobal 缺该闸（或标签与 args 脱钩）：本地档看不到，本地绿而 CI 红的落差由此产生",
  );
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["verify:prose-counts"], "node scripts/gate/verify-prose-counts.mjs");
});

// ── 拆出后各纯判据的直接单测（#732 E5）：每条锁一个形态判定，不经 checkPackage 间接观察 ──

test("parseRangeProse：区间展开、形态非法与区间倒置各判一次", () => {
  assert.deepEqual(parseRangeProse("1..3"), {
    kind: "range",
    segments: ["1", "2", "3"],
    reason: "",
  });
  assert.deepEqual(parseRangeProse("2..2"), { kind: "range", segments: ["2"], reason: "" });
  assert.deepEqual(parseRangeProse("1.."), {
    kind: "unknown",
    segments: [],
    reason: "区间形态非法：{1..}",
  });
  assert.deepEqual(parseRangeProse("3..1"), {
    kind: "unknown",
    segments: [],
    reason: "区间倒置：{3..1}",
  });
});

test("parseEnumProse：逐项 trim 后校验，任一项非法即整段 unknown", () => {
  assert.deepEqual(parseEnumProse("a, b"), { kind: "enum", segments: ["a", "b"], reason: "" });
  // 空项（尾随逗号）非法。
  assert.deepEqual(parseEnumProse("a,"), {
    kind: "unknown",
    segments: [],
    reason: "枚举项非法：{a,}",
  });
  // 非法段名（带空格以外的形式）非法，判词不点哪一项。
  assert.deepEqual(parseEnumProse("a, b/c"), {
    kind: "unknown",
    segments: [],
    reason: "枚举项非法：{a, b/c}",
  });
});

test("segmentSetMismatch：段清单与拓扑一致时无判词，缺/多各进一条判词", () => {
  const enumParsed = { kind: "enum", segments: ["a", "b"], reason: "" };
  assert.deepEqual(segmentSetMismatch("p", enumParsed, ["b", "a"]), []);
  assert.deepEqual(segmentSetMismatch("p", enumParsed, ["a"]), [
    "[p] config 段清单与拓扑不一致（enum形态）：拓扑多出无；散文多出b（拓扑 1 段，散文 2 段）",
  ]);
  assert.deepEqual(segmentSetMismatch("p", enumParsed, ["a", "b", "c"]), [
    "[p] config 段清单与拓扑不一致（enum形态）：拓扑多出c；散文多出无（拓扑 3 段，散文 2 段）",
  ]);
  // range 形态把 kind 带进判词。
  const rangeParsed = { kind: "range", segments: ["1", "2"], reason: "" };
  assert.deepEqual(segmentSetMismatch("p", rangeParsed, ["2", "3"]), [
    "[p] config 段清单与拓扑不一致（range形态）：拓扑多出3；散文多出1（拓扑 2 段，散文 2 段）",
  ]);
});
