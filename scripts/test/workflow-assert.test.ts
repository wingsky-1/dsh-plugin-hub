#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * workflow-assert — CI workflow 结构静态断言（#85 v3 F2 防回归条款）。
 *
 * 断言 ci.yml / observe.yml 的关键结构不变量：
 *   - repo-gate 聚合闸：if always()、fail-closed 断言步骤、required check 名不变
 *   - fail-closed 双闸：filter 失败 fallback 全量切片
 *   - build-test 矩阵恒全集构建（repo-gate 全局门禁依赖全量 lib 产物，评审 F1）
 *   - action 一律 pin commit SHA（供应链纪律，与 health-report.yml 既有惯例一致）
 *   - observe.yml：夜间调度、self-cov --check 与 mutate-scope-guard 执行点在位；
 *     六包串行清单 ↔ stryker.conf.d 文件集 ↔ gauntlet mutation.packages 三方一致
 *   - changes 的 case 映射覆盖全部包（防新增包静默漏检，评审 F7）
 *   - #187 触发面收敛：mutation-gate 仅限 pull_request；repo-gate 判定走
 *     scripts/gate/repo-gate-assert.mjs 并以判定表全组合单测锁死
 *   - #217 变异/覆盖解耦：cov 全局单次采集（coverage job）+ stryker 报告
 *     artifact 传递 + mutation-verdict 聚合判分；changes.hasMutations 显式布尔；
 *     mutate-scope-guard 前移进 PR 门禁；needs 连坐语义（coverage 失败 →
 *     verdict 不跑 → repo-gate 红）由结构锚锁死
 *
 * 运行：node --test scripts/test/workflow-assert.test.ts（或 pnpm test:scripts）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../..')
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const OBSERVE = readFileSync(join(ROOT, '.github/workflows/observe.yml'), 'utf8')
const GAUNTLET = JSON.parse(readFileSync(join(ROOT, 'scripts/data/gauntlet.config.json'), 'utf8'))

const ALL_PACKAGES = [
  'dsh-notifier',
  'dsh-idle-archive',
  'dsh-web-file-preview',
  'dsh-mcp-manager',
  'dsh-provider-usage',
  'dsh-lan-proxy',
  'dsh-plugins-all',
]

test('ci.yml: repo-gate 保持分支保护 required check 名', () => {
  const m = /repo-gate:\s*\n\s*name: (.+)/.exec(CI)
  assert.ok(m, '存在 repo-gate 作业且声明 name')
  assert.equal(m[1].trim(), 'Build / Contract / Smoke / Pack',
    'required check 名必须与旧单作业名一致（维护者分支保护无缝切换）')
})

test('ci.yml: repo-gate if always() 且 fail-closed 断言经判定脚本执行', () => {
  const gate = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(/if: always\(\)/.test(gate), 'repo-gate 必须 always() 运行（上游失败时仍执行判红）')
  assert.ok(/Fail-closed gate assertion/.test(gate), 'fail-closed 断言步骤在位')
  // #187：内联 bash 收敛为可单测的判定脚本，env 三维注入（事件 × 切片 × 结果）
  assert.ok(gate.includes('run: node scripts/gate/repo-gate-assert.mjs'),
    'repo-gate fail-closed 判定必须调用 scripts/gate/repo-gate-assert.mjs')
  for (const env of ['GATE_EVENT', 'GATE_CHANGES', 'GATE_BUILD_TEST', 'GATE_MUTATION', 'GATE_MUTATION_PKGS']) {
    assert.ok(new RegExp(`${env}: \\$\\{\\{`).test(gate), `判定脚本 env ${env} 注入缺失`)
  }
  // 时序约束（run #32800733630 教训）：脚本版断言依赖工作区文件，必须排在
  // Checkout 之后；旧内联 bash 无文件依赖曾掩盖该约束
  const checkoutIdx = gate.indexOf('- name: Checkout')
  const assertIdx = gate.indexOf('Fail-closed gate assertion')
  assert.ok(checkoutIdx > 0, 'repo-gate 存在 Checkout 步骤')
  assert.ok(assertIdx > checkoutIdx,
    'fail-closed 断言步骤必须排在 Checkout 之后（脚本需要工作区存在 scripts/gate/）')
})

test('ci.yml: filter 失败 fallback 全量切片（fail-closed 双闸）', () => {
  assert.ok(CI.includes('[ "$FILTER_OUTCOME" = "failure" ]'),
    'filter outcome failure 必须触发全量切片 fallback')
  assert.ok(/按全量处理/.test(CI), 'diff base 不可用时按全量处理（F4）')
})

test('ci.yml: build-test 矩阵恒全集且 build 无条件（评审 F1：全局门禁依赖全量产物）', () => {
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  repo-gate:'))
  for (const pkg of ALL_PACKAGES) {
    assert.ok(bt.includes(`- ${pkg}\n`), `矩阵含 ${pkg}`)
  }
  // build 步骤不得带切片条件；smoke/typecheck 必须带切片条件且 --if-present（评审 F3）
  const buildStep = /#([^#\n]*)Build package[^\n]*\n(?:.*\n)*?- name: Smoke tests/
  assert.ok(/Build package（无条件[^\n]*\n        run: pnpm --filter/.exec(bt.replace(buildStep, (s) => s)), null)
  const buildBlock = bt.slice(bt.indexOf('- name: Build package'), bt.indexOf('- name: Smoke tests'))
  assert.ok(!buildBlock.includes('if:'), 'build 步骤不允许任何 if 条件（产物全集保障）')
  for (const stepName of ['Smoke tests', 'Typecheck']) {
    const idx = bt.indexOf(`- name: ${stepName}`)
    const block = bt.slice(idx, bt.indexOf('- name:', idx + 10))
    assert.ok(block.includes('contains(fromJSON(needs.changes.outputs.hitPackages), matrix.package)'),
      `${stepName} 步骤须按命中清单切片`)
    assert.ok(block.includes('--if-present'), `${stepName} 须 --if-present（聚合包无该脚本）`)
  }
})

