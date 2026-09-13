#!/usr/bin/env node
/**
 * verify-scripts-index — `scripts/README.md` 索引的**存在性**与**引用即登记**判据
 * （#733 计划项 3.3 E2）。
 *
 * 为什么只有这两条判据、而不是「全仓文件清单 + 存量基线」：索引的用途是**可发现性**，不是
 * `ls` 的副本（原则 ⑥）。实测 scripts/ 下 116 个文件里只有约 50 个被机器可见的调用点引用，
 * 其余多为测试文件（按 `<被测脚本>.test.ts` 命名约定发现）与纯库；把它们逐一登记进 README
 * 等于把目录列表抄进文档——立刻漂移、而且没人读。索引的边界应当是「仓库会调用什么」。
 *
 *   A 存在性——索引里写出的每条路径必须真的存在：索引项腐烂 = 把读者指到空处。
 *   B 引用即登记——凡在机器可见调用点里被引用的脚本/数据（`package.json` 的 scripts、
 *     `packages/*​/package.json`、`.github/workflows/**`、`lefthook.yml`、以及 `scripts/**`
 *     与 `tools/**` 源码里出现的字面路径），必须在索引里出现。**新增一个会被调用的脚本却没有
 *     登记 → 红**，这就是棘轮；不需要存量基线，因为「未被任何调用点引用」的文件本来就不必登记
 *     （它们由报告面列出，供人工按需补）。
 *
 * 解析口径（跟文档结构走，不猜）：
 *   - 只认 `- \`path\`` 形态的列表项；含 `<...>` 的是模板/模式条目，跳过存在性检查；
 *   - 条目按所在 `## <path>/（…）` 小节解析：`tools/` 开头的小节相对仓库根的 `tools/`，
 *     「仓库根的派生生成物」小节相对仓库根，其余小节相对 `scripts/`。
 * 引用面口径（三条都写进判据，避免「口径外」的静默豁免）：
 *   - 含 `*` 的 glob 引用不展开——测试文件的发现方式就是 glob，展开它等于要求逐一登记 48 个
 *     测试文件；
 *   - `scripts/test/**​/*.test.ts` 按命名约定排除（同上）；
 *   - 被引用但**不存在**的路径不参与：历史注记与用法示例里会出现已退役的路径
 *     （如 `gauntlet.config.json` 注释里的 tap 桥接）。
 *
 * 用法：node scripts/gate/verify-scripts-index.mjs [--root <dir>] [--index <file>]
 * 退出码：0 = 通过；1 = 有违规；2 = 结构/环境错误（索引不可读、无任何索引条目）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const ROOT = join(import.meta.dirname, "../..");
const INDEX_REL = join("scripts", "README.md");

/** `scripts/<path>.<ext>` 形态的字面引用（引用面提取用）。 */
const SCRIPT_REF_RE = /scripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts|cjs|json)/g;
/** 引用面扫描的文本源：调用点声明 + 脚本源码本身。 */
const REF_SOURCES = ["package.json", "lefthook.yml"];
const REF_GLOBS = [
  { dir: ".github/workflows", ext: [".yml", ".yaml"] },
  { dir: "scripts", ext: [".mjs", ".ts", ".cjs"] },
  { dir: "tools", ext: [".mjs", ".js", ".cjs", ".ts"] },
  { dir: "packages", ext: [".json"], basename: "package.json" },
];

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/**
 * 解析索引条目：返回 [{ path, base, line, isPattern }]。
 * `base` 是条目相对哪个根——由所在小节标题决定，文档结构本身就是口径。
 */
