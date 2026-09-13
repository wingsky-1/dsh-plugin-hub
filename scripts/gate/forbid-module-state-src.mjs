#!/usr/bin/env node
/**
 * N2a 门禁（#733 M2c 后续）：packages/<pkg>/src 禁**模块级可变状态**。
 *
 * 背景（#733 宪法第 1 条）：状态必须收进闭包 / 实例（工厂返回值或类字段），模块级
 * `let`/`var` 让状态跨 apply()、跨实例共享——同一进程内两次挂载互相污染，且与
 * 「单刻快照 / 注入面」的域纪律相抵。实证缺陷：dsh-notifier 的
 * `src/server/system-notifier.ts` 曾用模块级 `let lastSystemOutcome` 透传节流窗口内的
 * 「上一次决议」，两个 SystemNotifier 实例因此共享该状态。
 *
 * 检测语义（纯 AST）：**Program 顶层的** `let` / `var` 声明（含 `export let` / `export var`
 * 形态）即命中。字符串与注释里的伪形态由 AST 天然排除；函数体内的 `let`/`var` 是正常
 * 局部状态，不命中；`declare let` 是环境声明（无运行时状态），经 esbuild 剥类型后不产生
 * 声明节点，不命中。
 *
 * 为什么不再按「顶格」过滤（#733 计划项 3.1.2）：旧实现额外要求声明在源码里顶格
 * （`/^(?:export\s+)?(?:let|var)\s/`），缩进的模块级声明被计入「口径外」而不判红。实证
 * `packages/dsh-notifier/src/client/index.tsx` 有 22 处缩进的模块级 `var`，它们是真的模块级
 * 可变状态——旧实现因此留下一个**静默的**绕过口：把声明缩进一格即可逃出判据。声明的作用
 * 域与它在源码里的缩进形态本就该解耦（原则 ③），现改为只看 AST 作用域。那 22 处按下面的
 * 登记豁免处置，而不是继续留在判据之外。
 *
 * 豁免的单一事实源：`scripts/data/gate-exemptions.json`（只取 `gate` 等于本门禁名的条目）。
 * 条目是**文件级**的——该文件的所有命中都算合法豁免。每条必须带 `reason` 与
 * `trackingIssue`（`#NNN`），并带 `reviewBy` 到期提示；到期机制落地前 `reviewBy` 只打印不判红
 * （#733 计划项 3.2）。
 *
 * 为什么豁免不再要求「调用点紧邻注释」：那等于把豁免写进被扫描的源码里，而客户端源码恰是
 * 本轮不能动的面；登记在数据文件里同样是 PR diff 可见的单一可审阅点。调用点注释仍被识别，
 * 但**不能替代登记**——只有注释而没有登记条目一律判红（防「加了注释就以为豁免了」）。
 *
 * 扫描面（版本化常量，**按包限定**）：本判据源自 #733 宪法且当前只对 dsh-notifier 生效。
 * 扩包是一次显式改动（PACKAGES 常量 + 该包存量清零或登记豁免），扩包前须先实测该包在新口径
 * 下的存量，不要照抄历史数字。
 *
 * fail-closed：文件解析失败、扫描面为空、豁免台账不可读或结构不合法，一律判红。
 * 用法：node scripts/gate/forbid-module-state-src.mjs [--root <dir>] [--exemptions <file>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";

const ROOT = join(import.meta.dirname, "../..");
const GATE_NAME = "forbid-module-state-src";
const EXEMPTIONS_PATH = join(ROOT, "scripts", "data", "gate-exemptions.json");

/** 扫描面（版本化常量）：只扫这些包的 src。 */
const PACKAGES_V = 1;
const PACKAGES = ["dsh-notifier"];

const EXEMPT_MARK = "dsh-gate:allow-module-state";
const EXEMPT_RE = new RegExp(`\\s*${EXEMPT_MARK}\\s+([^\\n]*#\\d+[^\\n]*)`);

/**
 * 读取豁免台账，只保留本门禁的条目，按 path 索引。
 * 任何 IO/结构错误都抛给调用方——台账坏掉等于豁免机制失效，不能当作「没有豁免」继续跑。
 */
