#!/usr/bin/env node
/**
 * collect-exemptions — 门禁豁免/临时项的**收口台账**收集器（#733 计划项 3.2 前置；裁决见 #765）。
 *
 * 为什么需要：豁免的收口依据有两类——`reviewBy`（到期日）与 `exitCriteria`（可证伪的解除
 * 条件），两者都**不自动判红**。判定若落在 test:scripts 这类每个 PR 都跑的门禁上，会无差别
 * 冻结全部 PR 与 auto-merge（#765 的裁决项）。既然不自动判红，就必须有人定期看，本脚本就是
 * 那份清单：**全量门禁档收集并打印**。
 *
 * 为什么 `exitCriteria` 与 `reviewBy` 平级（#765 裁决：**目标是零豁免，台账只是过渡期手段**）：
 * 日期只说明「什么时候再看一眼」，条件才说明「凭什么可以删」。只写日期不写解除条件，等于把
 * 收口推迟到某一天重新讨论一次——故两者都收，且只有日期、没有条件的条目单独点名。
 *
 * 为什么是扫描而不是清单：豁免的登记处是数据文件（scripts/data/*.json），本脚本递归遍历，
 * **按对象特征**分桶后计入（分桶实现见 scripts/lib/exemption-kind.ts）。**不在这里维护第二份
 * 清单**——新增豁免只要按约定写进数据文件就会自动出现在台账里（原则 ① 单源派生、⑤ 临时即到期）。
 * 尚未数据化的豁免（内嵌在门禁脚本里的常量）不在收集面内，把它们迁进数据文件是本项后续工作。
 *
 * ## 分桶口径：按对象特征识别，不再按字段认领
 *
 * 此前「凡带 `reviewBy` 或 `exitCriteria` 的对象即为一条待办」——于是**删掉这两个字段就能把一条
 * 待办洗成「设计事实」**：台账计数减 1、exit 0、无任何判词，判据不响。现在以 `kind` 为准：
 * 结构性 kind（type-only / not-source / facade / not-mutated）按设计不计入待办；暂缺类 kind
 * （今天只有 pending-project）**无论带不带 reviewBy / exitCriteria 都计入**。无 kind 的两个面
 * （gate-exemptions.json、gauntlet.config.json）按字段兜底，理由与漂移取舍见该库文件头。
 *
 * 退出码恒为 0：它是报告，不是门禁（#765 裁决：收口不判红，否则会无差别冻结全部 PR 与
 * auto-merge）。**判红不在这里**：排除面自身的结构与形态判据在
 * scripts/gate/verify-coverage-scope.mjs（形态未知 / 事实源缺失 fail-closed exit 2）。
 * 用法：node scripts/gate/collect-exemptions.mjs [--root <dir>] [--today YYYY-MM-DD]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUCKET, classifyLedgerNode, isLedgerNode } from "../lib/exemption-kind.ts";

const ROOT = join(import.meta.dirname, "../..");
const DATA_DIR = join("scripts", "data");
const DAY_MS = 86_400_000;
/** 多久内到期要单独点名（提示排期），与是否过期无关。 */
const SOON_DAYS = 90;

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/**
 * 条目的可读标识：取几个通用候选字段，都没有则如实说明（不编造）。
 * `pattern` 在列：覆盖率面的临时排除项（#733 3.4 起 coverage.config.json 的 exclude）用它标识。
 * `threshold` 在列且接受数字：阈值段（gauntlet.config.json 的 crap / complexity）没有包名或路径，
 * 除了阈值本身没有别的标识——只认字符串字段会让这类条目退化成「(无标识字段)」。
 */
function describeEntry(node) {
  const parts = [];
  for (const field of ["gate", "package", "pattern", "path", "name", "key", "threshold"]) {
    const value = node[field];
    if (typeof value === "string" || typeof value === "number") parts.push(`${field}=${value}`);
  }
  return parts.length > 0 ? parts.join("  ") : "(无标识字段)";
}

