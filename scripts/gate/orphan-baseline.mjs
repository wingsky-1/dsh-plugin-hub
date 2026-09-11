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
 *     - 探针 `ls-remote --exit-code` 判三态：广告里有该 ref / 广告里没有 / 环境故障（每态均带退避重试）
 *     - 仅在「广告里没有该 ref」时输出 notice 并以退出码 0 降级全量（首夜）
 *     - 远端不可达、或 ref 存在但拉取失败、或树里有 blob 却无任何基线文件，一律 fail-loud 退出
 *       （拒绝以空基线继续——写路径上这意味着删段，见 #718）
 *     - 取到后浅拉取（fetch --depth=1）并把 incremental-*.json 与 manifest.json 恢复到 coverage/mutation/
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

import { classifyRemoteProbe, decideRestoreOutcome } from './baseline-archive.mjs';

const action = process.argv[2];
const BRANCH = 'baseline/mutation';
const TARGET_DIR = join(process.cwd(), 'coverage', 'mutation');
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB，防止巨型基线 JSON 突破 Node 默认 1MB maxBuffer
const PROBE_ATTEMPTS = 3;
// 环境故障（远端不可达）可能瞬时，按与 fetch 同规格的退避重试；测试用 0 秒避免拖慢套件。
const RETRY_DELAY_MS = Number(process.env.ORPHAN_BASELINE_RETRY_DELAY_MS ?? 2000);

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

/**
 * 需要**退出码**的 git 调用：探针靠 exit 2 区分「无匹配 ref」与「环境故障」，
 * 而 `ignoreError` 会把两者都压成 null，丢掉这个信息。
 */
function runGitProbe(args) {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
      // 无 TTY 时凭据缺失会让 git 挂起等待输入，显式关掉交互提示。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    return { ok: true, code: 0, stdout };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.status === 'number' ? err.status : null,
      stdout: err.stdout ? String(err.stdout).trim() : '',
    };
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

  // 探针：`--exit-code` 让 git 自己给出三态（0=广告里有这条 ref / 2=广告里没有 / 其它=环境故障）。
  // 不能用「stdout 是否为空」反推「ref 不存在」——服务端隐藏 ref 时两者同形，见 decideRestoreOutcome。
  // 环境故障可能瞬时，探针必须和 fetch 一样带退避重试：探针比它保护的操作更脆就本末倒置了。
  let probeStatus = 'unreachable';
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const res = runGitProbe(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${BRANCH}`]);
    probeStatus = classifyRemoteProbe({ ok: res.ok, code: res.code });
    if (probeStatus !== 'unreachable') break;
    if (attempt < PROBE_ATTEMPTS) {
      console.warn(`[orphan-baseline] ls-remote 探测基线分支失败，第 ${attempt}/${PROBE_ATTEMPTS} 次重试...`);
      sleep(RETRY_DELAY_MS);
    }
  }

  // ref 不在广告里就是首夜，直接降级——不必为一个取不到的 ref 白跑一轮 fetch 重试。
  // ref 存在才拉取；拉取失败说明基线确实在、只是取不到，交由 decideRestoreOutcome 判 fail。
  let fetched = false;
  if (probeStatus === 'present') {
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      const res = runGit(
        ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`],
        { ignoreError: true },
      );
      if (res !== null) {
        fetched = true;
        break;
      }
      if (attempt < PROBE_ATTEMPTS) {
        console.warn(`[orphan-baseline] Fetch 孤立分支失败，第 ${attempt}/${PROBE_ATTEMPTS} 次重试...`);
        sleep(RETRY_DELAY_MS);
      }
    }
  }

  const outcome = decideRestoreOutcome({ probeStatus, fetchOk: fetched });

  if (outcome.action === 'fail') {
    console.error(`[orphan-baseline] ${outcome.reason}（fail-loud，本次未执行变异测试）`);
    process.exit(1);
  }
  if (outcome.action === 'bootstrap') {
    console.log(`::notice::${outcome.reason}`);
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
    // 树里有 blob 却一个都不符合基线命名 = 归档形状漂移。写路径若继续，会用本班产物覆盖这些
    // 未知文件，所以按 fail-loud 处理——与「树为空」（真·空归档，首夜语义）区分开。
    console.error(
      `[orphan-baseline] 远端树含 ${lines.length} 个条目但无任何基线文件（命名漂移？），拒绝继续（fail-loud）`,
    );
    process.exit(1);
  }

} else {
  console.error(`[orphan-baseline] 未知动作: ${action}，用法: node scripts/gate/orphan-baseline.mjs [push|restore]`);
  process.exit(1);
}