test('ci.yml: changes case 映射覆盖全部包（防新增包静默漏检，评审 F7）', () => {
  const computeBlock = CI.slice(CI.indexOf('Compute hit packages'))
  for (const pkg of ALL_PACKAGES) {
    assert.ok(computeBlock.includes(`dsh-${pkg.slice(4)})`) || computeBlock.includes(`${pkg}) V=`),
      `case 分支缺 ${pkg} —— 新增包必须同步加映射分支`)
  }
  // 循环遍历清单与 ALL_PACKAGES 一致
  const loopList = /for pkg in ([\w -]+); do/.exec(computeBlock)?.[1]?.trim().split(/\s+/).sort()
  assert.deepEqual(loopList, [...ALL_PACKAGES].sort(), 'for 循环清单与包全集不一致')
})

test('ci.yml/observe.yml: 第三方与官方 action 一律 pin commit SHA', () => {
  for (const [name, text] of [['ci.yml', CI], ['observe.yml', OBSERVE]]) {
    // 逐行解析 uses: 值（避免贪婪 \S+ 吞掉 @ref，评审 F9）
    const lines = text.split('\n').filter((l) => l.trim().startsWith('uses:'))
    assert.ok(lines.length > 0, `${name} 存在 uses 步骤`)
    for (const line of lines) {
      // owner/repo 及其子 action 路径（如 actions/cache/restore，#178 引入）
      const m = /^uses:\s*([\w.-]+(?:\/[\w.-]+)+)(?:@(\S+))?\s*(?:#.*)?$/.exec(line.trim())
      assert.ok(m, `${name}: 无法解析的 uses 行："${line.trim()}"`)
      assert.match(m[2] ?? '', /^[0-9a-f]{40}/, `${name}: ${m[1]} 未 pin 到 40 位 commit SHA`)
    }
  }
})

test('observe.yml: 夜间调度 + 双硬门禁执行点 + issues 写权限', () => {
  assert.ok(OBSERVE.includes('cron:'), 'schedule 触发器在位')
  assert.ok(OBSERVE.includes('workflow_dispatch'), '支持手动 dispatch')
  assert.ok(OBSERVE.includes('issues: write'), '自动建 issue 需要 issues:write')
  assert.ok(OBSERVE.includes('self-cov.mjs --check'), 'self-written 覆盖率阈值校验执行点（#85 v3）')
  assert.ok(OBSERVE.includes('mutate-scope-guard.mjs'), 'mutate 面守卫执行点（F5）')
  assert.ok(OBSERVE.includes('observe-check.mjs'), '阈值校验+回落检测脚本执行点（F1/F6）')
})

test('#220: docs 不在 ci.yml global 过滤面——文档 PR 不触发变异切片', () => {
  // gate/build/release 脚本均不消费 docs/ 内容；release-notes 校验仅在 release.yml。
  // 若未来新增消费 docs 的门禁脚本，须把 'docs/**' 加回 global 组并同步本断言
  const filterBlock = CI.slice(CI.indexOf('filters: |'), CI.indexOf("dsh-notifier:"))
  assert.ok(!/^.*-\s'docs\/\*\*'/m.test(filterBlock),
    "docs/** 不得出现在 global 过滤组——纯文档 PR 不应触发全量切片")
  assert.ok(CI.includes('# docs/** 刻意不在 global 面'),
    '过滤面旁必须保留理由注释（防后人「好心」加回）')
})

test('#220: observe 按需基线——push 裁剪、兜底全量、空计划跳过 collect', () => {
  assert.ok(OBSERVE.includes('Resolve mutation suites'), 'suite-plan 步骤在位')
  assert.ok(OBSERVE.includes("EVENT_NAME\"] = \"push") || OBSERVE.includes('[ "$EVENT_NAME" != "push" ]'),
    '非 push 事件必须走全量清单')
  assert.ok(OBSERVE.includes('grep -qv \'^[0-9a-f]\\{40\\}$\''),
    'before SHA 不可用必须 fail-closed 全量')
  assert.ok(OBSERVE.includes("^(shared/|pnpm-lock\\.yaml$"),
    'shared/与构建链文件变化必须强制全量刷新（内联产物全集漂移）')
  assert.ok(OBSERVE.includes("steps.suite-plan.outputs.has_suites == 'true'"),
    '变异执行与 collect 必须以 has_suites 为前提——空计划不跑 collect 防 copied=0 误红')
})

test('#220 段式三方一致：observe 计划 ↔ stryker.conf.d 文件集 ↔ gauntlet 包集', () => {
  // observe.yml 循环清单由 suite-plan 步骤产出（#220 按需基线）：全量模式 glob
  // conf 目录，push 模式按变动包裁剪——循环本身从计划文件读取
  assert.ok(OBSERVE.includes('list_all() { ls stryker.conf.d/dsh-*.json; }'),
    'observe suite-plan 的全量清单必须以 glob stryker.conf.d/dsh-*.json 为单一事实源（新增配置自动纳入）')
  assert.ok(OBSERVE.includes('while read -r conf; do'),
    '变异循环必须从 suite-plan 清单文件逐行消费')

  // stryker.conf.d 实际文件集 → 基础包名集合（段配置 <pkg>-<n>.json 归并到 <pkg>）
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.ok(confFiles.length > 0, 'stryker.conf.d 非空')
  const basePkgs = [...new Set(confFiles.map((f) => f.replace(/\.json$/, '').replace(/-\d+$/, '')))].sort()

  // gauntlet mutation.packages 与基础包名集一致
  const gauntPkgs = Object.keys(GAUNTLET?.mutation?.packages ?? {}).sort()
  assert.deepEqual(gauntPkgs, basePkgs,
    'gauntlet mutation.packages 应覆盖全部带变异配置的功能插件包')

  // jsonReporter / incrementalFile 输出路径与配置文件名自洽
  for (const f of confFiles) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    const out = conf?.jsonReporter?.fileName
    assert.ok(out && out.endsWith(`coverage/mutation/${f}`),
      `${f} 的 jsonReporter 输出应为 coverage/mutation/${f}（mutation-gate.mjs 按此约定读取）`)
    const inc = conf?.incrementalFile ?? ''
    assert.ok(inc.endsWith(`incremental-${f.replace(/^dsh-/, '').replace(/\.json$/, '')}.json`),
      `${f} 的 incrementalFile 应为 incremental-${f.replace(/^dsh-/, '').replace(/\.json$/, '')}.json（CI restore 步骤按此推导）`)
  }

  // packages/ 目录集 ⊇ 基础包名集
  for (const p of basePkgs) {
    assert.ok(existsSync(join(ROOT, 'packages', p)), `packages/${p} 目录存在`)
  }
})

