/**
 * mutation-report-lib — Stryker JSON 报告统计（单一事实源）
 *
 * 自 observe-check.mjs 提出（#178）：observe 夜间报告与 ci PR 增量门禁
 * （mutation-gate.mjs）共用同一 covered 口径统计，防两处口径漂移。
 */
import { readFileSync } from 'node:fs';

/**
 * 从 Stryker JSON 报告提取 covered 口径指标。
 *
 * 口径约定（#178 v2 固化）：
 *   - StrykerJS 10 无 Skipped 状态——incremental 模式复用的 mutant 继承上次
 *     的原状态（Killed/Survived/Timeout/NoCoverage），报告恒为全量口径，
 *     分母不因增量复用而缩水；
 *   - 未捕获异常经 scripts/test/mutation-tap-bridge.cjs 转写 TAP not ok 计
 *     Killed（error=0 前提，#151），RuntimeError 不会以冻结形式逃过计杀；
 *   - covered 口径与仓库既有基线一致：分母不含 noCoverage。
 *
 * 返回 null = 报告不存在或不可解析（调用方自行区分文案）。
 */
export function readMutationReport(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return null;
  }
  let killed = 0, timeout = 0, survived = 0, noCoverage = 0;
  for (const f of Object.values(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      if (m.status === 'Killed') killed += 1;
      else if (m.status === 'Timeout') timeout += 1;
      else if (m.status === 'Survived') survived += 1;
      else if (m.status === 'NoCoverage') noCoverage += 1;
    }
  }
  const covered = killed + timeout + survived;
  const coveredScore = covered > 0 ? Math.round(((killed + timeout) / covered) * 10000) / 100 : 0;
  return { killed, timeout, survived, noCoverage, total: covered + noCoverage, coveredScore };
}

/**
 * 多份段式报告聚合统计（#220 B 方案：mutate 段拆分为独立 matrix 实例后，
 * 同包多份 <pkg>-<seg>.json 聚合为一个包级口径再对 threshold 判分）。
 *
 * 去重约定：mutant 以「源文件路径 + mutant id」为唯一键——provider-usage
 * 两段存在历史重叠区间（2671-2792，#210 对齐后的原样保留），同一 mutant 会
 * 同时出现在两段报告中；状态冲突时取更保守值（NoCoverage > Survived >
 * Timeout > Killed），防聚合虚高。
 *
 * 任一报告缺失/不可解析 → 返回 null（调用方 fail-closed）。
 */
export function readMutationReportsAgg(paths) {
  const seen = new Map();
  for (const p of paths) {
    let raw;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return null;
    }
    for (const [file, f] of Object.entries(report.files ?? {})) {
      for (const m of f.mutants ?? []) {
        const key = `${file}::${m.id}`;
        const prev = seen.get(key);
        if (prev === undefined) {
          seen.set(key, m.status);
          continue;
        }
        const rank = { NoCoverage: 3, Survived: 2, Timeout: 1, Killed: 0 };
        if ((rank[m.status] ?? 0) > (rank[prev] ?? 0)) seen.set(key, m.status);
      }
    }
  }
  let killed = 0, timeout = 0, survived = 0, noCoverage = 0;
  for (const status of seen.values()) {
    if (status === 'Killed') killed += 1;
    else if (status === 'Timeout') timeout += 1;
    else if (status === 'Survived') survived += 1;
    else if (status === 'NoCoverage') noCoverage += 1;
  }
  const covered = killed + timeout + survived;
  const coveredScore = covered > 0 ? Math.round(((killed + timeout) / covered) * 10000) / 100 : 0;
  return { killed, timeout, survived, noCoverage, total: covered + noCoverage, coveredScore };
}
