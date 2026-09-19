#!/usr/bin/env node
"use strict";

/**
 * mcp-manager-service 契约测试编译面接线（issue #476 service-contract；#845 收全面）。
 *
 * 为什么存在：packages/dsh-mcp-manager/src/shared/service.ts 是 ctx.mcpManager 服务
 * 类型面的单一事实源（#767 B1.5b 起；此前在仓库级 shared/），但提供方包的主
 * tsconfig（include src/**）不编译 test/，
 * \`pnpm typecheck\`/\`pnpm build\` 的 tsc 面到不了契约测试文件；而 \`pnpm test\`/
 * \`pnpm test:scripts\` 都是 Node 直跑 TS（type stripping 擦除类型断言）——若只
 * 靠直跑，编译期 Equal/Same 断言是「假锁」（方案评审 P0-A 已实证）。
 *
 * 本文件 = 编译面接线器：spawn 仓库 tsc 以每个包的 test/tsconfig.json（noEmit，
 * include 全量测试 ts）真实编译契约测试文件，断言退出码 0。类型断言失败 →
 * tsc 非 0 → 本测试红。随 \`pnpm test:scripts\`（repo-gate 无条件步骤）执行，
 * CI/本地对「shared 类型面 ↔ 契约测试清单」漂移零成本判红。
 *
 * 接线对象（#845 起机械派生，不再手写清单）：packages/<pkg>/test/tsconfig.json。
 * 手写清单的漏项**不会让任何断言变红**——#845 实测 dsh-lan-proxy 与
 * dsh-provider-usage 两个包的 test/tsconfig.json 已在磁盘上却不在清单里，它们的
 * 编译面（5 + 26 个测试文件）从未被这条断言编译过。故面改成三条闭合规则：
 *   ① 面由文件系统派生（有 test/ 目录 = 有测试面）；
 *   ② 有测试面就**必须**有 test/tsconfig.json，否则判红；刻意不接的包进
 *      UNWIRED_TEST_FACES 逐包写明理由，且该豁免受反向断言（包还在、确实缺 tsconfig）；
 *   ③ 编译面清单（EXPECT_FILES）逐包登记，且与 `tsc --showConfig` 解析出的该包
 *      test/tsconfig.json 编译面**双向相等**：删清单里任一条目、删磁盘上任一面文件、把面
 *      文件排除出 tsconfig、新增面文件未登记，四种都判红。它是「编译面被真实覆盖」的锚
 *      （接线对象本身由磁盘派生），不是「重要程度排序」。
 *
 * 已知面的形态：dsh-mcp-manager 的 test/e2e/** 在它自己的 tsconfig 里显式 exclude
 * （文件级 @ts-nocheck 的产物契约测试，静态 import 本包 lib/index.js 会把包内
 * shared/*.d.ts 副本与仓库级 shared/*.d.ts 同时拉进 program，触发 TS2717）；
 * 契约与单元测试文件无 @ts-nocheck，类型断言真实参与检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { PREREQ_PACKAGES } from "./script-test-prereqs.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
// tsc 真实 JS 入口（node_modules/.bin/tsc 是 shell shim，不能经 node 执行；
// 用 typescript 包内的 bin 入口，node 直接加载）。
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

const PACKAGES_ROOT = join(ROOT, "packages");
const testDirOf = (pkg: string): string => join(PACKAGES_ROOT, pkg, "test");
const testTsconfigOf = (pkg: string): string => join(testDirOf(pkg), "tsconfig.json");

/**
 * 包面枚举：\`packages/\` 下全部 \`dsh-*\` 目录。不做任何白名单过滤——过滤掉一个包
 * 就等于把它的测试面移出本断言，而那正是 #845 要收的缺口。
 */
const PACKAGE_NAMES = readdirSync(PACKAGES_ROOT)
  .filter((name) => name.startsWith("dsh-"))
  .sort();

