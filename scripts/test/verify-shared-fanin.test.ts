#!/usr/bin/env node
"use strict";

/**
 * verify-shared-fanin 自测（#792 跨包档收口：扇入判据上线）。
 *
 * 三层断言，缺一不可：
 *   1. 纯函数口径——说明符提取（静态 / export-from / 动态）、注释里的假引用不算、
 *      相对路径必须解析进仓库根 shared/ 才算；
 *   2. fixture 正反例——值面 2 包绿 / 1 包红 / 0 包红，类型面 1 包绿，退役不豁免下限，
 *      悬空引用判红，test/ 引用不计入，端内门面转出计入，shared/ 内部依赖不传递；
 *   3. 真实仓库锚——PR2 修正过的四行登记偏差与 frontmatter 移除必须以派生结果为准，
 *      并锁住登记链（scripts/README.md / gate-scope-registry.json）；执行点接线不在此处，
 *      由 scripts/test/gate-wiring.test.ts 双向断言（CI repo-gate ↔ 本地 pr/full）。
 *
 * fixture 一律建在 mkdtempSync 的临时根（仓库零污染纪律）：本仓被禁的正是
 * 「为测试在仓库里造包目录」这类写法。
 *
 * 类型面（#792 CI 修复）：本文件在 scripts/tsconfig.json 的 strict 编译面内，故**不用**
 * `// @ts-nocheck`——那会多出一条 ban-ts-comment 警告（预算只许降不许升）。门禁是 .mjs，
 * 靠 allowJs 从实现推断类型，下面用最小的一组接口把推断结果归一，断言本身不做类型体操。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  collectConsumers,
  evaluateFanin,
  importSpecifiers,
  listSharedModules,
  renderReport,
} from "../gate/verify-shared-fanin.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 模块判定行（.mjs 推断出的形状，这里显式写出以免断言落在 any 上）。 */
interface FaninRow {
  base: string;
  kind: string;
  file: string;
  consumers: string[];
  floor: number;
  failed: boolean;
}

/** shared/ 模块清单项。 */
interface SharedModule {
  base: string;
  kind: string;
  file: string;
}

/** 判定结果：成功（rows/dangling）与结构错误（error）归一为可选字段。 */
interface FaninReport {
  rows?: FaninRow[];
  dangling?: string[];
  error?: string;
}

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function fixtureDir(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "shared-fanin-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 在 fixture 根下写一个文件（自动建父目录）——fixture 的形状就是被测的目录结构。 */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** 声明一个 shared 模块只被哪些包的 src 引用（消费者面与实现面分离，便于组合反例）。 */
function useShared(root: string, pkg: string, sharedRel: string, sub?: string): void {
  const rel = sub === undefined ? "src/use.ts" : sub;
  write(root, "packages/" + pkg + "/" + rel, 'import { x } from "' + sharedRel + '";\n');
}

/** 判定结果（把 .mjs 的联合归一到本文件的接口）。 */
function fanin(root: string): FaninReport {
  return evaluateFanin(root);
}

/** 报告行（把原始返回值直接喂给 renderReport，保持两边同一类型）。 */
function reportLines(root: string): string[] {
  return renderReport(evaluateFanin(root));
}

/** shared/ 模块清单（shared/ 不可读时返回空表，由专门的 fail-closed 用例覆盖）。 */
function modulesOf(root: string): SharedModule[] {
  return (listSharedModules(root) ?? []) as SharedModule[];
}

/** 取某模块的判定行（不存在即抛，避免 undefined 静默通过）。 */
function rowOf(result: FaninReport, base: string): FaninRow {
  const row = (result.rows ?? []).find((r) => r.base === base);
  if (row === undefined) throw new Error("result 里应有模块 " + base);
  return row;
}

test("importSpecifiers：静态 / export-from / 动态 import 全覆盖", () => {
  const src = [
    'import { a } from "../../shared/one.js";',
    'export { b } from "../../../shared/two.js";',
    'const m = await import("../../shared/three.js");',
    'import type { T } from "../../shared/four.js";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), [
    "../../shared/one.js",
    "../../../shared/two.js",
    "../../shared/four.js",
    "../../shared/three.js",
  ]);
});

