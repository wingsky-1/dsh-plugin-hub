#!/usr/bin/env node
/**
 * 生成周度健康报告的「机器信号段」markdown（指导文档 5.6 / 6.1）。
 * 数据源：pnpm cov 产出的 coverage/coverage-summary.json（#722 阶段三起为 vitest
 * 的 src 口径）与 pnpm crap 产出的 coverage/crap-report.json（该脚本自阶段三起
 * fail-closed 停用，文件缺席时本报告自动省略 CRAP 段）。人工判断段由模板预留，
 * 结论永远留给人。
 *
 * #718：基线（baseline/mutation）新鲜度由 baseline-staleness.mjs 先行产出
 * baseline-staleness.json，本脚本只把它翻译成机器信号段的一行——判定与措辞都不在这里，
 * 免得同一句判据在两处漂移。
 */
import { readFileSync, existsSync } from "node:fs";

import { renderReportLine } from "./baseline-staleness.mjs";

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/**
 * 基线状态文件的**宽容**读取：只有 status 为 fresh|stale 才算可用（与 workflow 最末 verdict
 * 步骤的白名单同口径）。为什么不能直接把文件丢给 renderReportLine：它会走 default 抛 TypeError，
 * 本步骤一红，下游「Create health issue」按 GHA 语义被跳过 ⇒ 周报工单不建——「留痕先于判红」
 * 反而在这个输入下不成立。判红交给 verdict 步骤，这里只如实写「状态不可用」。
 * 不可解析（写了一半 / 被改坏）与缺 status 字段归为同一类：两者都只说明「状态不可用」。
 */
function readStaleness(path) {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.status === "fresh" || parsed?.status === "stale")
      return { kind: "usable", state: parsed };
    return { kind: "unusable" };
  } catch {
    return { kind: "unusable" };
  }
}

const summary = readJson("coverage/coverage-summary.json");
const crap = readJson("coverage/crap-report.json");
const gauntlet = readJson("scripts/data/gauntlet.config.json");
const staleness = readStaleness("baseline-staleness.json");
const crapStrict = Boolean(crap?.strict ?? gauntlet?.crap?.strict);
const crapMode = crapStrict ? "strict 判红" : "观察期（仅记录）";

const lines = [];
lines.push("## 机器信号段（自动生成，勿改）");

if (summary?.total) {
  const t = summary.total;
  lines.push(
    `- 覆盖率（vitest/istanbul 源码口径，分母仅 src，不含 vendor 与 lib 产物；阈值见 vitest.config.ts）：lines ${t.lines.pct}% / functions ${t.functions.pct}%` +
      ` / branches ${t.branches.pct}%`,
  );
} else {
  lines.push("- 覆盖率：数据缺失");
}

if (crap) {
  const pct = crap.totalFns ? Math.round((crap.coveredFns / crap.totalFns) * 100) : 0;
  lines.push(
    `- CRAP（阈值 ${crap.threshold}，${crapMode}，strict 来源 scripts/data/gauntlet.config.json: crap.strict）：函数 ${crap.totalFns} 个，已覆盖 ` +
      `${pct}%；超阈热点 ${crap.hotspots.length} 个`,
  );
  const top = crap.hotspots.slice(0, 5);
  if (top.length) {
    lines.push("- Top 热点：");
    for (const h of top) {
      lines.push(
        `  - CRAP=${h.crap} comp=${h.comp}${h.covered ? "" : " 未覆盖"} \`${h.file}:${h.line}\``,
      );
    }
  }
} else {
  lines.push("- CRAP：数据缺失");
}

// 基线新鲜度（#718 验收判据）：三种输入都要能落成正文一行，且措辞互不混淆——
// 「检查过且可用」/「状态不可用」/「文件根本没产出」。
if (staleness.kind === "usable") {
  lines.push(renderReportLine(staleness.state));
} else if (staleness.kind === "unusable") {
  lines.push(
    "- 变异基线（`baseline/mutation`）新鲜度：无法确定（状态不可用）—— 判红步骤已按「检查未做成」处理",
  );
} else {
  lines.push("- 变异基线（`baseline/mutation`）龄：数据缺失（baseline-staleness.json 未产出）");
}

// 挣扎信号与零命中规则榜：基建启用后由 CI 补齐（见 issue #42 二期）
lines.push("- 挣扎信号：待 health 基线积累后启用（PR 反复回滚 / 半径膨胀检测）");
lines.push("");

lines.push("## 人工判断段（留给维护者填写）");
lines.push("- 这些信号是否构成「Agent 在原地打转」的结论？");
lines.push(
  "- 阈值收紧/放宽建议：<由人决定>（依据 scripts/data/gauntlet.config.json 的 crap.threshold / crap.strict 调整）",
);
lines.push("- 是否需要重划包边界：<由人决定>");

console.log(lines.join("\n"));
