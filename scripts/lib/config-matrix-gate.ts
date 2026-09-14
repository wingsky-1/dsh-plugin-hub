#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * config-matrix-gate — 配置平行事实源「字段覆盖矩阵」门禁编排（issue #471）。
 *
 * runConfigMatrix({ root }) 对两包真实 src 文件执行全部矩阵断言，返回结构化
 * 结果 { pass, problems: string[], lines: string[] }——不直接 console/exit，
 * 由调用方（contract-check.ts 追加段 / 负向自测）决定输出与退出码；文件树以
 * root 参数化，负向测试可对 mkdtemp 副本注入后复用同一逻辑（副本等效性：
 * 矩阵输入仅 src/config.ts / src/client/index.ts 文本，无 import 解析、
 * 无 lib 产物依赖）。
 *
 * 断言清单（对齐 issue #471 v2 验收 2/3/4/5/6/7）：
 *   L1 lan-proxy：Config / FILE_CONFIG_VALIDATORS / SETTING_FIELD_HINTS 三表
 *      键集全等（双向，现 16）
 *   L2 lan-proxy：client DEFAULTS ⊆ schema；schema − DEFAULTS 差集 == UI 豁免表
 *      （scripts/data/dsh-lan-proxy-ui-exempt.json，门禁不再内嵌条目）；豁免带原因
 *      「文件:行」+ 单包 ≤8（条目数是策略，留代码）；豁免残留（键已 UI 化）亦红
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
import {
  parseTs,
  findTopVar,
  objectKeysOf,
  diffKeys,
  sourceLineOf,
  extractReadmeConfigKeys,
} from "./config-matrix-lib.ts";
import { loadManifest } from "./plugins-manifest-lib.ts";

// lan-proxy 客户端 UI 豁免表（#733 计划项 3.2.2 数据化）：条目（哪些键、为什么）是**事实**，
// 在 scripts/data/dsh-lan-proxy-ui-exempt.json；条目数上限与「超限即红」是**策略**，留在代码里
// ——把上限放进被约束的数据文件等于让被约束方自己改约束。
const UI_EXEMPT_REL = "scripts/data/dsh-lan-proxy-ui-exempt.json";
const UI_EXEMPT_MAX = 8;

/**
 * 读取 UI 豁免表（键 → 原因）。只做**结构**加载：IO / JSON / 数组形态 / 键与原因的存在性 /
 * 重复键。策略检查（≤8、原因含「文件:行」）留给 checkExempts，避免同一判据两处实现。
 * 任何结构错误都转 problem：豁免机制失效不能表现为「没有豁免」——那会把合法差集报成
 * 「漏 UI」，把修复方向指错。
 */
function loadUiExempt(root, problems) {
  const filePath = join(root, UI_EXEMPT_REL);
  let json;
  try {
    json = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    problems.push(
      `lan-proxy UI 豁免表不可读（${UI_EXEMPT_REL}）：${String(e.message).split("\n")[0]}`,
    );
    return {};
  }
  if (!Array.isArray(json.exemptKeys)) {
    problems.push(`lan-proxy UI 豁免表缺 exemptKeys 数组（${UI_EXEMPT_REL}）`);
    return {};
  }
  const out = {};
  for (const item of json.exemptKeys) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof item.key !== "string" ||
      item.key.length === 0
    ) {
      problems.push(`lan-proxy UI 豁免表条目缺 key（${UI_EXEMPT_REL}）`);
      continue;
    }
    if (typeof item.reason !== "string" || item.reason.length === 0) {
      problems.push(`lan-proxy UI 豁免键 ${item.key} 缺 reason（${UI_EXEMPT_REL}）`);
      continue;
    }
    if (out[item.key] !== undefined) {
      problems.push(`lan-proxy UI 豁免表存在重复键：${item.key}`);
      continue;
    }
    out[item.key] = item.reason;
  }
  return out;
}

/** 豁免表结构自检：≤8 键 + 每条原因含「文件:行」+ 一句理由。 */
function checkExempts(pkg, exempt) {
  const problems = [];
  if (Object.keys(exempt).length > UI_EXEMPT_MAX) {
    problems.push(
      `${pkg} 豁免表 ${Object.keys(exempt).length} 键 > ${UI_EXEMPT_MAX}（超限即红，强制走评审）`,
    );
  }
  for (const [k, reason] of Object.entries(exempt)) {
    if (typeof reason !== "string" || reason.length === 0 || !/:\d+/.test(reason)) {
      problems.push(`${pkg} 豁免键 ${k} 缺原因（须含「文件:行 + 一句理由」）`);
    }
  }
  return problems;
}

