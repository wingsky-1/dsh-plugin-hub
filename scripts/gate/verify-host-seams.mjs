#!/usr/bin/env node
"use strict";
/**
 * verify-host-seams — 宿主接缝结构门禁（R1-R4，四函数一次遍历）。
 *
 * 背景：docs/host-contract.md 登记的四类宿主契约面（事件 / 路由与方法 / slot /
 * 复刻常量）在源码里以四种接缝形态出现。host-contract.mjs 派生器是只读观察
 * （不接门禁），本闸是结构侧的收敛判据：路由字面量只许落在允许文件、调用侧只许
 * 经具名表、事件与 slot 只许出现在装配点、多文件同值必须呈镜像对。
 *
 * 范围：各包 src 存在即扫（存在性即扫描面，不读 gate-scope-registry——
 * 范围是治理数据的惯例在此不适用：接缝面天然等于全部包的 src；禁 --package
 * （按包切分会让跨包镜像对在切片下恒绿，见 --package 判红用例）。扫描文件为
 * .ts\/.tsx\/.mts\/.cts，排除 *.d.ts 与 *.test.*（测试引用不构成插件实际使用，
 * 与 verify-shared-fanin 同口径）；css\/md\/docs 不在扫描扩展名内故天然排除。
 *
 * 管线：esbuild 剥类型 → acorn locations 解析 → node:module SourceMap 回映原文行。
 * 禁纯 grep 裸判：注释里的同形文本（如 provider server\/shared\/trend.ts 的
 * ctx.on 口径注释、mcp index.ts 的事件注释、notifier locales 的 GET 句子）不是
 * 代码事实，文本扫描会误报；拼接形态（+ \/ 模板 \/ ?? \/ join）更只有 AST 可见。
 * 四个规则函数共享一次 AST 遍历（analyzeAst），不做四遍扫描。
 *
 * R1（宿主事件）：CallExpression 且 callee 为 Member 且静态属性名精确等于 on
 * （仅 .on，emit\/once\/ waterfall 等不在本面；receiver 不限名——worktree-sidebar
 * 经 bindAgents 转发、notifier 经解构，卡接收者名即误报）。args[0] 为静态串且含 \/
 * 时为候选事件：只许 src\/index.ts ｜ src\/apply\/** ｜ src\/server\/**（允许优先，
 * 先判允许再判禁）；禁两类——src 根 shared 段锚定（路径切分 [packages,*,src,shared]
 * 方命中，server\/shared 不算：它是域内共享实现，不是根共享层）与 client\/**
 * 出现即红；其余位置默认红。首参非静态（标识符 \/ 模板带表达式 \/ 成员访问，如
 * worktree-sidebar src\/index.ts:63 透传）不判红，只进观察计数。
 *
 * R2（路由字面量，三层）：
 *   L 定义层——值 startsWith(\/api\/dsh-) 的静态串，只许 shared\/** ｜ client\/shared\/** ｜
 *     client\/index.{ts,tsx} ｜ apply\/** ｜ basename routes*.ts ｜ basename contract*.ts ｜
 *     server\/api\/**（basename 锚定：routes\/contract 只看文件名，不看目录——域内
 *     重排不改判据；句中包含（如 locales 的 GET 句子、tools 描述）因不以 \/api\/dsh-
 *     开头而自然过，不在定义层）。
 *   C 消费层——任一调用实参为静态串且 includes 该串，不分文件一律红（须经具名表
 *     import：直写 fetch(\/api\/...) 者绕过镜像对，404 静默）。模板带表达式不算静态，
 *     故 `${URL}?x=` 类组装不误报。
 *   B 拼接层——允许集之外，含片段的 + 运算 \/ 带表达式模板 \/ ?? 右操作数 \/ || \/
 *     join\/concat 含片段即红；?? 右为纯标识符时净（注入表转发形态，如
 *     injected(key, FALLBACK) 的右操作数是标识符，不展开）。允许集内不判（契约文件
 *     内的 ?? 回退即定义本身）。
 *   同站去重——同一文件同行同值同时命中 L 与 B 时只报更具体的 R2-B（见 isR2LDeduped；
 *     无值形态按行去重，一行多字面量的极小过收敛可接受：行号只定判词 site）。
 *
 * R3（slot 装配点）：*.inject\/*.register（receiver 不限名——notifier 经 slotHost 别名）
 * 首参为静态串且 startsWith(settings.)，或首参为对象字面量且其 name 属性为静态串
 * 且 startsWith(settings.)（register 取选项对象形态）时，仅许 client\/index.{ts,tsx}，
 * 余红。首参非静态（如 worktree takeover 的 BODY_SLOT 标识符）不计数。
 *
 * R4（复刻值分组，any-depth N1-N7 + (包,值) 分组）：定义形静态串（值 startsWith(\/)
 * 且无空白字符——T6 句中 GET 含空格故不收；T5 application\/json 不以 \/ 开头故不收；
 * T7 空串不收）按 (包,值) 分组，持有人去重到文件：>2 红；==2 须一端含 \/client\/
 * （镜像对：服务端定义 + 客户端镜像，任一端缺席即两端可各自漂移）；==1 过。同包同名
 * export const 在 >2 文件出现即红（具名表被复制三份即失去单一事实源）。any-depth
 * 收集覆盖 N1 初值（变量初值，含 ?? 右操作数 T2 收 C）\/ N2 三元（T1 cond 收 A 与 B）\/
 * N3 对象属性（T3 register([{path}]) 收 D）\/ N4 数组 \/ N5 return（T4 收 E）\/
 * N6 类属性与参数默认 \/ N7 JSX 属性——实现上即全 AST 字面量遍历（除 C 层调用实参另判），
 * T1-T7 由自测向量逐条锁定。非 \/api\/dsh- 开头的值（如上游 \/api\/remote.mux）只进
 * --observe 分组表（triple 等 disposition），不判红：它们的上游归属不在本包，阈值
 * 不由本闸定。
 *
 * 出口：fail-closed 一律经 lib\/gate-exit.mjs 的 failClosed，唯二两处——
 *   (1) CLI\/范围结构错误（--package 出现、--root 不可读、无 src 包、零扫描文件）；
 *   (2) AST 管线失败（任一文件 transform\/parse 异常，fail-closed 不读成通过）。
 * sourcemap 单点回映缺失不属上列：行号只定判词 site，不定红绿（命中与否只看 AST），
 * 故 best-effort 回退生成行，不计数、不 fail-closed。
 * 判据违例 exit 1（process.exit，非 gate-exit 口径）；通过 exit 0。--observe 只打印
 * 分组表（含 lan \/api\/remote.mux triple、?? 回退组、provider 镜像对的 disposition），
 * 结构错误与管线失败之外恒 exit 0。
 *
 * 用法：node scripts\/gate\/verify-host-seams.mjs [--root <dir>] [--observe]
 * 退出码：0 通过（--observe 下为观察成功）；1 判据违例；2 门禁故障（failClosed）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";
import { failClosed } from "../lib/gate-exit.mjs";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_PREFIX = "/api/dsh-";

function toPosix(p) {
  return p.split("\\").join("/");
}

function relPosix(root, abs) {
  return toPosix(relative(root, abs));
}

function pkgOf(rel) {
  const parts = rel.split("/");
  return parts[0] === "packages" ? (parts[1] ?? "") : "";
}

/** R1 允许位：src\/index.ts ｜ src\/apply\/** ｜ src\/server\/**（允许优先）。 */
export function isR1Allowed(rel) {
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(rel)) return true;
  if (rel.includes("/src/apply/")) return true;
  if (rel.includes("/src/server/")) return true;
  return false;
}

