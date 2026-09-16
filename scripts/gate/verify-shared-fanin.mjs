#!/usr/bin/env node
"use strict";

/**
 * verify-shared-fanin — 仓库根 shared/ 的**跨包扇入**判据（#792 跨包档收口）。
 *
 * 为什么需要：shared/ 准入规则 1 是「≥2 稳定消费者」，但此前它只是一句文档——模块的消费方
 * 散在各包 src 的相对 import 里，谁在消费只能靠人肉 grep 再手抄进 shared/README.md。实测那份
 * 人肉快照已经漂移（把零引用的包登成消费方 / 漏登真实消费方 / 整行模块缺失），而
 * shared/frontmatter.js 生产扇入为 0、只被一个测试引用，却长期留在共享层无人发现。本脚本把
 * 「shared 模块 → 消费包集合」变成每次门禁都重算的派生量，文档不再维护第二份事实源。
 *
 * 口径（写进判据，不留口径外的静默豁免）：
 *   - 消费面 = `packages/<pkg>/src/**`，**生产口径**：test/** 不计入消费者——测试引用不构成
 *     「插件实际使用」，frontmatter 正是靠 test-only 引用才逃过退役判定的。
 *   - 只认**直接**相对 import / export-from / 动态 import，且解析后落在仓库根 shared/ 内；
 *     各包自己的 `src/shared/` 门面不是仓库根 shared/，不算。
 *   - 经端内 shared 门面转出**同样计入**：门面文件自己就在 src/ 里、自己就 import 根 shared，
 *     同一套扫描天然覆盖，无需第二遍传递闭包。本仓 mcp-manager / provider-usage 尚未改造，
 *     收敛留后续重构 issue。
 *   - **不传递 shared 内部依赖**：host-utils.js 引 loopback.js，不使 host-utils 的消费者变成
 *     loopback 的消费者——否则任何被公共工具复用的模块都虚高，判据失去区分度。
 *
 * 判据：
 *   - 值面模块（有同基名 .js）：扇入 ≥ 2 包。
 *   - 类型面模块（只有 .d.ts，无实现可复用）：单列口径，≥ 1 包即合规。
 *   - **退役不豁免下限**（维护者裁决 D-A）：模块头标注 DEPRECATED 不改变判据——退役模块与
 *     普通模块同一下限，不满足即红。退役的正确做法是先把消费方迁走、再连同声明一起移除，
 *     不允许「标个 DEPRECATED 就长期留在共享层」这种形态存在。
 *   - shared/ 下不存在的模块被 src 引用（悬空引用）判红：那是构建期就会炸的引用。
 *
 * 用法：node scripts/gate/verify-shared-fanin.mjs [--root <dir>]
 * 退出码：0 = 通过；1 = 违规；2 = 结构/环境错误（root 不可读、shared/ 缺失、枚举为空）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walkFiles } from "../lib/walk-files.ts";
import { argValue } from "../lib/exemption-gate.ts";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 导出面的类型形状（JSDoc typedef）。
 *
 * 为什么写在这里：本文件是 .mjs，唯一进 scripts/ strict 编译面的方式是 allowJs 推断；
 * 不给形状，`{ ...m }` 这类展开在调用方（scripts/test/verify-shared-fanin.test.ts）会退化成
 * 缺字段的推断结果，消费方只能靠断言绕过——那正是「类型面靠 @ts-nocheck 过关」的老路。
 *
 * @typedef {{ base: string, kind: "value"|"type", file: string }} SharedModule
 * @typedef {{ base: string, kind: "value"|"type", file: string, consumers: string[], floor: number, failed: boolean }} FaninRow
 * @typedef {{ rows?: FaninRow[], dangling?: string[], error?: string }} FaninResult
 */

/** 生产源码扩展名（.d.ts 是声明、不是消费者代码）。 */
const SRC_FILE_RE = /\.(?:ts|tsx|mts|cts)$/;
/** 值面 / 类型面各自的扇入下限（准入规则 1）。 */
const FLOOR = { value: 2, type: 1 };

function isInside(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

/** shared/ 下该基名是否真有模块（值面或类型面）。 */
function modulePresent(sharedRoot, base) {
  return (
    existsSync(join(sharedRoot, base)) ||
    existsSync(join(sharedRoot, `${base}.js`)) ||
    existsSync(join(sharedRoot, `${base}.d.ts`))
  );
}

/** 去掉模块扩展名（`.js` / `.d.ts` / `.ts`），得模块基名。 */
function moduleBase(rel) {
  if (rel.endsWith(".d.ts")) return rel.slice(0, -".d.ts".length);
  return rel.replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, "");
}

/** 提取一段源码里的模块说明符（静态 import / export-from / 动态 import）。 */
export function importSpecifiers(text) {
  const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const specs = [];
  for (const m of code.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  )) {
    specs.push(m[1]);
  }
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

/**
 * 枚举仓库根 shared/ 下的模块：按基名聚合 js + d.ts 两份，判定值面 / 类型面。
 * @param {string} root 仓库根
 * @returns {SharedModule[]|null} null = shared/ 不可读（调用方按结构错误 fail-closed）
 */