test('gauntlet: mutation.packages 全部带 threshold 字段且 ≥60（阶段一基线）', () => {
  const pkgs = GAUNTLET?.mutation?.packages ?? {}
  assert.ok(Object.keys(pkgs).length > 0, 'mutation.packages 非空')
  for (const [pkg, cfg] of Object.entries(pkgs)) {
    assert.equal(typeof cfg.threshold, 'number', `${pkg}.threshold 已落盘`)
    assert.ok(cfg.threshold >= 60, `${pkg}.threshold=${cfg.threshold} 不低于阶段一基线 60`)
  }
})

// ── #178 v2 + #204：Stryker 增量模式接入（夜间全量落仓库基线 + PR 增量切片门禁）──
// #204 修订：actions/cache 按 ref 隔离（PR 永远 miss main 缓存，GitHub Community #58583），
// 基线改「仓库内版本化文件」——夜间 collect 到 scripts/gate/baseline/ + create-pull-request 合入 main，
// PR 侧直接读文件（git 跨 ref 天然可见、可本地实证）。

test('#178+#204: observe.yml 夜间保持全量——只收集仓库基线不读缓存', () => {
  assert.ok(
    !OBSERVE.includes('actions/cache/restore'),
    'observe.yml 严禁出现 restore 缓存步骤——无基线即天然全量（v2 架构定案，勿"好心"补 restore）',
  )
  assert.ok(
    !OBSERVE.includes('actions/cache/save@'),
    'observe.yml 已改用仓库内基线（#204），不得出现 cache/save 步骤',
  )
  const collectIdx = OBSERVE.indexOf('Collect incremental baseline')
  assert.ok(collectIdx > 0, 'collect 步骤在位（夜间基线 → 仓库内固定路径）')
  const collectBlock = OBSERVE.slice(collectIdx, OBSERVE.indexOf('- name:', collectIdx + 10))
  assert.ok(collectBlock.includes('if: always()'), 'collect 步骤必须 if: always()（部分失败夜已产出的基线照常收集）')
  assert.ok(collectBlock.includes('collect-incremental-baseline.mjs'), 'collect 脚本执行点在位')
  assert.ok(OBSERVE.includes('create-pull-request@'), '基线经 create-pull-request 自动开 PR 合入 main（受保护分支禁直接 push）')
  assert.ok(OBSERVE.includes('peter-evans/create-pull-request'), '使用业界标准 peter-evans/create-pull-request')
  assert.ok(OBSERVE.includes('contents: write'), 'observe.yml permissions 需 contents: write（自动 PR 创建需要）')
  assert.ok(OBSERVE.includes('pull-requests: write'), 'observe.yml permissions 需 pull-requests: write')
})

test('#276: mutate 区间机器派生——sync --write 先于 guard/stryker，入库行号允许漂移', () => {
  for (const [name, wf] of [['ci.yml', CI], ['observe.yml', OBSERVE]]) {
    assert.ok(wf.includes('node scripts/gate/sync-mutate-segments.mjs --write'),
      `${name} 必须在 stryker run 前调用 sync --write（区间从产物分段锚点重算，#276 方案 B）`)
    const syncIdx = wf.indexOf('sync-mutate-segments.mjs --write')
    const runIdx = wf.indexOf('npx stryker run')
    assert.ok(syncIdx > 0 && runIdx > syncIdx, `${name} 的 sync 步骤必须先于 stryker run`)
  }
  // 声明文件存在且为唯一分组事实源
  const segDecl = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'mutation-segments.json'), 'utf8'))
  const pkgs = Object.keys(segDecl).filter(k => k !== '$comment')
  assert.ok(pkgs.length >= 7, 'mutation-segments.json 应覆盖全部带变异配置的包')
})