/** R1 src 根 shared 段锚定：[packages,*,src,shared] 方命中（server\/shared 不算）。 */
export function isSrcRootShared(rel) {
  const parts = rel.split("/");
  return parts[0] === "packages" && parts[2] === "src" && parts[3] === "shared";
}

/** R2 定义层允许集（文件级）：shared \/ client\/index \/ apply \/ routes* \/ contract* \/ server\/api。 */
export function isR2Allowed(rel) {
  if (rel.includes("/shared/")) return true;
  if (/(^|\/)client\/index\.tsx?$/.test(rel)) return true;
  if (rel.includes("/src/apply/")) return true;
  const base = basename(rel);
  if (/^routes.*\.m?tsx?$/.test(base) || /^routes.*\.cts$/.test(base)) return true;
  if (/^contract.*\.tsx?$/.test(base)) return true;
  if (rel.includes("/server/api/")) return true;
  return false;
}

/** R3 装配点允许位：仅 client\/index.{ts,tsx}。 */
export function isR3Allowed(rel) {
  return /(^|\/)client\/index\.tsx?$/.test(rel);
}

/** 静态串取值：字面量串，或无表达式模板（cooked 拼接）；余 null。 */
export function staticString(node) {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

/** 成员访问静态属性名：a.b → b；a["b"] → b；动态 → null。 */
export function staticProp(member) {
  if (member.computed) {
    if (member.property.type === "Literal" && typeof member.property.value === "string") {
      return member.property.value;
    }
    return null;
  }
  return member.property.name ?? null;
}

/** R4 定义形：以 \/ 开头、无空白、长度 >1（T5\/T6\/T7 在此出局）。 */
export function isSlashDef(value) {
  return (
    typeof value === "string" && value.startsWith("/") && value.length > 1 && !/[\s]/.test(value)
  );
}

/**
 * 四函数共享的一次 AST 遍历：R1 事件位、R2 三层、R3 装配点、R4 定义收集。
 * @returns {{r1static: Array, r1dynamic: number, r2l: Array, r2c: Array, r2b: Array, r3: Array, r4defs: Array, exportNames: Array}}
 *   各命中带 generatedLine\/generatedColumn（0-based 生成码坐标，调用方回映）。
 */
function at(node) {
  return {
    generatedLine: node.loc.start.line - 1,
    generatedColumn: node.loc.start.column,
  };
}

function visitR1(node, acc) {
  if (node.type !== "CallExpression") return;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || staticProp(callee) !== "on") return;
  const first = node.arguments.length > 0 ? staticString(node.arguments[0]) : null;
  if (first !== null && first.includes("/")) acc.r1static.push({ ...at(node), name: first });
  else acc.r1dyn += 1;
}

