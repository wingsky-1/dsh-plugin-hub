#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * plugins-manifest-lib 自测（node:test，issue #36）。
 *
 * 覆盖三类漂移的 fail-loud 与 manifest 自身校验：
 *   - deps 多一行（退役包 / 未收录名两种分支文案）
 *   - 聚合 patch 少一行 / 多未知 id（回归保护）
 *   - 目录集 ↔ manifest.active 双向不等（新目录未登记 / active 悬空）
 *   - loadManifest：JSON 语法错、形状错、名字不合规、active∩retired 重名、数组重复项
 *   - 取数口径：断言面 = git index ∩ 磁盘存在（未跟踪目录不进面，已 tracked 的仍必须登记）
 *   - 正向全绿：当前真实 manifest + 真实派生目录集
 * 运行：node --test scripts/test/plugins-manifest.test.ts（或 pnpm test:scripts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkAggregateConsistency,
  compareConfigSurfaceContracts,
  filterOutRetiredDirs,
  isIndexedPackageDir,
  listPluginDirs,
  listTrackedPluginDirs,
  loadManifest,
} from "../lib/plugins-manifest-lib.ts";

const ACTIVE = ["dsh-alpha", "dsh-beta"];
const MANIFEST = {
  active: ACTIVE,
  retired: [{ name: "dsh-gone", reason: "测试退役", successor: "@wingsky-1/dsh-alpha" }],
};

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pm-test-"));
  // 预建 packages/ 与 scripts/data/，各用例按需写入
  mkdirSync(join(dir, "packages"), { recursive: true });
  mkdirSync(join(dir, "scripts", "data"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function matrixManifest() {
  const face = (name: string) => ({ module: "fixtures/config.ts", export: name });
  return {
    active: ["dsh-lan-proxy"],
    retired: [],
    configSurfaces: [
      {
        package: "dsh-lan-proxy",
        defaults: face("defaults"),
        normalizer: face("normalize"),
        booleanKeys: face("booleanKeys"),
        countLimits: face("countLimits"),
        matrix: {
          schema: face("schema"),
          validators: face("validators"),
          hints: face("hints"),
          clientDefaults: face("clientDefaults"),
        },
      },
    ],
  };
}

function withManifest(json, check) {
  const { dir, cleanup } = tempRepo();
  try {
    writeFileSync(join(dir, "scripts/data/plugins-manifest.json"), JSON.stringify(json));
    check(() => loadManifest(dir));
  } finally {
    cleanup();
  }
}

test("#774 完整矩阵接受独立声明路径", () => {
  const json = matrixManifest();
  withManifest(json, (load) => assert.deepEqual(load().configSurfaces, json.configSurfaces));
});

for (const missing of ["schema", "validators", "hints", "clientDefaults"]) {
  test("#774 matrix 缺 " + missing + " 必须失败", () => {
    const json = matrixManifest();
    delete json.configSurfaces[0].matrix[missing];
    withManifest(json, (load) => assert.throws(load, /matrix.*缺声明对象/));
  });
}

for (const invalid of [null, [], {}, { unknown: {} }]) {
  test("#774 非法 matrix " + JSON.stringify(invalid), () => {
    const json = matrixManifest();
    json.configSurfaces[0].matrix = invalid;
    withManifest(json, (load) => assert.throws(load, /matrix/));
  });
}

test("#774 旧基准无matrix也不能漏登必跑矩阵", () => {
  const json = matrixManifest();
  delete json.configSurfaces[0].matrix;
  withManifest(json, (load) => assert.throws(load, /dsh-lan-proxy.*matrix/));
});

test("#774 原必跑包改none不能取消L1 L2", () => {
  const json = matrixManifest();
  json.configSurfaces = [{ package: "dsh-lan-proxy", surface: "none", reason: "自行退出" }];
  withManifest(json, (load) => assert.throws(load, /dsh-lan-proxy.*matrix/));
});

for (const retire of [false, true]) {
  test("#774 同时移出受检集合不能取消必跑义务 retired=" + retire, () => {
    const json = matrixManifest();
    json.active = [];
    json.configSurfaces = [];
    if (retire) json.retired = [{ name: "dsh-lan-proxy", reason: "自行退役", successor: "" }];
    withManifest(json, (load) => assert.throws(load, /dsh-lan-proxy.*matrix/));
  });
}

test("#774 基准按包身份比较：重排与路径迁移不退化", () => {
  const base = matrixManifest();
  base.configSurfaces.push({ package: "dsh-other", surface: "none", reason: "无配置" });
  const candidate = structuredClone(base);
  candidate.configSurfaces.reverse();
  candidate.configSurfaces[1].matrix.schema.module = "moved/schema.ts";
  assert.deepEqual(compareConfigSurfaceContracts(base, candidate), []);
});

for (const mutation of ["remove", "none", "matrix", "input"]) {
  test("#774 独立基准检测矩阵退化 " + mutation, () => {
    const base = matrixManifest();
    base.configSurfaces[0].package = "dsh-other";
    const candidate = structuredClone(base);
    if (mutation === "remove") candidate.configSurfaces = [];
    if (mutation === "none")
      candidate.configSurfaces[0] = { package: "dsh-other", surface: "none", reason: "退化" };
    if (mutation === "matrix") delete candidate.configSurfaces[0].matrix;
    if (mutation === "input") delete candidate.configSurfaces[0].matrix.schema;
    const problems = compareConfigSurfaceContracts(base, candidate);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /dsh-other.*(退化|删除)/);
    assert.equal(base.configSurfaces[0].matrix.schema.export, "schema");
  });
}

for (const base of [null, {}, { configSurfaces: {} }, { configSurfaces: [null] }]) {
  test("#774 损坏基准不回退候选 " + JSON.stringify(base), () => {
    assert.throws(() => compareConfigSurfaceContracts(base, matrixManifest()), /基准/);
  });
}

const EXPECTED_DEPS = {
  "@wingsky-1/dsh-alpha": "workspace:*",
  "@wingsky-1/dsh-beta": "workspace:*",
};

test("#1 deps 多一行（退役包）→ 命中 retired 分支文案", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, "@wingsky-1/dsh-gone": "workspace:*" },
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多出已退役包 @wingsky-1\/dsh-gone/);
});

