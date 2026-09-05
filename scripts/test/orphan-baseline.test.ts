import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('#572: orphan-baseline restore 在无远端孤立分支时优雅降级（exit 0 + notice）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'orphan-test-restore-'));
  try {
    // 在临时 git 仓库中运行 restore（无 baseline/mutation 分支）
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const output = execFileSync('node', [scriptPath, 'restore'], {
      cwd: tmp,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(output.includes('::notice::'), '输出包含 notice 标注全量降级');
    assert.ok(output.includes('安全降级为全量变异'), '日志提示安全降级');
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
