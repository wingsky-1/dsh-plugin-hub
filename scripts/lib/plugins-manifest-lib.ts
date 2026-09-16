#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * plugins-manifest-lib — 插件清单单一事实源（issue #36）的纯函数库。
 *
 * `scripts/data/plugins-manifest.json` 是「某插件是否参与聚合/发布校验」的唯一声明处：
 *   - aggregate.ts / pack-check.ts / contract-check.ts / verify-npm-layout.ts 共读；
 *   - 断言逻辑只有本文件一份，入口脚本只喂数据（对齐 client-contract-lib 的
 *     「stub/实现同源」纪律，防两处内嵌实现漂移）。
 * schema 说明与 opt-in 设计动机见 docs/DEVELOPMENT.md §4「插件清单单一来源」。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGGREGATE_NAME = "dsh-plugins-all";
export const NPM_SCOPE = "@wingsky-1/";
export const MANIFEST_PATH_SEGMENTS = ["scripts", "data", "plugins-manifest.json"];
const NAME_RE = /^dsh-[a-z0-9-]+$/;

/**
 * 枚举 packages/ 下的插件目录：仅目录（isDirectory 过滤，防同名文件裸栈）、
 * dsh- 前缀、排除聚合包、稳定排序。四个枚举入口共用此实现。
 */
export function listPluginDirs(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("dsh-") && e.name !== AGGREGATE_NAME)
    .map((e) => e.name)
    .sort();
}

/** packages/ 下非 dsh- 前缀的目录警告（如 Dsh-Foo / dsh_foo 会被静默忽略，使其可见）。 */
export function warnUnknownEntries(root) {
  for (const e of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith("dsh-") && e.name !== AGGREGATE_NAME) {
      console.error(
        `[plugins-manifest] 警告：packages/ 下存在非 dsh- 前缀目录 ${e.name}，不参与插件清单`,
      );
    }
  }
}

/** `git ls-files --cached` 的原始输出（仓库根相对 posix 路径），pathspec 由调用方给。 */
function lsFiles(root, pathspec) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--", ...pathspec], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\0").filter((p) => p.length > 0);
}

/** index 里 packages/ 下的目录名集：不过滤前缀、不过问磁盘存在性。 */
function indexPackageDirNames(root) {
  const names = new Set();
  for (const p of lsFiles(root, ["packages"])) {
    const slash = p.indexOf("/", "packages/".length);
    if (slash > 0) names.add(p.slice("packages/".length, slash));
  }
  return names;
}

/**
 * 「参与清单校验的包目录」= git index ∩ 磁盘存在（dsh- 前缀、排除聚合包、稳定排序）。
 *
 * 为什么断言面用它与不用 listPluginDirs：这条判据的语义是「新增包目录必须登记 manifest」，
 * 而未登记的新目录**只可能存在于本地工作树**——CI 的 checkout 是干净的，index 集合与
 * readdirSync 结果精确相等，故窄化到 index 在 CI 上零损失，消除的只是本地多 agent 并行开发时
 * 「另一个进程刚创建、尚未 git add 的目录」造成的假红（同一 worktree 两次跑出 845/849 与
 * 849/849 即此形态）。listPluginDirs 物理枚举语义不变，消费方照旧用它。
 *
 * ∩ 磁盘存在这一半不可省：index 有、工作树已删（未 git rm）的目录若被当包枚举，下游按
 * package.json 读包会裸 ENOENT——与 filterOutRetiredDirs 当初要解决的是同一类故障。
 */
export function listTrackedPluginDirs(root) {
  const indexed = indexPackageDirNames(root);
  return listPluginDirs(root).filter((d) => indexed.has(d));
}

/**
 * 单个目录在 index 里是否有文件——反向断言专用。
 * pathspec 直接指到该目录，因此批量取数若因 pathspec 收窄而漏项，这里仍能给出独立答案。
 */
export function isIndexedPackageDir(root, name) {
  return lsFiles(root, [`packages/${name}`]).length > 0;
}

/**
 * 从物理目录集中剔除 manifest.retired 名（T1：#397 退役包目录残留致 contract /
 * verify-npm-layout 等按 package.json 读包的消费方裸 ENOENT 崩门禁）。
 * listPluginDirs 保持「物理目录事实源」语义不变（checkAggregateConsistency 双向
 * 校验依赖它：新目录必须登记 / 登记项必须存在）；本函数仅供「按 package.json 逐包
 * 消费」的入口过滤退役残留目录——出队顺序 = 物理枚举序，仅做名集过滤。
 */