/**
 * 递归收集**台账面**上的对象并按对象特征分桶（`isLedgerNode` 认面、`classifyLedgerNode` 定桶）；
 * pointer 用 `$.a[0].b` 形式，便于在 issue 里精确定位。父与子都是条目时两条都收（各自收口）。
 *
 * 认面谓词从「带 reviewBy / exitCriteria」换成形状 + 分桶（见文件头）：旧谓词让「删掉两个字段」
 * 成为一条待办的洗白通道。basis 随条目存下并逐条打印，使「这一条为什么算待办」当场可核对。
 */
function collectEntries(node, pointer, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectEntries(item, `${pointer}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (isLedgerNode(node)) {
    const { bucket, basis, kind } = classifyLedgerNode(node);
    out.push({
      pointer,
      bucket,
      basis,
      kind,
      reviewBy: typeof node.reviewBy === "string" ? node.reviewBy : null,
      exitCriteria: typeof node.exitCriteria === "string" ? node.exitCriteria : null,
      trackingIssue: typeof node.trackingIssue === "string" ? node.trackingIssue : null,
      label: describeEntry(node),
    });
  }
  for (const [k, v] of Object.entries(node)) collectEntries(v, `${pointer}.${k}`, out);
}

/**
 * 读一个数据文件并收集其台账条目。解析失败**不抛**——一个坏文件不该让整份台账收不到，
 * 但也必须让读者看见它，故连同来源行一起打印并计入 unreadable。
 */
function readEntries(dataDir, file) {
  let json;
  try {
    json = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  } catch (e) {
    console.log(`  来源 ${DATA_DIR}/${file}`);
    console.log(`    [跳过] JSON 解析失败：${String(e.message).split("\n")[0]}`);
    return { entries: [], unreadable: 1 };
  }
  const entries = [];
  collectEntries(json, "$", entries);
  return { entries, unreadable: 0 };
}

/**
 * 打印单条条目并回传它该计入哪几个计数。计数以「本条归属」形式返回而不是直接改外部变量，
 * 是为了让「分档规则」（过期 / 90 天内 / 仅解除条件 / 缺解除条件）只有这一处实现。
 */
/**
 * `reviewBy` → 一句到期描述 + 它该计入哪一档。
 * 无法解析的日期如实说「无法解析」而不是当成已过期：那会把一条坏数据伪装成待办。
 */
function describeDue(reviewBy, todayMs) {
  const dueMs = Date.parse(`${reviewBy}T00:00:00Z`);
  if (Number.isNaN(dueMs))
    return { text: `reviewBy ${reviewBy}（日期无法解析）`, bucket: "unknown" };
  const days = Math.round((dueMs - todayMs) / DAY_MS);
  if (days < 0) return { text: `reviewBy ${reviewBy}（已过期 ${-days} 天）`, bucket: "expired" };
  return {
    text: `reviewBy ${reviewBy}（剩 ${days} 天）`,
    bucket: days <= SOON_DAYS ? "soon" : "rest",
  };
}

function reportEntry(entry, todayMs) {
  const meta = [];
  const tally = { expired: 0, soon: 0, criteriaOnly: 0, withoutCriteria: 0 };
  if (entry.reviewBy === null) {
    tally.criteriaOnly = 1;
  } else {
    const due = describeDue(entry.reviewBy, todayMs);
    if (due.bucket === "expired") tally.expired = 1;
    if (due.bucket === "soon") tally.soon = 1;
    meta.push(due.text);
  }
  if (entry.trackingIssue !== null) meta.push(`trackingIssue ${entry.trackingIssue}`);
  if (entry.exitCriteria === null) {
    if (entry.reviewBy !== null) tally.withoutCriteria = 1;
  } else {
    meta.push(`exitCriteria ${entry.exitCriteria}`);
  }
  console.log(`    ${entry.pointer}  ${entry.label}`);
  console.log(`      ${describeBasis(entry)}  ${meta.join("  ")}`);
  return tally;
}

/** 分桶依据的判词：让「这条为什么算待办」当场可核对（kind 派生 / 无 kind 面的字段兜底）。 */
function describeBasis(entry) {
  const by = entry.kind === null ? "无 kind" : `kind=${entry.kind}`;
  return `待办（依据 ${by} / ${entry.basis}）`;
}

/** 汇总行；没有待办时如实说明扫描面，而不是打印一行全零。 */
function printSummary(tally, scannedFiles, today) {
  const structuralNote =
    tally.byDesign === 0 ? "" : ` / 结构性（按设计不计入待办）${tally.byDesign}`;
  if (tally.total === 0) {
    console.log(
      `  未发现待办条目（结构性 ${tally.byDesign} 条；扫描 ${scannedFiles} 个数据文件，分桶见 scripts/lib/exemption-kind.ts）`,
    );
    return;
  }
  const rest = tally.total - tally.expired - tally.soon - tally.criteriaOnly;
  const criteriaNote =
    tally.criteriaOnly === 0 ? "" : ` / 仅解除条件（无到期日）${tally.criteriaOnly}`;
  console.log(
    `  合计 ${tally.total} 条待办：已过期 ${tally.expired} / ${SOON_DAYS} 天内到期 ${tally.soon} / 其余 ${rest}${criteriaNote}${structuralNote}（统计日 ${today}；目标 0 条——#765「目标是零豁免，台账只是过渡期手段」）`,
  );
  if (tally.withoutCriteria > 0) {
    console.log(
      `  其中 ${tally.withoutCriteria} 条只有到期日、没有 exitCriteria——到期收口时缺「凭什么能删」的判据`,
    );
  }
}

