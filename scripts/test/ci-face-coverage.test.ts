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
 *   3. 面集合等值：命中某个文件的所有条目所声明的面之并集，必须**恰好等于** ci.yml 为该
 *      文件派生出的面集合。
 *      #875 H9 说明：这条**不是收紧**。旧的两条断言合起来已经蕴含等值——「面覆盖」给
 *      registered ⊆ derived，「反向核对」给 derived ⊆ registered。实测同一夹具在 origin/main
 *      上照样判红（多声明面 / 漏一个面 / 把有面条目退回 []，三种都 exit 1）。本轮做的是把两条
 *      合并为一条显式等值判据 + 语义显式化 + 适配 faces 可缺省，可读性变好，强度持平。
 *   4. 无空 glob：ci.yml 每条 glob 必须命中至少一个真实文件（防改名后留下死规则）。
 *   5. 消费方真实（#843 L5）：每条条目必须声明「仓内直接读取方」（consumers——路径存在，且文件
 *      文本字面命中 source）或「无直接读取方的缺口」（consumerGap——kind 限 none / external /
 *      indirect），两者排他。只判「路径存在」拦不住假 why：旧条目曾声称 contract-check.ts 消费
 *      worktree-sidebar 基线，而该文件并不引用它——引用核对才是能打红真实缺陷的那一条。
 *   6. 无面资格是推导出来的（#875 H9）：登记表的 `faces` 缺省时，「该文件不需要任何 CI 面」
 *      不是一个可以被随手写下的声明，而是由 N1/N2/N3 三条规则从对象特征推出的结论，见下方
 *      「无面资格推导」段。写 `faces: []` 判红——豁免通道已删除。
 *
 * 为什么 universe 排除 packages/**：包面由 workflow-assert 的「filters 键集合 ==
 * manifest.active ∪ standalone ∪ 聚合包」加逐包 `packages/<pkg>/**` 断言守着，重复覆盖
 * 只会拖慢测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, matchesGlob, posix } from "node:path";
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
  /** 归属面。缺省 = 该条目命中的文件都不需要面（#875 H9：由 N1/N2/N3 推导，不是登记的声明）。 */
  faces?: string[];
  consumers?: string[];
  consumerGap?: ConsumerGap;
  why?: string;
  invalidatesBaseline?: boolean;
  artifactPolicy?: string;
}

