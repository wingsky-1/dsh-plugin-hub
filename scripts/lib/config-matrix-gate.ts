#!/usr/bin/env node
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
 *   L2 lan-proxy：client DEFAULTS ⊆ schema；schema − DEFAULTS 差集 == 带 @not-gui 标记的
 *      豁免集（理由与键共置：标记写在 Config 键自己的相邻注释块内，无外部数据面）+ 单包
 *      ≤8（上限是策略，留代码）；标记缺理由、标记不在任何键的相邻块内、豁免残留（键已
 *      UI 化）亦红
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
  type AstNode,
  type AstProgram,
} from "./config-matrix-lib.ts";
import { loadManifest } from "./plugins-manifest-lib.ts";

// lan-proxy 客户端 UI 豁免：**共置于 Config 键旁的 JSDoc 标记** `@not-gui <理由>`（#875 H10）。
//
// 为什么理由只能共置、不能派生：豁免的不是某种结构特征，是人的判断——targetHost 不给 GUI
// 编辑是开放转发红线，wsDeflatePolicy 是 iOS Safari 启用 permessage-deflate 即失败（#308）。
// 实测四个候选派生判据的干净并集只覆盖 {wsDeflatePolicy, targetPort}，host / targetHost
// 无任何可派生依据，所以理由必须跟着它解释的那个键走。
//
// 旧形态（scripts/data/dsh-lan-proxy-ui-exempt.json + 自报「文件:行」锚点）已删、不留读：
// 行号锚点连续漂移过四轮（重排、#826、f572cca5 展开文件头 import、#856 新键）而形态判据
// 只认 /:\d+/ 看不出来，且同段的符号名从未被机器核验（把 reason 里的符号名改错照样过）。
// 本形态用「标记必须落在该键自己的相邻注释块内」取代自报坐标：坐标不再由人申报，
// 漂移与越界一并消失。
//
// 条目数上限与「超限即红」是**策略**，留在代码里——放进被约束的数据文件等于让被约束方改约束。
const NOT_GUI_RE = /@not-gui\b[ \t]*(.*)$/;
const UI_EXEMPT_MAX = 8;

/** 单张表的加载结果：结构键集 + 源码文本/AST/声明行（豁免派生与后续断言都从这份读）。 */
interface TableLoaded {
  err?: string;
  text?: string;
  ast?: AstProgram;
  init?: AstNode;
  keys?: string[];
  line?: number | null;
}

/** 注释行（JSDoc 首行 / 续行 / 结尾行、斜杠注释行）——相邻块与缩进导出共用这一个词法。 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("/*") || t.startsWith("*") || t.startsWith("//");
}

/** Config 表对象字面量所在行：声明行之后第一条以左花括号收尾的行。0 = 没找到。 */
function configObjectStartLine(lines: string[], declLine: number, spanEnd: number): number {
  for (let n = declLine; n < spanEnd && n <= lines.length; n += 1) {
    if (lines[n - 1].trimEnd().endsWith("{")) return n;
  }
  return 0;
}

/**
 * Config 表**顶层**属性的缩进：由对象字面量里第一条非注释属性行导出。
 *
 * 顶层属性比嵌套属性浅一层，故「同缩进 + 键名 + 冒号」就是顶层判据——嵌套对象里的同名
 * 属性行缩进更深，天然不匹配。旧判据只认「行首缩进 + 键名 + 冒号」不校验层级：把
 * `host: z.string()` 塞进 wsDeflatePolicy 的嵌套对象（零新增顶层键）再把锚点指过去即通过，
 * 当时注释里写的「当前不可达」是错的。
 */
function topLevelIndent(lines: string[], startLine: number, spanEnd: number): string | null {
  for (let n = startLine + 1; n < spanEnd && n <= lines.length; n += 1) {
    const m = /^([ \t]+)\S/.exec(lines[n - 1]);
    if (m && !isCommentLine(lines[n - 1])) return m[1];
  }
  return null;
}

/** 对象字面量的锚点（起始行 + 顶层缩进）；定位不到返回 null，调用方按未标记判红。 */
function configObjectAnchor(
  lines: string[],
  declLine: number,
  spanEnd: number,
): { startLine: number; indent: string } | null {
  if (declLine <= 0) return null;
  const startLine = configObjectStartLine(lines, declLine, spanEnd);
  if (startLine === 0) return null;
  const indent = topLevelIndent(lines, startLine, spanEnd);
  return indent === null ? null : { startLine, indent };
}

/** 该键的顶层定义行（1-based）；0 = 表里没有这一行。 */
function propertyLineOf(
  lines: string[],
  key: string,
  indent: string,
  startLine: number,
  spanEnd: number,
): number {
  const re = new RegExp(`^${indent}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:`);
  for (let n = startLine + 1; n < spanEnd && n <= lines.length; n += 1) {
    if (re.test(lines[n - 1])) return n;
  }
  return 0;
}

/**
 * 键定义行正上方那段**连续注释**（1-based 闭区间）。空行即断链：留了空行就不再算「相邻」，
 * 标记也就不会因为「反正挨着」而被收下。键上方没有注释时返回 null。
 */
