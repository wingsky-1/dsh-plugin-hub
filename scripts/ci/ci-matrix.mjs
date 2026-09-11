#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 空切片时 build-test 矩阵的哨兵项（#722）：见 computeCiMatrix 内 buildPackages 注释。
 * 取一个不可能成为包名的值，保证所有 `contains(hitPackages, matrix.package)` 条件为假。
 */
export const NO_HIT_PACKAGE = '__no-hit-package__';

/**
 * 计算 CI 切片与变异矩阵
 * 100% 原生 Node.js 内置模块（node:fs, node:path, node:process），无任何外部依赖
 *
 * @param {object} [options]
 * @param {object} [options.env] 环境变量注入，默认 process.env
 * @param {string} [options.rootDir] 仓库根目录，默认自动推导
 * @returns {{
 *   allPackages: string[],
 *   hitPackages: string[],
 *   mutationPackages: string[],
 *   hasMutations: string,
 *   mutationCombos: Array<{ package: string, seg: string }>
 * }}
 */
export function computeCiMatrix(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  // 1. 读取候选包全量集合（单一事实源：plugins-manifest.json）
  const manifestPath = path.join(rootDir, 'scripts/data/plugins-manifest.json');
  let manifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`读取 plugins-manifest.json 失败（fail-closed）: ${err.message}`);
  }

  const active = Array.isArray(manifest.active) ? manifest.active : [];
  const standalone = Array.isArray(manifest.standalone) ? manifest.standalone : [];
  const pluginSet = new Set([...active, ...standalone]);
  // allPackages = 全量插件集 ∪ ["dsh-plugins-all"]（排好序去重，供 downstream 产物验证）
  const allPackages = Array.from(new Set([...pluginSet, 'dsh-plugins-all'])).sort();

  if (allPackages.length === 0) {
    throw new Error('包清单为空（fail-closed，禁止静默通过）');
  }

  // 2. 环境变量解析
  const globalHit = env.GLOBAL_HIT === 'true';
  const filterOutcome = env.FILTER_OUTCOME;
  const baseSetRaw = (env.BASE_SET || '').trim();

  let filterOutputs = {};
  if (env.FILTER_OUTPUTS) {
    try {
      if (typeof env.FILTER_OUTPUTS === 'object' && env.FILTER_OUTPUTS !== null) {
        filterOutputs = env.FILTER_OUTPUTS;
      } else {
        filterOutputs = JSON.parse(env.FILTER_OUTPUTS) || {};
      }
    } catch {
      filterOutputs = {};
    }
  }

  // 3. 切片命中逻辑（hitPackages）
  // 若 GLOBAL_HIT === 'true' 或 FILTER_OUTCOME !== 'success' 或 BASE_SET 为空，全量回退：hitPackages = allPackages
  const shouldFallback = globalHit || filterOutcome !== 'success' || !baseSetRaw;

  let hitPackages = [];
  if (shouldFallback) {
    hitPackages = [...allPackages];
  } else {
    // 从 BASE_SET 解析出的包名集合
    const baseTokens = new Set(baseSetRaw.split(/\s+/).filter(Boolean));
    const hits = new Set();

    for (const pkg of allPackages) {
      const hitInBase = baseTokens.has(pkg);
      const val = filterOutputs[pkg];
      const hitInFilter = val === true || val === 'true';
      if (hitInBase || hitInFilter) {
        hits.add(pkg);
      }
    }
    hitPackages = Array.from(hits).sort();
  }

  // 4. 变异切片逻辑（mutationPackages / mutationCombos）
  const confDir = path.join(rootDir, 'stryker.conf.d');
  let confFiles = [];
  try {
    if (fs.existsSync(confDir)) {
      confFiles = fs.readdirSync(confDir).filter((f) => f.endsWith('.json'));
    }
  } catch {
    confFiles = [];
  }

  // mutationPackages = hitPackages 中排除了 "dsh-plugins-all" 以及在 stryker.conf.d/ 中没有任何配置文件的包
  const mutationPackages = [];
  for (const pkg of hitPackages) {
    if (pkg === 'dsh-plugins-all') continue;
    const hasSingleConf = confFiles.includes(`${pkg}.json`);
    const hasSegConf = confFiles.some((f) => f.startsWith(`${pkg}-`));
    if (hasSingleConf || hasSegConf) {
      mutationPackages.push(pkg);
    }
  }
  mutationPackages.sort();

  const hasMutations = String(mutationPackages.length > 0);

  // mutationCombos: 读取 stryker.conf.d/<pkg>-*.json 文件，展开组合，若只有单配置则 seg: "0"
  const mutationCombos = [];
  for (const pkg of mutationPackages) {
    const segFiles = confFiles.filter((f) => f.startsWith(`${pkg}-`));
    if (segFiles.length > 0) {
      const segNames = [];
      for (const file of segFiles) {
        const segName = file.slice(pkg.length + 1, -5); // 剥掉 `${pkg}-` 和 `.json`
        if (segName) {
          segNames.push(segName);
        }
      }
      segNames.sort();
      for (const seg of segNames) {
        mutationCombos.push({ package: pkg, seg });
      }
    } else {
      mutationCombos.push({ package: pkg, seg: '0' });
    }
  }

  mutationCombos.sort((a, b) => {
    const cmp = a.package.localeCompare(b.package);
    if (cmp !== 0) return cmp;
    return a.seg.localeCompare(b.seg);
  });

  // buildPackages（#722）：build-test 矩阵的来源 = 命中包；空切片时用哨兵占位。
  // 为什么需要哨兵：GHA 的**零实例动态矩阵**实测回报 failure（实证 run 32802575298），
  // 而 repo-gate 的判定表要求 build-test == success —— 纯文档/meta PR 会因此假红。
  // 哨兵实例不匹配任何包，所有步骤的 `contains(hitPackages, ...)` 条件自然为假，
  // 只花一次 checkout+setup 就换来「动态矩阵 + 确定性 success」。
  const buildPackages = hitPackages.length > 0 ? hitPackages : [NO_HIT_PACKAGE];

  return {
    allPackages,
    hitPackages,
    buildPackages,
    mutationPackages,
    hasMutations,
    mutationCombos,
  };
}

/**
 * CLI 入口逻辑
 */
export function runCli(argv = process.argv, env = process.env) {
  let result;
  try {
    result = computeCiMatrix({ env });
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  const { allPackages, hitPackages, buildPackages, mutationPackages, hasMutations, mutationCombos } = result;
  const isJson = argv.includes('--json');

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`全量包清单（单一事实源）: ${JSON.stringify(allPackages)}`);
    console.log(`命中包（跑 smoke/typecheck 切片）: ${JSON.stringify(hitPackages)}`);
    console.log(`build-test 矩阵（空切片时含哨兵）: ${JSON.stringify(buildPackages)}`);
    console.log(`变异包: ${JSON.stringify(mutationPackages)}`);
    console.log(`变异组合: ${JSON.stringify(mutationCombos)}`);
    console.log(`hasMutations: ${hasMutations}`);
  }

  if (env.GITHUB_OUTPUT) {
    try {
      const lines = [
        `allPackages=${JSON.stringify(allPackages)}`,
        `hitPackages=${JSON.stringify(hitPackages)}`,
        `buildPackages=${JSON.stringify(buildPackages)}`,
        `mutationPackages=${JSON.stringify(mutationPackages)}`,
        `hasMutations=${hasMutations}`,
        `mutationCombos=${JSON.stringify(mutationCombos)}`,
      ];
      fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      console.error(`::error::写入 GITHUB_OUTPUT 失败: ${err.message}`);
      process.exit(1);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli();
}