test("#2 deps 多一行（未收录名）→ 命中「既不在 active 也不在 retired」分支", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, "@wingsky-1/dsh-typo": "workspace:*" },
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多出未收录包 @wingsky-1\/dsh-typo/);
});

test("#3 patch 少一行 → 报缺失 id（回归保护）", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: EXPECTED_DEPS,
    aggPatchIds: ["ui-dsh-alpha"],
  });
  assert.deepEqual(problems, ["聚合 patch 缺 ui-dsh-beta（active 在册但无聚合行）"]);
});

test("#3b patch 多未知 id → fail-loud", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta", "ui-dsh-ghost"],
  });
  assert.deepEqual(problems, ["聚合 patch 多出未知 id ui-dsh-ghost"]);
});

test("#3c patch 同 id 重复行 → fail-loud（Set 去重盲区闭合）", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.deepEqual(problems, ["聚合 patch 存在重复 id 行: ui-dsh-alpha"]);
});

test("#4 目录有包但 manifest 没有 → 报「未登记」", () => {
  const problems = checkAggregateConsistency({
    dirNames: [...ACTIVE, "dsh-newkid"],
    manifest: MANIFEST,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未登记 manifest: dsh-newkid/);
});

test("#4b 目录有包但只在 standalone → 双向通过；聚合 deps 误引 → fail-loud", () => {
  const manifest = { active: ACTIVE, standalone: ["dsh-demo"], retired: MANIFEST.retired };
  // 目录集 == active ∪ standalone：正向全绿（无聚合断言段）
  assert.deepEqual(checkAggregateConsistency({ dirNames: [...ACTIVE, "dsh-demo"], manifest }), []);
  // 聚合 deps 误引 standalone 包 → 明确分支文案
  const problems = checkAggregateConsistency({
    dirNames: [...ACTIVE, "dsh-demo"],
    manifest,
    aggDeps: { ...EXPECTED_DEPS, "@wingsky-1/dsh-demo": "workspace:*" },
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多出独立发包 @wingsky-1\/dsh-demo/);
});

test("#4c 退役残留目录（manifest.retired 已登记）→ 方向 B 豁免不判红（T1）", () => {
  // 模拟 #397：dsh-idle-archive / dsh-subagent-model-inherit 退役后目录残留（无 package.json）。
  const manifest = {
    active: ACTIVE,
    retired: [...MANIFEST.retired, { name: "dsh-leftover", reason: "T1 残留", successor: "" }],
  };
  const problems = checkAggregateConsistency({ dirNames: [...ACTIVE, "dsh-leftover"], manifest });
  assert.deepEqual(problems, [], "retired 残留目录不得再报「未登记」（告警不红，清理债）");
});

test("#4d filterOutRetiredDirs：物理目录集按 manifest.retired 过滤，双向校验输入不退化（T1）", () => {
  const manifest = {
    active: ACTIVE,
    retired: [
      { name: "dsh-gone", reason: "测试退役", successor: "" },
      { name: "dsh-leftover", reason: "T1 残留", successor: "" },
    ],
  };
  const physical = [...ACTIVE, "dsh-newkid", "dsh-leftover"];
  const { kept, skipped } = filterOutRetiredDirs(physical, manifest);
  assert.deepEqual(kept, [...ACTIVE, "dsh-newkid"], "kept 保留物理序且含未登记新目录（守卫输入）");
  assert.deepEqual(skipped, ["dsh-leftover"], "skipped 仅命中 manifest.retired 名");
  // 守卫不退化：kept 里未登记的 dsh-newkid 仍被方向 B 捕获
  const problems = checkAggregateConsistency({ dirNames: kept, manifest });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未登记 manifest: dsh-newkid/);
});

test("#5 active 引用不存在目录 → 报「不存在的目录」", () => {
  const problems = checkAggregateConsistency({
    dirNames: ACTIVE,
    manifest: { active: [...ACTIVE, "dsh-vapor"], retired: [] },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /不存在的目录: dsh-vapor/);
});

test("#6 JSON 语法错 → 单行友好错误（非裸 SyntaxError）", () => {
  const { dir, cleanup } = tempRepo();
  try {
    mkdirSync(join(dir, "packages", "dsh-alpha"), { recursive: true });
    writeFileSync(join(dir, "scripts", "data", "plugins-manifest.json"), "{ active: ");
    assert.throws(
      () => loadManifest(dir),
      (e) => /JSON 语法错误/.test(e.message) && !/SyntaxError/.test(e.message),
    );
  } finally {
    cleanup();
  }
});

test("#7 形状错 / 名字不合规 → 报错", () => {
  const { dir, cleanup } = tempRepo();
  try {
    // 缺 active
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({ retired: [] }),
    );
    assert.throws(() => loadManifest(dir), /缺 active 数组/);
    // 名字不合规
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({ active: ["Dsh_Foo"], retired: [] }),
    );
    assert.throws(() => loadManifest(dir), /非法名字/);
  } finally {
    cleanup();
  }
});

