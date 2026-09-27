#!/usr/bin/env node
"use strict";

/**
 * shared-dts-lib 自测（node:test，issue #461 L2）。
 *
 * L2 目标：pack-check 对 shared 声明副本断言从「硬编码单文件」升级为
 * 「仓库 shared/ 全部 .d.ts（递归含子目录）逐一随包」——新增 shared 子目录/文件
 * （如 client/i18n.d.ts）漏打包时必须 fail-loud，机制保证 → 断言保证。
 *
 * 覆盖：
 *   - listSharedDts 枚举正确（含 client/ 子目录，返回相对路径）
 *   - assertSharedDtsPresent 缺文件报错 / 完整通过
 *   - 与 bundle-host d.ts X1 复制谓词同源：bundle-host 必须复用共享 walkFiles
 *     （防「复制机制」与「断言清单」两处枚举实现漂移）
 *   - 真实仓库方向：当前 shared/ 的 d.ts 清单非空且含新增 client/i18n.d.ts
 * 运行：node --test scripts/test/shared-dts.test.ts（或 pnpm test:scripts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSharedDtsInventoryNonEmpty,
  assertSharedDtsNoExtras,
  assertSharedDtsPresent,
  listSharedDts,
} from "../lib/shared-dts-lib.ts";
import { walkFiles } from "../lib/walk-files.ts";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "sdt-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixtureShared(root: string) {
  // 构造与真实 shared/ 同构的目录：顶层 loopback.d.ts + client/ 子目录
  const shared = join(root, "shared");
  mkdirSync(join(shared, "client"), { recursive: true });
  writeFileSync(join(shared, "loopback.d.ts"), "");
  writeFileSync(join(shared, "client", "i18n.d.ts"), "");
  // 非 .d.ts 文件不得被枚举（.js 是运行时内联源，不随包）
  writeFileSync(join(shared, "client", "i18n.js"), "");
  return shared;
}

test("#1 listSharedDts 递归枚举全部 .d.ts（含子目录、排除 .js）", () => {
  const { dir, cleanup } = tempDir();
  try {
    fixtureShared(dir);
    const list = listSharedDts(dir);
    assert.deepEqual(list, ["client/i18n.d.ts", "loopback.d.ts"]);
  } finally {
    cleanup();
  }
});

test("#2 assertSharedDtsPresent 缺文件报错（含子目录路径）", () => {
  const { dir, cleanup } = tempDir();
  try {
    const shared = fixtureShared(dir);
    // 模拟 pack-check 语义：期望清单来自仓库 shared/（删除前快照），
    // tarball 副本缺 client/i18n.d.ts（新增 shared d.ts 漏随包）→ 必须报出
    const expected = listSharedDts(dir);
    rmSync(join(shared, "client", "i18n.d.ts"));
    const missing = assertSharedDtsPresent(shared, expected);
    assert.deepEqual(missing, ["client/i18n.d.ts"]);
  } finally {
    cleanup();
  }
});

test("#3 assertSharedDtsPresent 完整副本通过（空缺件清单）", () => {
  const { dir, cleanup } = tempDir();
  try {
    fixtureShared(dir);
    const missing = assertSharedDtsPresent(join(dir, "shared"), listSharedDts(dir));
    assert.deepEqual(missing, []);
  } finally {
    cleanup();
  }
});

test("#4 与真实仓库 shared/ 一致：清单非空、含新增 client/i18n.d.ts、路径真实存在", () => {
  const root = join(import.meta.dirname, "..", "..");
  const list = listSharedDts(root);
  assert.ok(list.length >= 2, "仓库 shared/ 至少含顶层 + client/ 的 d.ts");
  // 必须命中 L2 新增断言目标：client/ 子目录文件（i18n.d.ts）
  assert.ok(list.includes("client/i18n.d.ts"), "新增 shared/client/i18n.d.ts 必须进入枚举清单");
  // 全部为 .d.ts 且在仓库 shared/ 真实存在
  for (const rel of list) {
    assert.match(rel, /\.d\.ts$/);
    assert.ok(existsSync(join(root, "shared", rel)), `清单项 ${rel} 应在仓库 shared/ 真实存在`);
  }
});

test("#5 同源防漂移：bundle-host 复用共享 walkFiles，无私有枚举实现", () => {
  const root = join(import.meta.dirname, "..", "..");
  const bundleHost = readFileSync(join(root, "scripts", "build", "bundle-host.ts"), "utf8");
  // 机制保证：bundle-host d.ts X1（2b）必须 import 共享 walkFiles，而不是自写遍历
  assert.match(
    bundleHost,
    // 引号形态归 Prettier（该文件在格式化面内），判据只认语义、不绑引号
    /import \{ walkFiles \} from ["']\.\.\/lib\/walk-files\.ts["']/,
    "bundle-host 必须复用共享 walkFiles",
  );
  // 断言保证：pack-check 必须经 listSharedDts 枚举期望清单（与复制谓词同源）
  const packCheck = readFileSync(join(root, "scripts", "gate", "pack-check.ts"), "utf8");
  assert.match(packCheck, /listSharedDts\(ROOT\)/, "pack-check 必须经 listSharedDts 枚举期望清单");
  // 共享 walkFiles 自身行为基准（防 lib 重构误伤）
  const { dir, cleanup } = tempDir();
  try {
    fixtureShared(dir);
    const walked = walkFiles(join(dir, "shared"), (f: string) => f.endsWith(".d.ts"));
    assert.deepEqual(walked, ["client/i18n.d.ts", "loopback.d.ts"]);
  } finally {
    cleanup();
  }
});

test("#6 assertSharedDtsNoExtras 查多：包内预置残留副本 → 报出该文件（红）", () => {
  const { dir, cleanup } = tempDir();
  try {
    const shared = fixtureShared(dir);
    const expected = listSharedDts(dir);
    // 模拟 retired 残留：源 shared/ 已移除某 d.ts，但包内 shared/ 仍残留旧副本
    mkdirSync(join(shared, "deep"), { recursive: true });
    writeFileSync(join(shared, "retired.d.ts"), "");
    writeFileSync(join(shared, "deep", "old-archived.d.ts"), "");
    const extras = assertSharedDtsNoExtras(shared, expected);
    assert.deepEqual(extras, ["deep/old-archived.d.ts", "retired.d.ts"]);
  } finally {
    cleanup();
  }
});

test("#6b assertSharedDtsNoExtras 查多：移除残留后出口为空（绿）", () => {
  const { dir, cleanup } = tempDir();
  try {
    const shared = fixtureShared(dir);
    const extras = assertSharedDtsNoExtras(shared, listSharedDts(dir));
    assert.deepEqual(extras, [], "无残留 → 空清单");
  } finally {
    cleanup();
  }
});

test("#7 同源防漂移：pack-check 每包接入查多出口（assertSharedDtsNoExtras fail-loud）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const packCheck = readFileSync(join(root, "scripts", "gate", "pack-check.ts"), "utf8");
  // 生产路径接入断言（防「检测出口不进生产路径」假绿回归）：pack-check 必须调用
  // assertSharedDtsNoExtras 并对非空 extra 判 FAIL（残留 fail-loud）
  assert.match(
    packCheck,
    /assertSharedDtsNoExtras/,
    "pack-check 必须调用查多出口 assertSharedDtsNoExtras",
  );
  assert.match(packCheck, /shared 副本残留/, "pack-check 对残留须报 fail-loud 文案");
});

test("#8 事实源非空：shared 未构建（清单为空）⇒ 判红（红线级静默绿的打红用例）", () => {
  const { dir, cleanup } = tempDir();
  try {
    // 造「shared 未构建」的真实形态：只有 .ts 源码、零 .d.ts 产物（声明是 tsc 产物、不入库）
    const shared = join(dir, "shared");
    mkdirSync(join(shared, "client"), { recursive: true });
    writeFileSync(join(shared, "paths.ts"), "export const a = 1;\n");
    writeFileSync(join(shared, "client", "i18n.ts"), "export const b = 1;\n");
    const expected = listSharedDts(dir);
    // 前置自检：确认本用例真的落在「清单为空」这一支上（否则断言会空转成恒真）
    assert.deepEqual(expected, [], "前置：只有 .ts 源码时清单必须为空");
    // 前提事实：空清单下查缺/查多双双空转恒真——这正是本闸要拦的静默绿
    assert.deepEqual(
      assertSharedDtsPresent(shared, expected),
      [],
      "前提：空清单下查缺出口恒真（无判据力）",
    );
    assert.deepEqual(
      assertSharedDtsNoExtras(shared, expected),
      [],
      "前提：空清单下查多出口恒真（无判据力）",
    );
    const problems = assertSharedDtsInventoryNonEmpty(expected);
    assert.equal(problems.length, 1, "清单为空必须判红：发布面判据不许在事实源为空时通过");
    assert.match(problems[0], /清单为空/, "判词须点明事实源为空");
    assert.match(problems[0], /先构建 shared/, "判词须给出可执行的下一步（构建 shared）");
  } finally {
    cleanup();
  }
});

test("#8b 事实源非空：清单非空 ⇒ 不判红（防恒真：绿必须只在有事实源时给出）", () => {
  const { dir, cleanup } = tempDir();
  try {
    fixtureShared(dir);
    const expected = listSharedDts(dir);
    assert.ok(expected.length >= 2, "前置：清单非空");
    assert.deepEqual(
      assertSharedDtsInventoryNonEmpty(expected),
      [],
      "清单非空不得判红（否则构建后恒红，本闸即误报）",
    );
  } finally {
    cleanup();
  }
});

test("#8c 真实仓库方向：shared 已构建 ⇒ 事实源非空闸放行（防误报打红 CI/发布）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const expected = listSharedDts(root);
  // 本用例只在 shared 已构建时有意义（未构建时是 #8 的形态，不是误报）
  if (expected.length === 0) return;
  assert.deepEqual(
    assertSharedDtsInventoryNonEmpty(expected),
    [],
    "shared 已构建时清单非空，事实源闸必须放行",
  );
});

test("#8d 接入：pack-check 取到清单后立即 fail-closed，且退出码是 1（判红）不是 2（门禁故障）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const packCheck = readFileSync(join(root, "scripts", "gate", "pack-check.ts"), "utf8");
  // 生产路径接入（防「检测出口不进生产路径」假绿回归）
  assert.match(
    packCheck,
    /assertSharedDtsInventoryNonEmpty\(SHARED_DTS_EXPECTED\)/,
    "pack-check 必须在取到清单后立即调用事实源非空出口",
  );
  // 退出码语义：判红（1）与门禁故障（2）必须可区分，判据判红不得用门禁故障顶替
  const after = packCheck.slice(
    packCheck.indexOf("assertSharedDtsInventoryNonEmpty(SHARED_DTS_EXPECTED)"),
  );
  const exitSite = after.slice(0, 600);
  // 守卫必须真的挂在清单判据上：只断言「调用与 exit 存在」会把 if (false) 这类**不可达守卫**
  // 判成绿（实测过：把守卫改成 if (false) 后调用与 exit 都还在，纯文本断言完全看不见）。
  // 故此处把「判据条件 → 逐条判词 → exit(1)」三段绑成一条正则，条件被旁路即判红。
  assert.match(
    exitSite,
    /if \(sharedDtsInventoryProblems\.length > 0\) \{\s*\n\s*for \(const p of sharedDtsInventoryProblems\)[^\n]*\n\s*process\.exit\(1\);/,
    "守卫必须由清单判据驱动并紧接 exit(1)（防不可达守卫把闸门架空）",
  );
  assert.doesNotMatch(
    exitSite,
    /process\.exit\(2\)/,
    "不得用 exit 2 结案：那语义是门禁故障（读不到输入/自身不可信），与判红不同",
  );
});
