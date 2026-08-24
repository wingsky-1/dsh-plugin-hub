#!/usr/bin/env node
/**
 * observe-check — 夜间观察报告的阈值校验与回落检测（#85 v3 F1/F6）
 *
 * 输入：
 *   - scripts/data/gauntlet.config.json（mutation.packages 基线 + threshold/strict）
 *   - coverage/mutation/dsh-<pkg>.json（Stryker JSON 报告，须先跑完变异套件）
 *   - coverage/self-coverage.json（self-cov 口径明细）
 *
 * 行为：
 *   - 逐包计算 covered score = (killed+timeout) / (killed+timeout+survived)
 *   - 与 gauntlet 的 per-package threshold / baselineCovered 对比
 *   - 回落判据：covered < baselineCovered - 1pp（隔夜必有工单，F6）
 *   - --body-file <path>   输出 markdown 报告
 *   - --marker-file <path> 输出回落追评正文；无回落时输出空文件
 *
 * 退出码：0 = 正常（含"未达标但 strict=false"的观察期情形）；
 *         1 = strict 开启且存在 threshold 违约；
 *         2 = 环境/数据缺失错误
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bodyFile = argOf('--body-file');
const markerFile = argOf('--marker-file');

const gauntletPath = join(repoRoot, 'scripts', 'data', 'gauntlet.config.json');
let gauntlet;
try {
  gauntlet = JSON.parse(readFileSync(gauntletPath, 'utf8'));
} catch (err) {
  console.error(`observe-check: gauntlet.config.json 解析失败：${err.message}`);
  process.exit(2);
}
const packages = gauntlet?.mutation?.packages ?? {};
const mutationStrict = Boolean(gauntlet?.mutation?.strict);

/** 从 Stryker 报告提取 covered 口径指标 */
function readMutationReport(path) {
  if (!existsSync(path)) return null;
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
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
  // covered 口径与仓库既有基线一致：分母不含 noCoverage
  const coveredScore = covered > 0 ? Math.round(((killed + timeout) / covered) * 10000) / 100 : 0;
  return { killed, timeout, survived, noCoverage, total: covered + noCoverage, coveredScore };
}

const rows = [];
const violations = [];
const regressions = [];
let selfWrittenPct = null;

// self-written 函数覆盖（供报告展示；硬校验已由 self-cov --check 独立执行）
const selfCovPath = join(repoRoot, 'coverage', 'self-coverage.json');
if (existsSync(selfCovPath)) {
  try {
    selfWrittenPct = JSON.parse(readFileSync(selfCovPath, 'utf8'))?.selfWritten?.functions?.pct ?? null;
  } catch { /* 展示性字段，缺失不致命 */ }
}

for (const [pkg, cfg] of Object.entries(packages)) {
  const reportPath = join(repoRoot, 'coverage', 'mutation', `${pkg}.json`);
  const r = readMutationReport(reportPath);
  if (!r) {
    rows.push({ pkg, missing: true });
    continue;
  }
  const threshold = typeof cfg.threshold === 'number' ? cfg.threshold : null;
  const baseline = typeof cfg.baselineCovered === 'number' ? cfg.baselineCovered : null;
  const belowThreshold = threshold !== null && r.coveredScore < threshold;
  // 回落判据：较入库基线下降超过 1pp
  const regressed = baseline !== null && r.coveredScore < baseline - 1;

  rows.push({ pkg, ...r, threshold, baseline, belowThreshold, regressed });
  if (belowThreshold) violations.push(`${pkg}: ${r.coveredScore}% < threshold ${threshold}%`);
  if (regressed) {
    regressions.push(
      `**${pkg}** 变异 covered 回落：${baseline}% → ${r.coveredScore}%（Δ${(r.coveredScore - baseline).toFixed(2)}pp）。\n` +
      `请排查最近合入 main 的改动（killed ${r.killed}+timeout ${r.timeout} / covered ${r.killed + r.timeout + r.survived}），` +
      `必要时补充边界断言或在原 issue 内说明口径调整理由。`,
    );
  }
}

// ── 报告产出 ──────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const lines = [];
lines.push(`## 夜间质量观察报告 ${today}`);
lines.push('');
if (selfWrittenPct !== null) {
  lines.push(`self-written 函数覆盖：**${selfWrittenPct}%**（threshold 见 gauntlet coverage.selfWrittenFunctions）`);
  lines.push('');
}
lines.push('| 包 | covered | threshold | 基线 | Δ vs 基线 | killed | survived | noCov |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.missing) {
    lines.push(`| ${r.pkg} | ⚠️ 报告缺失 | — | — | — | — | — | — |`);
    continue;
  }
  const delta = r.baseline === null ? '—' : (r.coveredScore - r.baseline).toFixed(2);
  const flags = [r.belowThreshold && '`低阈`', r.regressed && '`回落`'].filter(Boolean).join(' ');
  lines.push(
    `| ${r.pkg}${flags ? ' ' + flags : ''} | ${r.coveredScore}% | ${r.threshold ?? '—'} | ${r.baseline ?? '—'}% | ${delta}pp | ${r.killed} | ${r.survived} | ${r.noCoverage} |`,
  );
}
lines.push('');
lines.push(`mutation.strict = **${mutationStrict}**（false 时低阈仅标注不判红；provider-usage 二阶段达标后开启）`);
lines.push('');
lines.push('> 数据来源：`coverage/mutation/*.json`（Stryker JSON reporter）与本仓 `gauntlet.config.json` 基线；covered 口径 = (killed+timeout)/(killed+timeout+survived)。');

const body = lines.join('\n') + '\n';

let exitCode = 0;
if (violations.length > 0) {
  console.error(`observe-check: threshold 违约（strict=${mutationStrict}）：\n  - ${violations.join('\n  - ')}`);
  if (mutationStrict) exitCode = 1;
}

if (bodyFile) writeFileSync(bodyFile, body);
if (markerFile) writeFileSync(markerFile, regressions.join('\n\n'));

console.log(`observe-check: ${rows.length} 包处理完毕，violation=${violations.length} regression=${regressions.length}`);
process.exit(exitCode);