test('#178+#204: ci.yml PR 增量门禁——读仓库基线文件 + 按命中包切片 + 并入 repo-gate', () => {
  // #204：直接读 scripts/gate/baseline/ 仓库内文件，替代 actions/cache restore（跨 ref 失效）
  assert.ok(CI.includes('Restore repo incremental baseline'), 'mutation-gate 基线读取步骤在位（读仓库内文件）')
  assert.ok(!CI.includes('actions/cache/restore@'), 'ci.yml 不得再用 actions/cache/restore（#204 已废弃跨 ref 缓存通道）')
  assert.ok(!CI.includes('actions/cache/save@'), 'ci.yml 禁止 save 缓存（PR 结果绝不回写夜间基线）')
  assert.ok(!CI.includes('actions/cache/@'), 'ci.yml 禁用 actions/cache@ 主 action 形态')

  const gateIdx = CI.indexOf('\n  mutation-gate:')
  assert.ok(gateIdx > 0, 'mutation-gate job 在位')
  // #217 后矩阵只做基线 restore + stryker run + 报告上传，判分收敛到 mutation-verdict
  const mg = CI.slice(gateIdx, CI.indexOf('\n  mutation-verdict:'))
  assert.ok(mg.includes('combo: ${{ fromJSON(needs.changes.outputs.mutationCombos) }}'),
    '动态 matrix ← changes.mutationCombos（#220 段式组合：[{package,seg}]，命中包按段实例化）')
  assert.ok(mg.includes('scripts/gate/baseline/${BASENAME}.json'),
    '读仓库基线文件路径 scripts/gate/baseline/incremental-<pkg|pkg-seg>.json（#220 段式命名）')
  assert.ok(mg.includes('PKG="${MATRIX_PKG#dsh-}"'), '矩阵包名 dsh-<pkg> → 基线短名的映射在位')
  assert.ok(mg.includes('::notice::'), '基线缺失时须打 notice 标注全量降级（首夜属预期，防误判缺陷）')
  // build 必须全量（run #32790425132 教训）：mutate 区间行号锚定 esbuild 产物分段，
  // 产物结构依赖 workspace 内联链全集一致性
  const mgBuildIdx = mg.indexOf('Build all packages')
  assert.ok(mgBuildIdx > 0, 'mutation-gate 全量构建步骤在位')
  const mgBuildBlock = mg.slice(mgBuildIdx, mg.indexOf('- name:', mgBuildIdx + 10))
  assert.ok(/run: pnpm build\s*$/.test(mgBuildBlock), 'mutation-gate 构建步骤必须为全量 pnpm build')
  assert.ok(!mgBuildBlock.includes('--filter'), 'mutation-gate 构建步骤禁止 --filter 单包切片')

  // 成败并入既有聚合闸，不新增分支保护 required check 名
  assert.ok(/needs: \[changes, build-test, coverage, mutation-gate, mutation-verdict\]/.test(CI),
    'repo-gate needs 纳入 coverage 与 mutation-gate/mutation-verdict（#217 五维聚合）')
  // 聚合闸 fail-closed 判定脚本必须显式引用变异链结果（防聚合闸旁路）
  const rg = CI.slice(CI.indexOf('\n  repo-gate:'))
  assert.ok(rg.includes('needs.mutation-gate.result'),
    'repo-gate fail-closed 判定脚本必须检查 needs.mutation-gate.result')
})

// ── #187 触发面收敛：mutation-gate 仅限 pull_request，主干变异归夜间全量 ──

test('#187: ci.yml mutation-gate if 收敛至 pull_request（删除或改坏必红）', () => {
  // build-test 不受收敛影响：push 时仍须全集构建（repo-gate 全局门禁依赖产物）
  const bt = CI.slice(CI.indexOf('\n  build-test:'), CI.indexOf('\n  mutation-gate:'))
  assert.ok(bt.includes('if: always() && needs.changes.result == \'success\''),
    'build-test 的 if 必须保持 always() 全事件构建语义')

  const mg = CI.slice(CI.indexOf('\n  mutation-gate:'), CI.indexOf('\n  mutation-verdict:'))
  const m = /^    if: (.+)$/m.exec(mg)
  assert.ok(m, 'mutation-gate 声明 job 级 if')
  assert.equal(
    m[1].trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    'mutation-gate 的 if 必须精确为「仅 PR 且 hasMutations 显式布尔」——'
    + '事件限制被删除（退化 push 全量变异）或被改坏（PR 门禁静默缺席）均判红；'
    + '#217 起空切片判定走 changes.hasMutations，禁止 fromJSON|length 或裸 \'[]\' 比较',
  )
})

