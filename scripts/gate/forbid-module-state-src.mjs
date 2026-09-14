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
 * 域与它在源码里的缩进形态本就该解耦（原则 ③），现改为只看 AST 作用域。那批命中按台账
 * 登记豁免处置，而不是继续留在判据之外（#765 批次已把同一文件的 14 处常量 var 改 const，
 * 余 7 处真·可变绑定仍走登记豁免）。
 *
 * 豁免的单一事实源：`scripts/data/gate-exemptions.json`（只取 `gate` 等于本门禁名的条目）。
 * 条目是**文件级**的——该文件的所有命中都算合法豁免。机制实现（词法 / 三态 / 反向腐烂 /
 * 扫描面）在 `scripts/lib/exemption-gate.ts`，本文件只提供扫描器与策略。
 *
 * 为什么豁免不再要求「调用点紧邻注释」：那等于把豁免写进被扫描的源码里，而客户端源码恰是
 * 本轮不能动的面；登记在数据文件里同样是 PR diff 可见的单一可审阅点。调用点注释仍被识别，
 * 但**不能替代登记**——只有注释而没有登记条目一律判红（防「加了注释就以为豁免了」）。
 *
 * 扫描面：由 `scripts/data/gate-scope-registry.json` 声明（本闸 scopeFrom = registry），脚本内
 * 不再硬编码包名——范围是治理数据，改动应当是一次显式且可审的数据 diff。扩包前须先实测该包
 * 在新口径下的存量，不要照抄历史数字。
 *
 * fail-closed：文件解析失败、扫描面为空、豁免台账或范围注册表不可读/结构不合法、本闸未登记
 * 范围，一律判红。
 * 用法：node scripts/gate/forbid-module-state-src.mjs [--root <dir>] [--exemptions <file>] [--registry <file>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";
import { loadScopeRegistry, scopePackages } from "../lib/gate-scope-registry.ts";
import {
  argValue,
  collectSrcFiles,
  hasExemptionMarker,
  judgeHit,
  loadLedger,
  relPath,
  rotDetails,
} from "../lib/exemption-gate.ts";

const ROOT = join(import.meta.dirname, "../..");
const GATE_NAME = "forbid-module-state-src";
const LEDGER_DISPLAY = "scripts/data/gate-exemptions.json";
const EXEMPTIONS_PATH = join(ROOT, "scripts", "data", "gate-exemptions.json");
const REGISTRY_PATH = join(ROOT, "scripts", "data", "gate-scope-registry.json");

/**
 * 豁免策略：登记**必需**、调用点 marker **非必需**（识别但不作成要件）——marker 写在被扫
 * 源码里，而客户端源码不是本轮可动面；判据只认数据面的登记。
 */
const POLICY = {
  gate: GATE_NAME,
  mark: "dsh-gate:allow-module-state",
  markerRequired: false,
  ledgerDisplay: LEDGER_DISPLAY,
};

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

async function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const exemptionsPath = argValue(process.argv, "--exemptions", EXEMPTIONS_PATH);
  const registryPath = argValue(process.argv, "--registry", REGISTRY_PATH);

  let registry;
  let packages;
  try {
    registry = loadScopeRegistry(registryPath);
    packages = scopePackages(root, registry, GATE_NAME);
  } catch (e) {
    console.error(`forbid-module-state-src: ${e.message} —— 范围/豁免机制失效，fail-closed`);
    process.exit(1);
  }

  let ledger;
  try {
    ledger = loadLedger(exemptionsPath, GATE_NAME);
  } catch (e) {
    console.error(`forbid-module-state-src: ${e.message} —— 豁免机制失效，fail-closed`);
    process.exit(1);
  }

  const files = collectSrcFiles(root, packages);
  if (files.length === 0) {
    console.error(
      `forbid-module-state-src: 未发现任何扫描目标（${packages.join(", ")} 的 src 空，fail-closed）`,
    );
    process.exit(1);
  }
  const violations = [];
  const badExemptions = [];
  const legitExemptions = [];
  const parseFailures = [];
  const hitRels = new Set();
  for (const file of files) {
    const rel = relPath(root, file);
    let result;
    try {
      result = await scanFile(file);
    } catch (e) {
      parseFailures.push(`${rel}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const { hits, tsLines } = result;
    if (hits.length > 0) hitRels.add(rel);
    for (const h of hits) {
      const note = hasExemptionMarker(tsLines, h.line - 1, POLICY.mark);
      const detail = `${rel}:${h.line} [模块级 ${h.kind}（${h.names}）]`;
      const verdict = judgeHit(POLICY, ledger, rel, note, detail, h.text);
      if (verdict.kind === "legit") legitExemptions.push(verdict.detail);
      else if (verdict.kind === "bad") badExemptions.push(verdict.detail);
      else violations.push(verdict.detail);
    }
  }
  badExemptions.push(...rotDetails(POLICY, ledger, root, hitRels));

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
      `forbid-module-state-src: 发现 ${violations.length} 处模块级可变状态（应收进闭包/实例，或在 ${LEDGER_DISPLAY} 登记豁免）：`,
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
      `forbid-module-state-src: OK（扫描 ${files.length} 文件，包 ${packages.join(", ")}，登记豁免 ${legitExemptions.length} 处）：`,
    );
    for (const l of legitExemptions) console.log(`  - ${l}`);
  } else {
    console.log(
      `forbid-module-state-src: OK（扫描 ${files.length} 文件，包 ${packages.join(", ")} 无模块级可变状态）`,
    );
  }
}

main().catch((e) => {
  console.error(`forbid-module-state-src: 运行异常（fail-closed）：${e?.stack ?? e}`);
  process.exit(1);
});