/** 条目声明的面（缺省即「本条不主张任何面」——面归属由下一段的派生与等值核对决定）。 */
function declaredFaces(e: FaceRegistryEntry): string[] {
  return e.faces ?? [];
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

/*
 * ── 无面资格推导（#875 H9）────────────────────────────────────────────
 *
 * 裁决口径：「结构性不适用不是豁免」——真不适用时，规则应按**对象特征自动识别**，不靠登记。
 * 旧表把「这个文件不需要任何 CI 面」写成 `faces: []` 加一句人工 why，于是「不需要面」成了
 * 一个可以被随手写下的声明：任何新文件只要补一行 `faces: []` 就能静默退出所有切片，而现有
 * 断言一条都不会红（它们只核对「声明的面有没有接上」，空数组没有面可核对）。
 *
 * 现在它是一个**结论**，由三条规则从对象本身推出，三条同时成立才算推导成功：
 *   N1 无切片触发 —— ci.yml 任何面的 glob 都不命中该文件。filters 是「什么会触发切片」的
 *      唯一事实源：paths-filter 只在命中时才把面点亮，所以「不被任何 glob 命中」就是
 *      「改它不会触发任何切片」这一事实的机器形态。
 *   N2 无包消费 —— 没有任何 packages/** 下的代码文件按真实 import 图 import/require 它。
 *      按解析后的路径比对（而非字面包含），所以 README 里提到文件名不算数；这拦的是
 *      「文件本该是某个包的构建/测试输入，却被登记成无面」——旧口径对此完全无感。
 *
 *      **N2 的已知漏报面（实测过，别把它当编译器语义用）**：说明符提取是文本级正则 +
 *      路径规范化，以下八类读不出来——1 动态拼接 specifier（`import(\`./${n}.ts\`)`）、
 *      2 模板字面量 import、3 相对路径带 `#fragment`、4 `?query` 后缀、5 `createRequire`
 *      产出的 `req(...)`、6 `import.meta.resolve`、7 `readFileSync(new URL(...))` 这类运行时
 *      读文件（非 import 面）、8 `.js` 说明符指向磁盘上真实存在的 `.ts`。
 *      实测能检出的（别误列为漏报）：静态 `from` 字面量、`import("字面量")`（含 `if (x) import(...)`
 *      这类编译期条件导入）、`require("字面量")`、无 from 的副作用导入 `import "x"`。
 *      **口径现状：N2/N3 在当前真实数据上检出恒为 0/293——它们的真实防护从未被端到端验证过，
 *      今天的价值靠下面的载体自证 3/4/5 维持。**
 *   N3 消费者非包内 —— 条目的 consumers 不含 packages/** 路径，即消费它的入口都是仓级
 *      常驻闸（package.json 脚本 / workflow / 仓内门禁脚本），不是某个包的 job。
 *
 * N1 是入口条件（先确定「确实没有任何面会因它触发」），N2/N3 才是「就算没人登记也不该被
 * 当成需要面」的实质判据；三条依次不成立即判红。载体自证（见文末那条 test）保证推导本身
 * 没有失效——真实树上 N2 天然全过，只有合成反样本能把「条件恒真」打红。
 */

/** N1 的载体：ci.yml 为该文件派生出的面集合（filters 的 globs 命中它的面）。 */
function derivedFaces(file: string): string[] {
  return Object.entries(FILTERS)
    .filter(([, globs]) => globs.some((g) => hits(file, g)))
    .map(([face]) => face)
    .sort();
}

/** 登记表为该文件声明的面并集（缺省 faces 的条目不贡献任何面）。 */
function registeredFaces(file: string): string[] {
  const out = new Set<string>();
  for (const e of REGISTRY.entries) {
    if (!hits(file, e.path)) continue;
    for (const face of declaredFaces(e)) out.add(face);
  }
  return [...out].sort();
}

const RESOLVABLE = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** 把一条 import/require 说明符按仓库相对路径解析成真实文件（与 Node/TS 的解析口径同形）。 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const ext of RESOLVABLE) {
    if (TRACKED_SET.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVABLE.slice(1)) {
    if (TRACKED_SET.has(posix.join(base, "index" + ext))) return posix.join(base, "index" + ext);
  }
  if (TRACKED_SET.has(base)) return base;
  // 扩展名替换（#1028 后续重构）：shared TS 化后，包里的说明符仍是 ../../shared/**.js
  // （构建链要求 emit 出的说明符指向真实 .js），而**源码**已变成同名 .ts。上面两轮都是
  // 「往 base 后面追加扩展名」，不覆盖「把 .js 换成 .ts」——于是这批边会整体消失，
  // 连带把下面那条载体自证打成假红。此处按 TS 的解析口径补上这一形态。
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (stem !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      if (TRACKED_SET.has(stem + ext)) return stem + ext;
    }
  }
  return null;
}

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * N2 的载体：packages/ 下的代码文件按真实 import 图解析出的「仓外被引文件」集合。
 * 只取相对说明符并解析到 tracked 文件——裸包名走 node_modules，不属本仓判据。
 */
const PACKAGE_IMPORT_EDGES: { from: string; to: string }[] = [];
{
  // 四种形态都要吃到：from "x"、import("x")、require("x")，以及**无 from 的副作用导入**
  // `import "x"`——漏掉最后一种，等于让「只执行不取符号」的消费方式绕过 N2。
  const specRe = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport)\s*["']([^"']+)["']/g;
  for (const file of ALL_TRACKED) {
    if (!file.startsWith("packages/") || !CODE_EXT.test(file)) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(specRe)) {
      const to = resolveSpecifier(file, m[1]);
      if (to !== null) PACKAGE_IMPORT_EDGES.push({ from: file, to });
    }
  }
}

/** N2 判定：是否有 packages/** 的代码文件真的 import/require 了它。 */
function importedByPackages(file: string): string[] {
  return PACKAGE_IMPORT_EDGES.filter((e) => e.to === file)
    .map((e) => e.from)
    .sort();
}