/** 空计数（每个文件的增量都从这里起算，避免逐字段累加写两遍）。 */
function emptyDelta() {
  return { total: 0, expired: 0, soon: 0, criteriaOnly: 0, withoutCriteria: 0, byDesign: 0 };
}

/** 把一个文件的计数增量并进全局计数（逐字段枚举，键序由 emptyDelta 固定）。 */
function mergeDelta(tally, delta) {
  for (const key of Object.keys(delta)) tally[key] += delta[key];
}

/**
 * 打印单个数据文件：待办逐条打（带分桶依据），结构性按 kind 归并成一行。
 * 结构性条目逐条打印会让台账被「按设计不计入」的噪声淹没（本仓实测 29 条），故归并——
 * 数量仍然可见（漏收一条仍看得见），但待办与设计事实的分界一眼可辨。
 */
function reportFileEntries(entries, todayMs, file) {
  const delta = emptyDelta();
  const deferrals = entries.filter((e) => e.bucket === BUCKET.deferral);
  const byDesign = entries.filter((e) => e.bucket === BUCKET.byDesign);
  delta.byDesign = byDesign.length;
  if (deferrals.length === 0 && byDesign.length === 0) return delta;
  console.log(`  来源 ${DATA_DIR}/${file}`);
  for (const entry of deferrals) {
    delta.total += 1;
    const t = reportEntry(entry, todayMs);
    mergeDelta(delta, t);
  }
  if (byDesign.length > 0) console.log(`    ${describeStructural(byDesign)}`);
  return delta;
}

/** 结构性条目的一行归并描述：`kind×条数` 按 kind 名排序。 */
function describeStructural(byDesign) {
  const byKind = new Map();
  for (const entry of byDesign) {
    const key = entry.kind ?? "（无 kind 且无待办字段）";
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  const detail = [...byKind]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}×${n}`)
    .join("、");
  return `结构性 ${byDesign.length} 条（不计入待办）：${detail}`;
}

function main() {
  const root = argValue(process.argv, "--root", ROOT);
  const today = argValue(process.argv, "--today", new Date().toISOString().slice(0, 10));
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const dataDir = join(root, DATA_DIR);

  console.log(
    "collect-exemptions: 门禁豁免/临时项到期台账（全量门禁档收集；仅报告不判红，裁决见 #765）",
  );
  if (!existsSync(dataDir)) {
    console.log(`  数据目录不存在（${DATA_DIR}）—— 无台账可收集`);
    return 0;
  }
  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const tally = { ...emptyDelta(), unreadable: 0 };
  for (const file of files) {
    const { entries, unreadable } = readEntries(dataDir, file);
    tally.unreadable += unreadable;
    if (entries.length === 0) continue;
    mergeDelta(tally, reportFileEntries(entries, todayMs, file));
  }

  printSummary(tally, files.length, today);
  if (tally.unreadable > 0) {
    console.log(`  另有 ${tally.unreadable} 个数据文件无法解析（上方已列出）`);
  }
  return 0;
}

process.exit(main());