test("#8 active∩retired 重名 / 数组重复项 → 报错", () => {
  const { dir, cleanup } = tempRepo();
  try {
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({
        active: ["dsh-a"],
        retired: [{ name: "dsh-a" }],
      }),
    );
    assert.throws(() => loadManifest(dir), /同时出现在 active 与 retired/);
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({
        active: ["dsh-a", "dsh-a"],
        retired: [],
      }),
    );
    assert.throws(() => loadManifest(dir), /active 数组重复项：dsh-a/);
  } finally {
    cleanup();
  }
});

test("#8b standalone 校验：重名互斥 / 数组重复项 → 报错；缺省缺省为空集", () => {
  const { dir, cleanup } = tempRepo();
  try {
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({
        active: ["dsh-a"],
        standalone: ["dsh-a"],
        retired: [],
      }),
    );
    assert.throws(() => loadManifest(dir), /同时出现在 active 与 standalone/);
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({
        active: [],
        standalone: ["dsh-b", "dsh-b"],
        retired: [],
      }),
    );
    assert.throws(() => loadManifest(dir), /standalone 数组重复项：dsh-b/);
    writeFileSync(
      join(dir, "scripts", "data", "plugins-manifest.json"),
      JSON.stringify({
        ...matrixManifest(),
        active: ["dsh-lan-proxy", "dsh-a"],
        configSurfaces: [
          ...matrixManifest().configSurfaces,
          { package: "dsh-a", surface: "none", reason: "测试用" },
        ],
      }),
    );
    assert.deepEqual(loadManifest(dir).standalone, [], "缺 standalone 键应为空集");
  } finally {
    cleanup();
  }
});

