#!/usr/bin/env node
"use strict";

/**
 * config-matrix-gate — 配置平行事实源「字段覆盖矩阵」门禁编排（issue #471）。
 *
 * runConfigMatrix({ root }) 对 configSurfaces 声明驱动的各包真实 src 文件执行全部矩阵断言，
 * 返回结构化结果 { pass, problems: string[], lines: string[] }——不直接 console/exit，
 * 由调用方（contract-check.ts 追加段 / 负向自测）决定输出与退出码；文件树以
 * root 参数化，负向测试可对 mkdtemp 副本注入后复用同一逻辑（副本等效性：
 * 矩阵输入仅声明指向的配置域源码文本，无 import 解析、无 lib 产物依赖）。
 *
 * #1159 起 lan-proxy 退役删包，其 L1/L2 硬编码矩阵（Config 三表全等 + client DEFAULTS
 * 与 @not-gui 豁免共置）连同派生代码一并移除；@not-gui 共置形态的设计理由见
 * scripts/data/plugins-manifest.json 的 retired 条目与 git 历史，此处不再保留第二份。
 *
 * 断言清单（对齐 issue #471 v2 验收 2/3/4/5/6/7）：
 *   N1 notifier：configSurfaces 声明的 defaults 导出必须是非空对象（声明驱动，取代旧
 *      硬编码路径 src/config/{config,validators,normalize}.ts——#733 配置域搬到
 *      src/server/config/impl/** 后那三条路径全部 ENOENT，路径硬编码本身就是红因）
 *   N2 notifier：normalizeConfig({}) 的键集**双向等于** DEFAULT_CONFIG 键集
 *      （丢键 / 凭空造键都红）——本包当前唯一有实质约束力的行为断言
 *   N3 notifier：BOOLEAN_KEYS ⊆ 配置键，且默认值确是布尔（客户端 UI 按布尔键渲染开关）
 *   N4 notifier：COUNT_LIMITS ⊆ 配置键、上界是非负整数，且默认值不越界（上界必须真的箍住默认值）
 *   N5 notifier：README 配置表缺键仅 warn（量级 #12，不判红）
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { diffKeys, extractReadmeConfigKeys } from "./config-matrix-lib.ts";
import { loadManifest } from "./plugins-manifest-lib.ts";

/**
 * 按 configSurfaces 声明加载一个配置面并取真实导出值。任何失败都转成 problem 并返回
 * undefined（fail-closed）。require 锚点放在 root 内，使各包 package.json 的 type 字段
 * 参与解析（各包是 type: module，走 Node 的 require(esm)＋原生类型剥离，
 * 故这里能同步拿到 .ts 模块的导出）。同一 root 只加载一次；负例测试每次用新的 mkdtemp
 * 路径，ESM loader 缓存不串味。
 */
interface SurfaceFace {
  module: string;
  export: string;
}
interface SurfaceDecl {
  package: string;
  surface?: string;
  reason?: string;
  defaults?: SurfaceFace;
  normalizer?: SurfaceFace;
  booleanKeys?: SurfaceFace;
  countLimits?: SurfaceFace;
}
function loadSurfaceExport(
  root: string,
  pkg: string,
  face: SurfaceFace | undefined,
  label: string,
  problems: string[],
): unknown {
  if (typeof face?.module !== "string" || typeof face.export !== "string") {
    problems.push(`${pkg} configSurfaces.${label} 声明结构不合法（须含 module/export 字符串）`);
    return undefined;
  }
  try {
    const req = createRequire(join(root, "scripts", "data", "plugins-manifest.json"));
    const mod = req(join(root, face.module));
    if (mod === null || mod === undefined || mod[face.export] === undefined) {
      problems.push(
        `${pkg} configSurfaces.${label} 声明的导出不存在: ${face.module} → ${face.export}`,
      );
      return undefined;
    }
    return mod[face.export];
  } catch (e) {
    problems.push(
      `${pkg} configSurfaces.${label} 模块加载失败: ${face.module}（${String((e as Error).message).split("\n")[0]}）`,
    );
    return undefined;
  }
}