function r3NameOf(first) {
  const s = staticString(first);
  if (s !== null && s.startsWith("settings.")) return s;
  if (first !== null && first.type === "ObjectExpression") {
    for (const p of first.properties) {
      if (p.type !== "Property") continue;
      const key =
        p.key.type === "Identifier"
          ? p.key.name
          : p.key.type === "Literal" && typeof p.key.value === "string"
            ? p.key.value
            : null;
      if (key !== "name") continue;
      const v = staticString(p.value);
      if (v !== null && v.startsWith("settings.")) return v;
    }
  }
  return null;
}

function visitR3(node, acc) {
  if (node.type !== "CallExpression") return;
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return;
  const prop = staticProp(callee);
  if (prop !== "inject" && prop !== "register") return;
  const first = node.arguments.length > 0 ? node.arguments[0] : null;
  const name = r3NameOf(first);
  if (name !== null) acc.r3.push({ ...at(node), kind: prop, name });
}

function visitR2Args(node, acc) {
  for (const arg of node.arguments) {
    const s = staticString(arg);
    if (s !== null && s.includes(API_PREFIX)) acc.r2c.push({ ...at(arg), value: s });
  }
}

function checkJoinConcat(node) {
  const out = [];
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return out;
    const prop = staticProp(callee);
    if (prop !== "join" && prop !== "concat") return out;
    const parts = [callee.object, ...node.arguments].map(staticString);
    if (parts.some((s) => s !== null && s.includes(API_PREFIX)))
      out.push({ ...at(node), kind: "join-concat" });
    return out;
  }
  return out;
}
function checkPlusConcat(node) {
  const out = [];
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left);
    const r = staticString(node.right);
    if ((l !== null && l.includes(API_PREFIX)) || (r !== null && r.includes(API_PREFIX))) {
      out.push({ ...at(node), kind: "plus" });
    }
    return out;
  }
  return out;
}
function checkTemplateApi(node) {
  const out = [];
  if (node.type === "TemplateLiteral" && node.expressions.length > 0) {
    const cooked = node.quasis.map((q) => q.value.cooked ?? "").join("");
    if (cooked.includes(API_PREFIX)) out.push({ ...at(node), kind: "template-expr" });
    return out;
  }
  return out;
}
function checkLogicalApi(node) {
  const out = [];
  if (node.type === "LogicalExpression" && (node.operator === "??" || node.operator === "||")) {
    const r = staticString(node.right);
    if (r !== null && r.includes(API_PREFIX) && node.right.type !== "Identifier") {
      out.push({
        ...at(node),
        kind: node.operator === "??" ? "nullish-right" : "or-right",
        value: r,
      });
    }
  }
  return out;
}
function visitR2Splice(node, acc) {
  acc.r2b.push(...checkJoinConcat(node));
  acc.r2b.push(...checkPlusConcat(node));
  acc.r2b.push(...checkTemplateApi(node));
  acc.r2b.push(...checkLogicalApi(node));
}

