#!/usr/bin/env node
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
 *   5. 消费方真实（#843 L5）：每条条目必须声明「仓内直接读取方」（consumers——路径存在，且文件
 *      文本字面命中 source）或「无直接读取方的缺口」（consumerGap——kind 限 none / external /
 *      indirect），两者排他。只判「路径存在」拦不住假 why：旧条目曾声称 contract-check.ts 消费
 *      worktree-sidebar 基线，而该文件并不引用它——引用核对才是能打红真实缺陷的那一条。
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

/** 登记表条目：字段合法性由本文件第一条测试逐条断言，此处只声明后续判据要用到的面。 */
/** 无仓内直接读取方时的缺口声明：kind 受枚举约束，真缺口（none）必须带 trackingIssue。 */
interface ConsumerGap {
  kind: "none" | "external" | "indirect";
  reason: string;
  trackingIssue?: string;
}

interface FaceRegistryEntry {
  path: string;
  faces: string[];
  consumers?: string[];
  consumerGap?: ConsumerGap;
  why?: string;
  invalidatesBaseline?: boolean;
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
}

const REGISTRY = readJson<{ entries: FaceRegistryEntry[] }>("scripts/data/ci-face-registry.json");

// filters 块是下面所有判据的唯一输入：解析不出来就无可判之物，这里直接炸，别让后续断言在空表上静默通过。
const PARSED_FILTERS = parseFilterBlock(readFileSync(join(ROOT, CI_YML_REL), "utf8"));
assert.ok(PARSED_FILTERS !== null, `${CI_YML_REL} 必须含可解析的 paths-filter 块`);
const FILTERS = PARSED_FILTERS;

/** tracked 文件全集（git 口径：不含构建产物、临时文件与被忽略路径）。 */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

const ALL_TRACKED = trackedFiles();
const TRACKED_SET = new Set(ALL_TRACKED);

/** packages/ 之外的全部 tracked 文件 = 本断言的 universe。 */
const UNIVERSE = ALL_TRACKED.filter((f) => !f.startsWith("packages/"));

/**
 * 安全 glob 匹配。catch 只兜非字符串一类的调用错误（实测 Node 对畸形 glob 返回 false 而不抛）：
 * 畸形 pattern 因此表现为「不命中」，会被「悬空条目」与「死 glob」两条断言判红——这正是我们要的。
 */
function hits(file: string, pattern: string): boolean {
  try {
    return matchesGlob(file, pattern);
  } catch {
    return true;
  }
}

/**
 * 条目 source 的文本指纹（#843 L5 引用核对）：具体文件取基名；glob 取静态前缀（`<dir>/**`
 * 取目录部分），并补「当前真实命中该 glob 的文件基名」——`stryker.conf.d/<pkg>*.json` 这类
 * 只剩裸包名前缀的 glob，仅靠前缀会把「提到包名」误判成引用。
 */
function sourceFingerprints(source: string): string[] {
  const out = new Set<string>();
  const segment = source.split("/").pop() as string;
  if (!source.includes("*")) {
    out.add(segment);
    return [...out];
  }
  if (segment === "**") {
    const dir = source.slice(0, -3);
    if (dir.length >= 2) out.add(dir);
  } else {
    const prefix = segment.slice(0, segment.indexOf("*"));
    if (prefix.length >= 3) out.add(prefix);
  }
  for (const file of ALL_TRACKED) {
    if (hits(file, source)) out.add(file.split("/").pop() as string);
  }
  return [...out];
}