function loadExemptions(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`豁免台账不可读（${path}）：${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`豁免台账 JSON 语法错误（${path}）：${e.message}`);
  }
  if (!Array.isArray(json.exemptions)) throw new Error(`豁免台账缺 exemptions 数组（${path}）`);
  const byFile = new Map();
  for (const item of json.exemptions) {
    if (item === null || typeof item !== "object")
      throw new Error("豁免台账 exemptions 含非对象项");
    if (item.gate !== GATE_NAME) continue;
    if (typeof item.path !== "string" || item.path.length === 0)
      throw new Error(`豁免条目缺 path：${JSON.stringify(item)}`);
    if (typeof item.reason !== "string" || item.reason.length === 0)
      throw new Error(`${item.path}：豁免缺 reason`);
    if (typeof item.trackingIssue !== "string" || !/^#\d+$/.test(item.trackingIssue)) {
      throw new Error(
        `${item.path}：豁免 trackingIssue 须形如 #123（当前 ${JSON.stringify(item.trackingIssue)}）`,
      );
    }
    if (typeof item.reviewBy !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewBy)) {
      throw new Error(
        `${item.path}：豁免 reviewBy 须形如 2027-03-31（当前 ${JSON.stringify(item.reviewBy)}）`,
      );
    }
    if (byFile.has(item.path)) throw new Error(`豁免台账存在重复条目：${item.path}`);
    byFile.set(item.path, item);
  }
  return byFile;
}

/**
 * 提取行内的「真实」行注释文本——跳过字符串字面量中的 `//`（纯文本正则会把
 * `const msg = "// dsh-gate:allow-module-state #999 伪造"` 误判为豁免标记）。
 * 行内无字符串外的 `//` 注释 → 返回 null。
 */
function lineCommentText(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < n) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(i + 2);
    i++;
  }
  return null;
}

/** 递归收集扫描面内全部 .ts/.tsx/.mts/.mjs（含未跟踪；跳过 .d.ts 与 test 文件）。 */
function collectSrcFiles(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在：包命名约定下静默跳过，命中计数兜底
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        e.isFile() &&
        /\.(ts|tsx|mts|mjs)$/.test(e.name) &&
        !/\.d\.(ts|mts)$/.test(e.name) &&
        !/\.test\./.test(e.name)
      ) {
        hits.push(p);
      }
    }
  };
  for (const pkg of PACKAGES) walk(join(root, "packages", pkg, "src"));
  return hits;
}

/** 顶层 `let`/`var` 声明（含 export 包裹）→ [{ generatedLine, generatedColumn, kind, names }]。 */
function detectInAst(ast) {
  const hits = [];
  for (const node of ast.body) {
    let decl = node;
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration !== null &&
      node.declaration !== undefined
    ) {
      decl = node.declaration;
    }
    if (decl.type !== "VariableDeclaration" || (decl.kind !== "let" && decl.kind !== "var"))
      continue;
    const names = decl.declarations
      .map((d) =>
        d.id.type === "Identifier" ? d.id.name : d.id.type === "ObjectPattern" ? "{…}" : "[…]",
      )
      .join(", ");
    hits.push({
      generatedLine: decl.loc.start.line - 1,
      generatedColumn: decl.loc.start.column,
      kind: decl.kind,
      names,
    });
  }
  return hits;
}

/** 解析单个文件并检测。fail-closed：解析异常直接抛给调用方判红。 */
async function scanFile(file) {
  const content = readFileSync(file, "utf8");
  const tsLines = content.split("\n");
  const isMjs = file.endsWith(".mjs");
  let js = content;
  let mapJson = null;
  if (!isMjs) {
    const loader = file.endsWith(".tsx") ? "tsx" : "ts";
    const t = await transform(content, { loader, sourcemap: true, sourcefile: file });
    js = t.code;
    mapJson = t.map;
  }
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const rawHits = detectInAst(ast);
  if (rawHits.length === 0) return { hits: [], tsLines };
  const map = mapJson ? new SourceMap(JSON.parse(mapJson)) : null;
  const hits = [];
  for (const h of rawHits) {
    let lineIdx = h.generatedLine;
    if (map) {
      const entry = map.findEntry(h.generatedLine, h.generatedColumn);
      if (entry?.originalLine !== undefined) lineIdx = entry.originalLine;
    }
    const raw = tsLines[lineIdx] ?? "";
    hits.push({ line: lineIdx + 1, kind: h.kind, names: h.names, text: raw.trim().slice(0, 90) });
  }
  return { hits, tsLines };
}

