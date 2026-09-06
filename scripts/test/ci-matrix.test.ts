import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { computeCiMatrix, runCli } from '../ci/ci-matrix.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/data/plugins-manifest.json'), 'utf8'));
const EXPECTED_ALL = Array.from(new Set([...MANIFEST.active, ...(MANIFEST.standalone ?? []), 'dsh-plugins-all'])).sort();

test('ci-matrix: 场景 a - 正常命中单一 active 包 (via FILTER_OUTPUTS)', () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({ 'dsh-notifier': true }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.allPackages, EXPECTED_ALL);
  assert.deepEqual(res.hitPackages, ['dsh-notifier']);
  assert.deepEqual(res.mutationPackages, ['dsh-notifier']);
  assert.equal(res.hasMutations, 'true');
  assert.equal(res.mutationCombos.length, 4);
  assert.deepEqual(
    res.mutationCombos.map((c) => c.seg),
    ['config', 'history', 'message', 'server']
  );
});

test('ci-matrix: 场景 a - 正常命中单一 active 包 (via BASE_SET 空格分隔)', () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'dsh-lan-proxy',
      FILTER_OUTPUTS: '{}',
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, ['dsh-lan-proxy']);
  assert.deepEqual(res.mutationPackages, ['dsh-lan-proxy']);
  assert.equal(res.hasMutations, 'true');
  assert.deepEqual(
    res.mutationCombos.map((c) => c.seg),
    ['1', '2', '3', '4']
  );
});

test('ci-matrix: 场景 b - 命中 standalone 包 (dsh-codegraph 与 dsh-mem0)', () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({
        'dsh-codegraph': 'true',
        'dsh-mem0': true,
      }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, ['dsh-codegraph', 'dsh-mem0']);
  // 由于无 stryker 配置，mutationPackages 为空，hasMutations 为 'false'，mutationCombos 为空
  assert.deepEqual(res.mutationPackages, []);
  assert.equal(res.hasMutations, 'false');
  assert.deepEqual(res.mutationCombos, []);
});

test('ci-matrix: 场景 b - 命中无变异配置的 active 包 (dsh-verify-isolated)', () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({
        'dsh-verify-isolated': true,
      }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, ['dsh-verify-isolated']);
  assert.deepEqual(res.mutationPackages, []);
  assert.equal(res.hasMutations, 'false');
  assert.deepEqual(res.mutationCombos, []);
});

test('ci-matrix: 场景 c - 全局命中 (GLOBAL_HIT=true) 触发全量切片', () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'true',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({ 'dsh-notifier': true }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, EXPECTED_ALL);
  assert.equal(res.hasMutations, 'true');
  // 必须包含 active + standalone + dsh-plugins-all
  for (const p of [...MANIFEST.active, ...MANIFEST.standalone, 'dsh-plugins-all']) {
    assert.ok(res.hitPackages.includes(p), `hitPackages 必须包含 ${p}`);
  }
});

test('ci-matrix: 场景 c - 回退机制 (FILTER_OUTCOME!=success 或 BASE_SET 为空)', () => {
  // 1. FILTER_OUTCOME failure
  const resFailure = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'failure',
      BASE_SET: 'origin/main',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resFailure.hitPackages, EXPECTED_ALL);

  // 2. FILTER_OUTCOME cancelled
  const resCancelled = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'cancelled',
      BASE_SET: 'origin/main',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resCancelled.hitPackages, EXPECTED_ALL);

  // 3. BASE_SET 为空字符串
  const resEmptyBase = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: '',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resEmptyBase.hitPackages, EXPECTED_ALL);

  // 4. BASE_SET 仅含空格
  const resWhitespaceBase = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: '   ',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resWhitespaceBase.hitPackages, EXPECTED_ALL);
});

test('ci-matrix: 场景 d - 变异段展开正确性 (单配置与多段配置)', () => {
  // 单配置包 dsh-web-file-preview -> seg: "0"
  const resSingle = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({ 'dsh-web-file-preview': true }),
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resSingle.mutationCombos, [{ package: 'dsh-web-file-preview', seg: '0' }]);

  // 多个包组合排序
  const resMulti = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'dsh-web-file-preview dsh-notifier',
      FILTER_OUTPUTS: '{}',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resMulti.mutationPackages, ['dsh-notifier', 'dsh-web-file-preview']);
  assert.deepEqual(resMulti.mutationCombos, [
    { package: 'dsh-notifier', seg: 'config' },
    { package: 'dsh-notifier', seg: 'history' },
    { package: 'dsh-notifier', seg: 'message' },
    { package: 'dsh-notifier', seg: 'server' },
    { package: 'dsh-web-file-preview', seg: '0' },
  ]);
});

