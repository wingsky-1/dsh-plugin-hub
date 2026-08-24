#!/usr/bin/env node
/**
 * threshold-monotonic — 阈值单调性校验（#85 v3 F3 兜底）
 *
 * 对比工作区 gauntlet.config.json 与指定 git 基准（默认 origin/main）中的同名文件：
 *   - coverage.selfWrittenFunctions.threshold：只许升不许降；
 *   - mutation.packages.<pkg>.threshold：只许升不许降；新增包/新增字段不受限。
 * 降线必须走原 issue 内 approved 流程改基线，而不是悄悄调低阈值。
 *
 * 用法：node scripts/gate/threshold-monotonic.mjs [git-ref]
 * 退出码：0 = 无降线；1 = 存在降线；2 = 环境/数据错误
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const baseRef = process.argv[2] ?? 'origin/main';

function gauntletExistsInGit(ref) {
  // 区分「基准上确实没有此文件」与「git 环境故障」——后者必须判红而非放行（评审 F6）
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:scripts/data/gauntlet.config.json`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err.status === 1) return false;   // cat-file 对不存在对象退出 1
    throw err;                             // 其它（ref 缺失/仓库异常）上抛
  }
}

function readGauntletFromGit(ref) {
  return JSON.parse(
    execFileSync('git', ['show', `${ref}:scripts/data/gauntlet.config.json`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

let oldCfg;
try {
  if (!gauntletExistsInGit(baseRef)) {
    // 基准上尚无 config（首次引入本文件的 PR）：无从对比，放行并说明
    console.log(`threshold-monotonic: ${baseRef} 上无 gauntlet.config.json —— 首次引入，跳过单调性对比`);
    process.exit(0);
  }
  oldCfg = readGauntletFromGit(baseRef);
} catch (err) {
  console.error(`threshold-monotonic: 读取 ${baseRef} 基准失败：${err.message} —— 环境故障按 fail-closed 处理`);
  process.exit(2);
}

let newCfg;
try {
  newCfg = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'data', 'gauntlet.config.json'), 'utf8'));
} catch (err) {
  console.error(`threshold-monotonic: 工作区 config 解析失败：${err.message}`);
  process.exit(2);
}

let failures = 0;

// coverage.selfWrittenFunctions.threshold
const oldSelf = oldCfg?.coverage?.selfWrittenFunctions?.threshold;
const newSelf = newCfg?.coverage?.selfWrittenFunctions?.threshold;
if (typeof oldSelf === 'number' && typeof newSelf === 'number' && newSelf < oldSelf) {
  console.error(`[FAIL] coverage.selfWrittenFunctions.threshold 降线：${oldSelf} → ${newSelf}（须原 issue 内 approved 后方可下调）`);
  failures += 1;
}

// mutation.packages.<pkg>.threshold
const oldPkgs = oldCfg?.mutation?.packages ?? {};
const newPkgs = newCfg?.mutation?.packages ?? {};
for (const [pkg, cfg] of Object.entries(newPkgs)) {
  const oldThreshold = oldPkgs[pkg]?.threshold;
  const newThreshold = cfg?.threshold;
  if (
    typeof oldThreshold === 'number' &&
    typeof newThreshold === 'number' &&
    newThreshold < oldThreshold
  ) {
    console.error(`[FAIL] mutation.packages.${pkg}.threshold 降线：${oldThreshold} → ${newThreshold}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\nthreshold-monotonic: ${failures} 处降线 —— 阈值治理红线（AGENTS.md / #85 v3 F3）`);
  process.exit(1);
}
console.log('threshold-monotonic: 无阈值降线，校验通过');