/** 读取表键（容错返回 err；附带 text/ast/init/line 供下游派生断言）。 */
function loadTable(filePath, name, shape) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    return { err: `文件不可读: ${filePath}（${e.message}）` };
  }
  const line = sourceLineOf(text, name);
  const ast = parseTs(text);
  const init = findTopVar(ast, name);
  if (init === null) {
    return {
      err: `${name} 声明缺失 @ ${filePath}${line ? `:${line}` : ""}（提取器失效或声明被删）`,
    };
  }
  let keys;
  if (shape === "object") {
    keys = objectKeysOf(init);
  } else {
    keys =
      init.type === "ArrayExpression"
        ? init.elements
            .filter((e) => e && e.type === "Literal" && typeof e.value === "string")
            .map((e) => e.value)
        : [];
  }
  if (keys.length === 0) {
    return { err: `${name} 键集为空 @ ${filePath}:${line}（提取器可能失效或表被掏空）` };
  }
  return { text, ast, init, keys, line };
}

/** 差集 → 缺/多键报错行。 */
function diffProblems(scope, tableName, filePath, line, d, hint = "") {
  const out = [];
  for (const k of d.missing)
    out.push(
      `${scope} ${tableName} 缺键（相对基准）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ""}`,
    );
  for (const k of d.extra)
    out.push(
      `${scope} ${tableName} 多键（基准之外）: ${k} @ ${filePath}:${line}${hint ? `（${hint}）` : ""}`,
    );
  return out;
}

