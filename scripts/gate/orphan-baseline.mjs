#!/usr/bin/env node
/**
 * orphan-baseline.mjs — 变异测试基线孤立分支（baseline/mutation）管理脚本
 *
 * 核心目标：
 * 替代旧方案（#204 方案 A：把 20 份巨型 JSON 提交到 main 分支 scripts/gate/baseline/ 并自动建 PR），
 * 改为将增量基线纯文本树直接提交至独立的孤立分支 refs/heads/baseline/mutation（深度恒为 1）。
 *
 * 动作：
 *   node scripts/gate/orphan-baseline.mjs push
 *     - 从 coverage/mutation/ 收集 incremental-*.json 产物
 *     - 生成 coverage/mutation/manifest.json（文件级 size/mtime/sha256）
 *     - 用 git plumbing（hash-object -> mktree -> commit-tree）生成单 Commit 纯文本树
 *     - 强制推送到 refs/heads/baseline/mutation
 *
 *   node scripts/gate/orphan-baseline.mjs restore
 *     - 从 refs/heads/baseline/mutation 浅拉取（fetch --depth=1，带 3 次退避重试）
 *     - 将 incremental-*.json 与 manifest.json 恢复到 coverage/mutation/
 *     - 分支不存在或拉取失败时输出 notice 并以退出码 0 安全降级全量
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const action = process.argv[2];
const BRANCH = 'baseline/mutation';
const TARGET_DIR = join(process.cwd(), 'coverage', 'mutation');
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB，防止巨型基线 JSON 突破 Node 默认 1MB maxBuffer

function runGit(args, options = {}) {
  const { input, env, ignoreError = false } = options;
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      input,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env },
    }).trim();
  } catch (err) {
    if (ignoreError) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (action === 'push') {
  if (!existsSync(TARGET_DIR)) {
    console.error(`[orphan-baseline] 源目录不存在: ${TARGET_DIR}`);
    process.exit(1);
  }

  const baselineFiles = readdirSync(TARGET_DIR)
    .filter((f) => /^incremental-.+\.json$/.test(f))
    .sort();

  if (baselineFiles.length === 0) {
    console.error('[orphan-baseline] 未找到任何 incremental-*.json 基线文件，变异测试未产生可用基线');
    process.exit(1);
  }

  // 1. 生成 manifest.json
  const manifest = {};
  for (const f of baselineFiles) {
    const fullPath = join(TARGET_DIR, f);
    const buf = readFileSync(fullPath);
    const st = statSync(fullPath);
    manifest[f] = {
      size: buf.length,
      mtime: st.mtime.toISOString(),
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  const manifestPath = join(TARGET_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const allFiles = [...baselineFiles, 'manifest.json'];

  console.log(`[orphan-baseline] 准备提交 ${allFiles.length} 个基线文件到孤立分支 ${BRANCH}...`);

  // 2. 用 Git plumbing 构建纯文本 Tree（享受 Git Blob 原生内容寻址与去重红利）
  const mktreeLines = [];
  for (const f of allFiles) {
    const fullPath = join(TARGET_DIR, f);
    const blobSha = runGit(['hash-object', '-w', fullPath]);
    mktreeLines.push(`100644 blob ${blobSha}\t${f}`);
  }
  const treeSha = runGit(['mktree'], { input: mktreeLines.join('\n') + '\n' });

  // 3. 构建无父节点的孤立 Commit（单 commit 纯快照）
  const commitSha = runGit(
    ['commit-tree', treeSha, '-m', 'chore(ci): update mutation baseline snapshot [skip ci]'],
    {
      env: {
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com',
      },
    },
  );

  // 4. 组装远程推送目标
  const token = process.env.OBSERVE_PAT || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const remoteTarget = token && repo
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : 'origin';

  console.log(`[orphan-baseline] 强推 commit ${commitSha.slice(0, 8)} 到 refs/heads/${BRANCH}...`);
  runGit(['push', '--force', remoteTarget, `${commitSha}:refs/heads/${BRANCH}`]);
  console.log(`[orphan-baseline] 成功同步基线至孤立分支 ${BRANCH}（包含 ${allFiles.length} 份文件）`);

} else if (action === 'restore') {
  mkdirSync(TARGET_DIR, { recursive: true });

  // 带有退避重试的 fetch 机制（抵御 Runner 网络突发抖动）
  let fetched = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = runGit(
      ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`],
      { ignoreError: true },
    );
    if (res !== null) {
      fetched = true;
      break;
    }
    if (attempt < 3) {
      console.warn(`[orphan-baseline] Fetch 孤立分支失败，第 ${attempt}/3 次重试（等待 2s）...`);
      sleep(2000);
    }
  }

  if (!fetched) {
    console.log(`::notice::孤立分支 refs/heads/${BRANCH} 不可达或暂无基线，本次安全降级为全量变异`);
    process.exit(0);
  }

  // 遍历远端 commit 中的文件并写回目标目录
  const treeOutput = runGit(['ls-tree', '-r', 'FETCH_HEAD'], { ignoreError: true });
  if (!treeOutput) {
    console.log('::notice::孤立分支基线树为空，本次安全降级为全量变异');
    process.exit(0);
  }

  const lines = treeOutput.split('\n').filter(Boolean);
  let restored = 0;
  for (const line of lines) {
    const match = line.match(/^100644\s+blob\s+[0-9a-f]{40}\t(.+)$/);
    if (!match) continue;
    const fileName = match[1];
    if (/^incremental-.+\.json$/.test(fileName) || fileName === 'manifest.json') {
      const content = runGit(['show', `FETCH_HEAD:${fileName}`]);
      writeFileSync(join(TARGET_DIR, fileName), content);
      restored++;
    }
  }

  if (restored > 0) {
    console.log(`[orphan-baseline] 成功恢复 ${restored} 份基线文件至 ${TARGET_DIR}`);
  } else {
    console.log('::notice::孤立分支中未发现基线文件，本次安全降级为全量变异');
  }

} else {
  console.error(`[orphan-baseline] 未知动作: ${action}，用法: node scripts/gate/orphan-baseline.mjs [push|restore]`);
  process.exit(1);
}