function commentBlockAbove(lines: string[], defLine: number): [number, number] | null {
  const to = defLine - 1;
  if (to < 1 || !isCommentLine(lines[to - 1])) return null;
  let from = to;
  while (from - 1 >= 1 && isCommentLine(lines[from - 2])) from -= 1;
  return [from, to];
}

/** 注释块里第一处 @not-gui：行号与理由；没有则 null。理由只取该行余下部分。 */
function markerInBlock(
  lines: string[],
  block: [number, number],
): { line: number; reason: string } | null {
  for (let n = block[0]; n <= block[1]; n += 1) {
    const m = NOT_GUI_RE.exec(lines[n - 1]);
    if (m) return { line: n, reason: m[1].replace(/\*\/\s*$/, "").trim() };
  }
  return null;
}

/** 单键标记裁决：返回该键是否被豁免；块内行号记进 claimed（供反查认领）。 */
function keyMarker(
  lines: string[],
  key: string,
  defLine: number,
  claimed: Set<number>,
  problems: string[],
): boolean {
  const block = commentBlockAbove(lines, defLine);
  if (block === null) return false;
  for (let n = block[0]; n <= block[1]; n += 1) claimed.add(n);
  const marker = markerInBlock(lines, block);
  if (marker === null) return false;
  if (marker.reason.length === 0) {
    problems.push(
      `lan-proxy 配置键 ${key}（Config 第 ${defLine} 行）的 @not-gui 标记没有理由——「为什么不渲染 GUI」必须写出来`,
    );
    return false;
  }
  return true;
}

/**
 * 全文件里没有被任何键的相邻注释块认领的 @not-gui 一律判红：标记必须紧贴它豁免的那个键。
 *
 * 这是旧「:90-190 覆盖整段」假绿的封口。行号锚点能括住任意区间而门禁只查「区间内有一行
 * 命中」，仓内测试甚至祝福过区间写法；共置标记没有坐标可填，挪到别的键的注释里、或挪到
 * Config 表之外（文件头注释、同文件其它声明）都冒充不了豁免。
 */
function strayMarkerProblems(lines: string[], claimed: Set<number>): string[] {
  const out: string[] = [];
  for (let n = 1; n <= lines.length; n += 1) {
    if (NOT_GUI_RE.test(lines[n - 1]) && !claimed.has(n)) {
      out.push(
        `lan-proxy 第 ${n} 行的 @not-gui 标记不属于任何配置键的相邻注释块——标记必须紧贴它豁免的键`,
      );
    }
  }
  return out;
}

interface NotGuiScan {
  keys: string[];
  problems: string[];
}

/** 豁免集从 Config 源码派生：逐键「顶层定义行 → 相邻注释块 → @not-gui」，无外部数据面。 */
function scanNotGui(schema: TableLoaded, spanEnd: number): NotGuiScan {
  const lines = schema.text!.split("\n");
  const problems: string[] = [];
  const keys: string[] = [];
  const claimed = new Set<number>();
  const anchor = configObjectAnchor(lines, schema.line ?? 0, spanEnd);
  if (anchor === null) {
    problems.push(
      `lan-proxy Config 表对象字面量定位失败（声明行 ${schema.line ?? "未知"}）——豁免标记无从归属，按未标记判红`,
    );
    return { keys, problems };
  }
  for (const k of schema.keys!) {
    const defLine = propertyLineOf(lines, k, anchor.indent, anchor.startLine, spanEnd);
    if (defLine === 0) {
      problems.push(`lan-proxy Config 表里找不到键 ${k} 的顶层定义行（提取器与源码不同步）`);
      continue;
    }
    if (keyMarker(lines, k, defLine, claimed, problems)) keys.push(k);
  }
  problems.push(...strayMarkerProblems(lines, claimed));
  if (keys.length > UI_EXEMPT_MAX) {
    problems.push(
      `lan-proxy @not-gui 豁免 ${keys.length} 键 > ${UI_EXEMPT_MAX}（上限是策略，超限即红）`,
    );
  }
  return { keys, problems };
}

/** 读取表键（容错返回 err；附带 text/ast/init/line 供下游派生断言）。 */
function loadTable(filePath: string, name: string, shape: string): TableLoaded {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    return { err: `文件不可读: ${filePath}（${(e as Error).message}）` };
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
        ? init
            .elements!.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
            .map((e) => (e as AstNode).value as string)
        : [];
  }
  if (keys.length === 0) {
    return { err: `${name} 键集为空 @ ${filePath}:${line}（提取器可能失效或表被掏空）` };
  }
  return { text, ast, init, keys, line };
}