export function parseIndex(text) {
  const entries = [];
  let base = null;
  let inRootSection = false;
  text.split("\n").forEach((line, i) => {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      const title = heading[1];
      inRootSection = title.startsWith("仓库根");
      // 文档里的条目路径**自带**小节目录（`gate/contract-check.ts`），只有 tools 段是相对
      // `tools/`、根生成物段是相对仓库根——按小节标题判定，别猜。
      base = inRootSection ? "" : title.startsWith("tools/") ? "tools" : "scripts";
      return;
    }
    const item = /^\s*-\s+`([^`]+)`/.exec(line);
    if (item === null || base === null) return;
    entries.push({ path: item[1], base, line: i + 1, isPattern: item[1].includes("<") });
  });
  return entries;
}

/** 索引条目的仓库相对路径（`scripts/` 或 `tools/` 前缀由小节决定）。 */
function entryRepoPath(entry) {
  return entry.base === "" ? entry.path : `${entry.base}/${entry.path}`;
}

/** 递归收集目录下的文件（相对 root 的 POSIX 路径）。 */
function walk(dir, root, out) {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const abs = join(dir, item.name);
    if (item.isDirectory()) walk(abs, root, out);
    else out.push(relative(root, abs).split(sep).join("/"));
  }
  return out;
}

/** 引用面：机器可见调用点里字面引用的 `scripts/**` 路径（去重、排序）。 */
function collectRefs(root) {
  const refs = new Set();
  const texts = [];
  for (const rel of REF_SOURCES) {
    const abs = join(root, rel);
    if (existsSync(abs)) texts.push(readFileSync(abs, "utf8"));
  }
  for (const { dir, ext, basename } of REF_GLOBS) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    for (const rel of walk(absDir, root, [])) {
      if (!ext.some((e) => rel.endsWith(e))) continue;
      if (basename !== undefined && !rel.endsWith(`/${basename}`)) continue;
      texts.push(readFileSync(join(root, rel), "utf8"));
    }
  }
  for (const text of texts) {
    for (const m of text.matchAll(SCRIPT_REF_RE)) {
      const p = m[0];
      if (p.includes("*")) continue; // glob 引用不逐文件展开
      if (/^scripts\/test\/.*\.test\.ts$/.test(p)) continue; // 测试文件按命名约定发现
      if (!existsSync(join(root, p))) continue; // 历史注记/用法示例里的退役路径
      refs.add(p);
    }
  }
  return [...refs].sort();
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const indexRel = argValue(process.argv, "--index", INDEX_REL);
  const indexPath = join(root, indexRel);

  let text;
  try {
    text = readFileSync(indexPath, "utf8");
  } catch (e) {
    console.error(`verify-scripts-index: 索引不可读（${indexRel}）：${e.message}`);
    return 2;
  }
  const entries = parseIndex(text);
  if (entries.length === 0) {
    console.error(
      `verify-scripts-index: 索引里没有任何 \`- \\\`path\\\`\` 形态条目（${indexRel}）—— 解析口径与文档结构脱节或文档被清空，fail-closed`,
    );
    return 2;
  }

  const indexed = new Set(entries.map(entryRepoPath));
  const problems = [];

  // 判据 A：索引项存在性（模板条目跳过）
  for (const entry of entries) {
    if (entry.isPattern) continue;
    const rel = entryRepoPath(entry);
    if (!existsSync(join(root, rel))) {
      problems.push(`${indexRel}:${entry.line} 索引项不存在：${rel}（索引腐烂：读者会被指到空处）`);
    }
  }

  // 判据 B：引用即登记（棘轮）
  const refs = collectRefs(root);
  if (refs.length === 0) {
    console.error(
      "verify-scripts-index: 引用面解析为空 —— 提取口径失效（不是「没有引用」），fail-closed",
    );
    return 2;
  }
  for (const p of refs) {
    if (!indexed.has(p)) {
      problems.push(
        `被调用点引用但未登记进 ${indexRel}：${p}（新增会被调用的脚本必须登记；若它不再被调用，请删掉调用点）`,
      );
    }
  }

  // 报告面（不判红）：既未被引用也未被索引的文件——索引的边界是「仓库会调用什么」，
  // 这些文件不需要登记，但列出来可供人工判断哪些其实该被文档化。
  const all = walk(join(root, "scripts"), root, []).filter((p) => p !== indexRel);
  const unreferenced = all.filter((p) => !indexed.has(p) && !refs.includes(p));

  if (problems.length > 0) {
    console.error(`verify-scripts-index: ${problems.length} 条违规：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `verify-scripts-index: FAIL（索引条目 ${entries.length} 条、引用面 ${refs.length} 条、物理文件 ${all.length} 个）`,
    );
    return 1;
  }
  console.log(
    `verify-scripts-index: OK（索引条目 ${entries.length} 条全部存在，引用面 ${refs.length} 条全部已登记；scripts/ 物理文件 ${all.length} 个，其中未被引用且未登记 ${unreferenced.length} 个——仅报告，不判红）`,
  );
  return 0;
}

/** 仅直接执行时跑 main（被自测 import 时只取 parseIndex，与仓内其他门禁同口径）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main());
