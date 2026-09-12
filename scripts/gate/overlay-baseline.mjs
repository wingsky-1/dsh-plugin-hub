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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BASELINE_FILE_RE,
  GH_API_PER_PAGE,
  classifyMissingMutationProducts,
  classifyRemoteProbe,
  expectedBaselineFiles,
  mergeArtifactPage,
  mutationArtifacts,
  reconcileArchive,
} from './baseline-archive.mjs';
import { buildManifest, hashFile, pushBaselineTree } from './baseline-push.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const commitSha = process.env.COMMIT_SHA || execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.OBSERVE_PAT;
const BRANCH = 'baseline/mutation';
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB
const PROBE_ATTEMPTS = 3;
// 与 orphan-baseline.mjs 共用同一退避口径（测试置 0 避免拖慢套件）。
const RETRY_DELAY_MS = Number(process.env.ORPHAN_BASELINE_RETRY_DELAY_MS ?? 2000);

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 远端基线 ref 的三态探针——与 orphan-baseline.mjs 同一判据、同一重试规格。
 * 两入口若各写一套，就会重演「同一操作两份实现」的老问题（#718 的成因之一）。
 * `absent` 是确定结论，不再重试；只有环境故障才值得退避重试。
 */
function probeArchiveRef() {
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      runCmd('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${BRANCH}`], {
        // 无 TTY 时凭据缺失会让 git 挂起等待输入，显式关掉交互提示。
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
      return 'present';
    } catch (err) {
      const status = classifyRemoteProbe({
        ok: false,
        code: typeof err.status === 'number' ? err.status : null,
      });
      if (status !== 'unreachable') return status;
      if (attempt < PROBE_ATTEMPTS) {
        console.warn(`[overlay-baseline] ls-remote 探测基线分支失败，第 ${attempt}/${PROBE_ATTEMPTS} 次重试...`);
        sleepSync(RETRY_DELAY_MS);
      }
    }
  }
  return 'unreachable';
}

/**
 * 该 CI run 的 job 名清单（#718 S2.1）。只在「看不到变异产物」这一支调用——正常路径不为它多付
 * 一次 API 往返。取不到就返回空数组（= 判为「真·无产物」）：这个分流是为了**提高**报警灵敏度，
 * 不该因为多一次查询失败而把正常的纯文档 PR 判红。
 */