/** 消费方声明的形态判据（#843 L5）：consumers 与 consumerGap 排他，且各自形态合法。 */
function assertConsumerShape(e: FaceRegistryEntry): void {
  const hasConsumers = Array.isArray(e.consumers) && e.consumers.length > 0;
  const hasGap = e.consumerGap !== undefined && e.consumerGap !== null;
  assert.notEqual(
    hasConsumers,
    hasGap,
    `${e.path} 必须恰好其一：consumers（非空，仓内直接读取方）或 consumerGap（无直接读取方的缺口）`,
  );
  if (!hasGap) {
    assert.ok(Array.isArray(e.consumers), `${e.path} 的 consumers 必须是数组`);
    for (const rel of e.consumers ?? []) {
      assert.ok(
        typeof rel === "string" && rel.trim().length > 0,
        `${e.path} 的 consumers 不得含空项：${JSON.stringify(rel)}`,
      );
    }
    return;
  }
  const gap = e.consumerGap as ConsumerGap;
  assert.ok(
    gap.kind === "none" || gap.kind === "external" || gap.kind === "indirect",
    `${e.path} 的 consumerGap.kind 只许 none | external | indirect，实得 ${JSON.stringify(gap.kind)}`,
  );
  assert.ok(
    typeof gap.reason === "string" && gap.reason.trim().length > 0,
    `${e.path} 的 consumerGap.reason 必须写明「谁加载它」`,
  );
  if (gap.kind === "none") {
    assert.match(
      String(gap.trackingIssue ?? ""),
      /^#\d+$/,
      `${e.path} 的 consumerGap.kind=none 是真缺口，必须带 trackingIssue（形如 #847）`,
    );
  } else if (gap.trackingIssue !== undefined) {
    assert.match(
      String(gap.trackingIssue),
      /^#\d+$/,
      `${e.path} 的 consumerGap.trackingIssue 形态应为 #<编号>`,
    );
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
    assertConsumerShape(e);
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

test("#742 2.3: 反向核对——filters 每条 glob 命中的面外文件都必须由声明了该面的条目覆盖", () => {
  // 正向（上一条）只能发现「登记了但没接上」；发现不了「包面被悄悄扩大」——给某个包面加一条
  // 覆盖面外文件的 glob，所有声明都还成立，但那个文件从此会触发一个语义上不属于它的包。
  // 两个方向都锁住，「filters == 注册表」才是真契约。
  const gaps = [];
  for (const [face, globs] of Object.entries(FILTERS)) {
    for (const g of globs) {
      for (const file of UNIVERSE) {
        if (!hits(file, g)) continue;
        const declared = REGISTRY.entries.some((e) => e.faces.includes(face) && hits(file, e.path));
        if (!declared) gaps.push(`${face} 面的 glob「${g}」命中了未声明该面的文件 ${file}`);
      }
    }
  }
  assert.deepEqual(
    gaps,
    [],
    `filters 的面边界与注册表不一致（包面被静默扩大/错配）：\n${gaps.join("\n")}`,
  );
});

test("#742 1.7: invalidatesBaseline 只能标在声明了包面的条目上（否则不产生任何效果）", () => {
  const flagged = REGISTRY.entries.filter((e) => e.invalidatesBaseline !== undefined);
  assert.ok(flagged.length > 0, "至少要有一条带该字段的条目——否则 1.7 只剩 test/** 一条来源");
  for (const e of flagged) {
    assert.equal(
      typeof e.invalidatesBaseline,
      "boolean",
      `${e.path} 的 invalidatesBaseline 必须是布尔`,
    );
    if (e.invalidatesBaseline) {
      assert.ok(
        e.faces.length > 0 && !e.faces.includes("global"),
        `${e.path} 标了 invalidatesBaseline 却声明为豁免/全局面——失基线判据只认包面，它会成为死数据`,
      );
    }
  }
  // 回归锚：段配置与包级测试面配置必须带标记（它们定义「哪些测试在杀 mutant」）
  for (const p of [
    "test/smoke-lib.ts",
    "vitest.stryker.d/dsh-notifier.config.ts",
    "stryker.conf.d/dsh-notifier*.json",
  ]) {
    const e = REGISTRY.entries.find((x) => x.path === p);
    assert.equal(
      e?.invalidatesBaseline,
      true,
      `${p} 必须带 invalidatesBaseline：改它会改变变异测试面，static mutant 盲区要靠它失基线`,
    );
  }
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
    const files = walkFiles(testDir, (n: string) => n.endsWith(".ts"));
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

test("#843 L5: consumers 是真实读取方——路径存在且字面命中 source（假消费方判红）", () => {
  // 为什么需要引用核对：旧条目声称「消费方是 contract-check.ts」而该文件并不引用 source，
  // 只判「路径存在」时它照样全绿；本断言让「填一个看起来像消费方的路径」当场判红。
  const failures: string[] = [];
  let consumersChecked = 0;
  let gapsChecked = 0;
  for (const e of REGISTRY.entries) {
    if (Array.isArray(e.consumers) && e.consumers.length > 0) {
      consumersChecked++;
      const fingerprints = sourceFingerprints(e.path);
      for (const rel of e.consumers) {
        if (!TRACKED_SET.has(rel)) {
          failures.push(`${e.path} 的消费方 ${rel} 不在 git 跟踪的仓内文件里`);
          continue;
        }
        const text = readFileSync(join(ROOT, rel), "utf8");
        if (!fingerprints.some((fp) => text.includes(fp))) {
          failures.push(
            `${e.path} 的消费方 ${rel} 未字面命中 source 指纹 ${JSON.stringify(fingerprints)}——它不是该 source 的读取方`,
          );
        }
      }
    } else if (e.consumerGap !== undefined && e.consumerGap !== null) {
      gapsChecked++;
    }
  }
  assert.deepEqual(failures, [], `consumers 引用核对失败：\n${failures.join("\n")}`);
  // 载体自证：核对必须覆盖登记全集，防「一条没扫却恒绿」。
  assert.ok(consumersChecked > 0, "载体自证：至少要有一条 consumers 条目被核对");
  assert.equal(
    consumersChecked + gapsChecked,
    REGISTRY.entries.length,
    "载体自证：consumers 条目 + consumerGap 条目必须覆盖全部 entries",
  );
});