test("importSpecifiers：注释里的假引用不算（多行块注释 + 行注释）", () => {
  const src = [
    '// import { a } from "../../../shared/commented.js";',
    "/*",
    ' * import { b } from "../../../shared/blocked.js";',
    " */",
    'import { c } from "../../shared/real.js";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["../../shared/real.js"]);
});

test("listSharedModules：值面 / 类型面按同基名聚合（.js + .d.ts 是一个模块）", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/alpha.js", "export const a = 1;\n");
    write(dir, "shared/alpha.d.ts", "export declare const a: number;\n");
    write(dir, "shared/beta.d.ts", "export declare const b: number;\n");
    assert.deepEqual(
      modulesOf(dir).map((m) => [m.base, m.kind, m.file]),
      [
        ["alpha", "value", "alpha.js"],
        ["beta", "type", "beta.d.ts"],
      ],
    );
  } finally {
    cleanup();
  }
});

test("结构 fail-closed：shared/ 缺失 / 空目录都判环境错误", () => {
  const missing = fixtureDir();
  const empty = fixtureDir();
  try {
    assert.equal(listSharedModules(missing.dir), null, "shared/ 不存在 → null（结构错误）");
    assert.ok(fanin(missing.dir).error, "shared/ 不存在 → error");
    mkdirSync(join(empty.dir, "shared"), { recursive: true });
    assert.ok(fanin(empty.dir).error, "shared/ 存在但无 .js / .d.ts → 枚举口径失效，fail-closed");
  } finally {
    missing.cleanup();
    empty.cleanup();
  }
});

test("正例：值面 2 包 + 类型面 1 包 → 全部合规，报告无 FAIL", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/value.js", "export const v = 1;\n");
    write(dir, "shared/types.d.ts", "export declare const t: number;\n");
    useShared(dir, "pkg-a", "../../../shared/value.js", "src/value-use.ts");
    useShared(dir, "pkg-b", "../../../shared/value.js");
    useShared(dir, "pkg-a", "../../../shared/types.js", "src/types-use.ts");
    const result = fanin(dir);
    assert.deepEqual(
      (result.rows ?? []).map((r) => r.failed),
      [false, false],
    );
    assert.deepEqual(rowOf(result, "value").consumers, ["pkg-a", "pkg-b"]);
    assert.deepEqual(rowOf(result, "types").consumers, ["pkg-a"]);
    assert.deepEqual(result.dangling, []);
    assert.ok(!reportLines(dir).some((l) => l.startsWith("FAIL")), "无违规时不得有 FAIL 行");
  } finally {
    cleanup();
  }
});

test("反例：值面模块只有 1 个消费包 → 判红（准入规则 1）", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/solo.js", "export const s = 1;\n");
    useShared(dir, "pkg-a", "../../../shared/solo.js");
    assert.equal(rowOf(fanin(dir), "solo").failed, true);
    assert.deepEqual(rowOf(fanin(dir), "solo").consumers, ["pkg-a"]);
    assert.ok(
      reportLines(dir).some((l) => l.startsWith("FAIL") && l.includes("solo.js")),
      "单消费者模块必须出 FAIL 行",
    );
  } finally {
    cleanup();
  }
});

test("反例：值面模块 0 消费包（退役候选）→ 判红", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/orphan.js", "export const o = 1;\n");
    useShared(dir, "pkg-a", "../../../shared/other.js");
    write(dir, "shared/other.js", "export const z = 1;\n");
    const result = fanin(dir);
    assert.equal(rowOf(result, "orphan").failed, true);
    assert.deepEqual(rowOf(result, "orphan").consumers, []);
  } finally {
    cleanup();
  }
});