/** 有 \`test/\` 目录 = 有测试面（如 dsh-plugins-all 无测试面，不受本条约束）。 */
const TESTED_PACKAGES = PACKAGE_NAMES.filter((pkg) => existsSync(testDirOf(pkg)));

/** 接线包：磁盘上确实有 test/tsconfig.json（机械派生，见文件头 ①②）。 */
const WIRED_PACKAGES = TESTED_PACKAGES.filter((pkg) => existsSync(testTsconfigOf(pkg)));

/**
 * 有测试面但**刻意**不接 test/tsconfig.json 的包：显式豁免，逐包写理由。
 * 未列在这里、有测试面却没有 tsconfig 的包会在下面的用例里判红——「静默跳过」没有出口。
 */
const UNWIRED_TEST_FACES: Record<string, string> = {
  "dsh-verify-isolated":
    "唯一测试文件是 test/e2e/smoke.test.ts（脚本式大文件）：按其余包的模板建编译面实测 " +
    "300+ 条 noImplicitAny / TS7034 / TS18046 / TS2345，包 tsconfig 本就 exclude test。" +
    "接它等于先把整个 e2e 文件类型化，属独立工作，故显式豁免。",
};

/**
 * 每包编译面清单：与 `tsc --showConfig` 解析出的 test/tsconfig.json 编译面**双向相等**
 * （下面的用例逐包比对）。为什么不是手挑的「关键夹具」子集：手挑子集没有任何判据锚得住
 * ——从数组里删掉一条，其余断言全绿（#845 批次评审实跑复现）；而本表存在的全部意义就是让
 * 「夹具被误删 / 被排除出 tsconfig」在编译面静默少覆盖一块之前 fail-loud（#733 M2-3.2）。
 * 代价是新增面文件必须在此登记：这是刻意的同步成本，换的是两个方向都不静默。
 * 口径边界：这里的「面」是 tsconfig 解析出的文件列表，不是 test/ 的裸目录——裸目录里的
 * test/*.worker.mjs、hotreload-probe.mjs、tsconfig.json 与 test/ 外的 ../src/client/css.d.ts
 * 都不进任何 tsc program，要求它们登记才是假红。
 */