test('ci-matrix: 场景 e - 畸形输入与防御性回退', () => {
  // 畸形 JSON 字符串
  const resBadJson = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: '{broken-json',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resBadJson.hitPackages, []);
  assert.equal(resBadJson.hasMutations, 'false');

  // BASE_SET 含有无关 token 与有效包名
  const resTokens = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main 0000000000000000000000000000000000000000 dsh-lan-proxy non-existent-pkg',
      FILTER_OUTPUTS: '{}',
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resTokens.hitPackages, ['dsh-lan-proxy']);

  // 聚合包 dsh-plugins-all 不进入 mutationPackages
  const resAll = computeCiMatrix({
    env: {
      GLOBAL_HIT: 'false',
      FILTER_OUTCOME: 'success',
      BASE_SET: 'origin/main',
      FILTER_OUTPUTS: JSON.stringify({ 'dsh-plugins-all': true }),
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resAll.hitPackages, ['dsh-plugins-all']);
  assert.deepEqual(resAll.mutationPackages, []);
  assert.equal(resAll.hasMutations, 'false');
});

test('ci-matrix: 场景 e - fail-closed 异常防护 (manifest 损坏或空清单)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-matrix-mock-'));
  try {
    const scriptsDataDir = path.join(tmpDir, 'scripts/data');
    fs.mkdirSync(scriptsDataDir, { recursive: true });
    // 写入空 manifest
    fs.writeFileSync(path.join(scriptsDataDir, 'plugins-manifest.json'), JSON.stringify({ active: [], standalone: [] }));

    // 只有 dsh-plugins-all 时依然会成功，但如果为空或者读取失败
    fs.writeFileSync(path.join(scriptsDataDir, 'plugins-manifest.json'), 'invalid json');
    assert.throws(
      () => computeCiMatrix({ rootDir: tmpDir }),
      /读取 plugins-manifest\.json 失败/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ci-matrix: 场景 f - CLI 命令行与 --json 参数验证', () => {
  const scriptPath = path.join(ROOT, 'scripts/ci/ci-matrix.mjs');
  const ret = spawnSync(process.execPath, [scriptPath, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(ret.status, 0, `CLI 执行失败: ${ret.stderr}`);
  const parsed = JSON.parse(ret.stdout);
  assert.ok(Array.isArray(parsed.allPackages));
  assert.ok(Array.isArray(parsed.hitPackages));
  assert.ok(Array.isArray(parsed.mutationPackages));
  assert.ok(typeof parsed.hasMutations === 'string');
  assert.ok(Array.isArray(parsed.mutationCombos));
});

test('ci-matrix: 场景 f - GITHUB_OUTPUT 写入契约', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-matrix-gha-'));
  const outputFile = path.join(tmpDir, 'github_output.txt');
  fs.writeFileSync(outputFile, '');

  try {
    const scriptPath = path.join(ROOT, 'scripts/ci/ci-matrix.mjs');
    const ret = spawnSync(process.execPath, [scriptPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        GLOBAL_HIT: 'false',
        FILTER_OUTCOME: 'success',
        BASE_SET: 'origin/main',
        FILTER_OUTPUTS: JSON.stringify({ 'dsh-notifier': true }),
      },
    });
    assert.equal(ret.status, 0, `CLI 执行失败: ${ret.stderr}`);

    const content = fs.readFileSync(outputFile, 'utf8');
    const lines = content.trim().split('\n');
    const record = Object.fromEntries(lines.map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx), l.slice(idx + 1)];
    }));

    assert.equal(record.hitPackages, JSON.stringify(['dsh-notifier']));
    assert.equal(record.mutationPackages, JSON.stringify(['dsh-notifier']));
    assert.equal(record.hasMutations, 'true');
    assert.deepEqual(JSON.parse(record.allPackages), EXPECTED_ALL);
    const combos = JSON.parse(record.mutationCombos);
    assert.equal(combos.length, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