/**
 * 配置矩阵：**声明驱动 + 运行时取值**（#733 计划项 3.1.1；#774 起对 configSurfaces 的全部包生效）。
 *
 * 旧实现在这里硬编码三条包内路径并从源码文本抠字面量；#733 把配置域搬到
 * src/server/config/impl/** 之后那三条路径全部 ENOENT，门禁以「文件不可读」判红——
 * 路径硬编码本身就是这次红因。现改为从 plugins-manifest.json 的 configSurfaces 取模块
 * specifier、加载模块取真实导出值：键集从运行时派生，包内结构再调整也不必改门禁。
 *
 * #774 之前本函数只被 dsh-notifier 调用（`surfaces.find(...)` 硬编码包名），其余 5 包停在
 * 一份「只登记不断言」的 pending 清单上。收口后 pending 节与它的点名输出一并删除，声明成为
 * 唯一入口——门禁强度不再取决于包名，也不再有「登记了但没接管」的中途态。
 *
 * 断言集随事实源重建（旧 N1/N2/N3 的输入在新树上已不存在，不是「放宽」而是重建）：
 *   N1 声明的 defaults 导出必须是非空对象；
 *   N2 normalizeConfig({}) 的键集双向等于 DEFAULT_CONFIG 键集（丢键 / 凭空造键都红）；
 *   N5 README 配置表缺键仅 warn（量级 #12，保留）。
 *
 * N3 BOOLEAN_KEYS 的每个键都是真实配置键，且其在 DEFAULT_CONFIG 中的默认值是布尔
 *    （反向不成立：browserSound / systemSound 的默认值也是 true，但类型是
 *    boolean | SoundId，不属于「只接受布尔值」，故不做双向断言）；
 * N4 COUNT_LIMITS 的每个键都是真实配置键、上界是非负整数，且 DEFAULT_CONFIG 的默认值
 *    不超过该上界。
 * 这两层约束在 #733 重写后一度无法执行（那两个清单当时未导出，曾在门禁注释里如实登记为
 * 缺口）；notifier 侧导出后由声明驱动恢复，缺口随之关闭。
 */
function runSurface(
  root: string,
  surface: SurfaceDecl,
): { problems: string[]; warnings: string[]; lines: string[] } {
  const pkg = surface.package;
  // 「无配置面」是显式声明（#774）：跳过 N1–N4 但必须回显理由——否则它与「漏登记」在输出里
  // 无从区分，读者只能去翻 manifest。
  if (surface.surface === "none") {
    return {
      problems: [],
      warnings: [],
      lines: [`  ${pkg} 无用户配置面（surface: none）：${surface.reason}`],
    };
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];

  const loaded = loadSurfacePair(root, pkg, surface, problems);
  if (loaded === null) return { problems, warnings, lines };
  const { defaults, normalizer } = loaded;

  const base = checkSurfaceNormalization(pkg, surface, defaults, normalizer, problems);
  if (base === null) return { problems, warnings, lines };

  const lists = checkSurfaceKeyLists(root, pkg, surface, defaults, base, problems);
  if (lists === null) return { problems, warnings, lines };

  lines.push(formatSurfaceSummaryLine(pkg, base, lists.booleanKeys, lists.countLimits));
  collectSurfaceReadmeWarnings(root, pkg, base, warnings);
  return { problems, warnings, lines };
}

// N1 的前置：两个导出同属一个配置面，缺任一都无法做键集对照，整段作废（problems 已逐条记下）。
function loadSurfacePair(
  root: string,
  pkg: string,
  surface: SurfaceDecl,
  problems: string[],
): {
  defaults: Record<string, unknown>;
  normalizer: (arg: Record<string, unknown>) => Record<string, unknown>;
} | null {
  const defaults = loadSurfaceExport(root, pkg, surface.defaults, "defaults", problems);
  const normalizer = loadSurfaceExport(root, pkg, surface.normalizer, "normalizer", problems);
  if (defaults === undefined || normalizer === undefined) return null;
  return {
    defaults: defaults as Record<string, unknown>,
    normalizer: normalizer as (arg: Record<string, unknown>) => Record<string, unknown>,
  };
}

