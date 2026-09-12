import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pushBaselineTree } from '../gate/baseline-push.mjs';

const scriptPath = join(process.cwd(), 'scripts', 'gate', 'orphan-baseline.mjs');
const overlayScriptPath = join(process.cwd(), 'scripts', 'gate', 'overlay-baseline.mjs');

test('#579: overlay-baseline 模块语法与依赖导入健全性', () => {
  // node --check 验证模块语法解析无误
  assert.doesNotThrow(() => {
    execFileSync('node', ['--check', overlayScriptPath], { encoding: 'utf8', stdio: 'pipe' });
  });

  // 缺失 GITHUB_REPOSITORY 时 fail-closed exit 1
  assert.throws(() => {
    execFileSync('node', [overlayScriptPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GITHUB_REPOSITORY: '' },
    });
  }, /缺失 GITHUB_REPOSITORY/);
});

test('#572: orphan-baseline CLI 参数防御', () => {
  // 未知动作返回 1
  assert.throws(() => {
    execFileSync('node', [scriptPath, 'invalid-action'], { encoding: 'utf8', stdio: 'pipe' });
  }, /未知动作/);
});

test('#572: orphan-baseline push 在空目录下防御', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-test-empty-'));
  try {
    const cwd = tmp;
    assert.throws(() => {
      execFileSync('node', [scriptPath, 'push'], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }, /源目录不存在/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** 跑脚本并连退出码一起拿到——断言必须放在 try/catch 之外，否则会退化成「进了 catch 就算过」。 */
function runScript(script, args, options = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ORPHAN_BASELINE_RETRY_DELAY_MS: '0', ...(options.env ?? {}) },
    cwd: options.cwd,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 造一个假 gh。模式必须按**具体度降序**排列：artifacts 的 URL
 * （`.../actions/runs/<id>/artifacts?...`）也含 `actions/runs`，若把 `*actions/runs*` 放在前面，
 * 两条分支会被同一条 glob 吞掉，「锁定 Runs 站点」就名不副实了。
 */
function writeFakeGh(dir, {
  pullsOk = true,
  runsOk = false,
  runs = '[{"name":"CI","conclusion":"success","id":12345}]',
  artifactsOk = false,
  artifacts = '[]',
} = {}) {
  const head = `[{"number":7,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${'b'.repeat(40)}"}}]`;
  const script = `#!/bin/sh
case "$2" in
  *commits/*/pulls) ${pullsOk ? `printf '%s' '${head}'; exit 0` : `echo 'pulls boom' >&2; exit 1`} ;;
  *artifacts*) ${artifactsOk ? `printf '%s' '${artifacts}'; exit 0` : `echo 'artifacts boom' >&2; exit 1`} ;;
  *actions/runs*) ${runsOk ? `printf '%s' '${runs}'; exit 0` : `echo 'runs boom' >&2; exit 1`} ;;
esac
echo "unexpected gh args: $*" >&2; exit 1
`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/** 造一个假 git：只拦 `ls-remote`（放行=present）与 `fetch`（强制失败），其余交给真 git。 */
function writeGitShim(dir, { fetchFails = true } = {}) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const script = `#!/bin/sh
case "$1" in
  ls-remote) exit 0 ;;
  fetch) ${fetchFails ? `echo 'fetch boom' >&2; exit 1` : `exec "${real}" "$@"`} ;;
esac
exec "${real}" "$@"
`;
  const p = join(dir, 'git');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/** 假 gh 的 artifacts 分支返回 1 个变异产物，使 overlay 走到恢复段（第 5 步）。 */
const ONE_MUTATION_ARTIFACT = '{"total_count":1,"artifacts":[{"name":"mutation-incremental-dsh-x"}]}';

test('#572: orphan-baseline restore 在远端可达但无基线分支时优雅降级（exit 0 + notice）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-test-restore-'));
  try {
    // 首夜的真实形态是「远端可达、广告里没有这条 ref」——不是「没有远端」。
    // 无远端属「取不到」，必须与「不存在」区分开（见下一条测试）。
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', tmp], { cwd: tmp, stdio: 'ignore' });
    const r = runScript(scriptPath, ['restore'], { cwd: tmp });
    assert.equal(r.status, 0, `首夜应 exit 0，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /::notice::/, '输出包含 notice 标注全量降级');
    assert.match(r.out, /安全降级为全量变异/, '日志提示安全降级');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718: orphan-baseline restore 在远端不可达时 fail-loud（exit 1）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-test-unreachable-'));
  try {
    // 无 origin 远端 = 无法判定「是否存在基线」。此时若按空分支继续，会把沿用中的基线整批丢掉。
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const r = runScript(scriptPath, ['restore'], { cwd: tmp });
    assert.equal(r.status, 1, `远端不可达必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /fail-loud/, '输出须点名 fail-loud');
    assert.match(r.out, /远端不可达/, '输出须说明远端不可达');
    assert.doesNotMatch(r.out, /安全降级为全量变异/, '不得降级为首夜');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 「探针说 present、但 fetch 失败」用 git shim 构造（见下方恢复段用例）——评审指出原先那句
// 「无法用本地仓库构造」不成立：拦 ls-remote 与 fetch 两个子命令即可，不必真造坏远端。

test('#718: overlay-baseline 查询关联 PR 失败必须 fail-loud（exit 1）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-prfail-'));
  try {
    // 受限 PATH 让 gh 不可用 —— 「查不了」与「查不到（空数组）」必须走不同分支。
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: { PATH: tmp, GITHUB_REPOSITORY: 'owner/repo', COMMIT_SHA: 'a'.repeat(40), GH_TOKEN: 'dummy' },
    });
    assert.equal(r.status, 1, `查询失败必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /fail-loud/, '输出须点名 fail-loud');
    assert.match(r.out, /关联 PR/, '必须命中「关联 PR」站点');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718: overlay-baseline 查询 Workflow Runs 失败必须 fail-loud（exit 1）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-runsfail-'));
  try {
    // 假 gh 分流：pulls 查询成功 → 只让 runs 查询失败，锁定本次被改的那一处站点。
    writeFakeGh(tmp, { pullsOk: true, runsOk: false });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
        GH_TOKEN: 'dummy',
      },
    });
    assert.equal(r.status, 1, `Runs 查询失败必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /Workflow Runs/, '必须命中「Workflow Runs」站点，而非只匹配 fail-loud');
    assert.match(r.out, /fail-loud/, '输出须点名 fail-loud');
    // 站点锁定：Runs 查询在 artifacts 之前，失败时绝不该出现 artifacts 分页日志。
    assert.doesNotMatch(r.out, /分页取全/, '不得串到 artifacts 站点');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718: overlay-baseline 恢复段——探针说 present 但拉取失败时 fail-loud（exit 1）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-restore-'));
  const bin = mkdtempSync(join(tmpdir(), 'overlay-test-bin-'));
  try {
    // 这条覆盖第 5 步（恢复段）：pulls/runs/artifacts 都放行并给出 1 个变异产物，
    // 再用 git shim 让 ls-remote 放行、fetch 失败 → probe=present 且 fetch 失败。
    // 该分支曾是死代码（probeStatus 声明在 try 内、catch 引用 → ReferenceError），必须端到端锁住。
    writeFakeGh(tmp, { pullsOk: true, runsOk: true, artifactsOk: true, artifacts: ONE_MUTATION_ARTIFACT });
    writeGitShim(bin, { fetchFails: true });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${bin}:${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
        GH_TOKEN: 'dummy',
      },
    });
    assert.doesNotMatch(r.out, /ReferenceError/, '不得因变量作用域抛 ReferenceError');
    assert.equal(r.status, 1, `present 但拉取失败必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /存在但恢复失败/, '须点名「存在但恢复失败」，而不是笼统的「无法确认」');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('#718: overlay-baseline 恢复段——探针明确 absent 时走首夜且不得崩', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-firstnight-'));
  const bin = mkdtempSync(join(tmpdir(), 'overlay-test-bin2-'));
  try {
    // git shim：ls-remote 返回 exit 2（absent）、fetch 失败 → 应走「首夜」继续构建新快照。
    writeFakeGh(tmp, { pullsOk: true, runsOk: true, artifactsOk: true, artifacts: ONE_MUTATION_ARTIFACT });
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$1" in
  ls-remote) exit 2 ;;
  fetch) echo 'fetch boom' >&2; exit 1 ;;
esac
exec "${real}" "$@"
`, { mode: 0o755 });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${bin}:${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
        GH_TOKEN: 'dummy',
      },
    });
    assert.doesNotMatch(r.out, /ReferenceError/, '不得因变量作用域抛 ReferenceError');
    assert.match(r.out, /尚不存在（首夜）/, 'absent 应走首夜分支');
    // 之后产物下载失败 → overlayCount 0。**有产物却一个都没覆盖成功**不是「无事可做」：
    // #718 S2.1 起按 fail-loud 处理（旧行为是打印一句「跳过推送」就 exit 0，整次合并的基线静默丢失）。
    assert.equal(r.status, 1, `有产物但无一覆盖成功必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /无一覆盖成功/, '须点名「有产物但无一覆盖成功」');
    assert.match(r.out, /基线未更新/, '须说明后果');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('#718: overlay-baseline 「查到了但没有」仍是合法 no-op（exit 0）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-noop-'));
  try {
    // pulls 成功、runs 成功但为空数组 = 真的没有成功 CI Run → 必须保持 no-op，不得被 fail-loud 误伤。
    writeFakeGh(tmp, { pullsOk: true, runsOk: true, runs: '[]' });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
        GH_TOKEN: 'dummy',
      },
    });
    assert.equal(r.status, 0, `合法 no-op 必须 exit 0，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /未找到成功状态的 CI Run/, '应走「查到了但没有」分支');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#572: orphan-baseline 本地 push 与 restore 往返完整性', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-test-e2e-'));
  try {
    // 1. 初始化模拟本地仓库
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, stdio: 'ignore' });
    // 首次提交以使 HEAD 存在
    writeFileSync(join(tmp, 'dummy.txt'), 'dummy');
    execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });

    // 2. 模拟本地 remote 指向自身
    execFileSync('git', ['remote', 'add', 'origin', tmp], { cwd: tmp, stdio: 'ignore' });

    // 3. 构造 coverage/mutation 基线数据
    const targetDir = join(tmp, 'coverage', 'mutation');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'incremental-test-pkg.json'), '{"mutants":[{"id":1,"status":"Killed"}]}');
    writeFileSync(join(targetDir, 'incremental-test-pkg-2.json'), '{"mutants":[{"id":2,"status":"Survived"}]}');

    // 4. 执行 push
    const pushOutput = execFileSync('node', [scriptPath, 'push'], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(pushOutput.includes('成功同步基线至孤立分支'), 'push 成功完成');

    // 5. 验证孤立分支已被创建
    const branchCheck = execFileSync('git', ['rev-parse', '--verify', 'refs/heads/baseline/mutation'], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    assert.ok(branchCheck.length === 40, '孤立分支 commit sha 合法');

    // 6. 清理本地 coverage/mutation，验证 restore 能够如实还原
    rmSync(targetDir, { recursive: true, force: true });

    const restoreOutput = execFileSync('node', [scriptPath, 'restore'], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(restoreOutput.includes('成功恢复'), 'restore 成功完成');

    const file1 = readFileSync(join(targetDir, 'incremental-test-pkg.json'), 'utf8');
    const file2 = readFileSync(join(targetDir, 'incremental-test-pkg-2.json'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(targetDir, 'manifest.json'), 'utf8'));

    assert.ok(file1.includes('Killed'), '内容恢复一致');
    assert.ok(file2.includes('Survived'), '内容恢复一致');
    assert.ok(manifest['incremental-test-pkg.json'].size > 0, 'manifest 存在且包含文件统计');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── #718 S1.2：并集入档（archive）────────────────────────────────────────────
// 旧写入口把「本班次目录里有什么」当成「归档的全部内容」整树替换：段一旦没产出（实例超时/
// 被杀），该段文件就不在新树里，归档**静默缩水**（实测 33 → 31 且无任何日志）。以下用例锁住
// 并集语义、三类记账、退役清理与两条 fail-loud 分支。

/** 造一个「origin 指向自身」的模拟仓库（archive/push/restore 都能在上面真跑）。 */
function initBaselineRepo(confNames: string[]): string {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-archive-'));
  execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, stdio: 'ignore' });
  writeFileSync(join(tmp, 'dummy.txt'), 'dummy');
  execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', tmp], { cwd: tmp, stdio: 'ignore' });

  const confDir = join(tmp, 'stryker.conf.d');
  mkdirSync(confDir, { recursive: true });
  for (const name of confNames) {
    writeFileSync(join(confDir, `dsh-${name}.json`), JSON.stringify({ mutate: ['src/**/*.ts'] }));
  }
  mkdirSync(join(tmp, 'coverage', 'mutation'), { recursive: true });
  return tmp;
}

function writeBaselines(repo: string, files: Record<string, string>): void {
  const dir = join(repo, 'coverage', 'mutation');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

function archivedFiles(repo: string): string[] {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', 'refs/heads/baseline/mutation'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
}

function readArchived(repo: string, name: string): string {
  return execFileSync('git', ['show', `refs/heads/baseline/mutation:${name}`], { cwd: repo, encoding: 'utf8' });
}

test('#718 S1.2: archive 并集入档——本次未产出的段沿用远端，段数不缩水', () => {
  const tmp = initBaselineRepo(['alpha', 'beta', 'gamma']);
  try {
    writeBaselines(tmp, {
      'incremental-alpha.json': '{"seg":"alpha"}',
      'incremental-beta.json': '{"seg":"beta"}',
      'incremental-gamma.json': '{"seg":"gamma"}',
    });
    const seeded = runScript(scriptPath, ['push'], { cwd: tmp });
    assert.equal(seeded.status, 0, `首次 push 应成功，实际 ${seeded.status}: ${seeded.out}`);
    const tipBefore = execFileSync('git', ['rev-parse', 'refs/heads/baseline/mutation'], {
      cwd: tmp,
      encoding: 'utf8',
    }).trim();
    // push 会往本班次报告目录写 manifest；清掉它以便断言 archive 不污染该目录
    rmSync(join(tmp, 'coverage', 'mutation', 'manifest.json'));

    // 模拟「beta/gamma 两个实例被杀」：本次只产出 alpha
    rmSync(join(tmp, 'coverage', 'mutation', 'incremental-beta.json'));
    rmSync(join(tmp, 'coverage', 'mutation', 'incremental-gamma.json'));

    const archived = runScript(scriptPath, ['archive'], { cwd: tmp });
    assert.equal(archived.status, 0, `archive 应成功，实际 ${archived.status}: ${archived.out}`);
    assert.match(
      archived.out,
      /归档对账（期望 3 段）：新算 1 \/ 沿用 2 \/ 缺 0 \/ 退役 0/,
      '三类计数 + 退役必须逐项记账',
    );

    assert.deepEqual(
      archivedFiles(tmp),
      ['incremental-alpha.json', 'incremental-beta.json', 'incremental-gamma.json', 'manifest.json'],
      '并集入档后段的集合不得缩水（旧实现会在这里抹掉 beta/gamma）',
    );
    assert.equal(readArchived(tmp, 'incremental-beta.json'), '{"seg":"beta"}', '沿用段保留远端内容');
    // manifest 必须覆盖树里的**全部**段（新算 + 沿用）。2026-09-12 生产实测：首次并集入档时
    // manifest 只写了「新算」的 31 段、漏掉「沿用」的 2 段——树正确但 manifest 与树不对齐。
    assert.deepEqual(
      Object.keys(JSON.parse(readArchived(tmp, 'manifest.json'))).sort(),
      ['incremental-alpha.json', 'incremental-beta.json', 'incremental-gamma.json'],
      'manifest 必须覆盖树里的全部段（含沿用段）',
    );
    assert.ok(
      !existsSync(join(tmp, 'coverage', 'mutation', 'manifest.json')),
      'archive 不得把 manifest 写进本班次报告目录（会污染 observe-reports 留档）',
    );

    const tag = execFileSync('git', ['tag', '-l', 'baseline-snap-*'], { cwd: tmp, encoding: 'utf8' }).trim();
    assert.ok(tag.length > 0, '入档必须留下回滚快照 tag（分支深度恒为 1，可回滚性由 tag 承担）');
    assert.equal(
      execFileSync('git', ['rev-parse', `refs/tags/${tag}`], { cwd: tmp, encoding: 'utf8' }).trim(),
      tipBefore,
      '快照 tag 必须指向入档前的 tip（真回滚点）',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718 S1.2: archive 退役清理 + 缺段点名告警', () => {
  const tmp = initBaselineRepo(['alpha', 'beta']);
  try {
    // 远端先有一份「段已拆并/改名」的遗留文件，且 beta 从未有过基线
    writeBaselines(tmp, {
      'incremental-alpha.json': '{"seg":"alpha"}',
      'incremental-removed.json': '{"seg":"removed"}',
    });
    const seeded = runScript(scriptPath, ['push'], { cwd: tmp });
    assert.equal(seeded.status, 0, `首次 push 应成功，实际 ${seeded.status}: ${seeded.out}`);

    const archived = runScript(scriptPath, ['archive'], { cwd: tmp });
    assert.equal(archived.status, 0, `archive 应成功，实际 ${archived.status}: ${archived.out}`);
    assert.match(archived.out, /新算 1 \/ 沿用 0 \/ 缺 1 \/ 退役 1/, '缺与退役必须分别计数');
    assert.match(
      archived.out,
      /::warning::归档缺段 1 个.*incremental-beta\.json/,
      '缺段必须点名告警（告警而非判红：段首次入档本就无基线可沿用）',
    );
    assert.match(archived.out, /退役段.*incremental-removed\.json/, '退役段必须显式点名');
    assert.deepEqual(
      archivedFiles(tmp),
      ['incremental-alpha.json', 'manifest.json'],
      '退役段从归档移除；缺段不得落盘为空文件',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718 S1.2: archive 拉取失败必须 fail-loud（拒绝以空沿用集合入档）', () => {
  const tmp = initBaselineRepo(['alpha']);
  const bin = mkdtempSync(join(tmpdir(), 'orphan-archive-bin-'));
  try {
    writeBaselines(tmp, { 'incremental-alpha.json': '{"seg":"alpha"}' });
    // ls-remote 放行（present）、fetch 强制失败 → 「基线可能存在但取不到」这一支
    writeGitShim(bin, { fetchFails: true });
    const r = runScript(scriptPath, ['archive'], {
      cwd: tmp,
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 1, `拉取失败必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /拒绝以空沿用集合入档/, '须点名拒绝原因（取不到远端 ≠ 远端为空）');
    assert.match(r.out, /存在但拉取失败/, '须走「存在但恢复失败」站点，而不是笼统的无法确认');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('#718 S1.2: archive 期望集合为空必须 fail-loud（防把整棵基线判成退役）', () => {
  const tmp = initBaselineRepo([]);
  try {
    writeBaselines(tmp, { 'incremental-alpha.json': '{"seg":"alpha"}' });
    const r = runScript(scriptPath, ['archive'], { cwd: tmp });
    assert.equal(r.status, 1, `空期望集合必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /无法从 .*stryker\.conf\.d 派生期望段集合/, '须点名期望集合派生失败');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── #718 S2.1：overlay 的「产物过期」与「无产物」分流 ────────────────────────
// 旧实现把两件相反的事压成同一句「未产生任何增量变异产物，安全跳过」：真·无产物（正确的 no-op）
// 与产物已过期/被删（该 PR 命中段的新基线永远进不了归档）。日志里两者完全同形，事后无法区分。

/**
 * S2.1 用的假 gh：在既有 pulls/runs/artifacts 分流之上支持 jobs 查询。
 * jobs 走 `gh api --paginate <url> --jq ...` 形态，故 `$2` 是 `--paginate`、URL 落在 `$3`——
 * 与 `$2` 是 URL 的既有三条分流天然不冲突（假 gh 不做 jq，直接输出脚本已烘焙好的结果）。
 */
function writeFakeGhForOverlay(dir, { jobNames = [], artifacts = '[]' } = {}) {
  const head = `[{"number":7,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${'b'.repeat(40)}"}}]`;
  const runs = '[{"name":"CI","conclusion":"success","id":12345}]';
  const script = `#!/bin/sh
case "$2" in
  *commits/*/pulls) printf '%s' '${head}'; exit 0 ;;
  *artifacts*) printf '%s' '${artifacts}'; exit 0 ;;
  *actions/runs*) printf '%s' '${runs}'; exit 0 ;;
  --paginate) printf '%s\\n' ${jobNames.map((n) => `'${n}'`).join(' ')}; exit 0 ;;
esac
echo "unexpected gh args: $*" >&2; exit 1
`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

function runOverlayWithFakeGh(tmp, options) {
  writeFakeGhForOverlay(tmp, options);
  return runScript(overlayScriptPath, [], {
    cwd: tmp,
    env: {
      PATH: `${tmp}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'owner/repo',
      COMMIT_SHA: 'a'.repeat(40),
      GH_TOKEN: 'dummy',
    },
  });
}

test('#718 S2.1: 变异产物已丢失必须 fail-loud（CI 跑过变异实例却看不到产物）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-s21-lost-'));
  try {
    const r = runOverlayWithFakeGh(tmp, {
      // run 里确实有变异矩阵实例（且汇总判分 job 不得被误计），但产物列表里一份变异产物都没有：
      // 上传步骤是实例内 if: success() 门控，实例存在 ⇒ 产物产出过 ⇒ 只能解释为过期/被删。
      jobNames: [
        'Detect changed packages',
        'Mutation gate (dsh-notifier · text)',
        'Mutation gate verdict (aggregate)',
      ],
      artifacts: '{"total_count":1,"artifacts":[{"name":"observe-reports","expired":true}]}',
    });
    assert.equal(r.status, 1, `产物丢失必须 exit 1，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /产物已不可见/, '须点名「曾运行变异实例但看不到产物」');
    assert.match(r.out, /未进归档/, '须说明后果（该 PR 命中段的新基线未进归档）');
    assert.match(r.out, /retention-days/, '须给出可执行的处置方向');
    assert.doesNotMatch(r.out, /安全跳过 \(No-op\)/, '不得与「真·无产物」同形');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718 S2.1: 真·无产物仍是合法 no-op（CI 未运行任何变异实例）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-s21-none-'));
  try {
    // 与上一条同形（都看不到变异产物），区别只在 run 里没有变异矩阵实例 = 纯文档 PR。
    // 分流必须把这一支保留为 no-op，否则每个纯文档 PR 合并都会把 main 判红。
    const r = runOverlayWithFakeGh(tmp, {
      jobNames: ['Detect changed packages', 'Build / Test / Typecheck (dsh-notifier)'],
      artifacts: '{"total_count":0,"artifacts":[]}',
    });
    assert.equal(r.status, 0, `真·无产物必须 exit 0，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /未运行任何变异矩阵实例/, '须明说判据是「没跑过变异实例」');
    assert.match(r.out, /安全跳过 \(No-op\)/, '保持既有 no-op 文案');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718 S2.1: jobs 查询失败不得把纯文档 PR 误判为产物丢失', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-s21-jobsfail-'));
  const bin = mkdtempSync(join(tmpdir(), 'overlay-s21-bin-'));
  try {
    // 用 git shim 之外的手段不奏效（这里要坏的是 gh 的 jobs 分支），故写一个只让 --paginate 失败的假 gh。
    writeFakeGh(tmp, { pullsOk: true, runsOk: true, artifactsOk: true, artifacts: '{"total_count":0,"artifacts":[]}' });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
        GH_TOKEN: 'dummy',
      },
    });
    assert.equal(r.status, 0, `jobs 查询失败应降级为 no-op 而非判红，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /查询 run jobs 失败/, '须点名 jobs 查询失败（分流灵敏度降级，但不误伤）');
    assert.match(r.out, /安全跳过 \(No-op\)/, '降级为 no-op');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

/**
 * 端到端假 gh：pulls / runs / artifacts 之外还支持 `gh run download`（真在目标目录落一份段文件）。
 * 只有这条用例会走到 overlay 的写路径，故下载必须真产出文件，否则测不到 push。
 */
function writeFakeGhForOverlayPush(dir, { fileName, content }) {
  const head = `[{"number":7,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${'b'.repeat(40)}"}}]`;
  const runs = '[{"name":"CI","conclusion":"success","id":12345}]';
  const artifacts = '{"total_count":1,"artifacts":[{"name":"mutation-incremental-dsh-alpha"}]}';
  const script = `#!/bin/sh
case "$2" in
  *commits/*/pulls) printf '%s' '${head}'; exit 0 ;;
  *artifacts*) printf '%s' '${artifacts}'; exit 0 ;;
  *actions/runs*) printf '%s' '${runs}'; exit 0 ;;
esac
case "$1" in
  run)
    DIR=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "-D" ] && DIR="$a"
      prev="$a"
    done
    [ -n "$DIR" ] || exit 1
    mkdir -p "$DIR"
    printf '%s' '${content}' > "$DIR/${fileName}"
    exit 0 ;;
esac
echo "unexpected gh args: $*" >&2; exit 1
`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

test('#718 S2.1: overlay 端到端——差量覆盖生效 + 沿用段保留旧 manifest 条目 + 回滚快照', () => {
  const tmp = initBaselineRepo(['alpha', 'beta']);
  try {
    // 远端先有一份完整基线（alpha/beta 各一段）
    writeBaselines(tmp, {
      'incremental-alpha.json': '{"seg":"alpha","gen":1}',
      'incremental-beta.json': '{"seg":"beta","gen":1}',
    });
    assert.equal(runScript(scriptPath, ['push'], { cwd: tmp }).status, 0, '播种基线');
    const tipBefore = execFileSync('git', ['rev-parse', 'refs/heads/baseline/mutation'], {
      cwd: tmp,
      encoding: 'utf8',
    }).trim();
    const manifestBefore = JSON.parse(readArchived(tmp, 'manifest.json'));
    // push 会往报告目录写 manifest，清掉以免干扰后续断言
    rmSync(join(tmp, 'coverage', 'mutation', 'manifest.json'));

    // 该 PR 的 CI 只产出了 alpha 段的新基线（内容换代）
    writeFakeGhForOverlayPush(tmp, { fileName: 'incremental-alpha.json', content: '{"seg":"alpha","gen":2}' });
    const r = runScript(overlayScriptPath, [], {
      cwd: tmp,
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'owner/repo',
        COMMIT_SHA: 'a'.repeat(40),
      },
    });
    assert.equal(r.status, 0, `overlay 应成功，实际 ${r.status}: ${r.out}`);
    assert.match(r.out, /差量覆盖: incremental-alpha\.json/, '覆盖段须逐条点名');
    assert.match(r.out, /对账：期望 2 段，本次覆盖 1 段，沿用旧基线 2 段/, '对账口径保持既有文案');

    assert.equal(readArchived(tmp, 'incremental-alpha.json'), '{"seg":"alpha","gen":2}', '覆盖段换成新内容');
    assert.equal(readArchived(tmp, 'incremental-beta.json'), '{"seg":"beta","gen":1}', '未覆盖段原样保留');

    // 沿用段的 manifest 条目必须逐字段保留：其 mtime 是上次真实测量时间，重新盖章会让
    // 「基线是否陈旧」无从判断（旧实现给所有文件重算，这条锁住回归）。
    const manifestAfter = JSON.parse(readArchived(tmp, 'manifest.json'));
    assert.deepEqual(
      manifestAfter['incremental-beta.json'],
      manifestBefore['incremental-beta.json'],
      '沿用段的 manifest 条目不得被本次刷新',
    );
    assert.notDeepEqual(
      manifestAfter['incremental-alpha.json'],
      manifestBefore['incremental-alpha.json'],
      '覆盖段的 manifest 条目必须重算',
    );

    // 写路径与夜间班共用：回滚快照 tag 指向本次入档前的 tip
    const tag = execFileSync('git', ['tag', '-l', 'baseline-snap-*'], { cwd: tmp, encoding: 'utf8' }).trim();
    assert.ok(tag.length > 0, 'overlay 也必须留下回滚快照（深度恒为 1，可回滚性由 tag 承担）');
    assert.equal(
      execFileSync('git', ['rev-parse', `refs/tags/${tag}`], { cwd: tmp, encoding: 'utf8' }).trim(),
      tipBefore,
      '快照 tag 必须指向 overlay 入档前的 tip',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2026-09-12 生产实测暴露的 manifest 缺陷（并集入档首夜）──────────────────
// 现象：2 段实例失败 → archive 记账「新算 31 / 沿用 2」→ 树 34 份（33 段 + manifest）正确，
// 但 manifest.json 只有 31 条——漏掉了沿用段。manifest 是留段时间戳与完整性校验的唯一依据，
// 漏条目会让「不推不对齐归档」这道守卫在下一班把自己卡死。

/** 把远端归档分支的 manifest 改写成只含指定条目（模拟写入方漏条目 / 人工截断）。 */
function rewriteRemoteManifest(repo: string, keepNames: string[]): void {
  const full = JSON.parse(readArchived(repo, 'manifest.json'));
  const trimmed = Object.fromEntries(keepNames.map((n) => [n, full[n]]));
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify(trimmed, null, 2)}\n`,
  }).trim();
  const lines = execFileSync('git', ['ls-tree', '-r', 'refs/heads/baseline/mutation'], { cwd: repo, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.endsWith('\tmanifest.json') ? `100644 blob ${blob}\tmanifest.json` : l));
  const tree = execFileSync('git', ['mktree'], { cwd: repo, encoding: 'utf8', input: `${lines.join('\n')}\n` }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-m', 'test: trim manifest'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/heads/baseline/mutation', commit], { cwd: repo });
}

test('#718 S1.2 修复: 远端 manifest 缺沿用段条目时按 blob 重算并告警（自愈，不卡死归档）', () => {
  const tmp = initBaselineRepo(['alpha', 'beta']);
  try {
    writeBaselines(tmp, {
      'incremental-alpha.json': '{"seg":"alpha"}',
      'incremental-beta.json': '{"seg":"beta"}',
    });
    assert.equal(runScript(scriptPath, ['push'], { cwd: tmp }).status, 0, '播种基线');
    rewriteRemoteManifest(tmp, ['incremental-alpha.json']); // beta 条目被抹掉
    rmSync(join(tmp, 'coverage', 'mutation', 'manifest.json'));

    // 本次只产出 alpha → beta 走沿用分支，正是漏条目的那一支
    rmSync(join(tmp, 'coverage', 'mutation', 'incremental-beta.json'));
    const r = runScript(scriptPath, ['archive'], { cwd: tmp });
    assert.equal(r.status, 0, `缺条目必须自愈而非卡死归档，实际 ${r.status}: ${r.out}`);
    assert.match(
      r.out,
      /::warning::远端 manifest 缺 1 个沿用段条目.*incremental-beta\.json/,
      '须点名重算的段（异常可见，但不阻断入档）',
    );

    const manifest = JSON.parse(readArchived(tmp, 'manifest.json'));
    assert.deepEqual(
      Object.keys(manifest).sort(),
      ['incremental-alpha.json', 'incremental-beta.json'],
      '重算后 manifest 必须与树逐文件对齐',
    );
    assert.equal(manifest['incremental-beta.json'].mtime, null, '重算条目 mtime 必须诚实记 null（不冒充刚测过）');
    assert.equal(manifest['incremental-beta.json'].size, '{"seg":"beta"}'.length, 'size 取自远端 blob');
    assert.equal(typeof manifest['incremental-beta.json'].sha256, 'string', 'sha256 按远端 blob 原始字节重算');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718 S1.2 修复: manifest 与树不对齐时拒绝推送（任何写入方漏算都在推送前炸掉）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'push-guard-'));
  try {
    const entries = [
      { name: 'incremental-a.json', blobSha: 'a'.repeat(40) },
      { name: 'incremental-b.json', blobSha: 'b'.repeat(40) },
    ];
    assert.throws(
      () => pushBaselineTree({
        target: 'origin',
        branch: 'baseline/mutation',
        entries,
        manifest: { 'incremental-a.json': { size: 1, mtime: null, sha256: 'x' } },
        subject: 'x',
      }),
      /manifest 与树不对齐.*缺 1 条.*incremental-b\.json/,
      '漏条目必须在推送前炸掉',
    );
    assert.throws(
      () => pushBaselineTree({
        target: 'origin',
        branch: 'baseline/mutation',
        entries: [entries[0]],
        manifest: {
          'incremental-a.json': { size: 1, mtime: null, sha256: 'x' },
          'incremental-ghost.json': { size: 1, mtime: null, sha256: 'x' },
        },
        subject: 'x',
      }),
      /多 1 条.*incremental-ghost\.json/,
      '多余条目同样不对齐',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
