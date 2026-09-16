/**
 * mutation-report-lib — Stryker JSON 报告统计（单一事实源）
 *
 * 自 observe-check.mjs 提出（#178）：observe 夜间报告与 ci PR 增量门禁
 * （mutation-gate.mjs）共用同一 covered 口径统计，防两处口径漂移。
 */
import { readFileSync } from "node:fs";

/**
 * 从 Stryker JSON 报告提取 covered 口径指标。
 *
 * 口径约定（#178 v2 固化）：
 *   - StrykerJS 10 无 Skipped 状态——incremental 模式复用的 mutant 继承上次
 *     的原状态（Killed/Survived/Timeout/NoCoverage），报告恒为全量口径，
 *     分母不因增量复用而缩水；
 *   - #722 前未捕获异常经 scripts/test/mutation-tap-bridge.cjs 转写 TAP not ok
 *     计 Killed（error=0 前提，#151）；#722 起 runner 换为 vitest，该桥接退役，
 *     未捕获异常改由 vitest runner 归入 errorsSet 并使该次运行判 Error（fail-loud，
 *     不再以「冻结的 Killed」形态进入计分）；
 *   - covered 口径与仓库既有基线一致：分母不含 noCoverage。
 *
 * 返回 null = 报告不存在或不可解析（调用方自行区分文案）。
 */
export function readMutationReport(path) {
  const report = readJsonReport(path);
  if (report === null) return null;
  return reportTotals(tallyReportMutants(report));
}

/** 读 Stryker JSON 报告：文件缺失 / 非法 JSON 一律 null（调用方自行区分文案）。 */
function readJsonReport(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return null;
  }
  return report;
}

function tallyReportMutants(report) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  for (const f of Object.values(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      addStatusCount(counts, m.status);
    }
  }
  return counts;
}

function addStatusCount(counts, status) {
  if (status === "Killed") counts.killed += 1;
  else if (status === "Timeout") counts.timeout += 1;
  else if (status === "Survived") counts.survived += 1;
  else if (status === "NoCoverage") counts.noCoverage += 1;
}

/** covered 口径的总分与四项计数（分母不含 noCoverage，#178 v2 固化）。 */
function reportTotals(counts) {
  const covered = counts.killed + counts.timeout + counts.survived;
  const coveredScore =
    covered > 0 ? Math.round(((counts.killed + counts.timeout) / covered) * 10000) / 100 : 0;
  return {
    killed: counts.killed,
    timeout: counts.timeout,
    survived: counts.survived,
    noCoverage: counts.noCoverage,
    total: covered + counts.noCoverage,
    coveredScore,
  };
}

/**
 * 多份段式报告聚合统计（#220 B 方案：mutate 段拆分为独立 matrix 实例后，
 * 同包多份 <pkg>-<seg>.json 聚合为一个包级口径再对 threshold 判分）。
 *
 * 去重约定：mutant 以「源文件路径 + 完整位置 + mutator + replacement」为唯一
 * 键——Stryker JSON 报告的 mutant.id 是每份报告独立生成的序号（PR #257 实证：
 * seg1 的 "434" 与 seg2 的 "213" 毫无对应关系），跨报告按 id 去重会把不同
 * mutant 误合并、把分数打到假低；provider-usage 两段历史重叠区间（2671-2792，
 * #210 对齐后的原样保留）的同位置 mutant 经位置键正确配对（实证状态冲突 0）。
 * 状态冲突仍取更保守值（NoCoverage > Survived > Timeout > Killed）兜底。
 *
 * 任一报告缺失/不可解析 → 返回 null（调用方 fail-closed）。
 */
export function readMutationReportsAgg(paths) {
  const seen = new Map();
  for (const p of paths) {
    const report = readJsonReport(p);
    if (report === null) return null;
    mergeReportMutants(seen, report);
  }
  return reportTotals(tallySeenStatuses(seen));
}

function mergeReportMutants(seen, report) {
  for (const [file, f] of Object.entries(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      mergeMutant(seen, file, m);
    }
  }
}

function mergeMutant(seen, file, m) {
  const k = mutantKey(file, m);
  const prev = seen.get(k);
  if (prev === undefined) {
    seen.set(k, m.status);
    return;
  }
  const rank = { NoCoverage: 3, Survived: 2, Timeout: 1, Killed: 0 };
  if ((rank[m.status] ?? 0) > (rank[prev] ?? 0)) seen.set(k, m.status);
}

// id 是每份报告独立的序号（#257 实证），跨报告去重必须用完整位置
function mutantKey(file, m) {
  return `${file}::${mutantPosition(m)}::${m.mutatorName ?? ""}:${m.replacement ?? ""}`;
}

function mutantPosition(m) {
  return `${m.location?.start?.line}:${m.location?.start?.column}:${m.location?.end?.line}:${m.location?.end?.column}`;
}

function tallySeenStatuses(seen) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  for (const status of seen.values()) {
    addStatusCount(counts, status);
  }
  return counts;
}