function checkSurfaceNormalization(
  pkg: string,
  surface: SurfaceDecl,
  defaults: Record<string, unknown>,
  normalizer: (arg: Record<string, unknown>) => Record<string, unknown>,
  problems: string[],
): string[] | null {
  const base = Object.keys(defaults);
  if (base.length === 0) {
    problems.push(
      `${pkg} configSurfaces.defaults 的导出键集为空：${surface.defaults!.module} → ${surface.defaults!.export}`,
    );
    return null;
  }

  let normalized: Record<string, unknown> | undefined;
  try {
    normalized = normalizer({});
  } catch (e) {
    problems.push(
      `${pkg} normalizeConfig({}) 执行失败：${String((e as Error).message).split("\n")[0]}`,
    );
    return null;
  }
  const d2 = diffKeys(base, Object.keys(normalized ?? {}));
  for (const k of d2.missing) {
    problems.push(
      `${pkg} normalizeConfig 丢键: ${k}（DEFAULT_CONFIG 有该键，normalizeConfig({}) 结果里没有）`,
    );
  }
  for (const k of d2.extra) {
    problems.push(`${pkg} normalizeConfig 多键: ${k}（不在 DEFAULT_CONFIG 中——归一化凭空造键）`);
  }
  return base;
}

function checkSurfaceKeyLists(
  root: string,
  pkg: string,
  surface: SurfaceDecl,
  defaults: Record<string, unknown>,
  base: string[],
  problems: string[],
): { booleanKeys: unknown; countLimits: unknown } | null {
  // N3/N4：布尔键清单与计数上界清单（两张清单的导出由 notifier 侧补齐后恢复执行）
  const booleanKeys = loadSurfaceExport(root, pkg, surface.booleanKeys, "booleanKeys", problems);
  const countLimits = loadSurfaceExport(root, pkg, surface.countLimits, "countLimits", problems);
  if (booleanKeys === undefined || countLimits === undefined) return null;

  const baseSet = new Set(base);
  checkBooleanKeys(pkg, surface, defaults, baseSet, booleanKeys, problems);
  checkCountLimits(pkg, surface, defaults, baseSet, countLimits, problems);
  return { booleanKeys, countLimits };
}

function checkBooleanKeys(
  pkg: string,
  surface: SurfaceDecl,
  defaults: Record<string, unknown>,
  baseSet: Set<string>,
  booleanKeys: unknown,
  problems: string[],
): void {
  if (!Array.isArray(booleanKeys)) {
    problems.push(
      `${pkg} configSurfaces.booleanKeys 的导出不是数组（${surface.booleanKeys!.export}）`,
    );
    return;
  }
  for (const k of booleanKeys) {
    if (!baseSet.has(k)) {
      problems.push(`${pkg} BOOLEAN_KEYS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`);
    } else if (typeof defaults[k] !== "boolean") {
      problems.push(
        `${pkg} BOOLEAN_KEYS 含非布尔键: ${k}（DEFAULT_CONFIG 里的默认值是 ${typeof defaults[k]}）`,
      );
    }
  }
}

function checkCountLimits(
  pkg: string,
  surface: SurfaceDecl,
  defaults: Record<string, unknown>,
  baseSet: Set<string>,
  countLimits: unknown,
  problems: string[],
): void {
  if (countLimits === null || typeof countLimits !== "object" || Array.isArray(countLimits)) {
    problems.push(
      `${pkg} configSurfaces.countLimits 的导出不是对象（${surface.countLimits!.export}）`,
    );
    return;
  }
  for (const [k, limit] of Object.entries(countLimits)) {
    checkCountLimitEntry(pkg, defaults, baseSet, k, limit, problems);
  }
}

