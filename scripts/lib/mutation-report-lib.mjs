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
