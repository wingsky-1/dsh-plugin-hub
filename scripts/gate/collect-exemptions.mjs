#!/usr/bin/env node
/**
 * collect-exemptions — 门禁豁免/临时项的**到期台账**收集器（#733 计划项 3.2 前置；裁决见 #765）。
 *
 * 为什么需要：`reviewBy` 让豁免「机器可过期」，但到期**不自动判红**——到期判定若落在
 * test:scripts 这类每个 PR 都跑的门禁上，到期日会无差别冻结全部 PR 与 auto-merge（#765 的
 * 裁决项）。既然不自动判红，就必须有人定期看，本脚本就是那份清单：**全量门禁档收集并打印**，
 * 人工据此裁决「续期」还是「收口」。
 *
 * 为什么是扫描而不是清单：豁免的登记处是数据文件（scripts/data/*.json），本脚本递归遍历，
 * 凡带 `reviewBy` 的对象即为一条待办。**不在这里维护第二份清单**——新增豁免只要按约定写进
 * 数据文件就会自动出现在台账里（原则 ① 单源派生、⑤ 临时即到期）。尚未数据化的豁免（内嵌在
 * 门禁脚本里的常量）不在收集面内，把它们迁进数据文件是本项后续工作。
 *
 * 退出码恒为 0：它是报告，不是门禁。判定语义的任何收紧都要先过 #765 的裁决。
 * 用法：node scripts/gate/collect-exemptions.mjs [--root <dir>] [--today YYYY-MM-DD]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
 * `pattern` 在列：覆盖率面的临时排除项（#733 3.4 起 coverage.config.json 的 exclude）用它标识，
 * 少了它台账只会打印「(无标识字段)」——到期复核的人得自己回文件里数第几条。
 */
function describeEntry(node) {
  const parts = [];
  for (const field of ["gate", "package", "pattern", "path", "name", "key"]) {
    if (typeof node[field] === "string") parts.push(`${field}=${node[field]}`);
  }
  return parts.length > 0 ? parts.join("  ") : "(无标识字段)";
}

/**
 * 递归收集带 `reviewBy` 的对象；pointer 用 `$.a[0].b` 形式，便于在 issue 里精确定位。
 * 父与子都带 reviewBy 时两条都收（它们各自到期）。
 */
function collectEntries(node, pointer, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectEntries(item, `${pointer}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (typeof node.reviewBy === "string") {
    out.push({
      pointer,
      reviewBy: node.reviewBy,
      trackingIssue: typeof node.trackingIssue === "string" ? node.trackingIssue : null,
      label: describeEntry(node),
    });
  }
  for (const [k, v] of Object.entries(node)) collectEntries(v, `${pointer}.${k}`, out);
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

  let total = 0;
  let expired = 0;
  let soon = 0;
  let unreadable = 0;
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    } catch (e) {
      unreadable += 1;
      console.log(`  来源 ${DATA_DIR}/${file}`);
      console.log(`    [跳过] JSON 解析失败：${String(e.message).split("\n")[0]}`);
      continue;
    }
    const entries = [];
    collectEntries(json, "$", entries);
    if (entries.length === 0) continue;
    console.log(`  来源 ${DATA_DIR}/${file}`);
    for (const entry of entries) {
      total += 1;
      const dueMs = Date.parse(`${entry.reviewBy}T00:00:00Z`);
      let when;
      if (Number.isNaN(dueMs)) {
        when = `reviewBy ${entry.reviewBy}（日期无法解析）`;
      } else {
        const days = Math.round((dueMs - todayMs) / DAY_MS);
        if (days < 0) {
          expired += 1;
          when = `reviewBy ${entry.reviewBy}（已过期 ${-days} 天）`;
        } else {
          if (days <= SOON_DAYS) soon += 1;
          when = `reviewBy ${entry.reviewBy}（剩 ${days} 天）`;
        }
      }
      console.log(`    ${entry.pointer}  ${entry.label}`);
      console.log(
        `      ${when}${entry.trackingIssue === null ? "" : `  trackingIssue ${entry.trackingIssue}`}`,
      );
    }
  }

  if (total === 0) {
    console.log(`  未发现带 reviewBy 的条目（扫描 ${files.length} 个数据文件）`);
  } else {
    console.log(
      `  合计 ${total} 条：已过期 ${expired} / ${SOON_DAYS} 天内到期 ${soon} / 其余 ${total - expired - soon}（统计日 ${today}）`,
    );
  }
  if (unreadable > 0) console.log(`  另有 ${unreadable} 个数据文件无法解析（上方已列出）`);
  return 0;
}

process.exit(main());