test("反例：类型面模块 0 消费包 → 判红；单列口径的下限是 1", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/lonely.d.ts", "export declare const l: number;\n");
    const result = fanin(dir);
    assert.equal(rowOf(result, "lonely").floor, 1);
    assert.equal(rowOf(result, "lonely").failed, true);
  } finally {
    cleanup();
  }
});

test("退役不豁免下限：模块头标 DEPRECATED 但只有 1 个消费包 → 仍判红（无豁免口）", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(
      dir,
      "shared/retiring.js",
      "// DEPRECATED: 观察期保留，下一步连同消费方一起移除\nexport const r = 1;\n",
    );
    useShared(dir, "pkg-a", "../../../shared/retiring.js");
    const result = fanin(dir);
    assert.equal(rowOf(result, "retiring").failed, true);
    assert.deepEqual(rowOf(result, "retiring").consumers, ["pkg-a"]);
    const report = reportLines(dir);
    assert.ok(
      report.some((l) => l.startsWith("FAIL") && l.includes("retiring.js")),
      "标 DEPRECATED 不得让模块退出扇入下限（维护者裁决 #792 D-A：不要豁免机制）",
    );
    assert.ok(!report.some((l) => l.startsWith("SKIP")), "报告里不得再有退役观察期豁免通道");
  } finally {
    cleanup();
  }
});

test("悬空引用：src 引 shared/ 下不存在的模块 → 报告 dangling", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/real.js", "export const a = 1;\n");
    useShared(dir, "pkg-a", "../../../shared/ghost.js", "src/ghost-use.ts");
    const result = fanin(dir);
    assert.deepEqual(result.dangling, [
      "packages/pkg-a/src/ghost-use.ts → ../../../shared/ghost.js（shared/ 下无此模块）",
    ]);
    assert.ok(reportLines(dir).some((l) => l.startsWith("FAIL 悬空引用")));
  } finally {
    cleanup();
  }
});

test("生产口径：只有 test/ 引用的包不算消费者（frontmatter 正是这样逃过判定的）", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/m.js", "export const m = 1;\n");
    useShared(dir, "pkg-a", "../../../shared/m.js");
    // 只在 test/ 里引用：不构成「插件实际使用」
    write(dir, "packages/pkg-a/test/smoke.test.ts", 'import { m } from "../../../shared/m.js";\n');
    assert.deepEqual(rowOf(fanin(dir), "m").consumers, ["pkg-a"]);
  } finally {
    cleanup();
  }
});

test("经端内 shared 门面转出计入消费：门面在 src/ 里，同一套扫描天然覆盖", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/hub.js", "export const h = 1;\n");
    // pkg-a 只在 src/shared/facade.ts 里引根 shared，其余文件引门面
    write(
      dir,
      "packages/pkg-a/src/shared/facade.ts",
      'export { h } from "../../../../shared/hub.js";\n',
    );
    write(dir, "packages/pkg-a/src/user.ts", 'import { h } from "./shared/facade.ts";\n');
    useShared(dir, "pkg-b", "../../../shared/hub.js");
    assert.deepEqual(rowOf(fanin(dir), "hub").consumers, ["pkg-a", "pkg-b"]);
  } finally {
    cleanup();
  }
});

test("不传递 shared 内部依赖：host-utils 引 loopback 不使 loopback 受众虚高", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    write(dir, "shared/loopback.js", "export const l = 1;\n");
    write(dir, "shared/host-utils.js", 'import { l } from "./loopback.js";\nexport const h = l;\n');
    useShared(dir, "pkg-a", "../../../shared/host-utils.js");
    useShared(dir, "pkg-b", "../../../shared/host-utils.js");
    useShared(dir, "pkg-c", "../../../shared/host-utils.js");
    const result = fanin(dir);
    assert.deepEqual(rowOf(result, "host-utils").consumers, ["pkg-a", "pkg-b", "pkg-c"]);
    assert.deepEqual(
      rowOf(result, "loopback").consumers,
      [],
      "只有 packages/ 下的直接引用算消费者；shared/ 内部互相引不算",
    );
  } finally {
    cleanup();
  }
});