function checkCountLimitEntry(
  pkg: string,
  defaults: Record<string, unknown>,
  baseSet: Set<string>,
  k: string,
  limit: unknown,
  problems: string[],
): void {
  if (!baseSet.has(k)) {
    problems.push(`${pkg} COUNT_LIMITS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`);
    return;
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || (limit as number) < 0) {
    problems.push(`${pkg} COUNT_LIMITS.${k} 的上界不是非负整数: ${JSON.stringify(limit)}`);
  }
  const fallback: unknown = defaults[k];
  if (typeof fallback !== "number" || !Number.isInteger(fallback) || (fallback as number) < 0) {
    problems.push(
      `${pkg} COUNT_LIMITS 覆盖的键 ${k} 在 DEFAULT_CONFIG 里不是非负整数: ${JSON.stringify(fallback)}`,
    );
  } else if (Number.isInteger(limit) && (fallback as number) > (limit as number)) {
    problems.push(
      `${pkg} DEFAULT_CONFIG.${k} = ${fallback} 超过 COUNT_LIMITS.${k} 上界 ${limit}（默认值本身越界）`,
    );
  }
}

function formatSurfaceSummaryLine(
  pkg: string,
  base: string[],
  booleanKeys: unknown,
  countLimits: unknown,
): string {
  // 摘要里的计数用安全取值：类型不合法时上面已判红，这里不能再抛（报告要完整）。
  const boolCount = Array.isArray(booleanKeys) ? booleanKeys.length : "?";
  const limitCount =
    countLimits !== null && typeof countLimits === "object" && !Array.isArray(countLimits)
      ? Object.keys(countLimits).length
      : "?";
  return `${pkg} ${base.length} 键 × [defaults → normalizeConfig] 运行时取值全等 + BOOLEAN_KEYS ${boolCount} + COUNT_LIMITS ${limitCount}`;
}

function collectSurfaceReadmeWarnings(
  root: string,
  pkg: string,
  base: string[],
  warnings: string[],
): void {
  // 量级 #12：README JSON 样例键集一致性——代码键缺文档仅 warn 不判红
  const readmePath = join(root, `packages/${pkg}/README.md`);
  let readmeText = null;
  try {
    readmeText = readFileSync(readmePath, "utf8");
  } catch {
    readmeText = null;
  }
  if (readmeText !== null) {
    // 第二个参数是**短名**（extractReadmeConfigKeys 按它选解析分支；README 路径用完整
    // 包名，两者不是同一个口径）。
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, pkg.replace(/^dsh-/, ""));
    for (const k of diffKeys(base, docKeys).missing) {
      warnings.push(
        `${pkg} README JSON 样例缺文档键: ${k}（docs/README 与代码键集不一致，仅提示）`,
      );
    }
  }
}

/**
 * 运行两包矩阵门禁（root 参数化：真实仓库根或 mkdtemp 副本根）。
 * @returns {{ pass: boolean, problems: string[], warnings: string[], lines: string[] }}
 */
export function runConfigMatrix(root: string): {
  pass: boolean;
  problems: string[];
  warnings: string[];
  lines: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  // 配置面声明来自 manifest（#733 计划项 3.1.1）：读不到/结构不合法即红——
  // 声明是门禁的输入面，它坏掉不能退化成「没有声明就跳过 notifier 段」。
  let surfaces: SurfaceDecl[] = [];
  try {
    const manifest = loadManifest(root);
    surfaces = (manifest.configSurfaces ?? []) as unknown as SurfaceDecl[];
  } catch (e) {
    problems.push(
      `读取 configSurfaces 声明失败（scripts/data/plugins-manifest.json）：${(e as Error).message}`,
    );
  }
  // 每个在 configSurfaces 声明的包都跑一遍声明驱动断言（#774：不再只认 notifier；
  // #1159 起 lan-proxy 退役删包，其硬编码矩阵段随之移除）。
  const results = surfaces.map((s) => runSurface(root, s));
  for (const r of results) {
    problems.push(...r.problems);
    warnings.push(...(r.warnings ?? []));
    lines.push(...r.lines);
  }
  return { pass: problems.length === 0, problems, warnings, lines };
}