test('#217+#187: repo-gate-assert 判定表全组合锁定（事件 × 切片 × coverage × 矩阵 × verdict）', async () => {
  const { evaluateGate } = await import('../gate/repo-gate-assert.mjs')
  const base = {
    event: 'pull_request',
    changes: 'success',
    buildTest: 'success',
    coverage: 'success',
    mutation: 'success',
    verdict: 'success',
    hasMutations: 'true',
    mutationPkgsJson: '["dsh-notifier"]',
  }
  const run = (over) => evaluateGate({ ...base, ...over })
  const RESULTS = ['success', 'failure', 'cancelled', 'skipped']

  // 手写期望表（独立于实现成文，防同义反复；0=绿 1=红）：
  //   - 非 PR：覆盖/变异三段全部 skipped 才绿（触发面收敛不变量）
  //   - PR + hasMutations=true：coverage==success && 矩阵∈{success,failure}
  //     && verdict==success 才绿
  //   - PR + 空切片：coverage==skipped && 矩阵/verdict∈{skipped,failure} 才绿
  const expectOf = (event, hm, cov, mut, verd) => {
    if (event !== 'pull_request') {
      return (cov === 'skipped' && mut === 'skipped' && verd === 'skipped') ? 0 : 1
    }
    if (hm === 'true') {
      return (cov === 'success' && (mut === 'success' || mut === 'failure') && verd === 'success') ? 0 : 1
    }
    return (cov === 'skipped'
      && (mut === 'skipped' || mut === 'failure')
      && (verd === 'skipped' || verd === 'failure')) ? 0 : 1
  }

  // PR 分支：hasMutations × coverage × 矩阵 × verdict 全组合（2×4×4×4 = 128 case）
  for (const hm of ['true', 'false']) {
    const pkgsJson = hm === 'true' ? '["dsh-notifier"]' : '[]'
    for (const cov of RESULTS) {
      for (const mut of RESULTS) {
        for (const verd of RESULTS) {
          const expected = expectOf('pull_request', hm, cov, mut, verd)
          const v = run({ hasMutations: hm, mutationPkgsJson: pkgsJson, coverage: cov, mutation: mut, verdict: verd })
          assert.equal(v.code, expected,
            `PR hasMutations=${hm} coverage=${cov} mutation=${mut} verdict=${verd} 应为 code=${expected}`)
        }
      }
    }
  }

  // 非 PR 分支：三段结果全组合（2 事件 × 4×4×4 = 128 case）；push fail-closed
  // 真实形态（GATE_MUTATION_PKGS 的 push 取值）为非空全集清单，数据校验须放行
  for (const ev of ['push', 'workflow_dispatch']) {
    for (const cov of RESULTS) {
      for (const mut of RESULTS) {
        for (const verd of RESULTS) {
          const expected = expectOf(ev, 'true', cov, mut, verd)
          const v = run({
            event: ev,
            hasMutations: 'true',
            mutationPkgsJson: JSON.stringify(ALL_PACKAGES),
            coverage: cov,
            mutation: mut,
            verdict: verd,
          })
          assert.equal(v.code, expected,
            `${ev} coverage=${cov} mutation=${mut} verdict=${verd} 应为 code=${expected}`)
        }
      }
    }
  }

  // ── reason 文案锚：区分「coverage 失败连坐」与「mutation 门禁绕过」（#217）──
  assert.match(run({ coverage: 'failure' }).reason, /coverage 失败连坐/,
    'coverage failure 判词必须点名「失败连坐」而非误报绕过')
  assert.match(run({ coverage: 'cancelled' }).reason, /coverage 失败连坐/,
    'coverage cancelled 同属失败连坐语义')
  assert.match(run({ coverage: 'skipped' }).reason, /缺席/,
    'coverage 缺席是结构性违约（if 契约被改坏），文案须与失败连坐区分')
  assert.match(run({ mutation: 'skipped' }).reason, /门禁绕过/,
    '矩阵该跑没跑判词必须点名「门禁绕过」')
  assert.match(run({ verdict: 'skipped' }).reason, /门禁绕过/,
    'verdict 该跑没跑同样按门禁绕过点名')
  assert.match(run({ verdict: 'failure' }).reason, /双指标|判分未通过/,
    'verdict failure 判词须点名判分未通过')
  assert.match(run({ verdict: 'cancelled' }).reason, /被取消（未完成判分）/,
    'verdict cancelled 判词须单列「被取消」，不得与判分未通过混用（复核小修）')
  assert.match(run({ event: 'push', mutation: 'success' }).reason, /收敛不变量/,
    '非 PR 下变异执行判词须点名收敛不变量')

  // 防回归对照：矩阵 failure 在 hasMutations=true 下不单独判红（报告已下发、
  // 由 verdict 统一裁决），但 verdict 未通过时整体必红
  assert.equal(run({ mutation: 'failure', verdict: 'success' }).code, 0,
    '矩阵实例级 failure + verdict 达标 = 绿（聚合判分语义）')
  assert.equal(run({ mutation: 'success', verdict: 'failure' }).code, 1,
    '矩阵 success 但 verdict 判分未通过 = 红')
  assert.equal(run({ mutation: 'failure', verdict: 'failure' }).code, 1,
    '矩阵与 verdict 双红 = 红')

  // 前提闸：changes / build-test 非 success 一律红（含 cancelled / skipped）
  for (const r of ['failure', 'cancelled', 'skipped']) {
    assert.equal(run({ changes: r }).code, 1, `changes=${r} 必须红`)
    assert.equal(run({ buildTest: r }).code, 1, `build-test=${r} 必须红`)
  }

  // 数据契约破坏：exit 2 —— 清单非法 JSON、hasMutations 非 'true'/'false'、
  // 显式布尔与切片非空性交叉矛盾
  for (const bad of ['not-json', '{"a":1}', '"dsh-notifier"']) {
    assert.equal(run({ mutationPkgsJson: bad }).code, 2, `切片清单非法（${bad}）必须 exit 2`)
  }
  for (const badHm of ['', 'TRUE', '1', 'null']) {
    assert.equal(run({ hasMutations: badHm }).code, 2, `hasMutations="${badHm}" 必须 exit 2`)
  }
  assert.equal(run({ hasMutations: 'true', mutationPkgsJson: '[]' }).code, 2,
    'hasMutations=true 而切片为空 = 数据矛盾 exit 2')
  assert.equal(run({ hasMutations: 'false', mutationPkgsJson: '["dsh-notifier"]' }).code, 2,
    'hasMutations=false 而切片非空 = 数据矛盾 exit 2')
})

