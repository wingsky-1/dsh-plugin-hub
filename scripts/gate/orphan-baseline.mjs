#!/usr/bin/env node
/**
 * orphan-baseline.mjs — 变异测试基线孤立分支（baseline/mutation）管理脚本
 *
 * 核心目标：
 * 替代旧方案（#204 方案 A：把 20 份巨型 JSON 提交到 main 分支 scripts/gate/baseline/ 并自动建 PR），
 * 改为将增量基线纯文本树直接提交至独立的孤立分支 refs/heads/baseline/mutation（深度恒为 1）。
 *
 * 写入有两条动作，语义不同、不可混用：
 *   node scripts/gate/orphan-baseline.mjs archive（#718 S1.2，夜间全量班收口用）
 *     - 先取回远端现存基线，再与本次产物做**并集**：本次有的以本次为准（新算），
 *       本次没有但远端有的沿用旧文件（沿用），两边都没有的显式点名（缺）
 *     - 期望集合由 stryker.conf.d/ 派生；不在集合里的遗留文件从归档移除（退役）
 *     - 并集入档后「段被失败实例吃掉」在物理上不可能再发生（旧实现是整树替换，实测丢过 33 → 31）
 *     - 沿用文件直接复用远端 blob sha，字节级一致因而零新对象（保住内容去重红利）
 *
 *   node scripts/gate/orphan-baseline.mjs push（增量班用，退役前保留）
 *     - 从 coverage/mutation/ 收集 incremental-*.json 产物，整树推送（调用方已先 restore）
 *     - 生成 coverage/mutation/manifest.json（文件级 size/mtime/sha256）
 *
 *   两条动作共用：先给旧 tip 打回滚快照 tag（保留最近 N 个），再以显式租约强推新树。
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHIVE_SNAPSHOT_KEEP,
  ARCHIVE_SNAPSHOT_TAG_PREFIX,
  BASELINE_FILE_RE,
  BASELINE_MANIFEST_FILE,
  classifyRemoteProbe,
  decideRestoreOutcome,
  expectedBaselineFiles,
  planArchive,
  pruneSnapshotPlan,
  snapshotTagFor,
} from './baseline-archive.mjs';

const action = process.argv[2];
const BRANCH = 'baseline/mutation';
const CONF_DIR = join(process.cwd(), 'stryker.conf.d');
const TARGET_DIR = join(process.cwd(), 'coverage', 'mutation');
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB，防止巨型基线 JSON 突破 Node 默认 1MB maxBuffer
const PROBE_ATTEMPTS = 3;
// 环境故障（远端不可达）可能瞬时，按与 fetch 同规格的退避重试；测试用 0 秒避免拖慢套件。
const RETRY_DELAY_MS = Number(process.env.ORPHAN_BASELINE_RETRY_DELAY_MS ?? 2000);
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

/** 推送目标：CI 用带 token 的 URL（actions/checkout 的凭据不覆盖自定义 remote），本地退回 origin。 */
function remoteTarget() {
  const token = process.env.OBSERVE_PAT || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  return token && repo ? `https://x-access-token:${token}@github.com/${repo}.git` : 'origin';
}

/**
 * 归档分支当前 tip。空字符串 = 广告里没有这条 ref（首推）；取不到则抛错——
 * 首推与「读不到」都会走到非快进推送，但两者要给出不同的话，否则排障时无从区分。
 */
function remoteTipSha() {
  const res = runGitProbe(['ls-remote', '--heads', remoteTarget(), `refs/heads/${BRANCH}`]);
  if (!res.ok) throw new Error('无法读取归档分支 tip（远端不可达或凭据缺失），拒绝在未知状态下推送');
  return res.stdout ? res.stdout.split(/\s+/)[0] : '';
}

/**
 * 探针 + 浅拉取远端基线树（restore 与 archive 共用同一判定，避免同一操作两份实现长期分叉）。
 *
 * 不能用「stdout 是否为空」反推「ref 不存在」——服务端隐藏 ref 时两者同形，见 decideRestoreOutcome。
 * 环境故障可能瞬时，探针必须和 fetch 一样带退避重试：探针比它保护的操作更脆就本末倒置了。
 * 只有「探针明确说广告里没有这条 ref」才跳过 fetch（为首夜白跑一轮注定失败的重试没有意义）。
 * 探针结果不确定（unreachable）时仍要尝试 fetch：拉取成功说明基线确实在、能正常恢复，
 * 不该因探针的假阴性把「可恢复」判成「判红」——decideRestoreOutcome 把 fetchOk 放在第一位。
 */