test("真实仓库：扇入全部达标、无悬空引用", () => {
  const result = fanin(ROOT);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.dangling, []);
  assert.deepEqual(
    (result.rows ?? []).filter((r) => r.failed).map((r) => r.file),
    [],
    "shared/ 值面模块必须 >=2 消费包、类型面 >=1（准入规则 1）",
  );
});

test("#792 PR2 登记偏差修正：四行登记以派生结果为准", () => {
  const result = fanin(ROOT);
  // loopback：原快照登 4 包，实测 2 包——lan-proxy / provider-usage 是经 host-utils 间接用，
  // 属 host-utils 的消费者关系，不构成 loopback 的扇入
  assert.deepEqual(rowOf(result, "loopback").consumers, [
    "dsh-jev-decide",
    "dsh-mcp-manager",
    "dsh-notifier",
  ]);
  // settings-namespace：原快照多登 notifier（零引用）
  assert.deepEqual(rowOf(result, "settings-namespace").consumers, [
    "dsh-lan-proxy",
    "dsh-mcp-manager",
    "dsh-provider-usage",
  ]);
  // client/i18n：原快照漏登 dsh-lan-proxy
  assert.deepEqual(rowOf(result, "client/i18n").consumers, [
    "dsh-lan-proxy",
    "dsh-mcp-manager",
    "dsh-provider-usage",
  ]);
  // sse-hub：原快照整行缺失
  assert.deepEqual(rowOf(result, "sse-hub").consumers, ["dsh-mcp-manager", "dsh-notifier"]);
  // mcp-manager-service 类型面已不在共享层：#767 B1.5b 把 DTO 与服务类型收进包内
  // src/shared，仓库级声明已删（rowOf 不存在即抛，故此处反向断言它确实不在派生清单里）。
  assert.equal(
    (result.rows ?? []).find((r) => r.base === "mcp-manager-service"),
    undefined,
    "mcp-manager-service 已退回包内，不应再出现在共享层派生清单里",
  );
});

test("#792 PR2：frontmatter 已从共享层移除（不再出现在派生清单里）", () => {
  const result = fanin(ROOT);
  assert.equal(
    (result.rows ?? []).find((r) => r.base === "frontmatter"),
    undefined,
    "frontmatter 生产扇入为 0，已按准入规则退役移除；它回来即红",
  );
  assert.ok(
    !modulesOf(ROOT).some((m) => m.base.startsWith("frontmatter")),
    "shared/ 下不得再有 frontmatter 实现/声明",
  );
});

test("登记链：scripts/README.md 登记本门（引用即登记棘轮）", () => {
  const index = readFileSync(join(ROOT, "scripts", "README.md"), "utf8");
  assert.ok(
    index.includes("gate/verify-shared-fanin.mjs"),
    "新增门禁脚本必须在 scripts/README.md 登记（引用即登记棘轮）",
  );
});

test("登记链：gate-scope-registry.json 以 tree 口径登记本门（仓库固定面）", () => {
  const registry = JSON.parse(
    readFileSync(join(ROOT, "scripts", "data", "gate-scope-registry.json"), "utf8"),
  ) as { gates: { gate: string; script: string; scopeFrom: string; packages: unknown }[] };
  const entry = registry.gates.find((g) => g.gate === "verify-shared-fanin");
  if (entry === undefined) throw new Error("本门必须登记扫描范围（未登记即红）");
  assert.equal(entry.script, "scripts/gate/verify-shared-fanin.mjs");
  assert.equal(entry.scopeFrom, "tree", "范围由 packages 目录结构派生，不吃 --package");
  assert.equal(entry.packages, "dsh-*");
});