test('#217+#187: repo-gate-assert CLI 退出码转发（GitHub Actions 判红依据）', () => {
  const script = join(ROOT, 'scripts/gate/repo-gate-assert.mjs')
  const envOf = (over) => ({
    GATE_EVENT: over.event ?? '',
    GATE_CHANGES: over.changes ?? '',
    GATE_BUILD_TEST: over.buildTest ?? '',
    GATE_COVERAGE: over.coverage ?? '',
    GATE_MUTATION: over.mutation ?? '',
    GATE_VERDICT: over.verdict ?? '',
    GATE_HAS_MUTATIONS: over.hasMutations ?? '',
    GATE_MUTATION_PKGS: over.mutationPkgsJson ?? '',
  })
  // 通过场景 exit 0：push 触发面收敛形态（三段全 skipped + 非空全集清单）
  const okRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'push', changes: 'success', buildTest: 'success',
      coverage: 'skipped', mutation: 'skipped', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: JSON.stringify(ALL_PACKAGES),
    }) },
  })
  assert.equal(okRun.status, 0, 'push + 三段全 skipped 场景 CLI 必须 exit 0')
  // 违约场景 exit 1 且输出 ::error:: 可检索的判词：PR 该跑没跑（verdict skipped）
  const failRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'pull_request', changes: 'success', buildTest: 'success',
      coverage: 'success', mutation: 'skipped', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: '["dsh-lan-proxy"]',
    }) },
  })
  assert.equal(failRun.status, 1, 'PR 该跑没跑场景 CLI 必须 exit 1')
  assert.match(failRun.stderr, /::error::/, '违约判词必须带 ::error:: 注解前缀（PR 页面可见）')
  assert.match(failRun.stderr, /绕过/, '判词须点名门禁绕过语义')
  // 连坐场景 exit 1 且判词区分「coverage 失败连坐」（#217 reason 分型）。
  // env 取值贴合并行拓扑真实形态（复核裁决选项 b）：矩阵与 coverage 平行、
  // cov 挂了矩阵照跑 success，verdict 因 if 要求 coverage success 连带 skipped
  const covFailRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...envOf({
      event: 'pull_request', changes: 'success', buildTest: 'success',
      coverage: 'failure', mutation: 'success', verdict: 'skipped',
      hasMutations: 'true', mutationPkgsJson: '["dsh-lan-proxy"]',
    }) },
  })
  assert.equal(covFailRun.status, 1, 'coverage 失败连坐场景 CLI 必须 exit 1')
  assert.match(covFailRun.stderr, /::error::/, '连坐判词必须带 ::error:: 注解前缀')
  assert.match(covFailRun.stderr, /coverage 失败连坐/, '连坐场景判词必须点名「coverage 失败连坐」，不得误报为门禁绕过')
})

test('#178: ci.yml 包名全集 ≡ gauntlet 变异六包 ∪ {dsh-plugins-all}（防清单漂移）', () => {
  const mentioned = [...new Set(CI.match(/dsh-[a-z0-9-]+/g) ?? [])].sort()
  const expected = [...new Set([
    ...Object.keys(GAUNTLET?.mutation?.packages ?? {}),
    'dsh-plugins-all',
  ])].sort()
  assert.deepEqual(mentioned, expected,
    `ci.yml 出现的包名集合与 gauntlet mutation.packages ∪ {dsh-plugins-all} 不一致：`
    + `ci=${mentioned.join(',')} gauntlet+all=${expected.join(',')}——新增包须同步全部清单`)
})

test('#178: 六份 stryker 配置开增量且 incrementalFile 无点前缀', () => {
  const confDir = join(ROOT, 'stryker.conf.d')
  const confFiles = readdirSync(confDir).filter((f) => f.endsWith('.json')).sort()
  assert.ok(confFiles.length > 0, 'stryker.conf.d 非空')
  for (const f of confFiles) {
    const conf = JSON.parse(readFileSync(join(confDir, f), 'utf8'))
    assert.equal(conf.incremental, true, `${f} 未开启 incremental`)
    const inc = typeof conf.incrementalFile === 'string' ? conf.incrementalFile : ''
    assert.match(inc, /^coverage\/mutation\/incremental-[a-z0-9-]+\.json$/,
      `${f} incrementalFile 必须落在 coverage/mutation/ 下且命名 incremental-<pkg>.json`)
    assert.ok(!basename(inc).startsWith('.'), `${f} incrementalFile 不得为 dotfile（upload-artifact v4 默认排除 hidden files，评审 P2#1）`)
    const pkgShort = f.replace(/^dsh-/, '').replace(/\.json$/, '')
    assert.ok(inc.endsWith(`incremental-${pkgShort}.json`), `${f} incrementalFile 包名段与配置文件名一致`)
  }
})

