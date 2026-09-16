#!/usr/bin/env node
/**
 * scripts/gate/local-gate.mjs — 本地门禁分层执行器（#722 门禁分层）。
 *
 * 为什么需要它：AGENTS.md 的提交前最小集原本是「全仓 build + 全仓 test + 全仓 typecheck
 * + contract + pack:check」。全仓口径对单包改动的开发者是纯浪费——CI 早就按 ci.yml 的
 * paths-filter 做了切片（build-test 只对命中包跑 test/typecheck），本地却一律全量。本
 * 脚本把同一份包面归属搬到本地，并把各档的对象面固定下来（增量只留给 changed 快线）：
 *
 *   changed  命中包的 build + test + typecheck（迭代快线；命中全局面时自动升到 pr）
 *   pr       **全仓**口径：全仓 build + test + typecheck + 产物闸（contract / pack:check /
 *            verify:npmlayout，均传全包包名）+ 廉价全仓一致性闸（秒级静态检查，不依赖 lib 产物）
 *   full     同 pr（口径相同），另加豁免到期台账收集；`--with-coverage` 时补 cov / crap
 *
 * 注意 pr/full 两档都是**全仓**对象面，与 CI 的「PR 默认增量」不同——本文件只把增量留给
 * changed 快线（CI 的增量由 paths-filter 切片承担，本地没有 PR 上下文可切）。因此本地 pr
 * ≈ CI 的 gate:full 减去覆盖率与变异。
 *
 * 本地不跑变异（#742 阶段 3.2 起更要点明）：变异自 #742 阶段 1 起在 PR 上按命中切片**强制**
 * 跑，本地三档都覆盖不到它；覆盖率归 gate:full 标签与夜间 observe.yml（全仓产物闸已在 pr 档内）。
 * 包面归属的唯一事实源是 ci.yml 的 filters 块（见 local-scope.mjs），本脚本不重述路径规则。
 *
 * 用法：
 *   node scripts/gate/local-gate.mjs [--tier changed|pr|full] [--base <ref>] [--dry-run] [--with-coverage]
 * 退出码：0 = 全部通过；1 = 某步失败（首个失败即停，摘要列出全部已跑步骤的 exit code）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { computeCiMatrix } from "../ci/ci-matrix.mjs";
import { TIER_ALIAS, tierSteps } from "./gate-steps.mjs";
import { planChangedScope, shouldEscalateChangedTier } from "./local-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function sh(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
}

function gitLines(args) {
  const res = sh("git", args);
  if (res.status !== 0) return null;
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 本次改动文件集。
 *
 * 基准取 `merge-base(base, HEAD)`（三点比的等价物），而不是裸 `base`：两点比会把
 * 主干上先于本分支的提交算成「本次改动」——本地因此放大跑的面，并在 base 前进后产生
 * 与 CI 无关的假命中。
 *
 * 与 CI 的关系是「近似」而非「相等」：PR 事件上 dorny/paths-filter 走 REST
 * `pulls.listFiles`（显式 base 被忽略），语义 ≈ 三点比；差异有二——重命名会被折叠成
 * add+removed、单 PR 超过 3000 文件时截断。
 *
 * `--diff-filter` 必须含 D：删除同样是「包内改动」——删掉一个域/模块正是最需要重跑该包
 * build/test/typecheck 的形态。旧实现的 ACMR 让纯删除改动在本地判成「无命中包、无需跑
 * 门禁」，而 CI 会命中 → 本地绿 CI 红。
 */