function probeAndFetchBaseline() {
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

  let fetched = false;
  if (probeStatus !== 'absent') {
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      const res = runGit(
        ['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}`],
        // 与探针一致：无 TTY 时不让 git 挂起等待凭据输入。
        { ignoreError: true, env: { GIT_TERMINAL_PROMPT: '0' } },
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

  return { outcome: decideRestoreOutcome({ probeStatus, fetchOk: fetched }), fetched };
}

/** 目标目录里的段级基线文件（不含 manifest），排序后返回。 */
function baselineFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => BASELINE_FILE_RE.test(f))
    .sort();
}

/**
 * 期望段集合 = stryker.conf.d/dsh-*.json 派生（与 ci-matrix / mutation-ledger 同源口径）。
 * 空集合必须 fail-loud：期望集合为空会让每个现存文件都落进「退役」，并集语义反手把整棵归档删掉。
 */
function expectedFromConfDir() {
  const confNames = existsSync(CONF_DIR)
    ? readdirSync(CONF_DIR).filter((f) => f.startsWith('dsh-') && f.endsWith('.json'))
    : [];
  const expected = expectedBaselineFiles(confNames);
  if (expected.length === 0) {
    console.error(
      `[orphan-baseline] 无法从 ${CONF_DIR} 派生期望段集合（拒绝入档：空期望集合会把整棵基线判成退役段）`,
    );
    process.exit(1);
  }
  return expected;
}

/**
 * 读取 FETCH_HEAD 上的归档树：`ls-tree -l` 给出每份文件的 blob sha 与大小（不做内容往返）。
 * blob sha 直接复用于并集树里的沿用文件——字节级一致，因而不产生新对象，保住内容去重红利。
 */
function readRemoteTree() {
  const treeOutput = runGit(['ls-tree', '-r', '-l', 'FETCH_HEAD'], { ignoreError: true });
  if (!treeOutput) return { files: [], blobs: new Map(), manifest: {}, entries: 0 };

  const files = [];
  const blobs = new Map();
  let entries = 0;
  for (const line of treeOutput.split('\n').filter(Boolean)) {
    entries++;
    const match = line.match(/^100644\s+blob\s+([0-9a-f]{40})\s+\d+\t(.+)$/);
    if (!match) continue;
    const [, blobSha, fileName] = match;
    if (!BASELINE_FILE_RE.test(fileName)) continue;
    files.push(fileName);
    blobs.set(fileName, blobSha);
  }
  files.sort();

  // 树里有条目却一份基线文件都没有 = 归档形状漂移（命名改了？）。此时「沿用集合为空」是假的，
  // 继续并集会把用户可见的旧归档换成一份只剩本次产物的树——按 fail-loud 处理（与 restore 同判据）。
  if (entries > 0 && files.length === 0) {
    console.error(
      `[orphan-baseline] 远端树含 ${entries} 个条目但无任何基线文件（命名漂移？），拒绝以空期望继续（fail-loud）`,
    );
    process.exit(1);
  }

  let manifest = {};
  const rawManifest = runGit(['show', `FETCH_HEAD:${BASELINE_MANIFEST_FILE}`], { ignoreError: true });
  if (rawManifest) {
    try {
      manifest = JSON.parse(rawManifest);
    } catch {
      console.error('[orphan-baseline] 远端 manifest.json 非法 JSON（拒绝沿用不可信的陈旧判据，fail-loud）');
      process.exit(1);
    }
  }
  return { files, blobs, manifest, entries };
}

/**
 * manifest 条目。沿用文件保留远端条目（其 mtime 是**上次真实测量时间**；重新盖章会让陈旧
 * 判据失效——重写时间戳正是 #718 S3.1 要修的那个坑），新算文件现算。
 */
function buildManifest(dir, names, preserved = {}) {
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

function hashFile(path) {
  return runGit(['hash-object', '-w', path]);
}

function hashBlob(content) {
  return runGit(['hash-object', '-w', '--stdin'], { input: content });
}

/** 给旧 tip 打回滚快照 tag。必须先于新树推送——tag 指向的对象在推之前得是可达的。 */
function pushSnapshotTag(oldSha) {
  const tag = snapshotTagFor(oldSha);
  runGit(['push', remoteTarget(), `${oldSha}:refs/tags/${tag}`]);
  console.log(`[orphan-baseline] 回滚快照：refs/tags/${tag}（保留最近 ${ARCHIVE_SNAPSHOT_KEEP} 个）`);
}

function pruneSnapshotTags() {
  const listed = runGit(
    ['ls-remote', '--tags', remoteTarget(), `refs/tags/${ARCHIVE_SNAPSHOT_TAG_PREFIX}*`],
    { ignoreError: true },
  );
  const refs = (listed ?? '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean);
  const stale = pruneSnapshotPlan(refs);
  if (stale.length === 0) return;
  // 逐个删除：一条失败不连坐，过期快照留着只是多占一个 ref，不影响本次入档的正确性。
  for (const ref of stale) runGit(['push', remoteTarget(), '--delete', ref], { ignoreError: true });
  console.log(`[orphan-baseline] 清理过期回滚快照 ${stale.length} 个`);
}

/**
 * 归档分支深度恒为 1（无父 commit）：可回滚性靠快照 tag 承担，而不是靠父链——
 * 后者会让每次入档都把历史带上远端，与 #572「剥离 main 分支代码树巨型 JSON」的初衷分叉。
 * 推送用带显式 expect 的 `--force-with-lease`：本路径不做 fetch，无参形式会退化成裸 force（#718 裁决）。
 */
function pushBaselineCommit(entries, subject) {
  const allFiles = [...entries.map((e) => e.name), BASELINE_MANIFEST_FILE];
  console.log(`[orphan-baseline] 准备提交 ${allFiles.length} 个基线文件到孤立分支 ${BRANCH}...`);

  const mktreeLines = entries.map((e) => `100644 blob ${e.blobSha}\t${e.name}`);
  const treeSha = runGit(['mktree'], { input: mktreeLines.join('\n') + '\n' });
  const commitSha = runGit(['commit-tree', treeSha, '-m', subject], { env: BOT_IDENTITY });

  const target = remoteTarget();
  const oldSha = remoteTipSha();
  if (oldSha) {
    pushSnapshotTag(oldSha);
    pruneSnapshotTags();
    console.log(
      `[orphan-baseline] 推送 commit ${commitSha.slice(0, 8)} 到 refs/heads/${BRANCH}（租约 expect ${oldSha.slice(0, 8)}）...`,
    );
    runGit([
      'push',
      `--force-with-lease=refs/heads/${BRANCH}:${oldSha}`,
      target,
      `${commitSha}:refs/heads/${BRANCH}`,
    ]);
  } else {
    console.log(`[orphan-baseline] 推送 commit ${commitSha.slice(0, 8)} 到 refs/heads/${BRANCH}（首推）...`);
    runGit(['push', target, `${commitSha}:refs/heads/${BRANCH}`]);
  }
  console.log(`[orphan-baseline] 成功同步基线至孤立分支 ${BRANCH}（包含 ${allFiles.length} 份文件）`);
}

if (action === 'push') {
  if (!existsSync(TARGET_DIR)) {
    console.error(`[orphan-baseline] 源目录不存在: ${TARGET_DIR}`);
    process.exit(1);
  }

  const baselineFiles = baselineFilesIn(TARGET_DIR);
  if (baselineFiles.length === 0) {
    console.error('[orphan-baseline] 未找到任何 incremental-*.json 基线文件，变异测试未产生可用基线');
    process.exit(1);
  }

  const manifestPath = join(TARGET_DIR, BASELINE_MANIFEST_FILE);
  writeFileSync(manifestPath, JSON.stringify(buildManifest(TARGET_DIR, baselineFiles), null, 2) + '\n');

  pushBaselineCommit(
    [
      ...baselineFiles.map((f) => ({ name: f, blobSha: hashFile(join(TARGET_DIR, f)) })),
      { name: BASELINE_MANIFEST_FILE, blobSha: hashFile(manifestPath) },
    ].sort((a, b) => (a.name < b.name ? -1 : 1)),
    'chore(ci): update mutation baseline snapshot [skip ci]',
  );
} else if (action === 'archive') {
  if (!existsSync(TARGET_DIR)) {
    console.error(`[orphan-baseline] 源目录不存在: ${TARGET_DIR}`);
    process.exit(1);
  }

  const produced = baselineFilesIn(TARGET_DIR);
  if (produced.length === 0) {
    console.error('[orphan-baseline] 未找到任何 incremental-*.json 基线文件，变异测试未产生可用基线');
    process.exit(1);
  }
  const expected = expectedFromConfDir();

  const { outcome, fetched } = probeAndFetchBaseline();
  if (outcome.action === 'fail') {
    // 并集语义下「取不到远端」等于「沿用集合未知」：以空沿用集合推送 = 删段。故一律 fail-loud。
    console.error(`[orphan-baseline] ${outcome.reason}（fail-loud，拒绝以空沿用集合入档）`);
    process.exit(1);
  }

  const remote = fetched ? readRemoteTree() : { files: [], blobs: new Map(), manifest: {} };
  if (outcome.action === 'bootstrap') console.log(`::notice::${outcome.reason}`);

  const plan = planArchive({ expected, produced, carried: remote.files });
  const total = expected.length;
  console.log(
    `[orphan-baseline] 归档对账（期望 ${total} 段）：新算 ${plan.newlyMeasured.length} / 沿用 ${plan.carriedOver.length} / 缺 ${plan.missing.length} / 退役 ${plan.retired.length}`,
  );
  if (plan.retired.length > 0) {
    console.log(`[orphan-baseline] 退役段（配置已不在期望集合，从归档移除）：${plan.retired.join(' ')}`);
  }
  if (plan.missing.length > 0) {
    // 告警而非判红：段首次入档（拆段当夜）本就无基线可沿用，判红会让每次拆段必然红一夜。
    // 真·数据丢失由 workflow 的段报告齐备性校验与台账 --check 兜底判红。
    console.warn(
      `::warning::归档缺段 ${plan.missing.length} 个（本次未产出且远端无沿用——查实例是否超时/被杀）：${plan.missing.join(' ')}`,
    );
  }

  const kept = [...plan.newlyMeasured, ...plan.carriedOver].sort();
  const preserved = {};
  for (const f of plan.carriedOver) {
    if (!remote.manifest[f]) {
      // 归档写入方从不漏条目，缺条目意味着这份树不是本脚本写的（人工推送/截断）。
      console.error(`[orphan-baseline] 远端 manifest 缺 ${f} 条目（归档形状异常），拒绝沿用不可信条目（fail-loud）`);
      process.exit(1);
    }
    preserved[f] = remote.manifest[f];
  }

  const manifest = buildManifest(TARGET_DIR, plan.newlyMeasured, preserved);
  const entries = [
    // 沿用文件直接复用远端 blob sha：不做内容往返，字节级一致因而零新对象。
    ...plan.carriedOver.map((f) => ({ name: f, blobSha: remote.blobs.get(f) })),
    ...plan.newlyMeasured.map((f) => ({ name: f, blobSha: hashFile(join(TARGET_DIR, f)) })),
    { name: BASELINE_MANIFEST_FILE, blobSha: hashBlob(JSON.stringify(manifest, null, 2) + '\n') },
  ].sort((a, b) => (a.name < b.name ? -1 : 1));

  pushBaselineCommit(
    entries,
    `chore(ci): archive mutation baseline（并集入档 新算${plan.newlyMeasured.length}/沿用${plan.carriedOver.length}/缺${plan.missing.length}）[skip ci]`,
  );
} else if (action === 'restore') {
  mkdirSync(TARGET_DIR, { recursive: true });

  const { outcome, fetched } = probeAndFetchBaseline();

  if (outcome.action === 'fail') {
    console.error(`[orphan-baseline] ${outcome.reason}（fail-loud，本次未执行变异测试）`);
    process.exit(1);
  }
  if (outcome.action === 'bootstrap') {
    console.log(`::notice::${outcome.reason}`);
    process.exit(0);
  }
  if (!fetched) {
    console.error('[orphan-baseline] 恢复结果与探针不一致（fail-loud）');
    process.exit(1);
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
    if (BASELINE_FILE_RE.test(fileName) || fileName === BASELINE_MANIFEST_FILE) {
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
  console.error(
    `[orphan-baseline] 未知动作: ${action}，用法: node scripts/gate/orphan-baseline.mjs [archive|push|restore]`,
  );
  process.exit(1);
}
