#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * mcp-manager-service 契约测试编译面接线（issue #476 service-contract；#845 收全面）。
 *
 * 为什么存在：shared/mcp-manager-service.d.ts 是 ctx.mcpManager 服务类型面的
 * 单一事实源，但提供方包的主 tsconfig（include src/**）不编译 test/，
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
 *   ③ 关键夹具（EXPECT_FILES）逐包登记且与接线套件一一对应：删掉任一条目即判红（它是
 *      「编译面被真实覆盖」的锚，不是接线清单——接线清单由磁盘派生）。
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
import { join } from "node:path";

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
 * 每包的关键夹具：判据是「夹具被误删」时在此 fail-loud，而不是表现为编译面静默少覆盖一块。
 * 键集必须**恰好等于**接线套件（下面的用例双侧比对）——删掉任一条目即红，所以它不是注释，
 * 而是一份必须与面同步的数据。夹具表不是接线清单：接线清单由磁盘派生，本表只登记锚点。
 * 取值口径：优先登记该包类型面**真正参与检查**的文件（无 @ts-nocheck 者）；整面都是
 * @ts-nocheck 时取该包的主行为测试文件。
 */
const EXPECT_FILES: Record<string, string[]> = {
  // 本包 test 面 4/4 文件带 @ts-nocheck（脚本式大文件），无类型面锚点可登，取两个主行为单测。
  "dsh-lan-proxy": [join("unit", "unit-proxy.test.ts"), join("unit", "unit-apply.test.ts")],
  "dsh-mcp-manager": [join("integration", "service-contract.test.ts")],
  "dsh-notifier": [
    join("integration", "service-contract.test.ts"),
    join("integration", "consumer-types.test.ts"),
    // consumer-product-face.ts 是**产物面**消费方夹具（#733 M2-3.2）：按包名经
    // test/tsconfig.json 的 paths 取 lib/index.d.ts，判据是「声明合并对消费方可达」。
    join("integration", "consumer-product-face.ts"),
  ],
  // 本包类型面只剩这三个文件没有 @ts-nocheck，是这条编译面真正有牙齿的地方。
  "dsh-provider-usage": [
    join("client", "unit-trend-view.test.ts"),
    join("unit", "routes", "unit-routes.test.ts"),
    "smoke-pure.ts",
  ],
  "dsh-worktree-sidebar": [
    join("unit", "client-index.test.ts"),
    join("unit", "client-takeover.test.ts"),
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
  // 双侧比对：左边是数据，右边由磁盘派生。只查「悬空」会漏掉 #845 验收点名的那条反向
  // 自证——删掉一个 expectFiles 条目后，整个编译面就少了一个锚点，而其它断言全绿。
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