function isLogicRightOf(node, parent) {
  return (
    parent !== null &&
    parent !== undefined &&
    parent.type === "LogicalExpression" &&
    (parent.operator === "??" || parent.operator === "||") &&
    parent.right === node
  );
}

function visitR2(node, acc) {
  if (node.type === "CallExpression") visitR2Args(node, acc);
  visitR2Splice(node, acc);
  if (
    node.type === "Literal" &&
    typeof node.value === "string" &&
    node.value.startsWith(API_PREFIX)
  ) {
    acc.r2l.push({ ...at(node), value: node.value });
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    const v = node.quasis.map((q) => q.value.cooked ?? "").join("");
    if (v.startsWith(API_PREFIX)) acc.r2l.push({ ...at(node), value: v });
  }
}

function visitR4(node, parent, acc) {
  if (node.type === "LogicalExpression" && (node.operator === "??" || node.operator === "||")) {
    const r = staticString(node.right);
    if (r !== null && isSlashDef(r))
      acc.r4defs.push({ ...at(node.right), value: r, fallback: true });
    return;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    if (!isLogicRightOf(node, parent) && isSlashDef(node.value)) {
      acc.r4defs.push({ ...at(node), value: node.value, fallback: false });
    }
    return;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    const v = node.quasis.map((q) => q.value.cooked ?? "").join("");
    if (!isLogicRightOf(node, parent) && isSlashDef(v)) {
      acc.r4defs.push({ ...at(node), value: v, fallback: false });
    }
    return;
  }
  const isExport =
    node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
  if (!isExport || node.declaration == null || node.declaration.type !== "VariableDeclaration")
    return;
  for (const d of node.declaration.declarations) {
    if (d.id !== null && d.id !== undefined && d.id.type === "Identifier") {
      acc.exportNames.push({ ...at(d.id), name: d.id.name });
    }
  }
}

export function analyzeAst(ast) {
  const acc = {
    r1static: [],
    r1dyn: 0,
    r2l: [],
    r2c: [],
    r2b: [],
    r3: [],
    r4defs: [],
    exportNames: [],
  };
  (function walk(node, parent) {
    if (node === null || node === undefined || typeof node.type !== "string") return;
    visitR1(node, acc);
    visitR2(node, acc);
    visitR3(node, acc);
    visitR4(node, parent, acc);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c !== null && typeof c === "object" && typeof c.type === "string") walk(c, node);
        }
      } else if (child !== null && typeof child === "object" && typeof child.type === "string") {
        walk(child, node);
      }
    }
  })(ast, null);
  return {
    r1static: acc.r1static,
    r1dynamic: acc.r1dyn,
    r2l: acc.r2l,
    r2c: acc.r2c,
    r2b: acc.r2b,
    r3: acc.r3,
    r4defs: acc.r4defs,
    exportNames: acc.exportNames,
  };
}