/** 命中行的豁免注释匹配：命中 TS 行行尾或上一行的**真实**注释含合法豁免标记。 */
function hasExemption(tsLines, lineIdx) {
  const near = [tsLines[lineIdx], tsLines[lineIdx - 1]].filter((l) => l !== undefined);
  for (const line of near) {
    const comment = lineCommentText(line);
    if (comment === null) continue;
    const m = comment.match(EXEMPT_RE);
    if (m) return m[1].trim();
  }
  return null;
}

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

async function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const exemptionsPath = argValue(process.argv, "--exemptions", EXEMPTIONS_PATH);

  let exemptions;
  try {
    exemptions = loadExemptions(exemptionsPath);
  } catch (e) {
    console.error(`forbid-module-state-src: ${e.message} —— 豁免机制失效，fail-closed`);
    process.exit(1);
  }

  const files = collectSrcFiles(root);
  if (files.length === 0) {
    console.error(
      `forbid-module-state-src: 未发现任何扫描目标（${PACKAGES.join(", ")} 的 src 空，fail-closed）`,
    );
    process.exit(1);
  }
  const violations = [];
  const badExemptions = [];
  const legitExemptions = [];
  const parseFailures = [];
  const hitRels = new Set();
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    let result;
    try {
      result = await scanFile(file);
    } catch (e) {
      parseFailures.push(`${rel}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const { hits, tsLines } = result;
    if (hits.length > 0) hitRels.add(rel);
    const exempt = exemptions.get(rel);
    for (const h of hits) {
      const note = hasExemption(tsLines, h.line - 1);
      const detail = `${rel}:${h.line} [模块级 ${h.kind}（${h.names}）]`;
      if (exempt) {
        legitExemptions.push(
          `${detail} 登记豁免 ${exempt.trackingIssue}（reviewBy ${exempt.reviewBy}）`,
        );
      } else if (note) {
        badExemptions.push(
          `${detail} 有 ${EXEMPT_MARK} 注释但未在 scripts/data/gate-exemptions.json 登记（注释不能替代登记）`,
        );
      } else {
        violations.push(`${detail} ${h.text}`);
      }
    }
  }
  // 台账反向校验（防清单腐烂）：磁盘上存在、且本次**确有命中**的文件才算「活的」豁免条目——
  // 文件不存在（--root fixture / 包已整体移除）不判腐烂。
  for (const [p, item] of exemptions) {
    const onDisk = existsSync(join(root, p));
    if (onDisk && !hitRels.has(p)) {
      badExemptions.push(
        `${p}: 豁免条目指向的文件本次零命中（已腐烂，应删除条目 ${item.trackingIssue}）`,
      );
    }
  }

  const fail = violations.length > 0 || badExemptions.length > 0 || parseFailures.length > 0;
  if (parseFailures.length > 0) {
    console.error("forbid-module-state-src: 解析失败（fail-closed，一律判红）：");
    for (const p of parseFailures) console.error(`  - ${p}`);
  }
  if (badExemptions.length > 0) {
    console.error("forbid-module-state-src: 存在豁免但不合法：");
    for (const b of badExemptions) console.error(`  - ${b}`);
  }
  if (violations.length > 0) {
    console.error(
      `forbid-module-state-src: 发现 ${violations.length} 处模块级可变状态（应收进闭包/实例，或在 scripts/data/gate-exemptions.json 登记豁免）：`,
    );
    for (const v of violations) console.error(`  - ${v}`);
  }
  if (fail) {
    console.error(
      `forbid-module-state-src: FAIL（扫描 ${files.length} 文件，违规 ${violations.length} / 非法豁免 ${badExemptions.length} / 解析失败 ${parseFailures.length}）`,
    );
    process.exit(1);
  }
  if (legitExemptions.length > 0) {
    console.log(
      `forbid-module-state-src: OK（扫描 ${files.length} 文件，包 ${PACKAGES.join(", ")}（v${PACKAGES_V}），登记豁免 ${legitExemptions.length} 处）：`,
    );
    for (const l of legitExemptions) console.log(`  - ${l}`);
  } else {
    console.log(
      `forbid-module-state-src: OK（扫描 ${files.length} 文件，包 ${PACKAGES.join(", ")}（v${PACKAGES_V}）无模块级可变状态）`,
    );
  }
}

main().catch((e) => {
  console.error(`forbid-module-state-src: 运行异常（fail-closed）：${e?.stack ?? e}`);
  process.exit(1);
});
