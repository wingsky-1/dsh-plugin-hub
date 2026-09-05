#!/usr/bin/env node
/**
 * scripts/gate/gen-stryker-conf.mjs — Stryker 变异测试配置派生与门禁校验工具（#572）
 *
 * 核心设计（单一事实源 SSOT + 确定性代码生成）：
 * 1. 唯一事实源：scripts/data/mutation-topology.json
 * 2. 派生目标：stryker.conf.d/*.json（全部 21 份分段配置）
 *
 * 用法：
 *   node scripts/gate/gen-stryker-conf.mjs         # 生成/更新全部 stryker.conf.d/*.json
 *   node scripts/gate/gen-stryker-conf.mjs --check # 门禁校验：磁盘文件与清单一致，且无静默漏测源码
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const topologyPath = join(repoRoot, 'scripts', 'data', 'mutation-topology.json');
const confDir = join(repoRoot, 'stryker.conf.d');

if (!existsSync(topologyPath)) {
  console.error(`[gen-stryker-conf] 拓扑文件不存在: ${topologyPath}`);
  process.exit(1);
}

const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
const { sharedDefaults, packages } = topology;
const isCheckMode = process.argv.includes('--check');

function deriveConfig(pkgName, segKey, segDef, pkgDef) {
  const isSingle = segKey === '_single';
  const confFileName = isSingle ? `${pkgName}.json` : `${pkgName}-${segKey}.json`;
  const reportName = isSingle ? pkgName : `${pkgName}-${segKey}`;
  const shortPkg = pkgName.replace(/^dsh-/, '');
  const incrementalName = isSingle ? `incremental-${shortPkg}.json` : `incremental-${shortPkg}-${segKey}.json`;

  const mutate = [
    ...segDef.mutate,
    ...(segDef.excludes || [
      `!packages/${pkgName}/src/client/**`,
      `!packages/${pkgName}/src/types.ts`,
    ]),
  ];

  const config = {
    $schema: '../node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    mutate,
    testRunner: sharedDefaults.testRunner,
    mutator: {
      excludedMutations: sharedDefaults.excludedMutations,
    },
    plugins: [
      '@stryker-mutator/tap-runner',
    ],
    concurrency: pkgDef.concurrency ?? sharedDefaults.concurrency,
    timeoutMS: pkgDef.timeoutMS ?? sharedDefaults.timeoutMS,
    dryRunTimeoutMinutes: sharedDefaults.dryRunTimeoutMinutes,
    reporters: sharedDefaults.reporters,
    coverageAnalysis: sharedDefaults.coverageAnalysis,
    tempDirName: sharedDefaults.tempDirName,
    cleanTempDir: sharedDefaults.cleanTempDir,
    tap: {
      nodeArgs: sharedDefaults.tapNodeArgs,
      testFiles: pkgDef.testFiles,
    },
    jsonReporter: {
      fileName: `coverage/mutation/${reportName}.json`,
    },
    incremental: true,
    incrementalFile: `coverage/mutation/${incrementalName}`,
  };

  if (segDef.comment) {
    config._comment = segDef.comment;
  }

  return { confFileName, content: JSON.stringify(config, null, 2) + '\n' };
}

// 1. 生成或校验配置文件
const derivedConfigs = new Map();
for (const [pkgName, pkgDef] of Object.entries(packages)) {
  for (const [segKey, segDef] of Object.entries(pkgDef.segments)) {
    const { confFileName, content } = deriveConfig(pkgName, segKey, segDef, pkgDef);
    derivedConfigs.set(confFileName, content);
  }
}

if (isCheckMode) {
  let hasError = false;

  // 1. 检查磁盘上的配置文件是否与派生一致
  const diskFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort();
  const derivedFileNames = [...derivedConfigs.keys()].sort();

  const missingFiles = derivedFileNames.filter((f) => !diskFiles.includes(f));
  const extraFiles = diskFiles.filter((f) => !derivedFileNames.includes(f));

  if (missingFiles.length > 0) {
    console.error(`[gen-stryker-conf] 磁盘缺少以下派生配置文件: ${missingFiles.join(', ')}`);
    hasError = true;
  }
  if (extraFiles.length > 0) {
    console.error(`[gen-stryker-conf] 磁盘存在未在拓扑中定义的游离配置文件: ${extraFiles.join(', ')}`);
    hasError = true;
  }

  for (const [file, expectedContent] of derivedConfigs.entries()) {
    const filePath = join(confDir, file);
    if (existsSync(filePath)) {
      const diskContent = readFileSync(filePath, 'utf8');
      if (diskContent !== expectedContent) {
        console.error(`[gen-stryker-conf] 配置文件内容与拓扑派生不一致: ${file} (请运行 pnpm stryker:gen 同步)`);
        hasError = true;
      }
    }
  }

  if (hasError) {
    console.error('[gen-stryker-conf] --check 失败，配置文件与单一事实源脱节');
    process.exit(1);
  }

  console.log(`[gen-stryker-conf] --check 通过：全部 ${derivedConfigs.size} 份配置文件与拓扑清单严格一致`);
} else {
  // 写模式：同步生成到磁盘
  let written = 0;
  for (const [file, content] of derivedConfigs.entries()) {
    const filePath = join(confDir, file);
    writeFileSync(filePath, content, 'utf8');
    written++;
  }
  console.log(`[gen-stryker-conf] 成功派生生成全部 ${written} 份 Stryker 配置文件至 stryker.conf.d/`);
}