/** (包,值) 分组：key `${pkg}||${value}` → Set<rel>（持有人文件去重）。 */
export function groupByPkgValue(defs) {
  const groups = new Map();
  for (const d of defs) {
    const key = `${d.pkg}||${d.value}`;
    if (!groups.has(key))
      groups.set(key, { pkg: d.pkg, value: d.value, holders: new Set(), fallback: 0, total: 0 });
    const g = groups.get(key);
    g.holders.add(d.rel);
    g.total += 1;
    if (d.fallback === true) g.fallback += 1;
  }
  return groups;
}

/**
 * R2-L\/R2-B 同站去重谓词：同一文件同行同值同时命中定义层与拼接层时，L 让位给
 * 更具体的 B（B 钉拼接形态，L 只钉位置）。b 无 value 的形态（plus\/join-concat\/
 * template-expr）按行去重——一行多字面量的过收敛可接受（行号只定判词 site，
 * 同行任一定位都把该行标红）。调用方在行号回映后使用（.line 为原文行）。
 */
export function isR2LDeduped(lHit, bHits) {
  return bHits.some(
    (b) => b.line === lHit.line && (b.value === undefined || b.value === lHit.value),
  );
}

/** R4 单组 disposition（dsh 值才判红；非 dsh 只观察）。 */
export function decideGroup(g) {
  const holders = [...g.holders].sort();
  const isDsh = g.value.startsWith(API_PREFIX);
  const hasClient = holders.some((h) => h.includes("/client/"));
  if (!isDsh) {
    if (holders.length >= 3) return "upstream-triple";
    if (holders.length === 2) return hasClient ? "upstream-pair" : "upstream-pair-noclient";
    return "upstream-single";
  }
  if (holders.length > 2) return "multi-red";
  if (holders.length === 2) return hasClient ? "mirror-pass" : "mirror-noclient-red";
  return "single";
}

function listSrcFiles(srcDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(f);
      } else if (
        /\.(ts|tsx|mts|cts)$/.test(e.name) &&
        !e.name.endsWith(".d.ts") &&
        !e.name.includes(".test.")
      ) {
        out.push(f);
      }
    }
  };
  walk(srcDir);
  return out.sort();
}

export function discoverTargets(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) return null;
  const files = [];
  for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const src = join(packagesDir, e.name, "src");
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    for (const f of listSrcFiles(src)) files.push(f);
  }
  return files;
}

function loaderOf(file) {
  if (file.endsWith(".tsx")) return "tsx";
  return "ts";
}

