#!/usr/bin/env node
/**
 * mutation-gate — PR 增量变异门禁双指标判分（#178 v2；#217 起由 mutation-verdict
 * job 在 artifact 汇合后统一调用）
 *
 * 时序假设（#217 变异/覆盖解耦后的三段式链路）：
 *   1. coverage job 全局单次跑 pnpm cov + self-cov.mjs，先于本脚本产出
 *      coverage/self-coverage.json；
 *   2. mutation-gate 矩阵各实例只做基线 restore + stryker run，报告经
 *      upload-artifact 下发；
 *   3. mutation-verdict job 用 download-artifact 把两路产物还原到本脚本约定
 *      的固定路径后，才调用本脚本逐包判分。
 *
 * 输入（运行时必须已在工作区就位，均来自上游 artifact 下发）：
 *   - coverage/mutation/<pkg>.json     Stryker JSON 报告（incremental 运行产物，
 *                                      复用 mutant 继承原状态，报告恒为全量口径）
 *   - coverage/self-coverage.json      self-written 覆盖率明细（coverage job 先行产出）
 *   - scripts/data/gauntlet.config.json（阈值唯一事实源，随 checkout 就位）
 *
 * 用法：node scripts/gate/mutation-gate.mjs <pkg>   # pkg 形如 dsh-mcp-manager
 *
 * 判分（两项指标）：
 *   1) 测试覆盖率：self-written functions pct ≥ coverage.selfWrittenFunctions.threshold
 *      —— 恒硬（PR 门禁不随观察期开关放松，防止低覆盖改动借道合入）；
 *   2) 变异测试率：covered score ≥ mutation.packages[pkg].threshold
 *      —— 受全局 mutation.strict 开关约束：false 期间仅标注不拦截
 *      （provider-usage 在 #150 达标翻转 strict 后自动变硬，避免达标前卡死触该包的 PR）。
 *
 * 退出码：0 = 通过；1 = 门禁违约；2 = 环境/数据缺失错误（fail-closed）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMutationReport } from '../lib/mutation-report-lib.mjs';

const repoRoot = process.cwd();
const pkg = process.argv[2];
if (!pkg || !/^dsh-[a-z0-9-]+$/.test(pkg)) {
  console.error('mutation-gate: 用法：node scripts/gate/mutation-gate.mjs <dsh-<name>>');
  process.exit(2);
}

// ── gauntlet 配置 ─────────────────────────────────────────────
let gauntlet;
try {
  gauntlet = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'data', 'gauntlet.config.json'), 'utf8'));
} catch (err) {
  console.error(`mutation-gate: gauntlet.config.json 解析失败：${err.message}`);
  process.exit(2);
}
const mutCfg = gauntlet?.mutation?.packages?.[pkg];
if (!mutCfg) {
  console.error(`mutation-gate: ${pkg} 不在 gauntlet mutation.packages 内——聚合包无变异配置，不应进入本门禁`);
  process.exit(2);
}
const threshold = typeof mutCfg.threshold === 'number' ? mutCfg.threshold : null;
if (threshold === null) {
  console.error(`mutation-gate: ${pkg}.threshold 未配置 —— 视为配置错误（fail-closed）`);
  process.exit(2);
}
const mutationStrict = Boolean(gauntlet?.mutation?.strict);
const covCfg = gauntlet?.coverage?.selfWrittenFunctions ?? {};
const covThreshold = typeof covCfg.threshold === 'number' ? covCfg.threshold : null;
if (covThreshold === null) {
  console.error('mutation-gate: coverage.selfWrittenFunctions.threshold 未配置 —— 视为配置错误（fail-closed）');
  process.exit(2);
}

let failed = false;

// ── 指标一：测试覆盖率（self-written 函数口径，恒硬） ──────────
const selfCovPath = join(repoRoot, 'coverage', 'self-coverage.json');
if (!existsSync(selfCovPath)) {
  console.error('mutation-gate: coverage/self-coverage.json 不存在 —— coverage job 的 artifact 未下发（时序假设被破坏）—— fail-closed');
  process.exit(2);
}
let fnPct = null;
try {
  fnPct = JSON.parse(readFileSync(selfCovPath, 'utf8'))?.selfWritten?.functions?.pct ?? null;
} catch (err) {
  console.error(`mutation-gate: self-coverage.json 解析失败：${err.message}`);
  process.exit(2);
}
if (fnPct === null) {
  console.error('mutation-gate: self-coverage.json 缺少 selfWritten.functions.pct —— fail-closed');
  process.exit(2);
}
console.log(`mutation-gate [${pkg}] 测试覆盖率: functions ${fnPct}% vs threshold ${covThreshold}%（恒硬）`);
if (fnPct < covThreshold) {
  console.error(`mutation-gate: FAIL —— self-written 函数覆盖 ${fnPct}% 低于下限 ${covThreshold}%`);
  failed = true;
}

// ── 指标二：变异测试率（covered 口径，受 mutation.strict 约束）──
const reportPath = join(repoRoot, 'coverage', 'mutation', `${pkg}.json`);
const r = readMutationReport(reportPath);
if (!r) {
  // stryker 步骤成功后报告必然存在；缺失 = 报告 artifact 未下发（链路异常）
  // 而非门禁语义，一律判红
  console.error(`mutation-gate: ${pkg} 变异报告缺失或不可解析（${reportPath}）—— stryker 报告 artifact 未下发，fail-closed`);
  process.exit(2);
}
console.log(
  `mutation-gate [${pkg}] 变异测试率: covered ${r.coveredScore}% vs threshold ${threshold}%`
  + ` (killed ${r.killed} + timeout ${r.timeout} / covered ${r.killed + r.timeout + r.survived})`,
);
if (r.coveredScore < threshold) {
  if (mutationStrict) {
    console.error(`mutation-gate: FAIL —— 变异 covered ${r.coveredScore}% 低于 threshold ${threshold}%（strict=${mutationStrict}）`);
    failed = true;
  } else {
    console.warn(`mutation-gate: WARN —— 变异 covered ${r.coveredScore}% 低于 threshold ${threshold}%，strict=false 观察态不拦截（#150 达标后自动变硬）`);
  }
}

if (failed) process.exit(1);
console.log(`mutation-gate: ${pkg} 双指标通过`);