export function filterOutRetiredDirs(dirNames, manifest) {
  const retiredNames = new Set((manifest.retired ?? []).map((r) => r.name));
  const kept = [];
  const skipped = [];
  for (const d of dirNames) {
    if (retiredNames.has(d)) skipped.push(d);
    else kept.push(d);
  }
  return { kept, skipped };
}

function fail(msg) {
  throw new Error(
    `scripts/data/plugins-manifest.json 解析失败：${msg}（schema 见 docs/DEVELOPMENT.md §4 插件清单）`,
  );
}

function checkName(name, where) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    fail(`${where} 含非法名字 ${JSON.stringify(name)}（须匹配 ${NAME_RE}）`);
  }
}

/**
 * 读取并校验 manifest。自洽校验：数组内重复、active∩retired∩standalone 重名、
 * 名字合规。IO/形状错误抛单行友好错误（调用方 catch 后 exit 非 0），
 * 禁止裸 SyntaxError 栈。
 */
/** 读取 manifest 文件并校验顶层形状；IO / 语法 / 缺节一律走单行友好错误。 */
function readManifestJson(root) {
  let raw;
  try {
    raw = readFileSync(join(root, ...MANIFEST_PATH_SEGMENTS), "utf8");
  } catch (e) {
    fail(`无法读取文件：${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    fail(`JSON 语法错误：${e.message}`);
  }
  if (typeof json !== "object" || json === null || !Array.isArray(json.active)) {
    fail("缺 active 数组");
  }
  if (!Array.isArray(json.retired)) {
    fail("缺 retired 数组");
  }
  return json;
}

/** active 数组：逐个校验名字合规与重复项，返回名字集供下游互斥校验。 */
function collectActive(active) {
  const seen = new Set();
  for (const name of active) {
    checkName(name, "active");
    if (seen.has(name)) fail(`active 数组重复项：${name}`);
    seen.add(name);
  }
  return seen;
}

/** standalone 数组（可选，缺省空集）：名字合规、自身不重复，且不与 active 重名。 */
function collectStandalone(standalone, seenActive) {
  const seen = new Set();
  for (const name of standalone) {
    checkName(name, "standalone");
    if (seen.has(name)) fail(`standalone 数组重复项：${name}`);
    if (seenActive.has(name)) fail(`${name} 同时出现在 active 与 standalone`);
    seen.add(name);
  }
  return seen;
}

/** retired 数组：名字合规、自身不重复，且不与 active / standalone 重名。 */
function checkRetired(retired, seenActive, seenStandalone) {
  const seen = new Set();
  for (const item of retired) {
    if (typeof item !== "object" || item === null) fail("retired 数组含非对象项");
    checkName(item.name, "retired");
    if (seen.has(item.name)) fail(`retired 数组重复项：${item.name}`);
    seen.add(item.name);
    if (seenActive.has(item.name)) fail(`${item.name} 同时出现在 active 与 retired`);
    if (seenStandalone.has(item.name)) fail(`${item.name} 同时出现在 standalone 与 retired`);
  }
}

/** configSurfaces 的四个面字段（两种形态互斥时逐个检查「不得再带」）。 */
const SURFACE_FACES = ["defaults", "normalizer", "booleanKeys", "countLimits"];

/**
 * 形态 ② `surface: "none"`（显式无配置面）：用于**确实没有用户配置面**的包。必填 reason——
 * 它与「漏登记」在数据上长得一样，理由就是两者的区别；同时禁止再带任何面字段，否则
 * 「无配置面」会被当成省略校验的旁路。
 */
function checkSurfaceNone(item) {
  if (typeof item.reason !== "string" || item.reason.length === 0) {
    fail(`configSurfaces.${item.package} 声明 surface: "none" 时必填 reason（为什么没有配置面）`);
  }
  for (const field of SURFACE_FACES) {
    if (item[field] !== undefined) {
      fail(
        `configSurfaces.${item.package} 声明 surface: "none" 时不得再带 ${field}（两种形态互斥）`,
      );
    }
  }
}

/**
 * 形态 ① 四面对齐全（默认）：defaults（默认值/键集）、normalizer（归一化）、booleanKeys
 * （只接受布尔值的键清单）、countLimits（非负整数键及其上界）。后两者在 #733 重写后一度
 * 未导出、导致这两层约束无法在门禁侧恢复；notifier 侧导出后在此要求必备——没有的包应显式
 * 声明空数组/空对象，而不是省略字段（省略会让门禁静默失去该维度）。
 */
function checkSurfaceFaces(item) {
  for (const field of SURFACE_FACES) {
    const face = item[field];
    if (typeof face !== "object" || face === null)
      fail(`configSurfaces.${item.package}.${field} 缺声明对象`);
    if (typeof face.module !== "string" || face.module.length === 0)
      fail(`configSurfaces.${item.package}.${field}.module 缺失`);
    if (typeof face.export !== "string" || face.export.length === 0)
      fail(`configSurfaces.${item.package}.${field}.export 缺失`);
  }
}

/** 单个 configSurfaces 条目：包名归属、重复登记、两种形态二选一。 */
function checkSurfaceEntry(item, knownPackages, declared) {
  const where = "configSurfaces";
  if (typeof item !== "object" || item === null) fail(`${where} 含非对象项`);
  checkName(item.package, where);
  if (!knownPackages.includes(item.package)) {
    fail(`${where} 声明了不在 active ∪ standalone 的包：${item.package}`);
  }
  if (declared.has(item.package)) fail(`configSurfaces 数组重复登记：${item.package}`);
  declared.add(item.package);
  if (item.surface !== undefined && item.surface !== "none") {
    fail(
      `configSurfaces.${item.package}.surface 取值只能是 "none"（当前 ${JSON.stringify(item.surface)}）`,
    );
  }
  if (item.surface === "none") checkSurfaceNone(item);
  else checkSurfaceFaces(item);
}

export function loadManifest(root) {
  const json = readManifestJson(root);
  // standalone：独立发包、不进聚合包的插件（demo 演进等）；可选，缺省空集。
  const standalone = Array.isArray(json.standalone) ? json.standalone : [];
  const seenActive = collectActive(json.active);
  const seenStandalone = collectStandalone(standalone, seenActive);
  checkRetired(json.retired, seenActive, seenStandalone);
  // configSurfaces（#733 计划项 3.1.1）：配置面 SSOT 的声明处，供 config-matrix 门禁
  // 「运行时取值」而不硬编码包内路径。它必须**恰好覆盖** active ∪ standalone——未登记即红
  // （新包不登记就红）。#774 收口后「尚未接管」的 pending 节已删除：那批包全部转为正式声明，
  // 登记不再有中途态，也就没有第二个入口需要校验。
  const knownPackages = [...seenActive, ...seenStandalone];
  const surfaces = Array.isArray(json.configSurfaces) ? json.configSurfaces : [];
  const declared = new Set();
  for (const item of surfaces) checkSurfaceEntry(item, knownPackages, declared);
  for (const name of knownPackages) {
    if (!declared.has(name)) {
      fail(
        `configSurfaces 缺 ${name} 的配置面声明 —— active ∪ standalone 的每个包都必须登记（未登记即红）`,
      );
    }
  }
  return {
    active: [...seenActive],
    standalone: [...seenStandalone],
    retired: json.retired.map((r) => ({ ...r })),
    configSurfaces: surfaces.map((s) => ({ ...s })),
  };
}

/**
 * 聚合一致性断言集（problems[] 风格对齐 pack-check）。
 * @param {string[]} dirNames       packages/ 实际插件目录集（listPluginDirs 结果）
 * @param {{active: string[], retired: Array<{name: string}>}} manifest
 * @param {Record<string, string>} [aggDeps]     聚合包 package.json dependencies（缺省跳过 deps 段）
 * @param {string[]} [aggPatchIds]               聚合 cordis.patch.yml 的 insert id 集（缺省跳过 patch 段）
 * @param {string[]} [expectedPatchIds]          期望的聚合 insert id 集；缺省回退「ui-<dir>」约定
 * @returns {string[]} 问题列表（空 = 通过）
 */
/**
 * 目录集语义：active（进聚合）∪ standalone（独立发包）都必须真实存在；retired 包目录应删除，
 * 不在此列——残留目录（T1）属清理债：告警不判红，但仍强制「新目录必须登记」守卫（方向 B）。
 */
function checkDirSets(manifest, dirNames) {
  const problems = [];
  const actual = new Set(dirNames);
  const expected = new Set([...manifest.active, ...(manifest.standalone ?? [])]);
  const retiredNames = new Set(manifest.retired.map((r) => r.name));

  // #1 目录集 == active ∪ standalone 集（双向）：新目录必须登记；登记项必须真实存在
  for (const d of [...manifest.active, ...(manifest.standalone ?? [])]) {
    if (!actual.has(d)) {
      const where = manifest.active.includes(d) ? "active" : "standalone";
      problems.push(`manifest.${where} 引用了不存在的目录: ${d} —— 退役请移入 retired 并删除目录`);
    }
  }
  for (const d of dirNames) {
    // T1：#397 退役包残留目录（无 package.json）不再判红——已登记 retired 即属
    // 已知清理债，方向 B 豁免；新插件目录（非 active/standalone/retired 名）仍 fail。
    if (retiredNames.has(d)) {
      console.warn(
        `[plugins-manifest] 警告：packages/ 存在已退役包残留目录 ${d}（manifest.retired 已登记），请清理删除`,
      );
      continue;
    }
    if (!expected.has(d))
      problems.push(
        `packages/ 存在 dsh-* 子包但未登记 manifest: ${d} —— 新插件必须加入 scripts/data/plugins-manifest.json 的 active 或 standalone`,
      );
  }
  return problems;
}

/** 单个「多出」的聚合依赖 → 判词。三类各自的措辞是既有契约（自测按字面锁定），不合并措辞。 */
function extraDepProblem(dep, short, standaloneNames, retiredNames) {
  if (standaloneNames.has(short)) {
    return `deps 多出独立发包 ${dep} —— standalone 插件不进聚合包，请删除该依赖行`;
  }
  if (retiredNames.has(short)) {
    return `deps 多出已退役包 ${dep} —— 请删除该依赖行`;
  }
  return `deps 多出未收录包 ${dep} —— 既不在 active/standalone 也不在 retired，请检查拼写或在 manifest 登记`;
}

/**
 * #2 聚合包 dependencies 键集 == active 映射集（双向；只比键集合不比值——开发态 workspace:*、
 * 发布时 pnpm 替换版本号，存在即认可）。第三方依赖不归本校验管。
 */
function checkAggregateDeps(manifest, aggDeps) {
  const problems = [];
  const own = Object.keys(aggDeps).filter((k) => k.startsWith(NPM_SCOPE));
  const expectedDeps = new Set(manifest.active.map((d) => NPM_SCOPE + d));
  const standaloneNames = new Set(manifest.standalone ?? []);
  const retiredNames = new Set(manifest.retired.map((r) => r.name));
  for (const dep of own) {
    if (expectedDeps.has(dep)) continue;
    problems.push(extraDepProblem(dep, dep.slice(NPM_SCOPE.length), standaloneNames, retiredNames));
  }
  for (const dep of expectedDeps) {
    if (!own.includes(dep))
      problems.push(`deps 缺少 active 插件 ${dep} —— 请补 workspace:* 依赖行`);
  }
  return problems;
}

/**
 * #3 聚合 patch insert id 集 == 期望集（双向）。期望集显式传入时以其为准（pack-check 读各
 * active 子包 patch 的实际 insert id——客户端插件 ui-<dir>、纯宿主插件如 dsh-verify-isolated
 * 用 skill- 前缀）；缺省回退历史「ui-<dir>」约定（防「门禁假设所有插件都有客户端」的过强断言）。
 */
function checkAggregatePatchIds(manifest, aggPatchIds, expectedPatchIds) {
  const problems = [];
  // 重复行检测（Set 去重会吞掉「同 id 多行」漂移，单独比对长度闭合该缺口）
  const dupIds = aggPatchIds.filter((id, i) => aggPatchIds.indexOf(id) !== i);
  if (dupIds.length > 0)
    problems.push(`聚合 patch 存在重复 id 行: ${[...new Set(dupIds)].join(", ")}`);
  const expectedIds = new Set(expectedPatchIds ?? manifest.active.map((d) => `ui-${d}`));
  const actualIds = new Set(aggPatchIds);
  for (const id of expectedIds) {
    if (!actualIds.has(id)) problems.push(`聚合 patch 缺 ${id}（active 在册但无聚合行）`);
  }
  for (const id of aggPatchIds) {
    if (!expectedIds.has(id)) problems.push(`聚合 patch 多出未知 id ${id}`);
  }
  return problems;
}

export function checkAggregateConsistency({
  dirNames,
  manifest,
  aggDeps,
  aggPatchIds,
  expectedPatchIds,
}) {
  return [
    ...checkDirSets(manifest, dirNames),
    ...(aggDeps === undefined ? [] : checkAggregateDeps(manifest, aggDeps)),
    ...(aggPatchIds === undefined
      ? []
      : checkAggregatePatchIds(manifest, aggPatchIds, expectedPatchIds)),
  ];
}