test('#178: 变异统计口径单一事实源——observe-check 与 mutation-gate 共用 lib', () => {
  for (const f of ['scripts/gate/observe-check.mjs', 'scripts/gate/mutation-gate.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(src.includes("from '../lib/mutation-report-lib.mjs'"),
      `${f} 须 import scripts/lib/mutation-report-lib.mjs 共享统计函数（防两处 covered 口径漂移）`)
  }
})

// ── #217 变异/覆盖解耦：cov 全局单次采集 + artifact 跨 job 传递 + 聚合判分 ──
// 三段式：coverage（全局单进程 cov+self-cov+guard 前移）∥ mutation-gate 矩阵
// （仅基线+stryker+报告上传，needs 仅 changes、与 coverage 平行无依赖——复核
// 裁决选项 b，wall-clock = max）→ mutation-verdict（artifact 汇合后逐包判分，
// if 要求 coverage success：cov 失败时 verdict 连带缺席，repo-gate 判红兜底）。
// flake 根因（矩阵 6 路并行各自全仓 smoke 的端口竞争与时序漂移）随剥离消除。

test('#217: changes 输出显式布尔 hasMutations（禁止脆弱空切片判定形态）', () => {
  assert.ok(CI.includes('hasMutations: ${{ steps.pkgs.outputs.hasMutations }}'),
    'changes outputs 必须声明并透传 hasMutations')
  assert.ok(CI.includes("jq -c 'length > 0'"),
    'hasMutations 必须由 mutationPackages 清单推导为显式布尔')
  // 下游一律精确比较布尔字符串；GHA 表达式无 length/管道，两种脆弱形态禁用
  assert.ok(!/\|\s*length/.test(CI), 'ci.yml 禁止 fromJSON(...)|length 判空形态')
  assert.ok(!CI.includes("'[]'"), 'ci.yml 禁止裸字符串比较 \'[]\' 判空形态')
})

test('#217: coverage job 全局单次采集——if 精确、步骤链与 artifact 上传契约', () => {
  const covIdx = CI.indexOf('\n  coverage:')
  assert.ok(covIdx > 0, 'coverage job 在位（非矩阵单实例）')
  const cov = CI.slice(covIdx, CI.indexOf('\n  mutation-gate:'))
  assert.ok(!cov.includes('matrix:'), 'coverage job 不得使用 matrix（全局单次语义）')
  assert.equal(
    /^    if: (.+)$/m.exec(cov)?.[1]?.trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    'coverage if 必须精确为「仅 PR 且 hasMutations」',
  )
  // 步骤链顺序：build → guard → cov → self-cov → upload
  const buildIdx = cov.indexOf('- name: Build all packages')
  const guardIdx = cov.indexOf('mutate-scope-guard.mjs')
  const covRunIdx = cov.indexOf('run: pnpm cov')
  const selfCovIdx = cov.indexOf('node scripts/gate/self-cov.mjs')
  const upIdx = cov.indexOf('Upload self-coverage artifact')
  for (const [name, idx] of [['Build all packages', buildIdx], ['mutate-scope-guard', guardIdx],
    ['pnpm cov', covRunIdx], ['self-cov.mjs', selfCovIdx], ['upload artifact', upIdx]]) {
    assert.ok(idx > 0, `coverage 步骤 ${name} 在位`)
  }
  assert.ok(buildIdx < guardIdx && guardIdx < covRunIdx && covRunIdx < selfCovIdx && selfCovIdx < upIdx,
    'coverage 步骤链必须按 build → guard → cov → self-cov → upload 排布（guard 校验 lib 分段、self-cov 读 c8 产物）')
  assert.ok(!cov.slice(0, upIdx).includes('--check'), 'PR coverage 只落盘不判红（--check 阈值硬校验归 observe 夜间）')

  // artifact 上传契约（fail-closed）
  const uploadBlock = cov.slice(upIdx)
  assert.ok(uploadBlock.includes('name: self-coverage'), 'artifact 名必须精确为 self-coverage（下游同名精确下载）')
  assert.ok(uploadBlock.includes('path: coverage/self-coverage.json'), '上传路径为固定产物路径')
  assert.ok(uploadBlock.includes('if-no-files-found: error'), '产物缺失必须 error（防下游静默空判分）')
  assert.ok(uploadBlock.includes('retention-days: 1'), '跨 job 传递产物 retention 收敛为 1 天')

  // #217 顺路加固：mutate-scope-guard 前移进 PR 门禁（原只在 observe 夜间，
  // 配置漂移注定合并后才暴露——实证 run 32869177152 / #235）
  assert.ok(CI.includes('node scripts/gate/mutate-scope-guard.mjs'),
    'mutate-scope-guard 必须前移进 ci.yml PR 门禁')
})