test("#9 正向全绿：真实仓库 manifest + 真实目录 + 真实聚合 deps/patch", async () => {
  // 直接 import 根 package.json 同级的真实数据（node --test 直跑 TS，无构建步骤）
  const { readFileSync } = await import("node:fs");
  const root = join(import.meta.dirname, "..", "..");
  const manifest = loadManifest(root);
  // 取数口径与 pack-check 的断言面一致（git index ∩ 磁盘存在）：CI 的干净 checkout 上它与
  // listPluginDirs 精确相等，本地差异只来自并行进程瞬时创建、尚未 git add 的包目录。
  const dirs = listTrackedPluginDirs(root);
  assert.ok(dirs.length > 0, "载体自证：派生集为空时本用例空转全绿（枚举面失效）");
  // 反向断言（与 pack-check 同一判据）：物理目录集与派生集之差只允许差在「未跟踪」上——
  // 已 tracked 目录掉出派生集是静默失守，不是本地噪声。
  const derived = new Set(dirs);
  for (const d of listPluginDirs(root)) {
    if (derived.has(d)) continue;
    assert.equal(
      isIndexedPackageDir(root, d),
      false,
      `packages/${d} 在 git index 内有文件却不在派生集 —— 目录枚举面与 index 不一致`,
    );
  }
  assert.deepEqual(checkAggregateConsistency({ dirNames: dirs, manifest }), []);
  // 聚合包真实 deps 与 patch 也应双向相等
  const aggPkg = JSON.parse(
    readFileSync(join(root, "packages", "dsh-plugins-all", "package.json"), "utf8"),
  );
  const patch = readFileSync(join(root, "packages", "dsh-plugins-all", "cordis.patch.yml"), "utf8");
  const aggRows = [...patch.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1]);
  // 期望 id 集 = 各 active 子包 patch 实际 insert id（不硬编码 ui-，纯宿主插件如
  // dsh-verify-isolated 用 skill- 前缀；与 aggregate「原样拼接」语义一致）
  const expectedPatchIds = [];
  for (const dir of manifest.active) {
    const child = readFileSync(join(root, "packages", dir, "cordis.patch.yml"), "utf8");
    expectedPatchIds.push(...[...child.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1]));
  }
  assert.deepEqual(
    checkAggregateConsistency({
      dirNames: dirs,
      manifest,
      aggDeps: aggPkg.dependencies ?? {},
      aggPatchIds: aggRows,
      expectedPatchIds,
    }),
    [],
  );
});

// ---------------------------------------------------------------- 断言面的取数口径（git index ∩ 磁盘）

/** 临时 git 仓库：只需要 index，不必提交（派生面读的是 --cached）。 */
function tempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pm-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, "packages"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 铺一个包目录下的源文件（是否进 index 由调用方决定）。 */
function writePkgFile(dir, name, rel = "src/index.ts") {
  const full = join(dir, "packages", name, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "export {};\n", "utf8");
}

test("#10 listTrackedPluginDirs：未跟踪目录与「index 有、磁盘已删」目录都不进断言面", () => {
  const { dir, cleanup } = tempGitRepo();
  try {
    for (const n of ["dsh-alpha", "dsh-beta", "dsh-gone", "dsh-plugins-all", "Other-Foo"]) {
      writePkgFile(dir, n);
    }
    execFileSync("git", ["add", "packages"], { cwd: dir, stdio: "pipe" });
    // 未跟踪：只在磁盘、不进 index（多 agent 并行时另一个进程刚创建的目录就是这个形态）
    writePkgFile(dir, "dsh-junk");
    // index 有、磁盘已删（未 git rm）：进面会让下游读 package.json 裸 ENOENT
    rmSync(join(dir, "packages", "dsh-gone"), { recursive: true, force: true });

    assert.deepEqual(
      listTrackedPluginDirs(dir),
      ["dsh-alpha", "dsh-beta"],
      "派生面应为「index ∩ 磁盘」∩ dsh- 前缀 − 聚合包",
    );
    // 反向断言的判据本身：能不能区分「在 index 里」与「只是磁盘上有」——区分不了就恒绿
    assert.equal(isIndexedPackageDir(dir, "dsh-alpha"), true);
    assert.equal(isIndexedPackageDir(dir, "dsh-junk"), false, "未跟踪目录不得被判为已在 index");
    assert.equal(
      isIndexedPackageDir(dir, "dsh-gone"),
      true,
      "该目录仍在 index 里——正因如此只能靠 ∩ 磁盘把它挡在派生面外",
    );
  } finally {
    cleanup();
  }
});
