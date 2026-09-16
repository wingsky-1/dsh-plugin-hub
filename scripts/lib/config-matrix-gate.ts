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
 * 矩阵输入仅 src/server/config/impl/model.ts / src/client/index.ts 文本，无 import
 * 解析、无 lib 产物依赖）。
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
 * 读取 UI 豁免表（键 → { reason, rationale }）。只做**结构**加载：IO / JSON / 数组形态 /
 * 键与原因的存在性 / 重复键。策略检查（≤8、原因含「文件:行」、锚点指向真身）留给
 * checkExempts，避免同一判据两处实现。
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
    applyExemptEntry(out, item, problems);
  }
  return out;
}

function applyExemptEntry(out, item, problems) {
  if (
    item === null ||
    typeof item !== "object" ||
    typeof item.key !== "string" ||
    item.key.length === 0
  ) {
    problems.push(`lan-proxy UI 豁免表条目缺 key（${UI_EXEMPT_REL}）`);
    return;
  }
  if (typeof item.reason !== "string" || item.reason.length === 0) {
    problems.push(`lan-proxy UI 豁免键 ${item.key} 缺 reason（${UI_EXEMPT_REL}）`);
    return;
  }
  if (out[item.key] !== undefined) {
    problems.push(`lan-proxy UI 豁免表存在重复键：${item.key}`);
    return;
  }
  out[item.key] = {
    reason: item.reason,
    rationale: typeof item.rationale === "string" ? item.rationale : "",
  };
}

/** 豁免表结构自检：≤8 键 + 每条 reason 含「文件:行」+ 锚点必须指向真身（见 exemptAnchorProblems）。 */
function checkExempts(pkg, exempt, schema, cfgPath) {
  const problems = [];
  const keys = Object.keys(exempt);
  if (keys.length > UI_EXEMPT_MAX) {
    problems.push(`${pkg} 豁免表 ${keys.length} 键 > ${UI_EXEMPT_MAX}（超限即红，强制走评审）`);
  }
  // Config 表跨「export const Config」到校验表声明之前，锚点必须落在这个区间内。
  const spanEnd = sourceLineOf(schema.text, "FILE_CONFIG_VALIDATORS") ?? Number.POSITIVE_INFINITY;
  for (const k of keys) {
    const { reason, rationale } = exempt[k];
    if (typeof reason !== "string" || reason.length === 0 || !/:\d+/.test(reason)) {
      problems.push(`${pkg} 豁免键 ${k} 缺原因（须含「文件:行 + 一句理由」）`);
      continue;
    }
    problems.push(...exemptAnchorProblems(pkg, k, reason, rationale, schema, cfgPath, spanEnd));
  }
  return problems;
}

/**
 * 豁免键的「文件:行」锚点必须指向该键在 Config 表里的定义行。
 *
 * 为什么需要机器判据：本包的行号锚点连续漂移过两次——重排前登记 80/96/102/119 而真身在
 * 94/110/116/141；#826 改成 87/103/109/134 之后，f572cca5 展开文件头 import 又把它推到
 * 91/107/113/138。原来的形态判据只认 /:\d+/，漂移只能靠人眼发现，而门禁绿反而会让人
 * 以为锚点是对的。
 *
 * 判据取文本而非 AST：esbuild transform 会重排行号，AST 的 loc 对不上源文件——同
 * sourceLineOf 放弃 AST 的原因。锚点路径允许写成全仓库路径 / 包内相对路径 / 裸文件名
 * （都以 Config 文件路径为后缀，`./` 前缀先归一），引用其它文件的锚点不在本判据的适用面内。
 *
 * 已知边界（当前不可达，如实写明胜过过度声称）：propRe 只认「行首缩进 + 键名 + 冒号」，
 * 不校验它是 Config 的**顶层**属性——若将来某个嵌套对象里出现与顶层豁免键同名的属性行，
 * 锚点指向那一行也会通过。当前 4 个豁免键在 Config 区间内各自只有 1 行匹配（逐键实测）。
 *
 * 路径比较取「以 Config 文件路径为**后缀**」而非相等，是为了同时收下全仓库路径、包内相对
 * 路径与裸文件名三种写法。它不会误收别的文件：被接受者必然是 Config 路径的字符串后缀，因而
 * 在某个祖先目录下解析出的就是同一个文件。实测被判否的写法：not-model.ts / xmodel.ts /
 * del/model.ts / scripts/data/model.ts / ../../etc/model.ts（全部落进「未指向 Config 表所在
 * 文件」）。改文件名或用不构成后缀的路径都躲不开。
 */
