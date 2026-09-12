#!/usr/bin/env node
/**
 * scripts/gate/baseline-push.mjs — 归档分支写路径的共用管线（#718 S2.1）
 *
 * 为什么单独成文件：`baseline/mutation` 有两个写入方（夜间全量班的并集入档、PR 合并后的 overlay），
 * 两者都要「组纯文本树 → 建孤立 commit → 打回滚快照 → 带租约推送」。同一操作两份实现正是 #718
 * 的成因之一（探针判定、分页取全、对账都各写过一遍，随后各自漏修），故写路径只留这一份。
 *
 * 约定（与 #572 的存储形态绑定）：
 *   · 孤立分支深度恒为 1（`commit-tree` 不带父节点）——可回滚性由快照 tag 承担，不由父链承担；
 *   · 推送用带**显式期望值**的 `--force-with-lease`：本路径不做 fetch，无参形式会退化成裸 `--force`；
 *   · 沿用文件由调用方给 `blobSha`（直接复用远端已有 blob），字节级一致因而零新对象。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHIVE_SNAPSHOT_KEEP,
  BASELINE_MANIFEST_FILE,
  pruneSnapshotPlan,
  snapshotTagFor,
} from './baseline-archive.mjs';

const MAX_BUFFER = 64 * 1024 * 1024; // 64MB，防止巨型基线 JSON 突破 Node 默认 1MB maxBuffer
const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com',
};

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

export function hashFile(path) {
  return runGit(['hash-object', '-w', path]);
}

export function hashBlob(content) {
  return runGit(['hash-object', '-w', '--stdin'], { input: content });
}

/** manifest 的序列化形态（写入远端树与写入本地报告目录必须是同一份字节）。 */
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * manifest 条目。`preserved` 里的文件沿用其远端条目——那里的 mtime 是**上次真实测量时间**，
 * 重新盖章会让「基线是否陈旧」无从判断（#718 S3.1 要修的那个坑）。
 */
export function buildManifest(dir, names, preserved = {}) {
  const manifest = {};
  for (const f of names) {
    if (preserved[f]) {
      manifest[f] = preserved[f];
      continue;
    }
    const fullPath = join(dir, f);
    const buf = readFileSync(fullPath);
    manifest[f] = {
      size: buf.length,
      mtime: statSync(fullPath).mtime.toISOString(),
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  return manifest;
}

/** 归档分支当前 tip。空字符串 = 广告里没有这条 ref（首推）；取不到则抛错，不在未知状态下推送。 */
function remoteBranchTip(target, branch) {
  let stdout;
  try {
    stdout = execFileSync('git', ['ls-remote', '--heads', target, `refs/heads/${branch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
      // 无 TTY 时凭据缺失会让 git 挂起等待输入，显式关掉交互提示。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    throw new Error('无法读取归档分支 tip（远端不可达或凭据缺失），拒绝在未知状态下推送');
  }
  return stdout ? stdout.split(/\s+/)[0] : '';
}

/** 给旧 tip 打回滚快照 tag。必须先于新树推送——tag 指向的对象在推之前得是可达的。 */
function pushSnapshotTag(target, oldSha, keep, log) {
  const tag = snapshotTagFor(oldSha);
  runGit(['push', target, `${oldSha}:refs/tags/${tag}`]);
  log(`回滚快照：refs/tags/${tag}（保留最近 ${keep} 个）`);
}

function pruneSnapshotTags(target, keep, log) {
  const listed = runGit(['ls-remote', '--tags', target, 'refs/tags/baseline-snap-*'], { ignoreError: true });
  const refs = (listed ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean);
  const stale = pruneSnapshotPlan(refs, keep);
  if (stale.length === 0) return;
  // 逐个删除且不连坐：过期快照留着只是多占一个 ref，不影响本次写入的正确性。
  for (const ref of stale) runGit(['push', target, '--delete', ref], { ignoreError: true });
  log(`清理过期回滚快照 ${stale.length} 个`);
}

/**
 * 组树 → 建孤立 commit → 打快照 → 带租约推送。
 *
 * `entries` 为 `[{ name, blobSha }]`（沿用文件复用远端 blob sha）；`manifest` 由本函数序列化并
 * 作为树里的 manifest.json。给了 `manifestPath` 就同时落一份到本地（人工应急的 push 路径要用）。
 *
 * 推送前强制校验 **manifest 与树逐文件对齐**（双向）。这一条不是洁癖：2026-09-12 的并集入档
 * 首次上线时，manifest 只覆盖了「新算」的 31 段而漏掉「沿用」的 2 段，树本身正确（33 段没缩水）
 * 但 manifest 少 2 条——而 manifest 是留段时间戳与后续完整性校验的唯一依据。守卫放在这里，
 * 任何写入方漏算都会在**推送之前**炸掉，而不是把不对齐的归档推上去。
 */
export function pushBaselineTree({
  target,
  branch,
  entries,
  manifest,
  subject,
  keep = ARCHIVE_SNAPSHOT_KEEP,
  manifestPath,
  label = 'baseline-push',
  log = () => {},
}) {
  const say = (msg) => log(`[${label}] ${msg}`);
  const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = new Set(ordered.map((e) => e.name));
  const missing = [...names].filter((n) => !(n in manifest));
  const extra = Object.keys(manifest).filter((n) => !names.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `manifest 与树不对齐（缺 ${missing.length} 条${missing.length ? `: ${missing.slice(0, 5).join(', ')}` : ''}`
      + `；多 ${extra.length} 条${extra.length ? `: ${extra.slice(0, 5).join(', ')}` : ''}）——拒绝推送不对齐的归档`,
    );
  }
  const manifestBlobSha = hashBlob(serializeManifest(manifest));
  if (manifestPath) writeFileSync(manifestPath, serializeManifest(manifest));

  const allFiles = [...ordered.map((e) => e.name), BASELINE_MANIFEST_FILE];
  say(`准备提交 ${allFiles.length} 个基线文件到孤立分支 ${branch}...`);

  const mktreeLines = [
    ...ordered.map((e) => `100644 blob ${e.blobSha}\t${e.name}`),
    `100644 blob ${manifestBlobSha}\t${BASELINE_MANIFEST_FILE}`,
  ];
  const treeSha = runGit(['mktree'], { input: mktreeLines.join('\n') + '\n' });
  const commitSha = runGit(['commit-tree', treeSha, '-m', subject], { env: BOT_IDENTITY });

  const oldSha = remoteBranchTip(target, branch);
  if (oldSha) {
    pushSnapshotTag(target, oldSha, keep, say);
    pruneSnapshotTags(target, keep, say);
    say(`推送 commit ${commitSha.slice(0, 8)} 到 refs/heads/${branch}（租约 expect ${oldSha.slice(0, 8)}）...`);
    runGit([
      'push',
      `--force-with-lease=refs/heads/${branch}:${oldSha}`,
      target,
      `${commitSha}:refs/heads/${branch}`,
    ]);
  } else {
    say(`推送 commit ${commitSha.slice(0, 8)} 到 refs/heads/${branch}（首推）...`);
    runGit(['push', target, `${commitSha}:refs/heads/${branch}`]);
  }
  say(`成功同步基线至孤立分支 ${branch}（包含 ${allFiles.length} 份文件）`);
}