/** N3 判定：条目的 consumers 里有没有落在 packages/ 下的路径。 */
function packageConsumers(e: FaceRegistryEntry): string[] {
  return (e.consumers ?? []).filter((c) => c.startsWith("packages/")).sort();
}

/**
 * 无面资格的判定本体：纯函数，三个输入决定结论，null 表示推导成立。
 * 抽成纯函数是为了让「载体自证」能用合成样本正反打它——否则把任一条件改成永真/恒假都
 * 不会被真实树上的用例发现（真实树上无面文件本来就都没被包 import，条件失效与条件成立
 * 表现完全一样）。
 */
function judgeNoFace(args: {
  derived: string[];
  importers: string[];
  pkgConsumers: string[];
}): string | null {
  const { derived, importers, pkgConsumers } = args;
  if (derived.length > 0) {
    return `N1 不成立：ci.yml 派生出面 ${JSON.stringify(derived)}，它需要面而不是无面`;
  }
  if (importers.length > 0) {
    return `N2 不成立：被 packages/ 代码 import/require（${importers.slice(0, 3).join(", ")}）`;
  }
  if (pkgConsumers.length > 0) {
    return `N3 不成立：consumers 含包内路径 ${JSON.stringify(pkgConsumers)}，消费它的是包 job 而非仓级常驻闸`;
  }
  return null;
}

