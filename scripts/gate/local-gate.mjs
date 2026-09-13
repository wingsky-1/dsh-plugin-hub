#!/usr/bin/env node
/**
 * scripts/gate/local-gate.mjs — 本地门禁分层执行器（#722 门禁分层）。
 *
 * 为什么需要它：AGENTS.md 的提交前最小集原本是「全仓 build + 全仓 test + 全仓 typecheck
 * + contract + pack:check」。全仓口径对单包改动的开发者是纯浪费——CI 早就按 ci.yml 的
 * paths-filter 做了切片（build-test 只对命中包跑 test/typecheck），本地却一律全量。本
 * 脚本把同一份包面归属搬到本地，并统一「PR 也走增量」的口径：
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
 * 跑，本地三档都覆盖不到它；覆盖率与全仓产物闸归 gate:full 标签与夜间 observe.yml。
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
import { PREREQ_PACKAGES } from "../test/script-test-prereqs.mjs";
import { planChangedScope, shouldEscalateChangedTier } from "./local-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const TIER_ALIAS = { changed: "changed", fast: "changed", pr: "pr", full: "full" };

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

/** 每个步骤 = { label, args }；args 交给 pnpm。 */
function tierSteps(tier, { hitPackages, withCoverage, base, scopeLabel }) {
  const pkgFilters = hitPackages.map((p) => `./packages/${p}`);
  const scopedBuild = hitPackages.map((p) => `@wingsky-1/${p}...`);
  const scopeArg = hitPackages.join(",");

  if (tier === "changed") {
    const steps = [];
    if (hitPackages.length > 0) {
      steps.push({
        label: `build（命中包 + 依赖：${hitPackages.join(", ")}）`,
        args: [...scopedBuild.flatMap((f) => ["--filter", f]), "build"],
      });
      for (const filter of pkgFilters) {
        steps.push({ label: `test ${filter}`, args: ["--filter", filter, "--if-present", "test"] });
      }
      for (const filter of pkgFilters) {
        steps.push({
          label: `typecheck ${filter}`,
          args: ["--filter", filter, "--if-present", "typecheck"],
        });
      }
    }
    return steps;
  }

  // 廉价全仓一致性闸：不依赖 lib 产物、秒级，恒跑（不是「全量构建」类成本）。
  // test:scripts 不在此列——它有编译面用例依赖声明产物，需先满足前置包（见下方）。
  const cheapGlobal = [
    // 阈值单调性原先只在 ci.yml 的 `if: pull_request` 下跑——本地三档都跑不到它，
    // 「悄悄降线」要等 CI 才红（本地判绿的假象）。判据本身与 CI 同一入口，成本秒级。
    // 基准取 --base（默认 origin/main，与 CI 的硬编码一致）；取不到该 ref 时判据自身
    // fail-closed（exit 2），与本地其余步骤「取不到基准即按最严处理」的口径一致。
    {
      label: `threshold-monotonic（阈值只许升不许降，基准 ${base}）`,
      cmd: "node",
      args: ["scripts/gate/threshold-monotonic.mjs", base],
    },
    { label: "stryker:check（变异配置与拓扑一致）", args: ["stryker:check"] },
    { label: "aggregate:check（聚合 patch 不漂移）", args: ["aggregate:check"] },
    { label: "test:src-tests（*.src.test.ts 禁现）", args: ["test:src-tests"] },
    { label: "gate:homedir（src 禁直连 HOME）", args: ["gate:homedir"] },
    // #733 计划项 3.1.2：本闸原先只在 contract-check.ts 里 spawnSync，不进 cheapGlobal，
    // 于本地增量档不可见；现与兄弟闸一致（CI 侧同为直接步骤）。
    { label: "gate:module-state（src 禁模块级可变状态）", args: ["gate:module-state"] },
    { label: "docs:check（README/链接）", args: ["docs:check"] },
    {
      label: "verify:scripts-index（scripts 索引：存在性 + 引用即登记）",
      args: ["verify:scripts-index"],
    },
    {
      label: "verify:coverage-scope（覆盖率面：单一事实源 + 面完整性）",
      args: ["verify:coverage-scope"],
    },
    // 批 2b：发布物面内 vendored 裸二进制（登记 + 哈希绑定 + 许可随包）。执行点在 ci.yml
    // 的 repo-gate 恒跑段，本地同款接入——少了这一条，本地绿而 CI 红的落差会立刻出现。
    {
      label: "verify:vendored-binaries（发布物面内裸二进制：登记 + 哈希绑定 + 许可随包）",
      args: ["verify:vendored-binaries"],
    },
    { label: "lint（ESLint 复杂度门禁，阈值见 gauntlet.config.json）", args: ["lint"] },
    // #733 计划项 3.5：形态的 CI 执行点在 ci.yml（repo-gate 恒跑段），本地同款接入——
    // 否则「本地全绿、CI 红在 format」这种落差会天天发生。面见 .prettierignore。
    { label: "format:check（Prettier 形态，代码面全量）", args: ["format:check"] },
  ];
  const prereqStep = {
    label: `build 编译面前置包（test:scripts 依赖：${PREREQ_PACKAGES.join(", ")}）`,
    // --filter 与取值必须是两个独立 argv 元素（与本文件其余步骤同写法）；拼成单个
    // 字符串会被 pnpm 当成一个未知选项：Unknown options: 'filter @wingsky-1/<pkg>...'
    args: [...PREREQ_PACKAGES.flatMap((p) => ["--filter", `@wingsky-1/${p}...`]), "build"],
  };
  const scriptsSelfTest = { label: "test:scripts（门禁脚本自测）", args: ["test:scripts"] };

  if (tier === "pr") {
    // PR 增量口径：命中包构建/测试 + **命中包**产物闸 + 廉价全仓一致性闸。
    // 全仓产物闸（无 --packages）与覆盖率/变异归夜间，本地只在 gate:full 跑。
    const steps = [];
    if (hitPackages.length > 0) {
      steps.push({
        label: `build（命中包 + 依赖：${hitPackages.join(", ")}）`,
        args: [...scopedBuild.flatMap((f) => ["--filter", f]), "build"],
      });
      for (const filter of pkgFilters) {
        steps.push({ label: `test ${filter}`, args: ["--filter", filter, "--if-present", "test"] });
      }
      for (const filter of pkgFilters) {
        steps.push({
          label: `typecheck ${filter}`,
          args: ["--filter", filter, "--if-present", "typecheck"],
        });
      }
    }
    // 产物闸按切片跑；零命中包时**不**拼空口径（#742 阶段 2.1 起「白名单外的 scripts 改动」
    // 会走到这里：它们的消费方是常驻静态闸，跑一个 `--packages ""` 的产物闸既无意义又可能
    // 因空切片判红）。此时 pr 档退化为「廉价全仓一致性闸 + test:scripts」，正是那些常驻闸。
    if (hitPackages.length > 0) {
      steps.push(
        {
          label: `contract（${scopeLabel}）`,
          cmd: "node",
          args: ["scripts/gate/contract-check.ts", "--packages", scopeArg],
        },
        {
          label: `pack:check（${scopeLabel}）`,
          cmd: "node",
          args: ["scripts/gate/pack-check.ts", "--packages", scopeArg],
        },
        {
          label: `verify:npmlayout（${scopeLabel}）`,
          cmd: "node",
          args: ["scripts/gate/verify-npm-layout.ts", "--packages", scopeArg],
        },
      );
    }
    steps.push(...cheapGlobal, prereqStep, scriptsSelfTest);
    return steps;
  }

  const steps = [
    { label: "build（全仓）", args: ["build"] },
    { label: "test（全仓）", args: ["test"] },
    { label: "typecheck（全仓）", args: ["typecheck"] },
    { label: `contract（${scopeLabel}）`, args: ["contract"] },
    { label: `pack:check（${scopeLabel}）`, args: ["pack:check"] },
    { label: `verify:npmlayout（${scopeLabel}）`, args: ["verify:npmlayout"] },
    ...cheapGlobal,
    scriptsSelfTest,
    // 豁免/临时项到期台账：只在全量档收集打印（纯报告，退出码恒 0）。增量档不跑——
    // PR 上反复打印同一份存量台账只会变成噪音，而它的用途是排期复核（裁决见 #765）。
    {
      label: "豁免到期台账（收集 reviewBy，仅报告）",
      cmd: "node",
      args: ["scripts/gate/collect-exemptions.mjs"],
    },
  ];
  if (withCoverage) {
    steps.push({ label: "cov（vitest 覆盖率，unit + integration 直连 src）", args: ["cov"] });
    // crap 于 #722 阶段五完成 src 口径重建（复杂度取自 ESLint 的 complexity 规则，覆盖率取自
    // 同一份 src 口径产物），与 cov 同批恢复接入。
    steps.push({ label: "crap（CRAP 热点，strict 见 gauntlet.config.json）", args: ["crap"] });
  }
  return steps;
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
  const withCoverage = argv.includes("--with-coverage");

  const { allPackages } = computeCiMatrix({ env: {} });

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

  // 全局面命中（改 shared/scripts/.github/包管理文件）时，changed 快线不足以覆盖静态闸，升到 pr
  // 升档判据是纯函数（local-scope.shouldEscalateChangedTier，带回归用例）：#722 的全局面升档
  // 加 #742 阶段 2.1 的空切片升档——白名单外条目的消费方是 CI 上恒跑的静态闸，本地不能空转。
  let effectiveTier = tier;
  if (
    tier === "changed" &&
    shouldEscalateChangedTier({
      globalHit: plan.globalHit,
      hitPackages: plan.hitPackages,
      files,
    })
  ) {
    effectiveTier = "pr";
  }

  const scopeLabel =
    plan.hitPackages.length === allPackages.length
      ? "全仓口径"
      : `切片 ${plan.hitPackages.length} 包：${plan.hitPackages.join(", ")}`;
  const steps = tierSteps(effectiveTier, {
    hitPackages: plan.hitPackages,
    withCoverage,
    base,
    scopeLabel,
  });
  const escalated = effectiveTier !== tier;

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
    // 而这正是本地门禁最贵的一种误读——变异不达标只在 CI 上暴露。
    console.log(
      "[local-gate] 注意：本档不含变异与全仓覆盖率。变异在 PR 上按命中切片强制跑（#742 阶段 1），" +
        "覆盖率与全仓产物闸归 gate:full 标签与夜间 observe.yml —— 本地 PASS 不等于 CI 绿。",
    );
  }
  return failed ? 1 : 0;
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

process.exit(main(process.argv.slice(2)));