function resolveChangedFiles(base) {
  const verified = sh("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (verified.status !== 0) return null;
  const mergeBase = sh("git", ["merge-base", base, "HEAD"]);
  const ref = mergeBase.status === 0 ? mergeBase.stdout.trim() : base;
  const tracked = gitLines(["diff", "--name-only", "--diff-filter=ACMRDT", ref]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null || untracked === null) return null;
  return [...new Set([...tracked, ...untracked])];
}

function main(argv) {
  const tierArg = valueOf(argv, "--tier") ?? "changed";
  const tier = TIER_ALIAS[tierArg];
  if (tier === undefined) {
    console.error(`[local-gate] 未知 --tier ${tierArg}（可选 changed / pr / full）`);
    return 2;
  }
  const base = valueOf(argv, "--base") ?? "origin/main";
  const dryRun = argv.includes("--dry-run");
  const jsonOut = argv.includes("--json");
  const withCoverage = argv.includes("--with-coverage");

  const { allPackages } = computeCiMatrix({ env: {} });

  const { files, plan } = resolveScope(tier, base, allPackages);
  // 全局面命中（改 shared/scripts/.github/包管理文件）时，changed 快线不足以覆盖静态闸，升到 pr
  // 升档判据是纯函数（local-scope.shouldEscalateChangedTier，带回归用例）：#722 的全局面升档
  // 加 #742 阶段 2.1 的空切片升档——白名单外条目的消费方是 CI 上恒跑的静态闸，本地不能空转。
  const effectiveTier = resolveEffectiveTier(tier, plan, files);
  const scopeLabel = formatScopeLabel(plan, allPackages);
  const steps = tierSteps(effectiveTier, {
    hitPackages: plan.hitPackages,
    withCoverage,
    base,
    scopeLabel,
  });
  const escalated = effectiveTier !== tier;

  // --dry-run --json：向接线断言（scripts/test/gate-wiring.test.ts）提供结构化计划。
  // 为什么要有它：断言若去解析下面那几行人类可读输出，就会被标签措辞、箭头形态、别名与
  // 直调的等价改写反复误红（模板正则硬编码标签文本的坑已在本仓出现过一次）。显式 JSON
  // 把「计划」变成契约，人类输出保持逐字不变——只有同时传 --dry-run 与 --json 才走这条路径。
  if (dryRun && jsonOut) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tier,
          effectiveTier,
          base,
          scopeLabel,
          packages: plan.hitPackages,
          steps: steps.map((s) => ({ label: s.label, cmd: s.cmd ?? PNPM, args: s.args })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  logPlan({ tier, escalated, effectiveTier, base, files, plan });
  if (steps.length === 0) {
    console.log(
      "[local-gate] 无命中包面 —— 纯文档 diff 且无待跑步骤：本地快线不跑（CI 的 docs:check 等静态闸仍会跑）",
    );
    return 0;
  }
  console.log("[local-gate] 计划步骤：");
  // 连同将要执行的命令一起打印：只打标签的话，「标签没改、args 被换成别的闸」这种漂移在
  // --dry-run 的计划输出上完全看不出来（自测判据因此钉不住 args）。
  for (const s of steps) console.log(`  - ${s.label}  →  ${[s.cmd ?? PNPM, ...s.args].join(" ")}`);
  if (dryRun) {
    console.log("[local-gate] --dry-run：未执行");
    return 0;
  }

  return logSummary(steps, runSteps(steps)) ? 1 : 0;
}

/** 本次变更文件集与包面计划；changed 档取不到 diff 基准时按全量处理（fail-closed）。 */
function resolveScope(tier, base, allPackages) {
  let files = null;
  let scopeReason = "";
  if (tier === "changed") {
    files = resolveChangedFiles(base);
    if (files === null) {
      scopeReason = `取不到 diff 基准 ${base}（或 git 不可用）—— 按全量处理（fail-closed）`;
      files = null;
    }
  }

  let plan;
  if (tier !== "changed") {
    plan = {
      hitPackages: [...allPackages],
      globalHit: false,
      escalated: false,
      reason: `--tier ${tier}：全仓口径`,
    };
  } else if (files === null) {
    plan = {
      hitPackages: [...allPackages],
      globalHit: true,
      escalated: false,
      reason: scopeReason,
    };
  } else {
    plan = planChangedScope({ root: ROOT, files, allPackages });
  }
  return { files, plan };
}

function resolveEffectiveTier(tier, plan, files) {
  if (
    tier === "changed" &&
    shouldEscalateChangedTier({
      globalHit: plan.globalHit,
      hitPackages: plan.hitPackages,
      files,
    })
  ) {
    return "pr";
  }
  return tier;
}

function formatScopeLabel(plan, allPackages) {
  return plan.hitPackages.length === allPackages.length
    ? "全仓口径"
    : `切片 ${plan.hitPackages.length} 包：${plan.hitPackages.join(", ")}`;
}

function logPlan({ tier, escalated, effectiveTier, base, files, plan }) {
  console.log(
    `[local-gate] tier=${tier}${escalated ? ` → 升级为 ${effectiveTier}` : ""}  base=${base}  变更文件=${files === null ? "n/a" : files.length}`,
  );
  console.log(
    `[local-gate] 包面：${plan.hitPackages.length > 0 ? plan.hitPackages.join(", ") : "（无）"}  —— ${plan.reason}`,
  );
  if (plan.unknown && plan.unknown.length > 0) {
    console.log(
      `[local-gate] 注意：ci.yml filters 里的 ${plan.unknown.join(", ")} 不在包清单内，已忽略（若为新增包请同步 plugins-manifest.json）`,
    );
  }
}

/** 顺序执行步骤表，首个非零退出即停（fail-fast），返回已跑步骤的 exit code。 */
function runSteps(steps) {
  const results = [];
  for (const step of steps) {
    console.log(
      `\n[local-gate] ▶ ${step.label}\n[local-gate]   ${step.cmd ?? PNPM} ${step.args.join(" ")}`,
    );
    const res = spawnSync(step.cmd ?? PNPM, step.args, { cwd: ROOT, stdio: "inherit" });
    const code = res.status ?? 1;
    results.push({ label: step.label, code });
    if (code !== 0) {
      console.error(
        `\n[local-gate] ✗ ${step.label} 退出码 ${code} —— 后续步骤不再执行（fail-fast）`,
      );
      break;
    }
  }
  return results;
}

/** 打印执行摘要；返回是否失败（供 main 决定退出码）。 */
function logSummary(steps, results) {
  console.log("\n[local-gate] 执行摘要：");
  for (const r of results) console.log(`  exit=${r.code}  ${r.label}`);
  const skipped = steps.length - results.length;
  for (const s of steps.slice(results.length)) console.log(`  exit=skip  ${s.label}`);
  const failed = results.some((r) => r.code !== 0);
  if (skipped > 0) console.log(`[local-gate] 因首个失败跳过 ${skipped} 步`);
  console.log(failed ? "[local-gate] 结果：FAIL" : "[local-gate] 结果：PASS");
  if (!failed) {
    // #742 阶段 3.2：本地三档都不跑变异，而 PR 上变异自 #742 阶段 1 起按命中切片**强制**跑
    // （打不打 gate:full 标签都跑）。不点明的话「本地 PASS」很容易被读成「CI 也会绿」，
    // 而这正是本地门禁最贵的一种误读——变异不达标只在 CI 上暴露。覆盖率同属本地默认缺口：
    // 只有 full --with-coverage 才跑（全仓产物闸相反，pr / full 档内已经跑完）。
    console.log(
      "[local-gate] 注意：本地任何档都不跑变异——变异在 PR 上按命中切片强制跑（#742 阶段 1）；" +
        "覆盖率默认也不跑，要跑需显式 `pnpm gate:full --with-coverage`（CI 上归 gate:full 标签与" +
        "夜间 observe.yml）。全仓产物闸不属该缺口：pr / full 档内已跑完。本地 PASS 不等于 CI 绿。",
    );
  }
  return failed;
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

process.exit(main(process.argv.slice(2)));