/** 无面资格：把该文件的真实推导输入喂进判定本体。N1 是推导的入口条件（先判面）。 */
function noFaceVerdict(file: string, e: FaceRegistryEntry): string | null {
  return judgeNoFace({
    derived: derivedFaces(file),
    importers: importedByPackages(file),
    pkgConsumers: packageConsumers(e),
  });
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

/** 逐个消费方核对：路径在 git 内，且文件文本字面命中 source 的任一指纹；失败写进 failures。 */
function checkConsumerRefs(e: FaceRegistryEntry, failures: string[]): void {
  const fingerprints = sourceFingerprints(e.path);
  for (const rel of e.consumers ?? []) {
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
}

/** consumerGap 分支的形态判据：kind 枚举、reason 非空、trackingIssue 形态。 */
function assertConsumerGap(e: FaceRegistryEntry, gap: ConsumerGap): void {
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
  assertConsumerGap(e, e.consumerGap as ConsumerGap);
}

test("#742 2.3: ci-face-registry 结构合法（faces 名必须是 ci.yml 的真实面）", () => {
  assert.ok(Array.isArray(REGISTRY.entries) && REGISTRY.entries.length > 0, "entries 必须非空");
  assert.ok(FILTERS !== null, `${CI_YML_REL} 的 filters 块必须可解析`);
  const seen = new Set();
  for (const e of REGISTRY.entries) {
    assert.equal(typeof e.path, "string", `path 必须是字符串：${JSON.stringify(e)}`);
    assert.ok(e.path.length > 0, "path 不得为空");
    // #875 H9：faces 缺省 = 本条不主张任何面。写空数组就是走旧的「显式豁免」通道，判红——
    // 豁免入口已删除，「不需要面」改由 N1/N2/N3 从对象特征推导（见 noFaceVerdict）。
    if (e.faces !== undefined) {
      assert.ok(
        Array.isArray(e.faces),
        `${e.path} 的 faces 必须是数组；不需要面就整个字段不写（空数组豁免通道已删除）`,
      );
      assert.ok(
        e.faces.length > 0,
        `${e.path} 写了 faces: [] —— 空数组豁免通道已删除（#875 H9）。该条命中的文件若真的不需要面，把 faces 整个字段删掉，让 N1/N2/N3 去推导；若它其实需要面，补上真实的面名。`,
      );
    } else {
      // 无面条目的理由是推导出来的，why 由 N1/N2/N3 给出。
      assert.equal(
        e.why,
        undefined,
        `${e.path} 缺省 faces（无面），why 应由 N1/N2/N3 推导给出而不是手写——手写会把推导出的事实退化成登记的声明`,
      );
    }
    // 声明了面就仍然必须写归属理由——这条断言与 #742 同形，#875 H9 不得顺带把它松开：
    // 「为什么归这个面」是人要交代的判断，不是能从 filters 反推出来的事实。
    if (e.faces !== undefined) {
      assert.ok(
        typeof e.why === "string" && e.why.trim().length > 0,
        `${e.path} 必须写明归属理由（声明了面就必须交代为什么归这个面）`,
      );
    }
    assertConsumerShape(e);
    assert.ok(!seen.has(e.path), `注册表条目重复：${e.path}`);
    seen.add(e.path);
    for (const face of declaredFaces(e)) {
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
      "请在 scripts/data/ci-face-registry.json 登记它：需要面就写 faces，真不需要面就整个字段不写、让 N1/N2/N3 去推导（#875 H9 已删除空数组豁免通道）：\n" +
      unregistered.join("\n"),
  );
});

test("#742 2.3: 无悬空条目——每条注册表项都必须命中真实文件", () => {
  const stale = REGISTRY.entries
    .filter((e) => !UNIVERSE.some((file) => hits(file, e.path)))
    .map((e) => e.path);
  assert.deepEqual(stale, [], `注册表条目已无对应文件（改名或删除后忘改）：\n${stale.join("\n")}`);
});

test("#875 H9: 面集合等值——登记面并集必须恰好等于 ci.yml 为该文件派生出的面（漏面与多面都判红）", () => {
  // 为什么不写成「只查 registered ⊆ derived」：那正是旧的「面覆盖」，而它与「反向核对」合起来
  // 已经蕴含等值——**本条不是收紧，是把两条合成一条并让语义显式**。实测同一夹具在 origin/main
  // 上同样判红：多声明一个面 exit 1、漏一个面 exit 1、把有面条目退回 faces:[] 也 exit 1。
  // 合成之后读者不必自己把两条推到一起，判词也直接指出是哪个文件、并集与派生各是什么。
  const gaps: string[] = [];
  for (const file of UNIVERSE) {
    const derived = derivedFaces(file);
    const registered = registeredFaces(file);
    if (JSON.stringify(derived) !== JSON.stringify(registered)) {
      gaps.push(
        `${file}：ci.yml 派生出 ${JSON.stringify(derived)}，登记表声明 ${JSON.stringify(registered)}`,
      );
    }
  }
  assert.deepEqual(
    gaps,
    [],
    `归属登记与 filters 不一致（必须是集合等值，不是子集）：\n${gaps.join("\n")}`,
  );
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
        const declared = REGISTRY.entries.some(
          (e) => declaredFaces(e).includes(face) && hits(file, e.path),
        );
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
        declaredFaces(e).length > 0 && !declaredFaces(e).includes("global"),
        `${e.path} 标了 invalidatesBaseline 却没有包面（无面或全局面）——失基线判据只认包面，它会成为死数据`,
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
  assert.ok(
    declaredFaces(entry).length > 0,
    "test/smoke-lib.ts 不得无面：它是被多个包测试 import 的代码",
  );
  // 「不得豁免」现在有两条独立证据：登记表声明了面，且 N1 独立推出它确实有面。
  assert.deepEqual(
    derivedFaces("test/smoke-lib.ts"),
    [...declaredFaces(entry)].sort(),
    "test/smoke-lib.ts 声明的面与 ci.yml 派生面不一致",
  );

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
    [...declaredFaces(entry)].sort(),
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
      checkConsumerRefs(e, failures);
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

test("#875 H9: 无面资格由 N1/N2/N3 推导——不需要面是结论，不是登记的声明", () => {
  // 本条取代旧的「faces: [] 显式豁免」。推导的**对象是文件**，不是那行登记：`scripts/test/**`
  // 与 `scripts/test/run-vitest.mjs` 同时命中后者，而后者确实在 global 面里——这不是「豁免条目
  // 覆盖到了有面的文件」的缺陷，而是并集语义的正常结果（run-vitest.mjs 的面由它自己那条条目声明，
  // 集合等值那条 test 会核对）。所以这里只对「N1 判定为无面」的文件求值。
  const failures: string[] = [];
  let checkedFiles = 0;
  for (const file of UNIVERSE) {
    if (derivedFaces(file).length > 0) continue;
    checkedFiles++;
    // N3 逐条核对覆盖该文件的每个条目：谁都不许把包内路径当消费方。
    for (const e of REGISTRY.entries) {
      if (!hits(file, e.path)) continue;
      const verdict = noFaceVerdict(file, e);
      if (verdict !== null) failures.push(`${file}（条目 ${e.path}）：${verdict}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `混进了不该无面的文件——「不需要面」必须由 N1/N2/N3 从对象特征推出，不能靠登记：\n${failures.join("\n")}`,
  );

  // 载体自证 1：无面文件集必须非空，且必须真被推导扫过，否则这条断言可能整轮空跑。
  assert.ok(
    REGISTRY.entries.some((e) => e.faces === undefined),
    "载体自证：登记表里一条缺省 faces 的条目都没有——本断言整轮空跑",
  );
  assert.ok(checkedFiles > 0, "载体自证：ci.yml 没有派生出一个无面文件——推导整轮空跑");

  // 载体自证 2（N1 非恒真）：必须有文件被判为「有面」，否则 N1 退化成永假、无面集合会吞掉全树。
  const withFaces = UNIVERSE.filter((f) => derivedFaces(f).length > 0);
  assert.ok(withFaces.length > 0, "载体自证：ci.yml 派生不出任何面——filters 块或 matchesGlob 失效");
  for (const [face, globs] of Object.entries(FILTERS)) {
    assert.ok(globs.length > 0, `载体自证：面 ${face} 没有任何 glob`);
  }

  // 载体自证 3（N2 非恒真）：import 扫描面必须非空，且必须真的解析出仓外被引文件；
  // 否则「无包消费」这一条会恒真，把 N2 变成一句空话。
  assert.ok(PACKAGE_IMPORT_EDGES.length > 0, "载体自证：packages/ 的 import 扫描面为空");
  const outside = new Set(
    PACKAGE_IMPORT_EDGES.map((e) => e.to).filter((t) => !t.startsWith("packages/")),
  );
  assert.ok(
    outside.size > 0,
    "载体自证：packages/ 代码没有解析出任何仓外被引文件——说明符正则或路径解析失效",
  );
  assert.ok(
    importedByPackages("test/smoke-lib.ts").length > 0,
    "载体自证：N2 的正例样本 test/smoke-lib.ts 不再被任何包 import",
  );
  assert.ok(
    [...outside].some((t) => t.startsWith("shared/")),
    "载体自证：packages/ 代码不再 import shared/**——N2 的第二个正例样本失效",
  );

  // 载体自证 4（N3 非恒真）：必须有条目的 consumers 落在 packages/ 下，否则 N3 恒真。
  assert.ok(
    REGISTRY.entries.some((e) => packageConsumers(e).length > 0),
    "载体自证：没有任何条目的 consumers 落在 packages/ 下——N3 恒真，已失去区分力",
  );

  // 载体自证 5（判定本体非恒真）：用合成样本正反打 judgeNoFace。真实树上所有无面文件都没被
  // 包 import，所以真实用例区分不出「N2 判负」和「N2 恒真」——只有反样本能。任一条件被改成
  // 永真（if (false)）或永假（直接 return null），下面三条反样本立刻判红。
  const base = { derived: [], importers: [], pkgConsumers: [] };
  assert.equal(judgeNoFace(base), null, "载体自证：正样本（三条都不触发）应判为无面");
  assert.match(
    String(judgeNoFace({ ...base, derived: ["global"] })),
    /^N1 /,
    "载体自证：N1 反样本必须被拒——N1 已失效（恒真或恒假）",
  );
  assert.match(
    String(judgeNoFace({ ...base, importers: ["packages/dsh-notifier/src/index.ts"] })),
    /^N2 /,
    "载体自证：N2 反样本必须被拒——「无包消费」已退化为永真",
  );
  assert.match(
    String(judgeNoFace({ ...base, pkgConsumers: ["packages/dsh-notifier/package.json"] })),
    /^N3 /,
    "载体自证：N3 反样本必须被拒——「消费者非包内」已退化为永真",
  );
});