export function listSharedModules(root) {
  const sharedRoot = join(root, "shared");
  if (!existsSync(sharedRoot) || !statSync(sharedRoot).isDirectory()) return null;
  const byBase = new Map();
  for (const rel of walkFiles(sharedRoot, (n) => n.endsWith(".js") || n.endsWith(".d.ts"))) {
    const base = moduleBase(rel);
    const rec = byBase.get(base) ?? { base, hasJs: false };
    if (!rel.endsWith(".d.ts")) rec.hasJs = true;
    byBase.set(base, rec);
  }
  return [...byBase.values()]
    .map((rec) => ({
      base: rec.base,
      kind: rec.hasJs ? "value" : "type",
      file: rec.hasJs ? `${rec.base}.js` : `${rec.base}.d.ts`,
    }))
    .sort((a, b) => a.base.localeCompare(b.base));
}

/**
 * 扫 packages/<pkg>/src 的直接引用，得「模块基名 → 消费包集合」。
 * @returns {{consumers: Map<string, Set<string>>, dangling: string[]}}
 */
export function collectConsumers(root) {
  const sharedRoot = join(root, "shared");
  const packagesDir = join(root, "packages");
  const consumers = new Map();
  const dangling = [];
  if (!existsSync(packagesDir)) return { consumers, dangling };
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(packagesDir, entry.name, "src");
    if (!existsSync(srcDir)) continue;
    for (const rel of walkFiles(srcDir, (n) => SRC_FILE_RE.test(n) && !n.endsWith(".d.ts"))) {
      collectFileConsumers({
        file: join(srcDir, rel),
        pkgName: entry.name,
        srcRel: rel,
        sharedRoot,
        consumers,
        dangling,
      });
    }
  }
  return { consumers, dangling };
}

/** 记录一个 src 文件对 shared/ 的直接引用；落不到 shared/ 内已有模块的记入 dangling。 */
function collectFileConsumers({ file, pkgName, srcRel, sharedRoot, consumers, dangling }) {
  for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
    if (!spec.startsWith(".")) continue;
    const abs = resolve(dirname(file), spec);
    if (!isInside(sharedRoot, abs)) continue;
    const base = moduleBase(relative(sharedRoot, abs).split(sep).join("/"));
    if (!modulePresent(sharedRoot, base)) {
      dangling.push(`packages/${pkgName}/src/${srcRel} → ${spec}（shared/ 下无此模块）`);
      continue;
    }
    if (!consumers.has(base)) consumers.set(base, new Set());
    consumers.get(base).add(pkgName);
  }
}

/**
 * 逐模块判定扇入，返回可直接渲染的行与汇总。
 * @param {string} root 仓库根
 * @returns {FaninResult} error 非空 = 结构错误（调用方 fail-closed）
 */
export function evaluateFanin(root) {
  const modules = listSharedModules(root);
  if (modules === null) return { error: `shared/ 目录不存在或不可读：${join(root, "shared")}` };
  if (modules.length === 0) {
    return {
      error: "shared/ 下没有任何 .js / .d.ts 模块——枚举口径失效（不是「没有模块」），fail-closed",
    };
  }
  const { consumers, dangling } = collectConsumers(root);
  const rows = modules.map((m) => {
    const consumerPackages = [...(consumers.get(m.base) ?? [])].sort();
    const floor = FLOOR[m.kind];
    return {
      ...m,
      consumers: consumerPackages,
      floor,
      failed: consumerPackages.length < floor,
    };
  });
  return { rows, dangling };
}

/**
 * 渲染报告行（无副作用，供 CLI 与自测共用）。
 * @param {FaninResult} result evaluateFanin 的返回值
 * @returns {string[]} 报告行
 */
export function renderReport(result) {
  if (result.error !== undefined) return [`verify-shared-fanin: ${result.error}`];
  const lines = [];
  for (const row of result.rows) {
    const face = row.kind === "value" ? "值面" : "类型面";
    const pkgs = row.consumers.length === 0 ? "（无）" : row.consumers.join(", ");
    const mark = row.failed ? "FAIL" : "PASS";
    lines.push(
      `${mark} ${face} ${row.file} | ${row.consumers.length} 包（下限 ${row.floor}）：${pkgs}`,
    );
    if (row.failed) {
      lines.push(
        `     单一消费者/无消费者的共享模块应留在消费包内（shared/README.md 准入规则 1）；` +
          `退役不豁免下限——须先迁移全部消费方，再连同模块与声明一起移除`,
      );
    }
  }
  for (const d of result.dangling) lines.push(`FAIL 悬空引用 | ${d}`);
  return lines;
}

function main(argv) {
  const root = argValue(argv, "--root", DEFAULT_ROOT);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`verify-shared-fanin: --root 不是目录：${root}`);
    return 2;
  }
  const result = evaluateFanin(root);
  if (result.error !== undefined) {
    console.error(renderReport(result).join("\n"));
    return 2;
  }
  for (const line of renderReport(result)) console.log(line);
  const failed = result.rows.filter((r) => r.failed).length + result.dangling.length;
  const value = result.rows.filter((r) => r.kind === "value").length;
  const type = result.rows.filter((r) => r.kind === "type").length;
  console.log(
    `verify-shared-fanin: 值面 ${value} 个（下限 ${FLOOR.value} 包）、类型面 ${type} 个（下限 ${FLOOR.type} 包）`,
  );
  if (failed > 0) {
    console.log(`verify-shared-fanin: FAIL（${failed} 项）`);
    return 1;
  }
  console.log("verify-shared-fanin: OK");
  return 0;
}

/** 仅直接执行时跑 main（被自测 import 时只取纯函数，与仓内其他门禁同口径）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main(process.argv));
