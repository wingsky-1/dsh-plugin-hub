#!/usr/bin/env node
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

/** 判据调用归一（与 checkAggregateConsistency 同一实现）：lib 实现仍带 @ts-nocheck，解构入参被推断为
 * 全必填——而缺字段正是部分用例的输入形态（各判据段独立容忍缺失，只断言自己那段；非法输入由实现判红），
 * 测试侧按实际传入形态整体断言。lib 摘 nocheck 并把入参标为可选后，本适配器可删（调回原名）。 */
type AggregateInput = Parameters<typeof checkAggregateConsistency>[0];
const checkAggregate = (input: unknown) => checkAggregateConsistency(input as AggregateInput);

const EXPECTED_DEPS = {
  "@wingsky-1/dsh-alpha": "workspace:*",
  "@wingsky-1/dsh-beta": "workspace:*",
};

test("#1 deps 多一行（退役包）→ 命中 retired 分支文案", () => {
  const problems = checkAggregate({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, "@wingsky-1/dsh-gone": "workspace:*" },
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多出已退役包 @wingsky-1\/dsh-gone/);
});

test("#2 deps 多一行（未收录名）→ 命中「既不在 active 也不在 retired」分支", () => {
  const problems = checkAggregate({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: { ...EXPECTED_DEPS, "@wingsky-1/dsh-typo": "workspace:*" },
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多出未收录包 @wingsky-1\/dsh-typo/);
});

test("#3 patch 少一行 → 报缺失 id（回归保护）", () => {
  const problems = checkAggregate({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggDeps: EXPECTED_DEPS,
    aggPatchIds: ["ui-dsh-alpha"],
  });
  assert.deepEqual(problems, ["聚合 patch 缺 ui-dsh-beta（active 在册但无聚合行）"]);
});

test("#3b patch 多未知 id → fail-loud", () => {
  const problems = checkAggregate({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-beta", "ui-dsh-ghost"],
  });
  assert.deepEqual(problems, ["聚合 patch 多出未知 id ui-dsh-ghost"]);
});

test("#3c patch 同 id 重复行 → fail-loud（Set 去重盲区闭合）", () => {
  const problems = checkAggregate({
    dirNames: ACTIVE,
    manifest: MANIFEST,
    aggPatchIds: ["ui-dsh-alpha", "ui-dsh-alpha", "ui-dsh-beta"],
  });
  assert.deepEqual(problems, ["聚合 patch 存在重复 id 行: ui-dsh-alpha"]);
});

test("#4 目录有包但 manifest 没有 → 报「未登记」", () => {
  const problems = checkAggregate({
    dirNames: [...ACTIVE, "dsh-newkid"],
    manifest: MANIFEST,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未登记 manifest: dsh-newkid/);
});

test("#4b 目录有包但只在 standalone → 双向通过；聚合 deps 误引 → fail-loud", () => {
  const manifest = { active: ACTIVE, standalone: ["dsh-demo"], retired: MANIFEST.retired };
  // 目录集 == active ∪ standalone：正向全绿（无聚合断言段）
  assert.deepEqual(checkAggregate({ dirNames: [...ACTIVE, "dsh-demo"], manifest }), []);
  // 聚合 deps 误引 standalone 包 → 明确分支文案
  const problems = checkAggregate({
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
  const problems = checkAggregate({ dirNames: [...ACTIVE, "dsh-leftover"], manifest });
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
  const problems = checkAggregate({ dirNames: kept, manifest });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未登记 manifest: dsh-newkid/);
});

test("#5 active 引用不存在目录 → 报「不存在的目录」", () => {
  const problems = checkAggregate({
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
      (e: unknown) =>
        e instanceof Error && /JSON 语法错误/.test(e.message) && !/SyntaxError/.test(e.message),
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
        active: ["dsh-a"],
        retired: [],
        // 配置面声明是必需节（#733 计划项 3.1.1：未登记即红），最小 manifest 也要覆盖其包；
        // surface: "none" 是「确实没有用户配置面」的显式形态。
        configSurfaces: [{ package: "dsh-a", surface: "none", reason: "测试用" }],
      }),
    );
    assert.deepEqual(loadManifest(dir).standalone, [], "缺 standalone 键应为空集");
  } finally {
    cleanup();
  }
});

test("dshPeerContracts schema：缺键/非 active/重复/非官方成员均 fail-closed", () => {
  const cases: Array<{ value: unknown; pattern: RegExp }> = [
    {
      value: { "dsh-a": ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-tools"] },
      pattern: /peer 重复/,
    },
    { value: { "dsh-a": ["react"] }, pattern: /非法官方 peer/ },
    { value: { "dsh-b": [] }, pattern: /含不在 active ∪ standalone 的包/ },
  ];
  for (const { value, pattern } of cases) {
    const { dir, cleanup } = tempRepo();
    try {
      writeFileSync(
        join(dir, "scripts", "data", "plugins-manifest.json"),
        JSON.stringify({
          active: ["dsh-a"],
          standalone: [],
          retired: [],
          dshPeerContracts: value,
          configSurfaces: [{ package: "dsh-a", surface: "none", reason: "测试用" }],
        }),
      );
      assert.throws(() => loadManifest(dir), pattern);
    } finally {
      cleanup();
    }
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
  assert.deepEqual(checkAggregate({ dirNames: dirs, manifest }), []);
  // 聚合包真实 deps 与 patch 也应双向相等
  const aggPkg = JSON.parse(
    readFileSync(join(root, "packages", "dsh-plugins-all", "package.json"), "utf8"),
  );
  const patch = readFileSync(join(root, "packages", "dsh-plugins-all", "cordis.patch.yml"), "utf8");
  const aggRows = [...patch.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1]);
  // 期望 id 集 = 各 active 子包 patch 实际 insert id（不硬编码 ui-，纯宿主插件如
  // dsh-verify-isolated 用 skill- 前缀；与 aggregate「原样拼接」语义一致）
  const expectedPatchIds = [];
  for (const dir of manifest.active as string[]) {
    const child = readFileSync(join(root, "packages", dir, "cordis.patch.yml"), "utf8");
    expectedPatchIds.push(...[...child.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1]));
  }
  assert.deepEqual(
    checkAggregate({
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
function writePkgFile(dir: string, name: string, rel: string = "src/index.ts") {
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
