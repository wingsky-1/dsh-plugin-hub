import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

/** 造一个假 gh：只对 pulls 查询返回已合并 PR，其余子命令按 fail 退出（用于分流到指定 catch 站点）。 */
function writeFakeGh(dir, { pullsOk = true, runsOk = false } = {}) {
  const head = `[{"number":7,"merged_at":"2026-01-01T00:00:00Z","head":{"sha":"${'b'.repeat(40)}"}}]`;
  const script = `#!/bin/sh
case "$2" in
  *commits/*/pulls) ${pullsOk ? `printf '%s' '${head}'; exit 0` : `echo 'pulls boom' >&2; exit 1`} ;;
  *actions/runs*) ${runsOk ? `printf '%s' '[]'; exit 0` : `echo 'runs boom' >&2; exit 1`} ;;
esac
echo "unexpected gh args: $*" >&2; exit 1
`;
  const p = join(dir, 'gh');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

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

// 「探针说 present、但 fetch 失败」这一幕无法用本地仓库构造（破坏远端对象会让 ls-remote 一并失败，
// 落进 unreachable）。该组合的判定由 baseline-archive.test.ts 的纯函数用例覆盖，此处不写假测试。

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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('#718: overlay-baseline 「查到了但没有」仍是合法 no-op（exit 0）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overlay-test-noop-'));
  try {
    // pulls 成功、runs 成功但为空数组 = 真的没有成功 CI Run → 必须保持 no-op，不得被 fail-loud 误伤。
    writeFakeGh(tmp, { pullsOk: true, runsOk: true });
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
