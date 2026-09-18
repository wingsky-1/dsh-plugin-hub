/**
 * scripts/gate/gate-steps.mjs — 本地门禁「档位 → 步骤表」的纯函数单一来源。
 *
 * 为什么独立成文件：接线断言（scripts/test/gate-wiring.test.ts）要拿「本地某档实际会跑哪些步骤」
 * 与 ci.yml 的恒跑段对照。此前这份表与执行器同居 local-gate.mjs，而该文件末尾的
 * process.exit(main(...)) 使任何 import 都会真的执行一遍门禁——测试只能退而去解析 --dry-run 的
 * 人类可读输出，于是标签措辞、箭头形态、别名与直调的等价改写都会误红。
 * 抽成无副作用模块后，「事实源」与「被断言的对象」是同一份数据。
 */
import { PREREQ_PACKAGES } from "../test/script-test-prereqs.mjs";

export const TIER_ALIAS = { changed: "changed", fast: "changed", pr: "pr", full: "full" };

/** 每个步骤 = { label, args }；args 交给 pnpm。 */
export function tierSteps(tier, { hitPackages, withCoverage, base, scopeLabel }) {
  const pkgFilters = hitPackages.map((p) => `./packages/${p}`);
  const scopedBuild = hitPackages.map((p) => `@wingsky-1/${p}...`);
  const scopeArg = hitPackages.join(",");

  if (tier === "changed") {
    return collectScopedPackageSteps(hitPackages, pkgFilters, scopedBuild);
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
    // 于本地 pr / full 档不可见；现与兄弟闸一致（CI 侧同为直接步骤）。
    { label: "gate:module-state（src 禁模块级可变状态）", args: ["gate:module-state"] },
    // #843 P-2：门禁故障码不得绕开 failClosed（否定判据）。执行点在 ci.yml 的 repo-gate 恒跑段，
    // 本地同款接入——离线、纯 AST，秒级。
    {
      label: "forbid-raw-exit2（scripts/gate + scripts/release 禁裸 exit 2）",
      cmd: "node",
      args: ["scripts/gate/forbid-raw-exit2.mjs"],
    },
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
    // 以下四条原先内嵌在 contract-check.ts 里以 spawnSync 执行——判据存在，但在 ci.yml 与本地
    // 档位计划里都看不到，于是「每条判据至少一个可见执行点」这条不变量对它们永远为假
    // （接线盲区）。迁成与兄弟闸同形的直接步骤后，两侧都可见：与 #733 3.1.2 把 module-state
    // 迁出 contract 的方向一致。
    {
      label: "verify-dir-imports（目录门面：跨模块引用只走 interface.ts；4 包硬判）",
      cmd: "node",
      args: [
        "scripts/gate/verify-dir-imports.mjs",
        "--package",
        "dsh-mcp-manager",
        "--package",
        "dsh-notifier",
        "--package",
        "dsh-lan-proxy",
        "--package",
        "dsh-worktree-sidebar",
      ],
    },
    {
      label: "verify-dir-imports（provider-usage，--soft：直引明细只报告）",
      cmd: "node",
      args: ["scripts/gate/verify-dir-imports.mjs", "--package", "dsh-provider-usage", "--soft"],
    },
    {
      label: "export-surface-snapshot（dsh-notifier 导出面与基线零 diff）",
      cmd: "node",
      args: ["scripts/gate/export-surface-snapshot.mjs", "--package", "dsh-notifier"],
    },
    {
      label: "export-surface-snapshot（dsh-lan-proxy 导出面与基线零 diff）",
      cmd: "node",
      args: ["scripts/gate/export-surface-snapshot.mjs", "--package", "dsh-lan-proxy"],
    },
    {
      label: "export-surface-snapshot（dsh-worktree-sidebar 导出面与基线零 diff）",
      cmd: "node",
      args: ["scripts/gate/export-surface-snapshot.mjs", "--package", "dsh-worktree-sidebar"],
    },
    {
      label: "verify-shared-fanin（shared 模块跨包扇入；#792）",
      cmd: "node",
      args: ["scripts/gate/verify-shared-fanin.mjs"],
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
    return collectPrTierSteps({
      hitPackages,
      pkgFilters,
      scopedBuild,
      scopeArg,
      scopeLabel,
      cheapGlobal,
      prereqStep,
      scriptsSelfTest,
    });
  }

  return collectFullTierSteps({ scopeLabel, cheapGlobal, scriptsSelfTest, withCoverage });
}

/** 命中包的 build（含依赖）+ 逐包 test / typecheck；changed 与 pr 两档共用同一段。 */
function collectScopedPackageSteps(hitPackages, pkgFilters, scopedBuild) {
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

/**
 * pr 档：命中包步骤 + 产物闸 + 廉价全仓一致性闸 + test:scripts。
 *
 * 步骤表按 hitPackages 生成：直接 `--tier pr` 时 main() 已把包面置为全部包（本地没有 PR
 * 上下文可切，与 full 同对象面、只少豁免到期台账），此处即全仓；只有从 changed 升档才拿到真
 * 切片（全局面命中或空切片）。覆盖率与变异**默认**不在本地任何档跑——覆盖率可由
 * `gate:full --with-coverage` 补，变异只在 CI（PR 按切片强制 + 夜间全量）。
 */
function collectPrTierSteps({
  hitPackages,
  pkgFilters,
  scopedBuild,
  scopeArg,
  scopeLabel,
  cheapGlobal,
  prereqStep,
  scriptsSelfTest,
}) {
  const steps = collectScopedPackageSteps(hitPackages, pkgFilters, scopedBuild);
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

/** full 档：同 pr 对象面（全仓直跑）+ 豁免到期台账；`--with-coverage` 时补 cov / crap。 */
function collectFullTierSteps({ scopeLabel, cheapGlobal, scriptsSelfTest, withCoverage }) {
  const steps = [
    { label: "build（全仓）", args: ["build"] },
    { label: "test（全仓）", args: ["test"] },
    { label: "typecheck（全仓）", args: ["typecheck"] },
    { label: `contract（${scopeLabel}）`, args: ["contract"] },
    { label: `pack:check（${scopeLabel}）`, args: ["pack:check"] },
    { label: `verify:npmlayout（${scopeLabel}）`, args: ["verify:npmlayout"] },
    ...cheapGlobal,
    scriptsSelfTest,
    // 豁免/临时项到期台账：只在全量档收集打印（纯报告，退出码恒 0）。pr 档不跑——
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
