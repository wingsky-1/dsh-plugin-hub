#!/usr/bin/env node
/**
 * 生成周度健康报告的「机器信号段」markdown（指导文档 5.6 / 6.1）。
 * 数据源：pnpm cov 产出的 coverage/coverage-summary.json 与 pnpm crap 产出的
 * coverage/crap-report.json。人工判断段由模板预留，结论永远留给人。
 */
import { readFileSync, existsSync } from 'node:fs';

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const summary = readJson('coverage/coverage-summary.json');
const crap = readJson('coverage/crap-report.json');

const lines = [];
lines.push('## 机器信号段（自动生成，勿改）');

if (summary?.total) {
  const t = summary.total;
  lines.push(
    `- 覆盖率（lib 产物口径）：lines ${t.lines.pct}% / functions ${t.functions.pct}%` +
    ` / branches ${t.branches.pct}%`,
  );
} else {
  lines.push('- 覆盖率：数据缺失');
}

if (crap) {
  const pct = crap.totalFns ? Math.round((crap.coveredFns / crap.totalFns) * 100) : 0;
  lines.push(
    `- CRAP（阈值 ${crap.threshold}，观察期模式）：函数 ${crap.totalFns} 个，已覆盖 ` +
    `${pct}%；超阈热点 ${crap.hotspots.length} 个`,
  );
  const top = crap.hotspots.slice(0, 5);
  if (top.length) {
    lines.push('- Top 热点：');
    for (const h of top) {
      lines.push(`  - CRAP=${h.crap} comp=${h.comp}${h.covered ? '' : ' 未覆盖'} \`${h.file}:${h.line}\``);
    }
  }
} else {
  lines.push('- CRAP：数据缺失');
}

// 挣扎信号与零命中规则榜：基建启用后由 CI 补齐（见 issue #42 二期）
lines.push('- 挣扎信号：待 health 基线积累后启用（PR 反复回滚 / 半径膨胀检测）');
lines.push('');

lines.push('## 人工判断段（留给维护者填写）');
lines.push('- 这些信号是否构成「Agent 在原地打转」的结论？');
lines.push('- 阈值收紧/放宽建议：<由人决定>（两周观察期后校准 crap-check 阈值与 --strict 开关）');
lines.push('- 是否需要重划包边界：<由人决定>');

console.log(lines.join('\n'));