const EXPECT_FILES: Record<string, string[]> = {
  "dsh-lan-proxy": [
    "client-dom/settings-card.test.ts",
    "client-unit/ca-status.test.ts",
    "client-unit/client-routes.test.ts",
    "client-unit/host-trust-alert.test.ts",
    "client-unit/host-trust-status.test.ts",
    "client/client-style.test.ts",
    "e2e/smoke.test.ts",
    "integration/apply-token-provider.test.ts",
    "unit/unit-apply.test.ts",
    "unit/unit-ca.test.ts",
    "unit/unit-cacert.test.ts",
    "unit/unit-host-trust.test.ts",
    "unit/unit-proxy.test.ts",
    "unit/unit-tls.test.ts",
  ],
  "dsh-mcp-manager": [
    "client-unit/unit-summary-a3-guard.test.ts",
    "helpers.ts",
    "integration/real-context.test.ts",
    "integration/service-contract.test.ts",
    "unit/ports/api-ports.test.ts",
    "unit/ports/catalog-ports.test.ts",
    "unit/ports/inject-ports.test.ts",
    "unit/ports/lifecycle-ports.test.ts",
    "unit/ports/orchestrator-ports.test.ts",
    "unit/ports/pipeline-ports.test.ts",
    "unit/ports/runtime-ports.test.ts",
    "unit/unit-apply.test.ts",
    "unit/unit-call-stats.test.ts",
    "unit/unit-catalog.test.ts",
    "unit/unit-config-env.test.ts",
    "unit/unit-config-env-policy.test.ts",
    "unit/unit-dispatch.test.ts",
    "unit/unit-erasure.test.ts",
    "unit/unit-file-io-queue.test.ts",
    "unit/unit-file-io.test.ts",
    "unit/unit-hotspot.test.ts",
    "unit/unit-image-admission.test.ts",
    "unit/unit-init-failure.test.ts",
    "unit/unit-lifecycle-logs.test.ts",
    "unit/unit-lifecycle-mount.test.ts",
    "unit/unit-lifecycle.test.ts",
    "unit/unit-manager.test.ts",
    "unit/unit-manager2.test.ts",
    "unit/unit-middleware.test.ts",
    "unit/unit-official-package-face.test.ts",
    "unit/unit-pipeline.test.ts",
    "unit/unit-redaction-a1.test.ts",
    "unit/unit-redaction.test.ts",
    "unit/unit-routes-a2.test.ts",
    "unit/unit-routes-sse.test.ts",
    "unit/unit-shared.test.ts",
    "unit/unit-stats-a4.test.ts",
    "unit/unit-store.test.ts",
    "unit/unit-summary-a3.test.ts",
    "unit/unit-visibility.test.ts",
    "unit/upgrade/service.test.ts",
    "unit/upgrade/storage-layout.test.ts",
    "unit/upgrade/version.test.ts",
    "unit/unit-workspace-id.test.ts",
    "unit/unit-workspace.test.ts",
  ],
  "dsh-notifier": [
    "client-dom/apply-lifecycle.test.ts",
    "client-dom/controls.test.ts",
    "client-dom/diagnostics.test.ts",
    "client-dom/display.test.ts",
    "client-dom/status.test.ts",
    "client-dom/title.test.ts",
    "client-helpers.ts",
    "client-unit/api-error.test.ts",
    "client-unit/banner.test.ts",
    "client-unit/capabilities.test.ts",
    "client-unit/disposers.test.ts",
    "client-unit/locale-fallback.test.ts",
    "client-unit/locale.test.ts",
    "client-unit/mask.test.ts",
    "client-unit/notify-audio.test.ts",
    "client-unit/notify-lease.test.ts",
    "client-unit/notify-policy.test.ts",
    "client-unit/notify-registry.test.ts",
    "client-unit/notify-session.test.ts",
    "client-unit/notify-title.test.ts",
    "client-unit/reason-text.test.ts",
    "client-unit/save-guard.test.ts",
    "client-unit/settings-compare-912.test.ts",
    "client-unit/settings-diff.test.ts",
    "client-unit/status-poll.test.ts",
    "client-unit/status-text.test.ts",
    "client/capabilities.test.ts",
    "client/reason-text.test.ts",
    "e2e/smoke.test.ts",
    "helpers.ts",
    "integration/consumer-product-face.ts",
    "integration/consumer-types.test.ts",
    "integration/real-context.test.ts",
    "integration/service-contract.test.ts",
    "integration/status-roundtrip.test.ts",
    "unit/api/dry-run.test.ts",
    "unit/api/journal.test.ts",
    "unit/api/kinds.test.ts",
    "unit/api/probe.test.ts",
    "unit/api/route.test.ts",
    "unit/api/service.test.ts",
    "unit/api/settings.test.ts",
    "unit/api/stream.test.ts",
    "unit/channels/bark.test.ts",
    "unit/channels/browser.test.ts",
    "unit/channels/capabilities.test.ts",
    "unit/channels/deliver.test.ts",
    "unit/channels/dry-run.test.ts",
    "unit/channels/secure-fetch.test.ts",
    "unit/channels/system.test.ts",
    "unit/channels/webhook.test.ts",
    "unit/config/draft.test.ts",
    "unit/config/input.test.ts",
    "unit/config/model.test.ts",
    "unit/config/redact.test.ts",
    "unit/config/service.test.ts",
    "unit/events/listen.test.ts",
    "unit/events/session.test.ts",
    "unit/events/translate.test.ts",
    "unit/pipeline/dispatch.test.ts",
    "unit/pipeline/finalize.test.ts",
    "unit/pipeline/judge.test.ts",
    "unit/pipeline/route.test.ts",
    "unit/pipeline/service.test.ts",
    "unit/shared/channels.test.ts",
    "unit/shared/kinds.test.ts",
    "unit/shared/paths.test.ts",
    "unit/shared/reason-codes.test.ts",
    "unit/shared/reason.test.ts",
    "unit/shared/sounds.test.ts",
    "unit/shared/webhooks.test.ts",
    "unit/stores/history.test.ts",
    "unit/stores/status.test.ts",
    "unit/upgrade/legacy.test.ts",
    "unit/upgrade/reason-shape.test.ts",
    "unit/upgrade/service.test.ts",
    "unit/upgrade/steps.test.ts",
    "unit/upgrade/version.test.ts",
  ],
  "dsh-provider-usage": [
    "client/unit-detect.test.ts",
    "client/unit-fetch-timeout.test.ts",
    "client/unit-refresh-revalidate.test.ts",
    "client/unit-trend-view.test.ts",
    "e2e/smoke.test.ts",
    "helpers.ts",
    "smoke-pure.ts",
    "unit/adapters/unit-deepseek-official.test.ts",
    "unit/apply/unit-apply.test.ts",
    "unit/common/unit-errsurf.test.ts",
    "unit/history/unit-history.test.ts",
    "unit/pipeline/unit-signal-lock.test.ts",
    "unit/pipeline/unit-stats-service.test.ts",
    "unit/registry/unit-hotreload.test.ts",
    "unit/report/unit-report-executor.test.ts",
    "unit/report/unit-report.test.ts",
    "unit/routes/unit-routes.test.ts",
    "unit/shared/unit-config.test.ts",
    "unit/shared/unit-contract.test.ts",
    "unit/shared/unit-v1.test.ts",
    "unit/trend/unit-trend-ledger.test.ts",
    "unit/trend/unit-trend.test.ts",
  ],
  "dsh-worktree-sidebar": [
    "client-dom/inject-visibility.test.ts",
    "helpers.ts",
    "integration/apply-lifecycle.test.ts",
    "integration/binding-store.test.ts",
    "integration/git-real.test.ts",
    "integration/tools-real.test.ts",
    "unit/api-routes.test.ts",
    "unit/binding-model.test.ts",
    "unit/client-bindings.test.ts",
    "unit/client-index.test.ts",
    "unit/client-source.test.ts",
    "unit/client-takeover.test.ts",
    "unit/git-inspect.test.ts",
    "unit/git-service.test.ts",
    "unit/host-agents.test.ts",
    "unit/host-sessions.test.ts",
    "unit/host-typert.test.ts",
    "unit/inject-attach.test.ts",
    "unit/scope.test.ts",
    "unit/tools.test.ts",
  ],
};