async function scanFile(root, file) {
  const rel = relPosix(root, file);
  const content = readFileSync(file, "utf8");
  const t = await transform(content, { loader: loaderOf(file), sourcemap: true, sourcefile: rel });
  const ast = acorn.parse(t.code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const found = analyzeAst(ast);
  let map = null;
  try {
    map = new SourceMap(JSON.parse(t.map));
  } catch {
    map = null;
  }
  // best-effort 回映：单点缺失回退生成行；行号只影响判词 site，不影响是否判红，故不 fail-closed（见头注释出口段）。
  const lineOf = (h) => {
    if (map !== null) {
      try {
        const entry = map.findEntry(h.generatedLine, h.generatedColumn);
        if (entry !== null && entry !== undefined && entry.originalLine !== undefined)
          return entry.originalLine + 1;
      } catch {}
    }
    return h.generatedLine + 1;
  };
  const withLine = (arr) => arr.map((h) => ({ ...h, rel, line: lineOf(h) }));
  return {
    rel,
    pkg: pkgOf(rel),
    r1static: withLine(found.r1static),
    r1dynamic: found.r1dynamic,
    r2l: withLine(found.r2l),
    r2c: withLine(found.r2c),
    r2b: withLine(found.r2b),
    r3: withLine(found.r3),
    r4defs: withLine(found.r4defs).map((d) => ({ ...d, pkg: pkgOf(rel) })),
    exportNames: withLine(found.exportNames).map((e) => ({ ...e, pkg: pkgOf(rel) })),
  };
}

function fmtSite(s) {
  return `${s.rel}:${s.line}`;
}

function assertScanRoot(root) {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`--root 不是目录：${root}`);
}
function resolveScanRoot(argv) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 && argv[rootIdx + 1] !== undefined ? argv[rootIdx + 1] : DEFAULT_ROOT;
  let files = null;
  let scopeWhy = null;
  try {
    assertScanRoot(root);
    files = discoverTargets(root);
    if (files === null || files.length === 0)
      throw new Error("未发现任何扫描目标（packages/*/src 空）");
  } catch (e) {
    files = null;
    scopeWhy = String(e?.message ?? e).slice(0, 160);
  }
  return { root: root, files: files, scopeWhy: scopeWhy };
}
function establishScope(argv) {
  const resolved = resolveScanRoot(argv);
  const root = resolved.root;
  const files = resolved.files;
  const scopeWhy = resolved.scopeWhy;
  // 出口一（结构）：CLI/范围错误。--package 按包切分会让跨包镜像对恒绿，故禁。
  const structuralWhy = argv.includes("--package") ? "禁 --package（须全仓扫描）" : scopeWhy;
  if (structuralWhy !== null) {
    failClosed(`verify-host-seams: ${structuralWhy}（fail-closed）`);
  }
  return { root: root, files: files };
}
async function scanAll(root, files) {
  const scanned = [];
  const pipelineFailures = [];
  try {
    for (const file of files) {
      try {
        scanned.push(await scanFile(root, file));
      } catch (e) {
        pipelineFailures.push(`${relPosix(root, file)}: ${String(e?.message ?? e).slice(0, 140)}`);
      }
    }
  } catch (e) {
    pipelineFailures.push(`扫描调度异常：${String(e?.message ?? e).slice(0, 140)}`);
  }
  // 出口二（管线）：任一文件 transform/parse 异常即 fail-closed，不读成通过。
  if (pipelineFailures.length > 0) {
    failClosed(
      `verify-host-seams: AST 管线失败 ${pipelineFailures.length} 文件（fail-closed）：\n  - ${pipelineFailures.slice(0, 12).join("\n  - ")}`,
    );
  }
  return scanned;
}
function buildViolationGroups(allDefs) {
  const groups = groupByPkgValue(allDefs);
  const rows = [...groups.values()]
    .map((g) => ({
      ...g,
      holders: [...g.holders].sort(),
      disposition: decideGroup({ ...g, holders: new Set(g.holders) }),
    }))
    .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : a.value < b.value ? -1 : 1));
  const groupViolations = [];
  for (const r of rows) {
    if (r.disposition === "multi-red" || r.disposition === "mirror-noclient-red") {
      groupViolations.push(
        `R4 分组越位 (${r.pkg}, ${r.value}) 持有人 ${r.holders.length}：${r.holders.join("，")}`,
      );
    }
  }
  return { rows: rows, groupViolations: groupViolations };
}
function r1Violations(s) {
  const out = [];
  for (const h of s.r1static) {
    if (isR1Allowed(s.rel)) continue;
    if (isSrcRootShared(s.rel))
      out.push(
        `R1 根共享越位 ${fmtSite(h)} 事件 ${JSON.stringify(h.name)}（src 根 shared 不得直连宿主事件）`,
      );
    else if (s.rel.includes("/src/client/"))
      out.push(`R1 客户端越位 ${fmtSite(h)} 事件 ${JSON.stringify(h.name)}（事件只许装配点）`);
    else
      out.push(
        `R1 位置越位 ${fmtSite(h)} 事件 ${JSON.stringify(h.name)}（只许 src\/index.ts｜src\/apply\/**｜src\/server\/**）`,
      );
  }
  return out;
}
function r2Violations(s) {
  const out = [];
  if (!isR2Allowed(s.rel)) {
    for (const h of s.r2l) {
      if (isR2LDeduped(h, s.r2b)) continue;
      out.push(
        `R2-L 定义越位 ${fmtSite(h)} 值 ${JSON.stringify(h.value)}（路由字面量只许共享\/契约\/装配文件）`,
      );
    }
    for (const h of s.r2b)
      out.push(`R2-B 拼接越位 ${fmtSite(h)} 形态 ${h.kind}（允许集外不得拼接路由）`);
  }
  for (const h of s.r2c)
    out.push(
      `R2-C 直调越位 ${fmtSite(h)} 值 ${JSON.stringify(h.value)}（调用实参须经具名表 import）`,
    );
  return out;
}
function r3Violations(s) {
  const out = [];
  for (const h of s.r3) {
    if (!isR3Allowed(s.rel))
      out.push(
        `R3 装配越位 ${fmtSite(h)} slot ${JSON.stringify(h.name)}（仅许 client\/index.{ts,tsx}）`,
      );
  }
  return out;
}
function collectViolations(scanned) {
  const violations = [];
  let dynamicOn = 0;
  const allDefs = [];
  const exportByPkgName = new Map();
  for (const s of scanned) {
    dynamicOn += s.r1dynamic;
    violations.push(...r1Violations(s));
    violations.push(...r2Violations(s));
    violations.push(...r3Violations(s));
    for (const d of s.r4defs) allDefs.push(d);
    for (const e of s.exportNames) {
      const key = `${e.pkg}||${e.name}`;
      if (!exportByPkgName.has(key)) exportByPkgName.set(key, new Set());
      exportByPkgName.get(key).add(s.rel);
    }
  }
  for (const [key, holders] of exportByPkgName) {
    if (holders.size > 2)
      violations.push(
        `R4 同名多出 ${key}（${holders.size} 文件导出同名：${[...holders].sort().join("，")}）`,
      );
  }
  const grouped = buildViolationGroups(allDefs);
  const rows = grouped.rows;
  for (const v of grouped.groupViolations) violations.push(v);
  return { violations: violations, rows: rows, dynamicOn: dynamicOn, allDefs: allDefs };
}
function reportVerify(observe, scope, result) {
  if (observe) {
    console.log(
      `verify-host-seams: 分组表（${scope.files.length} 文件，${result.allDefs.length} 定义，动态 on 首参 ${result.dynamicOn} 处）`,
    );
    for (const r of result.rows) {
      const fb = r.fallback > 0 ? ` fallback${r.fallback}\/${r.holders.length}` : "";
      console.log(`  [${r.disposition}] (${r.pkg}, ${r.value})${fb}`);
      for (const h of r.holders) console.log(`    - ${h}`);
    }
    console.log(`verify-host-seams: OBSERVE OK（观察模式不判红）`);
    return 0;
  }
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(`verify-host-seams: ${v}`);
    console.error(
      `verify-host-seams: FAIL（${result.violations.length} 项，扫描 ${scope.files.length} 文件）`,
    );
    return 1;
  }
  console.log(
    `verify-host-seams: OK（扫描 ${scope.files.length} 文件，${result.rows.length} 组，动态 on 首参 ${result.dynamicOn} 处只观察）`,
  );
  return 0;
}
async function main(argv) {
  const scope = establishScope(argv);
  const root = scope.root;
  const files = scope.files;
  const observe = argv.includes("--observe");
  const scanned = await scanAll(root, files);
  const result = collectViolations(scanned);
  return reportVerify(observe, scope, result);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(await main(process.argv));
