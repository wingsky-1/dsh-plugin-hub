#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * 配置契约按 manifest 发现真实输入；包特有历史矩阵隔离在兼容适配中。
 * 文件树与可信基准读取分别注入，隔离测试不依赖候选声明充当基准。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { createRequire } from "node:module";
import {
  runLanProxyLegacyMatrix,
  checkLanProxyLegacyObligation,
} from "./lan-proxy-config-contract.ts";
import { join } from "node:path";
import { diffKeys, extractReadmeConfigKeys } from "./config-matrix-lib.ts";
import { loadManifest, compareConfigSurfaceContracts } from "./plugins-manifest-lib.ts";
import { failClosed } from "./gate-exit.mjs";

function matrixRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 按 configSurfaces 声明加载一个配置面并取真实导出值。任何失败都转成 problem 并返回
 * undefined（fail-closed）。require 锚点放在 root 内，使各包 package.json 的 type 字段
 * 参与解析（各包是 type: module，走 Node 的 require(esm)＋原生类型剥离，
 * 故这里能同步拿到 .ts 模块的导出）。同一 root 只加载一次；负例测试每次用新的 mkdtemp
 * 路径，ESM loader 缓存不串味。
 */
function loadSurfaceExport(root, pkg, face, label, problems) {
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
      `${pkg} configSurfaces.${label} 模块加载失败: ${face.module}（${String(e.message).split("\n")[0]}）`,
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
function runSurface(root, surface) {
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
  const problems = [];
  const warnings = [];
  const lines = [];

  if (surface.matrix && surface.package !== "dsh-lan-proxy") {
    return { problems: [surface.package + " 尚未登记包级 matrix 适配器"], lines: [], warnings: [] };
  }
  if (surface.matrix) {
    const matrix = runLanProxyLegacyMatrix(root, surface, loadSurfaceExport);
    problems.push(...matrix.problems);
    lines.push(...matrix.lines);
  }
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
function loadSurfacePair(root, pkg, surface, problems) {
  const defaults = loadSurfaceExport(root, pkg, surface.defaults, "defaults", problems);
  const normalizer = loadSurfaceExport(root, pkg, surface.normalizer, "normalizer", problems);
  if (defaults === undefined || normalizer === undefined) return null;
  return { defaults, normalizer };
}

function checkSurfaceNormalization(pkg, surface, defaults, normalizer, problems) {
  if (!matrixRecord(defaults) || typeof normalizer !== "function") {
    problems.push(pkg + " defaults 必须是非数组对象且 normalizer 必须是函数");
    return null;
  }
  const base = Object.keys(defaults);
  if (base.length === 0) {
    problems.push(
      `${pkg} configSurfaces.defaults 的导出键集为空：${surface.defaults.module} → ${surface.defaults.export}`,
    );
    return null;
  }

  let normalized;
  try {
    normalized = normalizer({});
  } catch (e) {
    problems.push(`${pkg} normalizeConfig({}) 执行失败：${String(e.message).split("\n")[0]}`);
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

function checkSurfaceKeyLists(root, pkg, surface, defaults, base, problems) {
  // N3/N4：布尔键清单与计数上界清单（两张清单的导出由 notifier 侧补齐后恢复执行）
  const booleanKeys = loadSurfaceExport(root, pkg, surface.booleanKeys, "booleanKeys", problems);
  const countLimits = loadSurfaceExport(root, pkg, surface.countLimits, "countLimits", problems);
  if (booleanKeys === undefined || countLimits === undefined) return null;

  const baseSet = new Set(base);
  checkBooleanKeys(pkg, surface, defaults, baseSet, booleanKeys, problems);
  checkCountLimits(pkg, surface, defaults, baseSet, countLimits, problems);
  return { booleanKeys, countLimits };
}

function checkBooleanKeys(pkg, surface, defaults, baseSet, booleanKeys, problems) {
  if (!Array.isArray(booleanKeys)) {
    problems.push(
      `${pkg} configSurfaces.booleanKeys 的导出不是数组（${surface.booleanKeys.export}）`,
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

function checkCountLimits(pkg, surface, defaults, baseSet, countLimits, problems) {
  if (countLimits === null || typeof countLimits !== "object" || Array.isArray(countLimits)) {
    problems.push(
      `${pkg} configSurfaces.countLimits 的导出不是对象（${surface.countLimits.export}）`,
    );
    return;
  }
  for (const [k, limit] of Object.entries(countLimits)) {
    checkCountLimitEntry(pkg, defaults, baseSet, k, limit, problems);
  }
}

function checkCountLimitEntry(pkg, defaults, baseSet, k, limit, problems) {
  if (!baseSet.has(k)) {
    problems.push(`${pkg} COUNT_LIMITS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`);
    return;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    problems.push(`${pkg} COUNT_LIMITS.${k} 的上界不是非负整数: ${JSON.stringify(limit)}`);
  }
  const fallback = defaults[k];
  if (!Number.isInteger(fallback) || fallback < 0) {
    problems.push(
      `${pkg} COUNT_LIMITS 覆盖的键 ${k} 在 DEFAULT_CONFIG 里不是非负整数: ${JSON.stringify(fallback)}`,
    );
  } else if (Number.isInteger(limit) && fallback > limit) {
    problems.push(
      `${pkg} DEFAULT_CONFIG.${k} = ${fallback} 超过 COUNT_LIMITS.${k} 上界 ${limit}（默认值本身越界）`,
    );
  }
}

function formatSurfaceSummaryLine(pkg, base, booleanKeys, countLimits) {
  // 摘要里的计数用安全取值：类型不合法时上面已判红，这里不能再抛（报告要完整）。
  const boolCount = Array.isArray(booleanKeys) ? booleanKeys.length : "?";
  const limitCount =
    countLimits !== null && typeof countLimits === "object" && !Array.isArray(countLimits)
      ? Object.keys(countLimits).length
      : "?";
  return `${pkg} ${base.length} 键 × [defaults → normalizeConfig] 运行时取值全等 + BOOLEAN_KEYS ${boolCount} + COUNT_LIMITS ${limitCount}`;
}

function collectSurfaceReadmeWarnings(root, pkg, base, warnings) {
  // 量级 #12：README JSON 样例键集一致性——代码键缺文档仅 warn 不判红
  const readmePath = join(root, `packages/${pkg}/README.md`);
  let readmeText = null;
  try {
    readmeText = readFileSync(readmePath, "utf8");
  } catch {
    readmeText = null;
  }
  if (readmeText !== null) {
    // 第二个参数是**短名**（extractReadmeConfigKeys 按它选解析分支：lan-proxy 走表格、
    // 其余走 JSON 样例）；README 路径用完整包名，两者不是同一个口径。
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, pkg.replace(/^dsh-/, ""));
    for (const k of diffKeys(base, docKeys).missing) {
      warnings.push(
        `${pkg} README JSON 样例缺文档键: ${k}（docs/README 与代码键集不一致，仅提示）`,
      );
    }
  }
}

/** 生产读取器不能把缺失或损坏的可信基准当成候选违规；测试通过独立 reader 注入夹具。 */
export function readConfigSurfaceBaseline(root) {
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    const sha = execFileSync(
      "git",
      ["rev-parse", "--verify", "origin/main^{commit}"],
      options,
    ).trim();
    const base = JSON.parse(
      execFileSync("git", ["show", sha + ":scripts/data/plugins-manifest.json"], options),
    );
    compareConfigSurfaceContracts(base, base);
    return base;
  } catch (error) {
    failClosed("config-matrix 基准不可用：" + error.message);
  }
}

export function runConfigMatrix(root, { readBaseline = readConfigSurfaceBaseline } = {}) {
  const problems = [];
  const warnings = [];
  const lines = [];
  // 配置面声明来自 manifest（#733 计划项 3.1.1）：读不到/结构不合法即红——
  // 声明是门禁的输入面，它坏掉不能退化成「没有声明就跳过 notifier 段」。
  let surfaces = [];
  try {
    const manifest = loadManifest(root);
    checkLanProxyLegacyObligation(manifest);
    problems.push(...compareConfigSurfaceContracts(readBaseline(root), manifest));
    surfaces = manifest.configSurfaces;
  } catch (e) {
    problems.push(
      `读取 configSurfaces 声明失败（scripts/data/plugins-manifest.json）：${e.message}`,
    );
  }
  // 每个在 configSurfaces 声明的包都跑一遍声明驱动断言（#774：不再只认 notifier）。
  const results = surfaces.map((s) => runSurface(root, s));
  for (const r of results) {
    problems.push(...r.problems);
    warnings.push(...(r.warnings ?? []));
    lines.push(...r.lines);
  }
  return { pass: problems.length === 0, problems, warnings, lines };
}
