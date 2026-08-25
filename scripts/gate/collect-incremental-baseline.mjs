#!/usr/bin/env node
/**
 * collect-incremental-baseline — 夜间增量基线收集（#204，替代 actions/cache save）
 *
 * 把六包 Stryker incremental 基线从 coverage/mutation/ 收集到仓库内固定路径
 * scripts/gate/baseline/，供 PR 的 mutation-gate 直接读文件（git 跨 ref 天然
 * 可见，不依赖 actions/cache 的平台缓存 ref 隔离行为——#204 实证 PR 永远
 * miss main 的缓存）。
 *
 * 用法：node scripts/gate/collect-incremental-baseline.mjs
 * 行为：
 *   1. 扫描 coverage/mutation/incremental-*.json（六包产物）；
 *   2. 汇总拷贝到 scripts/gate/baseline/incremental-<pkg>.json；
 *   3. 生成 scripts/gate/baseline/manifest.json（每包：源文件 mtime/size/hash），
 *      供后续判定「基线是否有实质变化」（无变化不建 PR，防噪音提交）；
 *   4. 退出码：0 = 有基线文件就绪；1 = 无任何基线产物（不应发生在夜间末尾）。
 * 本脚本只做文件收集与清单输出，不 commit 不 push —— 仓库内改动由
 * workflow 中 create-pull-request 步骤完成。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const srcDir = join(repoRoot, 'coverage', 'mutation');
const dstDir = join(repoRoot, 'scripts', 'gate', 'baseline');

const PKGS = ['notifier', 'idle-archive', 'web-file-preview', 'mcp-manager', 'provider-usage', 'lan-proxy'];

if (!existsSync(srcDir)) {
  console.error(`collect-incremental-baseline: 源目录不存在：${srcDir}`);
  process.exit(1);
}

mkdirSync(dstDir, { recursive: true });

const manifest = {};
let copied = 0;

for (const pkg of PKGS) {
  const src = join(srcDir, `incremental-${pkg}.json`);
  if (!existsSync(src)) {
    console.warn(`collect-incremental-baseline: 缺少 ${pkg} 基线（跳过）：${src}`);
    continue;
  }
  const dst = join(dstDir, `incremental-${pkg}.json`);
  copyFileSync(src, dst);
  const st = statSync(src);
  const buf = readFileSync(src);
  manifest[pkg] = {
    size: buf.length,
    mtime: st.mtime.toISOString(),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  copied++;
  console.log(`collect-incremental-baseline: ${pkg} → scripts/gate/baseline/incremental-${pkg}.json (${buf.length} bytes)`);
}

if (copied === 0) {
  console.error('collect-incremental-baseline: 无任何基线产物，夜间变异未产出可用基线');
  process.exit(1);
}

writeFileSync(join(dstDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`collect-incremental-baseline: 完成，${copied}/6 包基线就绪`);
