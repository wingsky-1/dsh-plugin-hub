#!/usr/bin/env node
/**
 * mutation-gate — PR 增量变异门禁变异率判分（#178 v2；#217 起由 mutation-verdict
 * job 在 artifact 汇合后统一调用）
 *
 * 时序假设（#217 变异/覆盖解耦；#722 阶段三起覆盖率维度上移）：
 *   1. coverage job 单次跑 pnpm cov，阈值判分由 vitest 的 coverage.thresholds
 *      在该 job 内 fail-closed 完成，本脚本不再读覆盖率数据；
 *   2. mutation-gate 矩阵各实例只做基线 restore + stryker run，报告经
 *      upload-artifact 下发；
 *   3. mutation-verdict job 用 download-artifact 把报告还原到本脚本约定的
 *      固定路径后，才调用本脚本逐包判分。
 *
 * 输入（运行时必须已在工作区就位，来自上游 artifact 下发）：
 *   - coverage/mutation/<pkg>.json     Stryker JSON 报告（incremental 运行产物，
 *                                      复用 mutant 继承原状态，报告恒为全量口径）
 *   - scripts/data/gauntlet.config.json（变异阈值唯一事实源，随 checkout 就位）
 *
 * 用法：node scripts/gate/mutation-gate.mjs <pkg>   # pkg 形如 dsh-mcp-manager
 *
 * 判分（单项指标）：
 *   变异测试率：covered score ≥ mutation.packages[pkg].threshold
 *     —— 受全局 mutation.strict 开关约束：false 期间仅标注不拦截
 *     （provider-usage 在 #150 达标翻转 strict 后自动变硬，避免达标前卡死触该包的 PR）。
 *
 * 覆盖率维度为何不在此判：其 fail-closed 由 needs 链承担——mutation-verdict 的 if
 * 显式要求 needs.coverage.result == 'success'，coverage 失败则本 job skipped，repo-gate
 * 判定表按 GATE_COVERAGE 维度点名连坐。阈值唯一事实源是 vitest.config.ts 的
 * coverage.thresholds（#722 阶段三 D1：避免同一数字在配置与脚本两处漂移）。
 *
 * 退出码：0 = 通过；1 = 门禁违约；2 = 环境/数据缺失错误（fail-closed）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMutationReport, readMutationReportsAgg } from '../lib/mutation-report-lib.mjs';

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

let failed = false;

// ── 变异测试率（covered 口径，受 mutation.strict 约束）──────────
// #220 B 方案：包可拆分为多个段配置（<pkg>-<seg>.json），各段独立 matrix 实例
// 产出 <pkg>-<seg>.json 报告；此处按段报告聚合（mutant id 去重）为包级口径。
// 未拆分包仍读单报告 <pkg>.json。任一段报告缺失即 fail-closed。
const reportDir = join(repoRoot, 'coverage', 'mutation');
let r = null;
{
  // 期望段名由 stryker.conf.d/ 实际存在的 <pkg>-<后缀>.json 推导（单一事实源；
  // 后缀即功能段名，数字段名亦兼容——#342 二期功能命名改造）；报告必须与段
  // 配置一一对应，缺任一段 = 链路异常，fail-closed
  const confDir = join(repoRoot, 'stryker.conf.d');
  const expectedSegs = readdirSync(confDir)
    .map((f) => (f.match(new RegExp(`^${pkg}-(.+)\\.json$`)) ?? [])[1])
    .filter(Boolean)
    .sort();
  const segPaths = expectedSegs.map((n) => {
    const p = join(reportDir, `${pkg}-${n}.json`);
    if (!existsSync(p)) {
      console.error(`mutation-gate: ${pkg} 段 ${n} 报告缺失（${p}）—— 段 matrix 实例未产出，fail-closed`);
      process.exit(2);
    }
    return p;
  });
  if (segPaths.length > 0) {
    r = readMutationReportsAgg(segPaths);
    if (!r) {
      console.error(`mutation-gate: ${pkg} 段式报告缺失或不可解析（${segPaths.length} 份中存在异常）—— fail-closed`);
      process.exit(2);
    }
  } else {
    const singlePath = join(reportDir, `${pkg}.json`);
    r = readMutationReport(singlePath);
    if (!r) {
      // stryker 步骤成功后报告必然存在；缺失 = 报告 artifact 未下发（链路异常）
      // 而非门禁语义，一律判红
      console.error(`mutation-gate: ${pkg} 变异报告缺失或不可解析（${singlePath}）—— stryker 报告 artifact 未下发，fail-closed`);
      process.exit(2);
    }
  }
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
console.log(`mutation-gate: ${pkg} 变异率通过`);
