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

import {
  BASELINE_FILE_RE,
  GH_API_PER_PAGE,
  classifyRemoteProbe,
  expectedBaselineFiles,
  mergeArtifactPage,
  mutationArtifacts,
  reconcileArchive,
} from './baseline-archive.mjs';

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
    // fail-loud（#690 门禁纪律）：查询失败 ≠「查不到关联 PR」。后者是空数组、属正常 no-op；
    // 前者意味着无法判定这次合并是否需要覆盖基线，静默跳过会让归档更新无声丢失。
    console.error(`[overlay-baseline] 查询关联 PR 失败，未执行归档（fail-loud）: ${err.message}`);
    process.exit(1);
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
      `repos/${repo}/actions/runs?head_sha=${prHeadSha}&event=pull_request&status=completed&per_page=${GH_API_PER_PAGE}`,
      '--jq',
      '.workflow_runs',
    ]);
    runs = JSON.parse(raw);
  } catch (err) {
    // 与下方 artifacts 查询同一纪律：查不了就必须红，不能当成「没有成功的 CI Run」。
    console.error(`[overlay-baseline] 查询 PR #${pr.number} 的 Workflow Runs 失败，未执行归档（fail-loud）: ${err.message}`);
    process.exit(1);
  }

  const successfulCiRun = runs.find((r) => r.name === 'CI' && r.conclusion === 'success');
  if (!successfulCiRun) {
    console.log(`[overlay-baseline] PR #${pr.number} 未找到成功状态的 CI Run，跳过基线覆盖`);
    process.exit(0);
  }

  // 3. 检查是否有变异增量产物（必须分页取全：默认 30 条会截断，实测一次 PR CI 有 70 个 artifact，
  //    第 1 页只含 14 个 mutation-incremental —— 截断后强推会把其余段的旧基线固化，见 baseline-archive.mjs 头注释）
  let artifacts = [];
  try {
    let page = 1;
    let expectedTotal = null;
    // 硬上限：翻页条件用「已收条数 < total_count」，若上游返回短页且 total_count 偏大，
    // 没有上限就会无限重复请求同一页。20 页 × 100 条 = 2000，远超单次 run 的产物规模。
    const MAX_PAGES = 20;
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      const raw = runGh([
        'api',
        `repos/${repo}/actions/runs/${successfulCiRun.id}/artifacts?per_page=${GH_API_PER_PAGE}&page=${page}`,
      ]);
      const body = JSON.parse(raw);
      if (expectedTotal === null && typeof body.total_count === 'number') expectedTotal = body.total_count;
      const merged = mergeArtifactPage(artifacts, body, page);
      artifacts = merged.items;
      if (merged.nextPage === null) break;
      page = merged.nextPage;
      if (guard === MAX_PAGES - 1) {
        throw new Error(`artifact 分页超过 ${MAX_PAGES} 页仍未取完（拿到 ${artifacts.length} / total_count ${expectedTotal}）`);
      }
    }
    if (expectedTotal !== null && artifacts.length < expectedTotal) {
      throw new Error(`artifact 分页取全失败：拿到 ${artifacts.length} / total_count ${expectedTotal}`);
    }
    console.log(`[overlay-baseline] artifact 分页取全：${artifacts.length} / total_count ${expectedTotal ?? artifacts.length}`);
  } catch (err) {
    // fail-loud（#690 门禁纪律：环境/数据获取失败不得静默降级为成功）。
    // 「查不到产物」与「确实没有产物」是两回事：前者说明归档没同步，必须让合并后的
    // baseline-overlay 步骤红，否则缺口会被静默固化（本缺陷的历史形态）。
    console.error(`[overlay-baseline] 查询 Artifacts 列表失败，未执行归档（fail-loud）: ${err.message}`);
    process.exit(1);
  }

  const mutArtifacts = mutationArtifacts(artifacts);
  if (mutArtifacts.length === 0) {
    console.log(`[overlay-baseline] PR #${pr.number} 未产生任何增量变异产物（纯文档/未触及变异切片），安全跳过 (No-op)`);
    process.exit(0);
  }

  console.log(`[overlay-baseline] 发现 ${mutArtifacts.length} / ${artifacts.length} 个增量产物，准备执行差量覆盖 (Overlay)...`);

  // 4. 创建隔离的临时目录工作区
  const tmpWork = mkdtempSync(join(tmpdir(), 'dsh-overlay-'));
  const baselineDir = join(tmpWork, 'baseline');
  const artifactsDir = join(tmpWork, 'artifacts');
  const carriedForward = []; // 旧基线里带过来的段文件（对账用：区分「本次覆盖」与「沿用旧版」）
  const overlaid = []; // 本次真正写入的段文件
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  try {
    // 5. 先恢复孤立分支的现存基线全量快照
    console.log(`[overlay-baseline] 恢复孤立分支 ${BRANCH} 现存基线...`);
    try {
      // 与 orphan-baseline.mjs 共用**同一个探针与同一套分类**（判据只允许一处实现）：
      // `ls-remote --exit-code` 的 0 / 2 / 其它 分别是「广告里有这条 ref」/「广告里没有」/「环境故障」。
      // 这里原本用 `gh api .../git/ref/heads/<branch>`，其失败被裸 catch 吞成「首夜」——
      // 正是 2026-09-11 05:18 事故的原始形态；#716 只修了「探针成功但 fetch 失败」那一半。
      let probeStatus = 'unreachable';
      try {
        runCmd('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${BRANCH}`], {
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
        probeStatus = 'present';
      } catch (probeErr) {
        probeStatus = classifyRemoteProbe({
          ok: false,
          code: typeof probeErr.status === 'number' ? probeErr.status : null,
        });
      }
      runCmd('git', ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`]);
      const treeOutput = runCmd('git', ['ls-tree', '-r', 'FETCH_HEAD']);
      for (const line of treeOutput.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        const fileName = parts[1];
        if (BASELINE_FILE_RE.test(fileName) || fileName === 'manifest.json') {
          const content = runCmd('git', ['show', `FETCH_HEAD:${fileName}`]);
          writeFileSync(join(baselineDir, fileName), content);
          if (BASELINE_FILE_RE.test(fileName)) carriedForward.push(fileName);
        }
      }
    } catch (err) {
      // 只有「广告里确实没有这条 ref」才是首夜；探针没能给出否定结论时一律拒绝以空快照覆盖。
      if (probeStatus !== 'absent') {
        console.error(
          `[overlay-baseline] 无法确认孤立分支 ${BRANCH} 是否存在（探针结果 ${probeStatus}），拒绝以空快照覆盖（fail-loud）: ${err.message}`,
        );
        process.exit(1);
      }
      console.log(`[overlay-baseline] 孤立分支 ${BRANCH} 尚不存在（首夜），基于当前产物构建全新快照`);
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
      if (files.length === 0) {
        // 下载成功但目录里没有预期文件名：说明 upload 的 path 约定与这里不一致（段名/命名漂移），
        // 静默跳过会让该段永远没有基线，故显式点名。
        console.warn(`[overlay-baseline] 产物 ${art.name} 内无 incremental-*.json（实际: ${readdirSync(downloadPath).join(', ') || '空目录'}）`);
        continue;
      }
      for (const f of files) {
        const src = join(downloadPath, f);
        const dst = join(baselineDir, f);
        let content;
        try {
          content = readFileSync(src, 'utf8');
        } catch (readErr) {
          console.warn(`[overlay-baseline] 文件 ${f} 读取失败，拒绝覆盖: ${readErr.message}`);
          continue;
        }
        try {
          JSON.parse(content); // 严格校验合法 JSON
        } catch (parseErr) {
          console.warn(`[overlay-baseline] 文件 ${f} 非有效 JSON（大小 ${content.length}B），拒绝覆盖: ${parseErr.message}`);
          continue;
        }
        writeFileSync(dst, content);
        overlayCount++;
        overlaid.push(f);
        console.log(`[overlay-baseline] 差量覆盖: ${f}`);
      }
    }

    if (overlayCount === 0) {
      console.log('[overlay-baseline] 没有成功覆盖任何有效基线文件，跳过推送');
      process.exit(0);
    }

    // 6.5 对账（#714 后续修复）：期望集合 = stryker.conf.d 派生的段文件；缺口 = 既没被本次覆盖
    //     也不在旧基线里 —— 该段在归档分支上没有可用基线，增量班次每次都会全量重跑。
    //     不拒绝推送（拒绝会让归档停在更旧的树），但必须判红点名，暴露上游问题。
    const expected = expectedBaselineFiles(readdirSync(join(process.cwd(), 'stryker.conf.d')));
    const reconciled = reconcileArchive({ expected, overlaid, carriedForward });
    console.log(
      `[overlay-baseline] 对账：期望 ${expected.length} 段，本次覆盖 ${reconciled.overlaidCount} 段，`
      + `沿用旧基线 ${reconciled.carriedCount} 段`,
    );
    let archiveGap = false;
    if (reconciled.missing.length > 0) {
      archiveGap = true;
      console.error(
        `[overlay-baseline] 归档缺口 ${reconciled.missing.length} 段（既未覆盖也不在旧基线）：`
        + reconciled.missing.join(', '),
      );
      console.error('[overlay-baseline] 这些段将每次全量重跑。检查上游：产物是否上传成功 / 分页是否取全 / 段配置是否漂移。');
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
    if (archiveGap) {
      console.error('[overlay-baseline] 归档已更新，但存在缺口（见上）—— 本次以非零退出暴露问题');
      process.exitCode = 1;
    }
  } finally {
    rmSync(tmpWork, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[overlay-baseline] 异常退出: ${err.stack || err.message}`);
  process.exit(1);
});
