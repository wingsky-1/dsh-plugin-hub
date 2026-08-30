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
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMutationReport, readMutationReportsAgg } from '../lib/mutation-report-lib.mjs';

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

// #220 B 方案：包可拆分为段式配置（<pkg>-<后缀>.json，后缀即功能段名，
// 数字段名亦兼容——#342 二期功能命名改造），夜间变异产出 <pkg>-<后缀>.json
// 段报告；此处按 conf 目录枚举段后缀，聚合为包级口径（mutant 位置键去重，
// 与 mutation-gate.mjs 同一 lib 函数）。未拆分包仍读单报告 <pkg>.json。
// 缺任一段报告 = 该包未完整执行，fail-closed。
const confDir = join(repoRoot, 'stryker.conf.d');
const reportDir = join(repoRoot, 'coverage', 'mutation');
const segNamesByPkg = new Map(); // pkg → 段后缀数组（未排序）
for (const f of readdirSync(confDir)) {
  const m = f.match(/^(dsh-[a-z0-9-]+)-(.+)\.json$/);
  if (m) {
    const list = segNamesByPkg.get(m[1]) ?? [];
    list.push(m[2]);
    segNamesByPkg.set(m[1], list);
  }
}

for (const [pkg, cfg] of Object.entries(packages)) {
  const expectedSegs = (segNamesByPkg.get(pkg) ?? []).sort();
  let r = null;
  if (expectedSegs.length > 0) {
    const segPaths = [];
    for (const n of expectedSegs) {
      const p = join(reportDir, `${pkg}-${n}.json`);
      if (!existsSync(p)) {
        rows.push({ pkg, missing: true, missingLabel: `段 ${n} 未执行` });
        if (mutationStrict) violations.push(`${pkg}: 段 ${n} 变异报告缺失（${pkg}-${n}.json 不存在——该段未执行）`);
        r = null;
        break;
      }
      segPaths.push(p);
    }
    if (segPaths.length === expectedSegs.length) {
      r = readMutationReportsAgg(segPaths);
      if (!r) {
        rows.push({ pkg, missing: true, missingLabel: '报告损坏' });
        if (mutationStrict) violations.push(`${pkg}: 段式报告不可解析（共 ${expectedSegs.length} 段）`);
        continue;
      }
    } else {
      continue;
    }
  } else {
    const reportPath = join(reportDir, `${pkg}.json`);
    // 缺失与损坏分开标注（#178）：逐包容错记账后单包失败不再中断整夜，
    // 「文件不存在」= 该包本次未执行（非崩溃），「存在但解析失败」= 报告损坏
    if (!existsSync(reportPath)) {
      rows.push({ pkg, missing: true, missingLabel: '未执行' });
      // F4 fail-closed：strict 开启后报告缺失 = 门禁被静默跳过，必须判红
      if (mutationStrict) violations.push(`${pkg}: 变异报告缺失（${pkg}.json 不存在——该包未执行）`);
      continue;
    }
    r = readMutationReport(reportPath);
    if (!r) {
      rows.push({ pkg, missing: true, missingLabel: '报告损坏' });
      if (mutationStrict) violations.push(`${pkg}: 变异报告损坏（${pkg}.json 存在但不可解析）`);
      continue;
    }
  }
  const threshold = typeof cfg.threshold === 'number' ? cfg.threshold : null;
  // F8：notifier 的 baselineCovered=1.33 是 bridge 修正前的试点原始记录（legacyNote），
  // 真实加固后基线在 fixedCovered——回退链 fixedCovered ?? baselineCovered：
  // 有 fixed 字段说明该包经历过修正后重校准，回落检测必须以新基线为准
  const baseline = typeof cfg.fixedCovered === 'number'
    ? cfg.fixedCovered
    : (typeof cfg.baselineCovered === 'number' ? cfg.baselineCovered : null);
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
    lines.push(`| ${r.pkg} | ⚠️ ${r.missingLabel} | — | — | — | — | — | — |`);
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
