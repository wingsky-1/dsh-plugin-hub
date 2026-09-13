#!/usr/bin/env node
// @ts-nocheck
/**
 * exemption-gate — 路径受限门禁的**豁免机制**共享实现（#733 计划项 3.2.2，出处 #765 D）。
 *
 * 为什么抽出来：`forbid-homedir-src.mjs` 与 `forbid-module-state-src.mjs` 各自实现了同一套机制
 * ——真实行注释词法、marker 正则、双源三态、台账反向腐烂校验、扫描面枚举——两处近乎逐字重复。
 * 重复的判据实现必然漂移（一处修了另一处没修），而这两道闸守的是同一件事：豁免必须**可数、
 * 可审、可过期**。
 *
 * 事实源分工（原则 ① 单源派生）：
 *   - **条目**（谁被豁免、为什么、到什么时候）在 `scripts/data/gate-exemptions.json`，门禁不再内嵌；
 *   - **策略**（豁免要几源、marker 长什么样、台账怎么显示）由各门禁声明，本库不预设；
 *   - **扫描器**（什么算命中）留在各门禁自己手里——本库不认识任何门禁的业务语义。
 *
 * 文件面统一：homedir 闸旧过滤是 `.ts/.mts/.mjs`（**不含 `.tsx`**），module-state 含 `.tsx`。
 * 客户端入口基本都是 `.tsx`（仓内 10 个），前者因此对客户端面存在潜伏盲区。现统一到
 * `isScannedSourceFile`，两闸同一张网。
 *
 * 判定三态（`judgeHit` 返回值）：`legit`（登记齐备）/ `bad`（有豁免形态但不合法）/ `violation`
 * （无豁免）。`bad` 与 `violation` 都判红，分开只为给出不同的修法提示。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 两闸共用的豁免 marker 形状：`<mark> <理由，须含 #NNN>`。 */
function markerRegex(mark) {
  return new RegExp(`\\s*${mark}\\s+([^\\n]*#\\d+[^\\n]*)`);
}

/**
 * 提取行内的「真实」行注释文本——跳过字符串字面量中的 `//`。纯文本正则会把
 * `const msg = "// dsh-gate:allow-xxx #999 伪造"` 误判成豁免标记，使「逐调用点」粒度失效。
 * 轻量词法：跟踪单/双引号与反引号（含转义；模板字符串内不做嵌套插值解析，本仓豁免注释
 * 行不依赖该场景）。无字符串外的 `//` 注释 → 返回空串。
 */
export function lineCommentText(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i += 1;
      while (i < n) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(i + 2);
    i += 1;
  }
  return "";
}

/**
 * 命中行的豁免注释匹配：命中行行尾或上一行的**真实**注释含合法 marker 时返回理由文本，
 * 否则返回空串（`#NNN` 缺失即不算豁免，避免「随手一豁」）。
 */
export function hasExemptionMarker(tsLines, lineIdx, mark) {
  const re = markerRegex(mark);
  for (const line of [tsLines[lineIdx], tsLines[lineIdx - 1]]) {
    if (line === undefined) continue;
    const comment = lineCommentText(line);
    if (comment === "") continue;
    const m = comment.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * 扫描面文件过滤：`.ts/.tsx/.mts/.mjs`，排除 `.d.ts`/`.d.mts` 声明与 `*.test.*`
 * （测试用 homedir 锁默认路径契约是合法的，不该被判据命中）。
 */
export function isScannedSourceFile(name) {
  return /\.(ts|tsx|mts|mjs)$/.test(name) && !/\.d\.(ts|mts)$/.test(name) && !/\.test\./.test(name);
}

/** 列出 `packages/` 下以 prefix 开头的包目录名（读不到 packages 目录时抛出，由调用方 fail-closed）。 */
export function listPackageNames(root, prefix) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
}

/**
 * 收集扫描面内全部源文件的**绝对路径**（含未跟踪文件；扫描面定义见 `isScannedSourceFile`）。
 * 目录不存在时静默跳过（包没建 src 不是违规），整体为空由调用方 fail-closed 判红——
 * 扫描面为空等于判据失效，不能退化成「零违规」。
 */
export function collectSrcFiles(root, packageNames) {
  const hits = [];
  for (const pkg of packageNames) {
    const srcDir = join(root, "packages", pkg, "src");
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && isScannedSourceFile(e.name)) hits.push(p);
      }
    };
    walk(srcDir);
  }
  return hits;
}

/** 相对 root 的 POSIX 形式路径（台账条目一律用这个形态做键）。 */
export function relPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

