#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * CI 归属完整性（#742 阶段 2.3）。
 *
 * 为什么存在：dorny/paths-filter 的过滤面是 fail-open 的——把一个文件从所有面里删掉
 * 不会让任何断言变红，只会让它静默地不再触发任何切片（本地同理由 local-scope 解析同一份
 * filters，一起漏）。阶段 2.1 把整树 `scripts/**` 收窄成显式白名单后，这个 fail-open 的
 * 敞口从「只影响新增目录」变成「每条白名单都可能漏」，所以必须有 completeness 断言把
 * 「packages/ 之外的每个 tracked 文件归哪个面」变成可判红的契约。
 *
 * 断言方向（双向，缺一不可）：
 *   1. 完整性：真实 tracked 文件 → 必须被注册表某条命中（新文件未登记即红）；
 *   2. 无悬空：注册表每条 → 必须命中至少一个真实文件（改名/删除后忘改即红）；
 *   3. 面覆盖：命中的每个声明面，ci.yml 该面的 filters 必须有 glob 能命中该文件
 *      （验证「登记了但过滤面没接上」——登记本身不产生任何效果）；
 *   4. 无空 glob：ci.yml 每条 glob 必须命中至少一个真实文件（防改名后留下死规则）。
 *
 * 为什么 universe 排除 packages/**：包面由 workflow-assert 的「filters 键集合 ==
 * manifest.active ∪ standalone ∪ 聚合包」加逐包 `packages/<pkg>/**` 断言守着，重复覆盖
 * 只会拖慢测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFilterBlock } from "../gate/local-scope.mjs";
import { walkFiles } from "../lib/walk-files.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_YML_REL = ".github/workflows/ci.yml";

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

const REGISTRY = readJson("scripts/data/ci-face-registry.json");
const FILTERS = parseFilterBlock(readFileSync(join(ROOT, CI_YML_REL), "utf8"));

/** tracked 文件全集（git 口径：不含构建产物、临时文件与被忽略路径）。 */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** packages/ 之外的全部 tracked 文件 = 本断言的 universe。 */
const UNIVERSE = trackedFiles().filter((f) => !f.startsWith("packages/"));

/** 安全 glob 匹配：非法 glob 视为命中（放大判红面，不静默放过）。 */
function hits(file, pattern) {
  try {
    return matchesGlob(file, pattern);
  } catch {
    return true;
  }
}

test("#742 2.3: ci-face-registry 结构合法（faces 名必须是 ci.yml 的真实面）", () => {
  assert.ok(Array.isArray(REGISTRY.entries) && REGISTRY.entries.length > 0, "entries 必须非空");
  assert.ok(FILTERS !== null, `${CI_YML_REL} 的 filters 块必须可解析`);
  const seen = new Set();
  for (const e of REGISTRY.entries) {
    assert.equal(typeof e.path, "string", `path 必须是字符串：${JSON.stringify(e)}`);
    assert.ok(e.path.length > 0, "path 不得为空");
    assert.ok(Array.isArray(e.faces), `${e.path} 的 faces 必须是数组（豁免写空数组）`);
    assert.ok(
      typeof e.why === "string" && e.why.trim().length > 0,
      `${e.path} 必须写明归属理由（豁免也要写：豁免的依据是常驻闸，不是「没人管」）`,
    );
    assert.ok(!seen.has(e.path), `注册表条目重复：${e.path}`);
    seen.add(e.path);
    for (const face of e.faces) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(FILTERS, face),
        `${e.path} 声明的面 "${face}" 不是 ${CI_YML_REL} 的 filters 键——面名写错等于没登记`,
      );
    }
  }
});

test("#742 2.3: 归属完整性——packages/ 之外每个 tracked 文件都被登记（新增文件不登记即红）", () => {
  assert.ok(
    UNIVERSE.length > 100,
    `universe 规模异常（${UNIVERSE.length}）——git ls-files 是否失效？`,
  );
  const unregistered = UNIVERSE.filter((file) => !REGISTRY.entries.some((e) => hits(file, e.path)));
  assert.deepEqual(
    unregistered,
    [],
    "下列文件不在任何 CI 归属条目内——它们不会触发任何切片（fail-open）。" +
      "请在 scripts/data/ci-face-registry.json 登记其归属面，豁免也必须显式登记：\n" +
      unregistered.join("\n"),
  );
});

test("#742 2.3: 无悬空条目——每条注册表项都必须命中真实文件", () => {
  const stale = REGISTRY.entries
    .filter((e) => !UNIVERSE.some((file) => hits(file, e.path)))
    .map((e) => e.path);
  assert.deepEqual(stale, [], `注册表条目已无对应文件（改名或删除后忘改）：\n${stale.join("\n")}`);
});

test("#742 2.3: 面覆盖——登记的面必须在 ci.yml 里真的接上（登记本身不产生效果）", () => {
  const gaps = [];
  for (const file of UNIVERSE) {
    for (const e of REGISTRY.entries) {
      if (!hits(file, e.path)) continue;
      for (const face of e.faces) {
        const globs = FILTERS[face] ?? [];
        if (!globs.some((g) => hits(file, g))) {
          gaps.push(`${file}（条目 ${e.path}）声明面 ${face}，但该面 filters 无一 glob 命中`);
        }
      }
    }
  }
  assert.deepEqual(gaps, [], `归属登记与 filters 不一致：\n${gaps.join("\n")}`);
});

test("#742 2.3: 无死 glob——ci.yml 每条 filters glob 必须命中至少一个 tracked 文件", () => {
  const all = trackedFiles();
  const dead = [];
  for (const [face, globs] of Object.entries(FILTERS)) {
    for (const g of globs) {
      if (!all.some((f) => hits(f, g))) dead.push(`${face}: ${g}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `下列 filters glob 不命中任何 tracked 文件（改名/迁移后留下的死规则，会让人误判覆盖面）：\n${dead.join("\n")}`,
  );
});

test("#742 2.3: test/smoke-lib.ts 的包名单按真实 import 图核对（第 6 个包接入必须同步）", () => {
  const entry = REGISTRY.entries.find((e) => e.path === "test/smoke-lib.ts");
  assert.ok(entry, "注册表必须有 test/smoke-lib.ts 条目");
  assert.ok(entry.faces.length > 0, "test/smoke-lib.ts 不得豁免：它是被多个包测试 import 的代码");

  const importers = [];
  for (const dirent of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const testDir = join(ROOT, "packages", dirent.name, "test");
    if (!existsSync(testDir)) continue;
    const files = walkFiles(testDir, (n) => n.endsWith(".ts"));
    if (
      files.some((rel) =>
        /["'][^"']*test\/smoke-lib\.ts["']/.test(readFileSync(join(testDir, rel), "utf8")),
      )
    ) {
      importers.push(dirent.name);
    }
  }
  assert.deepEqual(
    [...entry.faces].sort(),
    importers.sort(),
    "test/smoke-lib.ts 的声明面与真实 import 图不一致——新接入的包不会因它改动而重跑测试",
  );
});