function fetchRunJobNames(runId) {
  try {
    return runGh([
      'api',
      '--paginate',
      `repos/${repo}/actions/runs/${runId}/jobs?per_page=${GH_API_PER_PAGE}`,
      '--jq',
      '.jobs[].name',
    ])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    console.warn(`[overlay-baseline] 查询 run jobs 失败，无法分流「产物过期」与「无产物」: ${err.message}`);
    return [];
  }
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
  const expiredArtifacts = artifacts.filter((a) => a?.expired === true);
  if (mutArtifacts.length === 0) {
    // #718 S2.1：分流「真·无产物」与「产物已过期/被删」。后者若也走静默 no-op，该 PR 命中段的
    // 新基线就永远进不了归档，而日志与前者完全同形（这是本缺陷此前无法从日志发现的原因）。
    const verdict = classifyMissingMutationProducts({
      jobNames: fetchRunJobNames(successfulCiRun.id),
      expiredArtifactCount: expiredArtifacts.length,
    });
    if (verdict.kind === 'lost') {
      console.error(`[overlay-baseline] ${verdict.reason} —— 该 PR 命中段的新基线未进归档（fail-loud）`);
      console.error(
        '[overlay-baseline] 处置：重跑该 PR 的 CI 后重新触发合并，或等下一次全量班次并集入档重建；'
        + '若为保留期过短所致，调 ci.yml 里变异产物的 retention-days。',
      );
      process.exit(1);
    }
    console.log(`[overlay-baseline] PR #${pr.number} ${verdict.reason}，安全跳过 (No-op)`);
    process.exit(0);
  }
  if (expiredArtifacts.length > 0) {
    // 部分过期：产物还在，能覆盖的先覆盖；但必须点名，否则「哪些段没被覆盖」只能靠人的记忆。
    console.warn(
      `[overlay-baseline] ::warning::本次 CI 有 ${expiredArtifacts.length} 个 artifact 已过期`
      + `（${expiredArtifacts.slice(0, 5).map((a) => a.name).join(', ')}${expiredArtifacts.length > 5 ? ' …' : ''}）`
      + '—— 其对应的段不会被本次覆盖',
    );
  }

  console.log(`[overlay-baseline] 发现 ${mutArtifacts.length} / ${artifacts.length} 个增量产物，准备执行差量覆盖 (Overlay)...`);

  // 4. 创建隔离的临时目录工作区
  const tmpWork = mkdtempSync(join(tmpdir(), 'dsh-overlay-'));
  const baselineDir = join(tmpWork, 'baseline');
  const artifactsDir = join(tmpWork, 'artifacts');
  const carriedForward = []; // 旧基线里带过来的段文件（对账用：区分「本次覆盖」与「沿用旧版」）
  const overlaid = []; // 本次真正写入的段文件
  // 远端 manifest：本次未覆盖的沿用段要保留它的条目（那里的 mtime 是上次真实测量时间）。
  let remoteManifest = {};
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  try {
    // 5. 先恢复孤立分支的现存基线全量快照
    console.log(`[overlay-baseline] 恢复孤立分支 ${BRANCH} 现存基线...`);
    // 探针必须声明在 try 之外：catch 要靠它区分「首夜」与「探针没能给出否定结论」。
    // 上一版把声明放进 try、又在 catch 引用，命中即 ReferenceError——守卫成了死代码（#716 也是同一写法）。
    const probeStatus = probeArchiveRef();
    try {
      runCmd('git', ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`], {
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
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
        const why = probeStatus === 'present'
          ? `孤立分支 ${BRANCH} 存在但恢复失败`
          : `无法确认孤立分支 ${BRANCH} 是否存在（探针结果 ${probeStatus}）`;
        console.error(`[overlay-baseline] ${why}，拒绝以空快照覆盖（fail-loud）: ${err.message}`);
        process.exit(1);
      }
      console.log(`[overlay-baseline] 孤立分支 ${BRANCH} 尚不存在（首夜），基于当前产物构建全新快照`);
    }
    try {
      remoteManifest = JSON.parse(readFileSync(join(baselineDir, 'manifest.json'), 'utf8'));
    } catch {
      // 缺 manifest / 内容损坏：沿用段的陈旧判据取不到，但覆盖本身仍是对的，
      // 故降级为「现存条目一律重算」并点名，而不是让整次合并丢基线。
      console.warn('[overlay-baseline] 远端 manifest 不可用，沿用段的时间戳将按本次时间重算（陈旧判据降级）');
      remoteManifest = {};
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
      // #718 S2.1：有产物却一个都没覆盖成功 = 下载/解析全线失败或产物全部过期。旧实现只打印一句
      // 「跳过推送」就 exit 0，与「真·无产物」同形——整次合并的基线就这么静默丢掉了。
      const expiredNames = mutArtifacts.filter((a) => a?.expired === true).map((a) => a.name);
      console.error(
        `[overlay-baseline] 发现 ${mutArtifacts.length} 个变异产物但无一覆盖成功（`
        + (expiredNames.length > 0
          ? `其中 ${expiredNames.length} 个已过期: ${expiredNames.slice(0, 5).join(', ')}`
          : '下载或解析全部失败')
        + '）—— 本次合并的基线未更新（fail-loud）',
      );
      process.exitCode = 1;
      return;
    }

    // 6.5 对账（#714 后续修复）：期望集合 = stryker.conf.d 派生的段文件；缺口 = 既没被本次覆盖
    //     也不在旧基线里 —— 该段在归档分支上没有可用基线，后续每次 PR 门禁都会降级为全量重跑。
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

    // 7. 重建 manifest 并入档。写路径与夜间班的并集入档共用 baseline-push.mjs——同一操作两份实现
    //    正是 #718 的成因之一（两份各自漏修），回滚快照与带租约推送也由该模块统一承担。
    const allFiles = readdirSync(baselineDir)
      .filter((f) => BASELINE_FILE_RE.test(f))
      .sort();

    // 本次未覆盖的沿用段保留远端 manifest 条目：那里的 mtime 是上次真实测量时间，
    // 重新盖章会让「基线是否陈旧」无从判断（#718 S3.1 要修的那个坑）。
    const preserved = {};
    for (const f of allFiles) {
      if (!overlaid.includes(f) && remoteManifest[f]) preserved[f] = remoteManifest[f];
    }

    pushBaselineTree({
      target: token ? `https://x-access-token:${token}@github.com/${repo}.git` : 'origin',
      branch: BRANCH,
      entries: allFiles.map((f) => ({ name: f, blobSha: hashFile(join(baselineDir, f)) })),
      manifest: buildManifest(baselineDir, allFiles, preserved),
      subject: `chore(baseline): overlay incremental from PR #${pr.number} [skip ci]`,
      label: 'overlay-baseline',
      log: console.log,
    });
    console.log(`[overlay-baseline] 成功完成 PR #${pr.number} 产物差量覆盖并推至 ${BRANCH}！`);
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
