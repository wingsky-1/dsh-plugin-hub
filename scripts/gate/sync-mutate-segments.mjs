#!/usr/bin/env node
/**
 * sync-mutate-segments — mutate 区间机器派生写入/校验（#276 方案 B 执行器）
 *
 * 从声明式分组（scripts/data/mutation-segments.json）+ 当前 lib 产物分段锚点
 * 派生各配置的 mutate 行号区间：
 *   --write  把派生区间写回 stryker.conf.d/*.json（CI build 后调用，保证本次
 *            run 的行号与刚构建的产物一致；本地跑会改工作区文件）；
 *   --check  只比对不写入：入库 conf 与派生结果不一致则 exit 1 并打印期望值
 *            （fail-with-fix，供 mutate-scope-guard F5 与提交前检查调用）。
 *
 * 产物不存在时静默跳过对应包（如单包构建场景）；声明错误（confFiles 与
 * groups 数量不一致、锚点解析失败）一律 exit 1。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeDeriver } from '../lib/mutation-segments-lib.mjs';

const repoRoot = process.cwd();
const mode = process.argv[2] ?? '--check';
if (mode !== '--write' && mode !== '--check') {
  console.error('用法：node scripts/gate/sync-mutate-segments.mjs [--write|--check]');
  process.exit(2);
}

const declPath = join(repoRoot, 'scripts', 'data', 'mutation-segments.json');
let decl;
try {
  decl = JSON.parse(readFileSync(declPath, 'utf8'));
} catch (err) {
  console.error(`sync-mutate-segments: 声明文件解析失败：${err.message}`);
  process.exit(2);
}
const derive = makeDeriver();
const pkgs = Object.keys(decl).filter((k) => k !== '$comment');

let okCount = 0;
let wroteCount = 0;
const problems = [];

for (const pkg of pkgs) {
  const libPath = join(repoRoot, 'packages', pkg, 'lib', 'index.js');
  if (!existsSync(libPath)) continue;
  const meta = decl[pkg];
  // groups 与「全部 confFiles 的 mutate 元素按声明顺序展平」一一对应
  const totalRanges = meta.confFiles.reduce((n, cf) => {
    const p = join(repoRoot, 'stryker.conf.d', cf);
    if (!existsSync(p)) return n;
    return n + JSON.parse(readFileSync(p, 'utf8')).mutate.length;
  }, 0);
  if (totalRanges !== meta.groups.length) {
    problems.push(`${pkg}: confFiles 合计 ${totalRanges} 个区间与 groups(${meta.groups.length}) 不一致——声明错误`);
    continue;
  }
  const derivedAll = derive(readFileSync(libPath, 'utf8'), meta.groups);
  if (!derivedAll) {
    problems.push(`${pkg}: 分组锚点解析失败——核对 scripts/data/mutation-segments.json`);
    continue;
  }
  let di = 0; // derived 游标
  for (const cf of meta.confFiles) {
    const confPath = join(repoRoot, 'stryker.conf.d', cf);
    if (!existsSync(confPath)) continue;
    const rel = `stryker.conf.d/${cf}`;
    const conf = JSON.parse(readFileSync(confPath, 'utf8'));
    let changed = false;
    conf.mutate = conf.mutate.map((r) => {
      const want = `packages/${pkg}/lib/index.js:${derivedAll[di].start}-${derivedAll[di].end}`;
      di++;
      if (r === want) {
        okCount++;
        return r;
      }
      changed = true;
      if (mode === '--write') {
        okCount++;
        return want;
      }
      problems.push(`${rel} 区间漂移：现 ${r} → 应为 ${want}`);
      return r;
    });
    if (changed && mode === '--write') {
      writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
      wroteCount++;
    }
  }
}

if (problems.length > 0) {
  console.error(`sync-mutate-segments (${mode}) 发现问题：\n  - ${problems.join('\n  - ')}`);
  if (mode === '--check') {
    console.error('修复方式：node scripts/gate/sync-mutate-segments.mjs --write 后提交；或核对 scripts/data/mutation-segments.json 分组声明');
  }
  process.exit(1);
}
console.log(`sync-mutate-segments (${mode}): ${okCount} 配置一致${wroteCount ? `，已更新 ${wroteCount}` : ''}`);