/** 差集 → 缺/多键报错行。 */
function diffProblems(
  scope: string,
  tableName: string,
  filePath: string,
  line: number | null | undefined,
  d: { missing: string[]; extra: string[] },
  hint: string = "",
): string[] {
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
function runLanProxy(root: string): { problems: string[]; warnings: string[]; lines: string[] } {
  const problems: string[] = [];
  const lines: string[] = [];
  const cfgPath = join(root, "packages/dsh-lan-proxy/src/server/config/impl/model.ts");
  const clientPath = join(root, "packages/dsh-lan-proxy/src/client/shared/defaults.ts");

  const schema = loadTable(cfgPath, "Config", "object");
  const validators = loadTable(cfgPath, "FILE_CONFIG_VALIDATORS", "object");
  const hints = loadTable(cfgPath, "SETTING_FIELD_HINTS", "object");
  const defaults = loadTable(clientPath, "DEFAULTS", "object");
  const failed = [schema, validators, hints, defaults].filter((t) => t.err);
  if (failed.length > 0) {
    for (const t of failed) problems.push(t.err!);
    return { problems, warnings: [], lines };
  }

  checkLanProxyTableEquality(cfgPath, problems, schema, validators, hints);

  const exemptKeys = checkLanProxyClientDefaults(problems, schema, defaults, clientPath);

  lines.push(
    `lan-proxy ${schema.keys!.length} 键 × [schema/validators/hints] 全等 + client DEFAULTS ${defaults.keys!.length}(豁免 ${exemptKeys.length})`,
  );

  const warnings = collectLanProxyReadmeWarnings(root, schema);
  return { problems, warnings, lines };
}

function checkLanProxyTableEquality(
  cfgPath: string,
  problems: string[],
  schema: TableLoaded,
  validators: TableLoaded,
  hints: TableLoaded,
): void {
  // L1：三表两两全等（19 键，#911 加 tlsCaCertFile）
  const pairs: [string, TableLoaded, string, TableLoaded][] = [
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
        diffKeys(ta.keys!, tb.keys!),
        `与 ${na} 不一致`,
      ),
    );
    problems.push(
      ...diffProblems(
        "lan-proxy",
        na,
        cfgPath,
        ta.line,
        diffKeys(tb.keys!, ta.keys!),
        `与 ${nb} 不一致`,
      ),
    );
  }
}

function checkLanProxyClientDefaults(
  problems: string[],
  schema: TableLoaded,
  defaults: TableLoaded,
  clientPath: string,
): string[] {
  // L2：DEFAULTS ⊆ schema；schema − DEFAULTS == 豁免；豁免集与标记自检（全部从 Config 派生）
  // Config 表跨「export const Config」到校验表声明之前，顶层属性与标记都只在这个区间内认。
  const spanEnd = sourceLineOf(schema.text!, "FILE_CONFIG_VALIDATORS") ?? Number.POSITIVE_INFINITY;
  const scan = scanNotGui(schema, spanEnd);
  problems.push(...scan.problems);
  const exemptKeys = scan.keys;
  const d = diffKeys(schema.keys!, defaults.keys!);
  // DEFAULTS 出现 schema 外键 → 红（客户端提交未知键被宿主白名单静默丢弃）
  for (const k of d.extra)
    problems.push(
      `lan-proxy client DEFAULTS 多键（Config 之外）: ${k} @ ${clientPath}:${defaults.line}`,
    );
  // schema − DEFAULTS 缺键必须恰为带 @not-gui 标记的豁免集合（新增可编辑键漏 UI → 红；
  // 真不给 GUI 编辑的键则因没标记而落在这里，报错行直接指回该写标记的地方）
  for (const k of d.missing) {
    if (!exemptKeys.includes(k))
      problems.push(
        `lan-proxy client DEFAULTS 缺键（相对 Config，非豁免）: ${k} @ ${clientPath}:${defaults.line}（它确实不给 GUI 编辑就在该键相邻注释块内写 @not-gui <理由>）`,
      );
  }
  // 豁免残留：带标记的键出现在客户端 DEFAULTS 中 = 键已 UI 化但标记没删
  // （注意判据是「∈ DEFAULTS」而非「∉ 差集」——键从 Config 删除时差集自然不含它，
  // 此时不算残留）
  for (const k of exemptKeys) {
    if (defaults.keys!.includes(k))
      problems.push(
        `lan-proxy 键 ${k} 标了 @not-gui 却已在客户端 DEFAULTS 中（豁免残留，应删标记或改理由）`,
      );
  }
  return exemptKeys;
}

function collectLanProxyReadmeWarnings(root: string, schema: TableLoaded): string[] {
  // 量级 #12：README 配置表键集一致性——代码键缺文档仅 warn 不判红（防文档漂移提示）
  const warnings: string[] = [];
  const readmePath = join(root, "packages/dsh-lan-proxy/README.md");
  let readmeText: string | null = null;
  try {
    readmeText = readFileSync(readmePath, "utf8");
  } catch {
    readmeText = null;
  }
  if (readmeText !== null) {
    const { keys: docKeys } = extractReadmeConfigKeys(readmeText, "lan-proxy");
    for (const k of diffKeys(schema.keys!, docKeys).missing) {
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
  // 每个在 configSurfaces 声明的包都跑一遍声明驱动断言（#774：不再只认 notifier）。
  const results = [runLanProxy(root), ...surfaces.map((s) => runSurface(root, s))];
  for (const r of results) {
    problems.push(...r.problems);
    warnings.push(...(r.warnings ?? []));
    lines.push(...r.lines);
  }
  return { pass: problems.length === 0, problems, warnings, lines };
}