test("接线：本门不得再内嵌回 contract-check（执行点必须可见）", () => {
  // 原先这里断言「contract-check.ts 引用了本门」——那正是「执行点不可见」的形态：判据确实
  // 在跑，但 workflow 与本地档位计划里都看不到它，于是「每条判据至少一个可见执行点」对它
  // 恒为假。执行点迁成 ci.yml 与 local-gate 的直接步骤后，正向接线由
  // scripts/test/gate-wiring.test.ts 双向断言守护；此处改为反向钉，防止它被塞回去。
  // 只认「执行形态」：spawnSync / execFileSync 调用附近出现的本门路径。用 includes 子串会被
  // 注释里的提及满足——本 PR 就在 contract-check.ts 里留了一段说明历史迁移的注释，那不该算
  // 「内嵌回去」。
  const contract = readFileSync(join(ROOT, "scripts", "gate", "contract-check.ts"), "utf8");
  const executed = [...contract.matchAll(/(?:spawnSync|execFileSync)\s*\(/g)].some((call) =>
    contract.slice(call.index, call.index + 800).includes("scripts/gate/verify-shared-fanin.mjs"),
  );
  assert.ok(!executed, "本门不得内嵌回 contract-check：那会让执行点重新变成不可见");
});

test("collectConsumers：无 packages/ 目录时返回空集合（不抛）", () => {
  const { dir, cleanup } = fixtureDir();
  try {
    mkdirSync(join(dir, "shared"), { recursive: true });
    const { consumers, dangling } = collectConsumers(dir);
    assert.equal(consumers.size, 0);
    assert.deepEqual(dangling, []);
  } finally {
    cleanup();
  }
});

const SCRIPT = join(ROOT, "scripts", "gate", "verify-shared-fanin.mjs");

function runCli(
  root: string,
  extra: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], {
      encoding: "utf8",
    }) as unknown as {
      status: number | null;
      stdout: string;
      stderr: string;
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("fail-closed：--root 不是目录 → exit 2 且统一故障注解", () => {
  const { dir, cleanup } = fixtureDir();
  const missing = join(dir, "ghost-root");
  cleanup();
  const r = spawnSync(process.execPath, [SCRIPT, "--root", missing], { encoding: "utf8" });
  assert.equal(r.status, 2, String(r.stderr));
  assert.match(
    String(r.stderr),
    /^::error::门禁故障（非判据结论）：verify-shared-fanin: --root 不是目录/m,
  );
  assert.equal(String(r.stdout), "");
});

test("fail-closed：shared/ 缺失 → exit 2 且统一故障注解", () => {
  const { dir } = fixtureDir();
  const r = runCli(dir);
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /^::error::门禁故障（非判据结论）：verify-shared-fanin: shared\/ 目录不存在或不可读/m,
  );
  assert.equal(r.stdout, "");
});

test("fail-closed：shared/ 空枚举 → exit 2 且统一故障注解", () => {
  const { dir } = fixtureDir();
  mkdirSync(join(dir, "shared"), { recursive: true });
  const r = runCli(dir);
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /^::error::门禁故障（非判据结论）：verify-shared-fanin: shared\/ 下没有任何/m,
  );
  assert.equal(r.stdout, "");
});

test("CLI 三态：判红仍 exit 1 且无故障注解，真仓通过 exit 0", () => {
  const bad = fixtureDir();
  try {
    write(bad.dir, "shared/solo.js", "export const s = 1;\n");
    useShared(bad.dir, "pkg-a", "../../../shared/solo.js");
    const r1 = spawnSync(process.execPath, [SCRIPT, "--root", bad.dir], { encoding: "utf8" });
    assert.equal(r1.status, 1, String(r1.stderr));
    assert.doesNotMatch(String(r1.stderr), /::error::门禁故障/);
    assert.match(String(r1.stdout), /FAIL/);
  } finally {
    bad.cleanup();
  }
  const r0 = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r0.status, 0, String(r0.stderr));
  assert.doesNotMatch(String(r0.stderr), /::error::门禁故障/);
  assert.match(String(r0.stdout), /verify-shared-fanin: OK/);
});