test('#217: mutation-gate 剥离 cov——与 coverage 平行（needs 仅 changes）、if 精确锁定', () => {
  const mg = CI.slice(CI.indexOf('\n  mutation-gate:'), CI.indexOf('\n  mutation-verdict:'))
  // 复核裁决选项 b：矩阵与 coverage 平行无依赖（wall-clock = max）；
  // cov 失败时矩阵照常跑完，由 verdict 缺席 + repo-gate 判定表兜底整体红
  assert.ok(/^    needs: changes$/m.test(mg),
    'mutation-gate needs 必须恰为 changes（不得挂 coverage 连坐——拓扑已裁决为并行）')
  assert.ok(!mg.includes('needs: [changes, coverage'), '禁止恢复 mutation-gate → coverage 串行连坐拓扑')
  const m = /^    if: (.+)$/m.exec(mg)
  assert.ok(m, 'mutation-gate 声明 job 级 if')
  assert.equal(
    m[1].trim(),
    "github.event_name == 'pull_request' && needs.changes.outputs.hasMutations == 'true'",
    '矩阵 if 必须精确锁定事件面与显式布尔切片',
  )
  // cov 已剥离出矩阵（每实例重复全仓 smoke 是 flake 根因）
  assert.ok(!mg.includes('run: pnpm cov'), '矩阵不得再跑 pnpm cov（已收敛至 coverage job 单次）')
  assert.ok(!mg.includes('self-cov.mjs'), '矩阵不得再跑 self-cov.mjs')
  // 报告上传契约：失败实例的报告也下发聚合判分
  const upIdx = mg.indexOf('Upload stryker report artifact')
  assert.ok(upIdx > 0, 'stryker 报告上传步骤在位')
  const upBlock = mg.slice(upIdx)
  assert.ok(/if: always\(\)/.test(upBlock), '报告上传必须 if: always()（实例非零退出时报告照常下发统一判分）')
  assert.ok(upBlock.includes('name: mutation-report-${{ matrix.combo.package }}-s${{ matrix.combo.seg }}'),
    '报告 artifact 名含 matrix.combo（package+seg）保证段实例唯一（pattern 下游可枚举）')
  assert.ok(upBlock.includes('if-no-files-found: error'), '报告缺失必须 error（verdict 缺报告 fail-closed 的前提）')
})

test('#217: mutation-verdict 聚合收尾——artifact 汇合 + 逐包双指标判分', () => {
  const mv = CI.slice(CI.indexOf('\n  mutation-verdict:'), CI.indexOf('\n  repo-gate:'))
  assert.ok(mv.length > 0, 'mutation-verdict job 在位')
  assert.ok(/needs: \[changes, coverage, mutation-gate\]/.test(mv),
    'verdict needs 三元：切片清单 + 覆盖产物 + 变异报告缺一不可')
  assert.equal(
    /^    if: (.+)$/m.exec(mv)?.[1]?.trim(),
    "always() && needs.coverage.result == 'success' && needs.mutation-gate.result != 'skipped'",
    'verdict if 必须精确为「always() 且 coverage success 且矩阵非 skipped」——'
    + '矩阵 failure 时仍聚合判分（缺报告包 exit 2 fail-closed）；coverage 非 success 或矩阵 skipped 时连带缺席',
  )
  // artifact 下载：精确名 + pattern 双通道；download self-coverage 步骤块逐项精确断言
  const dlIdx = mv.indexOf('- name: Download self-coverage artifact')
  assert.ok(dlIdx > 0, 'self-coverage 下载步骤在位')
  const dlBlock = mv.slice(dlIdx, mv.indexOf('- name:', dlIdx + 10))
  assert.ok(dlBlock.includes('name: self-coverage'),
    'download 必须用精确 name self-coverage（pattern 匹配 0 个不报错，精确名缺失才报错）')
  assert.ok(/path: coverage\s*$/m.test(dlBlock),
    'download path 必须恰为 coverage/（单文件 zip 根层级 = 文件本身，解压即还原 coverage/self-coverage.json）')
  assert.ok(mv.includes('pattern: mutation-report-*'), '各包 stryker 报告经 pattern 枚举下载')
  assert.ok(mv.includes('node scripts/gate/mutation-gate.mjs'), '逐包判分脚本调用在位')
  assert.ok(mv.includes("SLICE: ${{ needs.changes.outputs.mutationPackages }}"),
    'verdict 以 changes 切片清单驱动逐包判分')
})

test('#217: repo-gate 五维聚合 needs + 判定脚本 env 全维注入', () => {
  const rg = CI.slice(CI.indexOf('\n  repo-gate:'))
  for (const env of ['GATE_EVENT', 'GATE_CHANGES', 'GATE_BUILD_TEST',
    'GATE_COVERAGE', 'GATE_MUTATION', 'GATE_VERDICT', 'GATE_HAS_MUTATIONS', 'GATE_MUTATION_PKGS']) {
    assert.ok(new RegExp(`${env}: \\$\\{\\{`).test(rg), `判定脚本 env ${env} 注入缺失`)
  }
  // 判定表实现侧同维锁定（env ↔ evaluateGate 输入一一对应）
})

test('#217: observe.yml Mutation suites id + collect 区分整套 skip 与部分失败', () => {
  const sIdx = OBSERVE.indexOf('- name: Mutation suites')
  assert.ok(sIdx > 0, 'Mutation suites 步骤在位')
  const sBlock = OBSERVE.slice(sIdx, OBSERVE.indexOf('- name:', sIdx + 10))
  assert.ok(sBlock.includes('id: mutation-suites'), 'Mutation suites 必须声明 id 供下游引用 outcome')
  const cIdx = OBSERVE.indexOf('- name: Collect incremental baseline')
  const cBlock = OBSERVE.slice(cIdx, OBSERVE.indexOf('- name:', cIdx + 10))
  assert.ok(cBlock.includes("if: always() && steps.mutation-suites.outcome != 'skipped'"),
    'collect 条件必须区分整套 skip（无产物不收集）与部分失败（记账夜照常收集）')
})
