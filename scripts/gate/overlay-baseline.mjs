#!/usr/bin/env node
/**
 * scripts/gate/overlay-baseline.mjs — PR 增量变异产物合入秒级覆盖同步脚本（#572）
 *
 * 核心机制：
 * 当 PR 被合入 main 时，无需重新运行耗时的变异测试，直接复用该 PR 在 CI 门禁阶段
 * 产出的最新 incremental 基线产物（mutation-incremental-* artifacts），
 * 差量覆盖（Overlay）到当前孤立分支 refs/heads/baseline/mutation 上，15 秒内完成同步。
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repo = process.env.GITHUB_REPOSITORY;
const commitSha = process.env.COMMIT_SHA || execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.OBSERVE_PAT;
const BRANCH = 'baseline/mutation';
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB

function runCmd(cmd, args = [], options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

function runGh(args) {
  return runCmd('gh', args, { env: token ? { GH_TOKEN: token } : {} });
}

async function main() {
  if (!repo) {
    console.error('[overlay-baseline] 缺失 GITHUB_REPOSITORY 环境变量');
    process.exit(1);
  }

  console.log(`[overlay-baseline] 正在反查 Commit ${commitSha.slice(0, 8)} 关联的已合并 PR...`);

  // 1. 权威反查 Commit 关联的 PR
  let pulls;
  try {
    const raw = runGh(['api', `repos/${repo}/commits/${commitSha}/pulls`]);
    pulls = JSON.parse(raw);
  } catch (err) {
    console.log(`[overlay-baseline] 查询关联 PR 失败或无关联，安全跳过 (No-op): ${err.message}`);
    process.exit(0);
  }

  if (!Array.isArray(pulls) || pulls.length === 0) {
    console.log('[overlay-baseline] 该 Commit 不是 PR 合并（可能是直接推送），安全跳过 (No-op)');
    process.exit(0);
  }

  const pr = pulls.find((p) => p.merged_at);
  if (!pr) {
    console.log('[overlay-baseline] 关联的 PR 尚未标记为 merged，安全跳过 (No-op)');
    process.exit(0);
  }

  const prHeadSha = pr.head.sha;
  console.log(`[overlay-baseline] 锁定已合并 PR #${pr.number} (head: ${prHeadSha.slice(0, 8)})`);

  // 2. 定位 PR 在 ci.yml 中的最新成功 Run
  let runs;
  try {
    const raw = runGh([
      'api',
      `repos/${repo}/actions/runs?head_sha=${prHeadSha}&event=pull_request&status=completed`,
      '--jq',
      '.workflow_runs',
    ]);
    runs = JSON.parse(raw);
  } catch (err) {
    console.log(`[overlay-baseline] 查询 PR #${pr.number} 的 Workflow Runs 失败，跳过基线覆盖: ${err.message}`);
    process.exit(0);
  }

  const successfulCiRun = runs.find((r) => r.name === 'CI' && r.conclusion === 'success');
  if (!successfulCiRun) {
    console.log(`[overlay-baseline] PR #${pr.number} 未找到成功状态的 CI Run，跳过基线覆盖`);
    process.exit(0);
  }

  // 3. 检查是否有变异增量产物
  let artifacts;
  try {
    const raw = runGh([
      'api',
      `repos/${repo}/actions/runs/${successfulCiRun.id}/artifacts`,
      '--jq',
      '.artifacts',
    ]);
    artifacts = JSON.parse(raw);
  } catch (err) {
    console.log(`[overlay-baseline] 查询 Artifacts 列表失败，跳过基线覆盖: ${err.message}`);
    process.exit(0);
  }

  const mutArtifacts = (artifacts || []).filter((a) => a.name.startsWith('mutation-incremental-'));
  if (mutArtifacts.length === 0) {
    console.log(`[overlay-baseline] PR #${pr.number} 未产生任何增量变异产物（纯文档/未触及变异切片），安全跳过 (No-op)`);
    process.exit(0);
  }

  console.log(`[overlay-baseline] 发现 ${mutArtifacts.length} 个增量产物，准备执行差量覆盖 (Overlay)...`);

  // 4. 创建隔离的临时目录工作区
  const tmpWork = mkdtempSync(join(tmpdir(), 'dsh-overlay-'));
  const baselineDir = join(tmpWork, 'baseline');
  const artifactsDir = join(tmpWork, 'artifacts');
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  try {
    // 5. 先恢复孤立分支的现存基线全量快照
    console.log(`[overlay-baseline] 恢复孤立分支 ${BRANCH} 现存基线...`);
    try {
      runCmd('git', ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`]);
      const treeOutput = runCmd('git', ['ls-tree', '-r', 'FETCH_HEAD']);
      for (const line of treeOutput.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        const fileName = parts[1];
        if (/^incremental-.+\.json$/.test(fileName) || fileName === 'manifest.json') {
          const content = runCmd('git', ['show', `FETCH_HEAD:${fileName}`]);
          writeFileSync(join(baselineDir, fileName), content);
        }
      }
    } catch {
      console.log(`[overlay-baseline] 孤立分支 ${BRANCH} 尚不可达或为空，将基于当前产物构建全新快照`);
    }

    // 6. 逐个下载增量产物并覆盖同名基线
    let overlayCount = 0;
    for (const art of mutArtifacts) {
      if (!/^[a-zA-Z0-9_-]+$/.test(art.name)) continue;
      const downloadPath = join(artifactsDir, art.name);
      mkdirSync(downloadPath, { recursive: true });

      try {
        runGh(['run', 'download', String(successfulCiRun.id), '-n', art.name, '-D', downloadPath]);
      } catch (err) {
        console.warn(`[overlay-baseline] 下载产物 ${art.name} 失败，跳过该项: ${err.message}`);
        continue;
      }

      const files = readdirSync(downloadPath).filter((f) => /^incremental-.+\.json$/.test(f));
      for (const f of files) {
        const src = join(downloadPath, f);
        const dst = join(baselineDir, f);
        try {
          const content = readFileSync(src, 'utf8');
          JSON.parse(content); // 严格校验合法 JSON
          writeFileSync(dst, content);
          overlayCount++;
          console.log(`[overlay-baseline] 差量覆盖: ${f}`);
        } catch {
          console.warn(`[overlay-baseline] 文件 ${f} 损坏或非有效 JSON，拒绝覆盖`);
        }
      }
    }

    if (overlayCount === 0) {
      console.log('[overlay-baseline] 没有成功覆盖任何有效基线文件，跳过推送');
      process.exit(0);
    }

    // 7. 重新校准并生成 manifest.json
    const allFiles = readdirSync(baselineDir)
      .filter((f) => /^incremental-.+\.json$/.test(f))
      .sort();

    const manifest = {};
    for (const f of allFiles) {
      const fullPath = join(baselineDir, f);
      const buf = readFileSync(fullPath);
      const st = statSync(fullPath);
      manifest[f] = {
        size: buf.length,
        mtime: st.mtime.toISOString(),
        sha256: createHash('sha256').update(buf).digest('hex'),
      };
    }
    writeFileSync(join(baselineDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    allFiles.push('manifest.json');

    // 8. 用 Git plumbing 构建孤立 commit 并推送
    console.log(`[overlay-baseline] 准备提交 ${allFiles.length} 个基线文件到孤立分支...`);
    const mktreeLines = [];
    for (const f of allFiles) {
      const fullPath = join(baselineDir, f);
      const blobSha = runCmd('git', ['hash-object', '-w', fullPath]);
      mktreeLines.push(`100644 blob ${blobSha}\t${f}`);
    }

    const treeSha = execFileSync('git', ['mktree'], {
      input: mktreeLines.join('\n') + '\n',
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    }).trim();

    const commitMsg = `chore(baseline): overlay incremental from PR #${pr.number} [skip ci]`;
    const commitShaNew = runCmd(
      'git',
      ['commit-tree', treeSha, '-m', commitMsg],
      {
        env: {
          GIT_AUTHOR_NAME: 'github-actions[bot]',
          GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com',
          GIT_COMMITTER_NAME: 'github-actions[bot]',
          GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com',
        },
      },
    );

    const remoteTarget = token
      ? `https://x-access-token:${token}@github.com/${repo}.git`
      : 'origin';

    runCmd('git', ['push', '--force', remoteTarget, `${commitShaNew}:refs/heads/${BRANCH}`]);
    console.log(`[overlay-baseline] 成功完成 PR #${pr.number} 产物差量覆盖并强推至 ${BRANCH}！`);
  } finally {
    rmSync(tmpWork, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[overlay-baseline] 异常退出: ${err.stack || err.message}`);
  process.exit(1);
});