/** lan-proxy 矩阵；返回 { problems, lines }。 */
function runLanProxy(root) {
  const problems = [];
  const lines = [];
  const cfgPath = join(root, "packages/dsh-lan-proxy/src/config.ts");
  const clientPath = join(root, "packages/dsh-lan-proxy/src/client/index.ts");

  const schema = loadTable(cfgPath, "Config", "object");
  const validators = loadTable(cfgPath, "FILE_CONFIG_VALIDATORS", "object");
  const hints = loadTable(cfgPath, "SETTING_FIELD_HINTS", "object");
  const defaults = loadTable(clientPath, "DEFAULTS", "object");
  const failed = [schema, validators, hints, defaults].filter((t) => t.err);
  if (failed.length > 0) {
    for (const t of failed) problems.push(t.err);
    return { problems, lines };
  }

  // L1：三表两两全等（16 键）
  const pairs = [
    ["Config", schema, "FILE_CONFIG_VALIDATORS", validators],
    ["Config", schema, "SETTING_FIELD_HINTS", hints],
    ["FILE_CONFIG_VALIDATORS", validators, "SETTING_FIELD_HINTS", hints],
  ];
  for (const [na, ta, nb, tb] of pairs) {
    problems.push(
      ...diffProblems(
        "lan-proxy",
        nb,
        cfgPath,
        tb.line,
        diffKeys(ta.keys, tb.keys),
        `与 ${na} 不一致`,
      ),
    );
    problems.push(
      ...diffProblems(
        "lan-proxy",
        na,
        cfgPath,
        ta.line,
        diffKeys(tb.keys, ta.keys),
        `与 ${nb} 不一致`,
      ),
    );
  }

  // L2：DEFAULTS ⊆ schema；schema − DEFAULTS == 豁免；豁免表结构自检
  const exempt = loadUiExempt(root, problems);
  problems.push(...checkExempts("lan-proxy", exempt));
  const exemptKeys = Object.keys(exempt);
  const d = diffKeys(schema.keys, defaults.keys);
  // DEFAULTS 出现 schema 外键 → 红（客户端提交未知键被宿主白名单静默丢弃）
  for (const k of d.extra)
    problems.push(
      `lan-proxy client DEFAULTS 多键（Config 之外）: ${k} @ ${clientPath}:${defaults.line}`,
    );
  // schema − DEFAULTS 缺键必须恰为豁免集合（新增可编辑键漏 UI → 红）
  for (const k of d.missing) {
    if (!exemptKeys.includes(k))
      problems.push(
        `lan-proxy client DEFAULTS 缺键（相对 Config，非豁免）: ${k} @ ${clientPath}:${defaults.line}（新增可编辑键漏 UI）`,
      );
  }
  // 豁免残留：豁免键出现在客户端 DEFAULTS 中 = 键已 UI 化但白名单未删
  // （注意判据是「∈ DEFAULTS」而非「∉ 差集」——豁免键从 schema 删除时差集自然
  // 不含它，此时不算残留）
  for (const k of exemptKeys) {
    if (defaults.keys.includes(k))
      problems.push(
        `lan-proxy 豁免键 ${k} 已在客户端 DEFAULTS 中（豁免残留，应移除豁免或改豁免原因）`,
      );
  }

  lines.push(
    `lan-proxy ${schema.keys.length} 键 × [schema/validators/hints] 全等 + client DEFAULTS ${defaults.keys.length}(豁免 ${exemptKeys.length})`,
  );

  // 量级 #12：README 配置表键集一致性——代码键缺文档仅 warn 不判红（防文档漂移提示）
  const warnings = [];
  const readmePath = join(root, "packages/dsh-lan-proxy/README.md");
  let readmeText = null;
  try {
    readmeText = readFileSync(readmePath, "utf8");
  } catch {
    readmeText = null;
  }
  if (readmeText !== null) {
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, "lan-proxy");
    for (const k of diffKeys(schema.keys, docKeys).missing) {
      warnings.push(
        `lan-proxy README 配置表缺文档键: ${k}（docs/README 与代码键集不一致，仅提示）`,
      );
    }
  }
  return { problems, warnings, lines };
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
 * configSurfacesPending 上「只登记不断言」。现在对声明面里的**每个**包逐个执行同一套断言——
 * 门禁强度不再取决于包名。
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

  if (!surface) {
    problems.push(
      `${pkg} 未在 scripts/data/plugins-manifest.json 的 configSurfaces 声明配置面（#733 计划项 3.1.1：未登记即红）`,
    );
    return { problems, warnings, lines };
  }

  const defaults = loadSurfaceExport(root, pkg, surface.defaults, "defaults", problems);
  const normalizer = loadSurfaceExport(root, pkg, surface.normalizer, "normalizer", problems);
  if (defaults === undefined || normalizer === undefined) return { problems, warnings, lines };

  const base = Object.keys(defaults);
  if (base.length === 0) {
    problems.push(
      `${pkg} configSurfaces.defaults 的导出键集为空：${surface.defaults.module} → ${surface.defaults.export}`,
    );
    return { problems, warnings, lines };
  }

  let normalized;
  try {
    normalized = normalizer({});
  } catch (e) {
    problems.push(`${pkg} normalizeConfig({}) 执行失败：${String(e.message).split("\n")[0]}`);
    return { problems, warnings, lines };
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

  // N3/N4：布尔键清单与计数上界清单（两张清单的导出由 notifier 侧补齐后恢复执行）
  const booleanKeys = loadSurfaceExport(root, pkg, surface.booleanKeys, "booleanKeys", problems);
  const countLimits = loadSurfaceExport(root, pkg, surface.countLimits, "countLimits", problems);
  if (booleanKeys === undefined || countLimits === undefined) return { problems, warnings, lines };

  const baseSet = new Set(base);
  if (!Array.isArray(booleanKeys)) {
    problems.push(
      `${pkg} configSurfaces.booleanKeys 的导出不是数组（${surface.booleanKeys.export}）`,
    );
  } else {
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

  if (countLimits === null || typeof countLimits !== "object" || Array.isArray(countLimits)) {
    problems.push(
      `${pkg} configSurfaces.countLimits 的导出不是对象（${surface.countLimits.export}）`,
    );
  } else {
    for (const [k, limit] of Object.entries(countLimits)) {
      if (!baseSet.has(k)) {
        problems.push(`${pkg} COUNT_LIMITS 含非配置键: ${k}（不在 DEFAULT_CONFIG 中）`);
        continue;
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
  }

  // 摘要里的计数用安全取值：类型不合法时上面已判红，这里不能再抛（报告要完整）。
  const boolCount = Array.isArray(booleanKeys) ? booleanKeys.length : "?";
  const limitCount =
    countLimits !== null && typeof countLimits === "object" && !Array.isArray(countLimits)
      ? Object.keys(countLimits).length
      : "?";
  lines.push(
    `${pkg} ${base.length} 键 × [defaults → normalizeConfig] 运行时取值全等 + BOOLEAN_KEYS ${boolCount} + COUNT_LIMITS ${limitCount}`,
  );

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
  return { problems, warnings, lines };
}

/**
 * 运行两包矩阵门禁（root 参数化：真实仓库根或 mkdtemp 副本根）。
 * @returns {{ pass: boolean, problems: string[], warnings: string[], lines: string[] }}
 */
export function runConfigMatrix(root) {
  const problems = [];
  const warnings = [];
  const lines = [];
  // 配置面声明来自 manifest（#733 计划项 3.1.1）：读不到/结构不合法即红——
  // 声明是门禁的输入面，它坏掉不能退化成「没有声明就跳过 notifier 段」。
  let surfaces = [];
  let pending = [];
  try {
    const manifest = loadManifest(root);
    surfaces = manifest.configSurfaces ?? [];
    pending = manifest.configSurfacesPending ?? [];
  } catch (e) {
    problems.push(
      `读取 configSurfaces 声明失败（scripts/data/plugins-manifest.json）：${e.message}`,
    );
  }
  // 每个在 configSurfaces 声明的包都跑一遍声明驱动断言（#774：不再只认 notifier）。
  const results = [runLanProxy(root), ...surfaces.map((s) => runSurface(root, s))];
  for (const r of results) {
    problems.push(...r.problems);
    warnings.push(...(r.warnings ?? []));
    lines.push(...r.lines);
  }
  // pending 是**显式待办**（#774 的收口目标是把它们清零），只点名不判红——否则「尚未接管」
  // 与「声明坏了」混成同一个红，收口方向就看不出来了。
  if (pending.length > 0) {
    lines.push(
      `  configSurfacesPending（未接管配置面，${pending.length}）：${pending.map((p) => p.package).join(", ")}`,
    );
  }
  return { pass: problems.length === 0, problems, warnings, lines };
}