function exemptAnchorProblems(pkg, k, reason, rationale, schema, cfgPath, spanEnd) {
  const problems = [];
  const lines = schema.text.split("\n");
  const propRe = new RegExp(`^[ \\t]*${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:`);
  // 锚点形态「<路径>:<行>」；区间写法（`:91-95`）与 `./` 前缀都是人写锚点的自然形态，
  // 判据不该因为写法差异判红——那只会把修复方向指错。
  const anchors = [...`${reason}\n${rationale}`.matchAll(/([\w./-]+\.[A-Za-z]+):(\d+)(?:-(\d+))?/g)]
    .map((m) => ({
      path: m[1].replace(/^\.\//, ""),
      raw: m[0],
      from: Number(m[2]),
      to: m[3] === undefined ? Number(m[2]) : Number(m[3]),
    }))
    .filter((a) => cfgPath.endsWith(a.path));
  if (anchors.length === 0) {
    problems.push(
      `${pkg} 豁免键 ${k} 的锚点未指向 Config 表所在文件（${cfgPath}）：须写成「<路径>:<行>」才可被机器校验`,
    );
    return problems;
  }
  for (const a of anchors) {
    // 区间内**任意**一行命中即算指向正确——区间常把上方注释一起括进来。
    let hit = false;
    for (let line = a.from; line <= a.to && !hit; line += 1) {
      hit = line >= schema.line && line < spanEnd && propRe.test(lines[line - 1] ?? "");
    }
    if (!hit) {
      problems.push(
        `${pkg} 豁免键 ${k} 的锚点 ${a.raw} 指错——区间内没有一行是 Config 里 ${k} 的定义行（Config 表跨 ${schema.line}-${spanEnd - 1} 行）`,
      );
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
  const cfgPath = join(root, "packages/dsh-lan-proxy/src/server/config/impl/model.ts");
  const clientPath = join(root, "packages/dsh-lan-proxy/src/client/shared/defaults.ts");

  const schema = loadTable(cfgPath, "Config", "object");
  const validators = loadTable(cfgPath, "FILE_CONFIG_VALIDATORS", "object");
  const hints = loadTable(cfgPath, "SETTING_FIELD_HINTS", "object");
  const defaults = loadTable(clientPath, "DEFAULTS", "object");
  const failed = [schema, validators, hints, defaults].filter((t) => t.err);
  if (failed.length > 0) {
    for (const t of failed) problems.push(t.err);
    return { problems, lines };
  }

  checkLanProxyTableEquality(cfgPath, problems, schema, validators, hints);

  const exemptKeys = checkLanProxyClientDefaults(
    root,
    problems,
    schema,
    defaults,
    clientPath,
    cfgPath,
  );

  lines.push(
    `lan-proxy ${schema.keys.length} 键 × [schema/validators/hints] 全等 + client DEFAULTS ${defaults.keys.length}(豁免 ${exemptKeys.length})`,
  );

  const warnings = collectLanProxyReadmeWarnings(root, schema);
  return { problems, warnings, lines };
}

function checkLanProxyTableEquality(cfgPath, problems, schema, validators, hints) {
  // L1：三表两两全等（18 键）
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
}

function checkLanProxyClientDefaults(root, problems, schema, defaults, clientPath, cfgPath) {
  // L2：DEFAULTS ⊆ schema；schema − DEFAULTS == 豁免；豁免表结构自检
  const exempt = loadUiExempt(root, problems);
  problems.push(...checkExempts("lan-proxy", exempt, schema, cfgPath));
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
  return exemptKeys;
}

function collectLanProxyReadmeWarnings(root, schema) {
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
  return warnings;
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
  try {
    const manifest = loadManifest(root);
    surfaces = manifest.configSurfaces ?? [];
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
  return { pass: problems.length === 0, problems, warnings, lines };
}
