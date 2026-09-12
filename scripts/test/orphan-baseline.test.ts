import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('#718: overlay-baseline 恢复段——探针明确 absent 时走首夜且不得崩（exit 0）', () => {
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
    // 之后产物下载失败 → overlayCount 0 → 无有效覆盖，跳过推送并正常退出。
    assert.equal(r.status, 0, `首夜应继续并最终 no-op exit 0，实际 ${r.status}: ${r.out}`);
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