/**
 * 接线套件：磁盘上的 test/tsconfig.json × 夹具表。缺条目不会静默降级为「只做编译面断言」
 * ——下面的「一一对应」用例会判红，故这里的 `?? []` 只是让失败可读的兜底。
 */
const SUITES = WIRED_PACKAGES.map((pkg) => ({
  pkg,
  tsconfig: testTsconfigOf(pkg),
  expectFiles: EXPECT_FILES[pkg] ?? [],
}));

/**
 * 包 test/tsconfig.json 的**解析后面**：`tsc --showConfig` 给出的文件列表（不展开 import
 * 闭包——那把 src 与 node_modules 一并拉进来，不是本面的对象）。为什么用 tsc 自己解析而不是
 * 在本文件里复刻 include/exclude 的 glob 语义：面只有一处事实源，两处独立复刻必然漂移。
 * 只保留 test/ 以内的文件（dsh-notifier 的 ../src/client/css.d.ts 进 program 但不属本面）。
 */
function compileFaceOf(tsconfig: string): string[] {
  const testDir = dirname(tsconfig);
  const result = spawnSync(process.execPath, [TSC, "-p", tsconfig, "--showConfig"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.strictEqual(
    result.status,
    0,
    "tsc --showConfig 解析 tsconfig 失败（exit=" + result.status + "）：\n" + result.stderr,
  );
  const parsed = JSON.parse(result.stdout) as { files?: string[] };
  return (parsed.files ?? [])
    .map((file) => relative(testDir, resolve(testDir, file)).split(sep).join("/"))
    .filter((file) => file !== "" && !file.startsWith("../") && file !== "tsconfig.json")
    .sort();
}

test("#845: 有测试面的包必须接上编译面（缺 test/tsconfig.json 且未豁免即红）", () => {
  const missing = TESTED_PACKAGES.filter(
    (pkg) => !existsSync(testTsconfigOf(pkg)) && !(pkg in UNWIRED_TEST_FACES),
  );
  assert.deepEqual(
    missing,
    [],
    "下列包有 test/ 目录却没有 test/tsconfig.json，也未登记豁免——它们的测试面不在任何 " +
      "tsc 编译面内（类型断言在 Node 直跑时被擦除，等于没有）：\n" +
      missing.join("\n"),
  );
});

test("#845: 豁免必须仍然成立且写明理由（豁免不是永久许可，也不是静默跳过）", () => {
  const stale = Object.keys(UNWIRED_TEST_FACES).filter(
    (pkg) => !TESTED_PACKAGES.includes(pkg) || existsSync(testTsconfigOf(pkg)),
  );
  assert.deepEqual(
    stale,
    [],
    "这些豁免条目描述的事实已不存在（包没了，或已经有 test/tsconfig.json）——豁免不是永久许可",
  );
  // 理由必须是**被读到的**数据而不是注释：没有它，下一位读者无从判断该豁免是否仍然成立，
  // 而「重新接上编译面」与「静默跳过」在 diff 里会长得一样。
  const noReason = Object.entries(UNWIRED_TEST_FACES)
    .filter(([, reason]) => typeof reason !== "string" || reason.trim().length < 20)
    .map(([pkg]) => pkg);
  assert.deepEqual(noReason, [], "豁免必须写明理由（少于 20 字视为没写）");
});

test("#845: 接线面不得被收窄（套件 == 磁盘上全部 test/tsconfig.json）", () => {
  // 这条判据直接钉住 #845 的原始缺口形态：把枚举换回手写清单（或加任何包名过滤）后，
  // 被漏掉的包不会让其它任何断言变红。比对两侧来源独立——右边从 PACKAGE_NAMES 现场重算，
  // 不经过 SUITES 的派生路径。
  const onDisk = PACKAGE_NAMES.filter((pkg) => existsSync(testTsconfigOf(pkg)));
  assert.deepEqual(
    SUITES.map((s) => s.pkg),
    onDisk,
    "接线套件与磁盘上的 test/tsconfig.json 不一致：枚举被收窄了——面外的包其编译面不会被任何断言编译",
  );
});

test("#845: 夹具表必须与接线套件一一对应（删掉任一条目即红，不留静默缩面出口）", () => {
  // 键集双侧比对：左边是数据，右边由磁盘派生。它只钉「包」这一层，数组内条目的增删由下面
  // 「编译面清单与解析面双向相等」用例逐条钉住。
  assert.deepEqual(
    Object.keys(EXPECT_FILES).sort(),
    WIRED_PACKAGES,
    "夹具表与接线套件不一致：要么某包少了锚点（删条目即静默缩面），要么条目已悬空（死数据）",
  );
  // 每个套件至少留一个锚点：把某包的夹具数组清空也要红（「删掉一个条目」的另一种形态）。
  const emptied = Object.entries(EXPECT_FILES)
    .filter(([, files]) => files.length === 0)
    .map(([pkg]) => pkg);
  assert.deepEqual(emptied, [], "这些套件的夹具列表被清空——编译面失去了全部锚点");
});

test("#845: 编译面清单与解析面双向相等（删任一条目 / 面文件 / 排除出 tsconfig 即红）", () => {
  // 左半边（清单 ⊆ 面）拦「登记了不被编译的死条目」与「面文件被排除出 tsconfig」；右半边
  // （面 ⊆ 清单）拦「从数组里删掉一条」——本表此前唯一的静默缩面出口。面由 tsc 自己解析，
  // 故这不是自己跟自己比。
  for (const suite of SUITES) {
    const face = compileFaceOf(suite.tsconfig);
    assert.deepEqual(
      [...suite.expectFiles].sort(),
      face,
      suite.pkg +
        "：编译面清单与 test/tsconfig.json 解析出的文件列表不一致。\n清单独有（死条目，或已被" +
        "排除出 tsconfig）：[" +
        suite.expectFiles
          .filter((file) => !face.includes(file))
          .sort()
          .join(", ") +
        "]\n面独有（清单里删掉了条目，或新增面文件未登记）：[" +
        face
          .filter((file) => !suite.expectFiles.includes(file))
          .sort()
          .join(", ") +
        "]",
    );
  }
});

test("#845: 包面枚举有效（载体自证：遍历失效时不许在空集上全绿）", () => {
  // 枚举失效（readdir 读不到 / 前缀写错）会让上面所有断言在空集上恒真。锚点取本面最初的
  // 两个接线对象：它们的 test/tsconfig.json 由 #476 契约面与包目录结构双重保证存在。
  const anchors = ["dsh-mcp-manager", "dsh-notifier"];
  assert.deepEqual(
    anchors.filter((p) => !TESTED_PACKAGES.includes(p)),
    [],
    "包面枚举里缺锚点包：packages/ 的遍历是否失效？（当前 " +
      TESTED_PACKAGES.length +
      " 个包有测试面）",
  );
  assert.deepEqual(
    anchors.filter((p) => !WIRED_PACKAGES.includes(p)),
    [],
    "接线套件里缺锚点包：test/tsconfig.json 的枚举是否失效？（当前 " +
      WIRED_PACKAGES.length +
      " 个套件）",
  );
});

test("#722: 编译面套件的前置包清单覆盖完整（防切片构建后假红）", () => {
  // 本用例需要各包**声明产物**（lib/index.d.ts）；#722 门禁分层后 PR 默认只构建命中包，
  // 故 CI/本地门禁按 script-test-prereqs.mjs 的清单补建。新增套件却忘记登记时会在此判红，
  // 而不是在 CI 里表现为「tsc 找不到 ../../lib/index.js」的假红。
  for (const suite of SUITES) {
    assert.ok(
      PREREQ_PACKAGES.includes(suite.pkg),
      "接线包 " + suite.pkg + " 未登记进 scripts/test/script-test-prereqs.mjs 的 PREREQ_PACKAGES",
    );
  }
});

test("service-contract 编译面接线：契约测试文件被 tsc 真实编译（#476）", () => {
  assert.ok(existsSync(TSC), "仓库 tsc 应存在（" + TSC + "）——pnpm install 后才有");
  for (const suite of SUITES) {
    assert.ok(existsSync(suite.tsconfig), "tsconfig 应存在（" + suite.tsconfig + "）");
    for (const file of suite.expectFiles) {
      const f = join(suite.tsconfig, "..", file);
      assert.ok(existsSync(f), "契约测试文件应存在（" + f + "）");
    }
    const result = spawnSync(process.execPath, [TSC, "-p", suite.tsconfig, "--noEmit"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.strictEqual(
      result.status,
      0,
      suite.pkg +
        "：tsc 编译测试面失败（exit=" +
        result.status +
        "）——shared 类型面与契约测试清单漂移？\n" +
        result.stdout +
        "\n" +
        result.stderr,
    );
  }
});