/**
 * 读取豁免台账，只保留本门禁的条目，按相对路径索引。
 *
 * 结构校验覆盖**全文件**（不只本门禁的条目）：台账是共享数据面，一行坏数据不该只在
 * 「恰好读它的那门禁」里才炸。任何 IO/结构错误都抛给调用方——台账坏掉等于豁免机制失效，
 * **不能当作「没有豁免」继续跑**（那会把已豁免的存量一次性判成违规，或反过来放过）。
 *
 * `reviewBy` 可选：**有**=临时豁免（进 §2.3b 的到期台账）；**无**=长期条目（如 `~user`
 * 透传这类 DSH_HOME 域之外的设计事实）。强行为长期条目编一个到期日会逼出「永不续期」的
 * 假条目，反而不如如实区分。
 */
export function loadLedger(path, gate) {
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
  const items = new Map();
  for (const item of json.exemptions) {
    if (item === null || typeof item !== "object")
      throw new Error("豁免台账 exemptions 含非对象项");
    if (typeof item.gate !== "string" || item.gate.length === 0)
      throw new Error(`豁免条目缺 gate：${JSON.stringify(item).slice(0, 120)}`);
    if (typeof item.path !== "string" || item.path.length === 0)
      throw new Error(`豁免条目缺 path：${JSON.stringify(item).slice(0, 120)}`);
    if (typeof item.reason !== "string" || item.reason.length === 0)
      throw new Error(`${item.gate}/${item.path}：豁免缺 reason`);
    if (typeof item.trackingIssue !== "string" || !/^#\d+$/.test(item.trackingIssue)) {
      throw new Error(
        `${item.gate}/${item.path}：豁免 trackingIssue 须形如 #123（当前 ${JSON.stringify(item.trackingIssue)}）`,
      );
    }
    if (item.reviewBy !== undefined) {
      if (typeof item.reviewBy !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewBy)) {
        throw new Error(
          `${item.gate}/${item.path}：豁免 reviewBy 须形如 2027-03-31（当前 ${JSON.stringify(item.reviewBy)}）`,
        );
      }
    }
    if (item.gate !== gate) continue;
    if (items.has(item.path)) throw new Error(`豁免台账存在重复条目：${item.path}`);
    items.set(item.path, item);
  }
  return items;
}

/** 合法豁免的回显文本：临时条目带 reviewBy，长期条目如实说明。 */
function legitDetail(entry) {
  const due =
    entry.reviewBy === undefined ? "（长期条目，无 reviewBy）" : `（reviewBy ${entry.reviewBy}）`;
  return `登记豁免 ${entry.trackingIssue}${due}`;
}

/**
 * 单次命中的豁免裁决。
 * `policy` = { gate, mark, markerRequired, ledgerDisplay }；`detail` = 命中点描述（由门禁拼）。
 * `note` = 命中点紧邻注释里的豁免理由（空串=无）；`codeText` = 命中源码片段（仅违规时回显）。
 */
export function judgeHit(policy, ledger, rel, note, detail, codeText) {
  const entry = ledger.get(rel);
  if (entry !== undefined) {
    if (policy.markerRequired && note === "") {
      return {
        kind: "violation",
        detail: `${detail} 已登记在 ${policy.ledgerDisplay} 但该调用点缺紧邻豁免注释 ${policy.mark}`,
      };
    }
    return { kind: "legit", detail: `${detail} ${legitDetail(entry)}` };
  }
  if (note !== "") {
    return {
      kind: "bad",
      detail: `${detail} 有 ${policy.mark} 注释但未在 ${policy.ledgerDisplay} 登记（注释不能替代登记）`,
    };
  }
  return { kind: "violation", detail: `${detail} ${codeText}` };
}

/**
 * 台账反向腐烂校验（防清单腐烂）：磁盘上存在、且本次**确有命中**的文件才算「活的」豁免。
 * 文件不存在（--root fixture / 包已整体移除）不判腐烂；文件存在但零命中 = 豁免点已删或
 * 已重构而台账没清 → 判红，逼条目随代码一起收口。
 */
export function rotDetails(policy, ledger, root, hitFiles) {
  const out = [];
  for (const [rel, entry] of ledger) {
    if (!existsSync(join(root, rel))) continue;
    if (!hitFiles.has(rel)) {
      out.push(`${rel}: 豁免条目指向的文件本次零命中（已腐烂，应删除条目 ${entry.trackingIssue}）`);
    }
  }
  return out;
}

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
export function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}
