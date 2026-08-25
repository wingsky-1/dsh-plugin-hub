#!/usr/bin/env node
/**
 * repo-gate-assert — repo-gate 聚合闸 fail-closed 判定脚本（#187 触发面收敛版）
 *
 * 取代原先内联在 ci.yml 的 bash 断言：判定逻辑收敛为纯函数后可被单元测试
 * 全组合锁死，避免内联 bash 只能靠 workflow 静态文本锚间接覆盖。
 *
 * 输入（由 ci.yml repo-gate 首步以 env 注入）：
 *   GATE_EVENT          github.event_name（pull_request / push / workflow_dispatch / …）
 *   GATE_CHANGES        needs.changes.result
 *   GATE_BUILD_TEST     needs.build-test.result
 *   GATE_MUTATION       needs.mutation-gate.result
 *   GATE_MUTATION_PKGS  needs.changes.outputs.mutationPackages（JSON 数组文本，恒为合法数组）
 *
 * 判定表（fail-closed：任何未显式放行的组合一律红）：
 *   1) changes != success → 红（一切切片判定的前提，#85 F2）；
 *   2) build-test != success → 红（全集构建是全局门禁的产物前提，评审 F1）；
 *   3) mutationPackages 解析失败 / 非数组 → 环境数据违约（exit 2，fail-closed）；
 *   4) pull_request 事件：
 *      - 切片非空 → mutation-gate 必须 success。skipped 视同「该跑没跑」的
 *        门禁静默绕过（与空矩阵合法缺席在 job result 上无法区分，故按清单
 *        维度区分——这是 #187 收敛前旧判定存在的语义漏洞，此处堵死）；
 *      - 切片为空 → skipped 或 failure 均属合法缺席（GitHub 对零实例动态矩阵
 *        实测回报 failure 而非官方口径 skipped，实证 run 32802575298；
 *        success/cancelled 说明矩阵契约被破坏）；
 *   5) 非 pull_request 事件（push / workflow_dispatch / 未来新增触发器）→
 *      mutation-gate 必须 skipped。这是 #187 的触发面收敛不变量：主干变异覆盖
 *      归 observe.yml 夜间全量、发版归 release.yml tag 管线全量；若非 skipped，
 *      说明 ci.yml 中 if 的事件限制已被破坏，宁可显性红也不静默退化全量。
 *
 * 用法：node scripts/gate/repo-gate-assert.mjs   （无命令行参数，全部走 env）
 * 退出码：0 = 通过；1 = 门禁违约；2 = 环境/数据缺失错误（fail-closed）
 */
import { pathToFileURL } from 'node:url';

/**
 * 判定核心（纯函数，供单元测试全组合覆盖）。
 * @param {{
 *   event: string,
 *   changes: string,
 *   buildTest: string,
 *   mutation: string,
 *   mutationPkgsJson: string,
 * }} input
 * @returns {{ ok: boolean, code: 0 | 1 | 2, reason: string }}
 */
export function evaluateGate(input) {
  const { event, changes, buildTest, mutation } = input;

  // 前提闸：changes 是所有切片判定的事实源，非 success 即红
  if (changes !== 'success') {
    return { ok: false, code: 1, reason: `changes 作业未成功（${changes}）—— fail-closed` };
  }
  // build-test 恒全集构建（不受触发面收敛影响），任何实例失败/skipped 即红
  if (buildTest !== 'success') {
    return { ok: false, code: 1, reason: `build-test 存在失败/skipped 实例（${buildTest}）—— fail-closed` };
  }

  // 变异切片清单：changes 已成功仍解析失败 = 数据契约破坏，按环境错误处理
  let pkgs;
  try {
    pkgs = JSON.parse(input.mutationPkgsJson);
  } catch (err) {
    return { ok: false, code: 2, reason: `mutationPackages 不是合法 JSON（${err.message}）—— 数据契约破坏` };
  }
  if (!Array.isArray(pkgs)) {
    return { ok: false, code: 2, reason: 'mutationPackages 不是 JSON 数组 —— 数据契约破坏' };
  }

  if (event === 'pull_request') {
    // PR 事件：变异门禁必须真实执行或合法缺席，二选一精确锁定
    if (pkgs.length > 0) {
      // 切片非空 → 必须 success。skipped 在 job result 上与「if 被改坏导致
      // 该跑没跑」不可区分，一律按门禁绕过判红（#187 堵旧判定语义漏洞）
      if (mutation !== 'success') {
        return {
          ok: false,
          code: 1,
          reason: `mutation-gate 切片 [${pkgs.join(', ')}] 结果为 ${mutation}（期望 success）—— PR 下该跑没跑视为门禁绕过`,
        };
      }
    } else {
      // 空切片（合法缺席）：GitHub 对零实例动态矩阵实测回报 'failure' 而非官方
      // 口径 'skipped'——实证 run 32802575298（commit 3012980，PR 仅改
      // stryker.conf.d/<pkg>.json 不被任何包 filter 命中 → mutationPackages=[] →
      // 矩阵零实例化：check-runs 无该 job 记录、jobs API total_count=9 无变异实例，
      // needs.mutation-gate.result 却为 'failure'）。两种形态均放行；
      // success/cancelled 仍属契约异常照旧判红。
      // 注意与 job 级 if 整体跳过（非 PR 分支，result='skipped'）是不同机制，
      // 该分支语义不受本实证影响、维持只收 skipped。
      if (mutation !== 'skipped' && mutation !== 'failure') {
        return {
          ok: false,
          code: 1,
          reason: `mutation-gate 空切片却得到结果 ${mutation}（期望 skipped/failure）—— 动态矩阵契约破坏`,
        };
      }
    }
    return { ok: true, code: 0, reason: 'PR 门禁：变更切片 + 增量变异全部通过' };
  }

  // 非 PR 事件：触发面收敛不变量——变异只允许 skipped（main 归夜间、发版归 release）
  if (mutation !== 'skipped') {
    return {
      ok: false,
      code: 1,
      reason: `${event} 事件下 mutation-gate 结果为 ${mutation}（期望 skipped）—— #187 触发面收敛不变量被破坏（ci.yml if 事件限制疑似失效）`,
    };
  }
  return { ok: true, code: 0, reason: '主干/手动触发：变异门禁已收敛至夜间与发版管线（skipped 符合预期）' };
}

// ── CLI 入口（仅直跑时执行；被测试 import 时只暴露 evaluateGate 不产生副作用）──
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const env = process.env;
  const verdict = evaluateGate({
    event: env.GATE_EVENT ?? '',
    changes: env.GATE_CHANGES ?? '',
    buildTest: env.GATE_BUILD_TEST ?? '',
    mutation: env.GATE_MUTATION ?? '',
    mutationPkgsJson: env.GATE_MUTATION_PKGS ?? '',
  });
  console.log(`event=${env.GATE_EVENT}  changes=${env.GATE_CHANGES}  `
    + `build-test=${env.GATE_BUILD_TEST}  mutation-gate=${env.GATE_MUTATION}`);
  // 违约/环境错误走 ::error:: 注解（GitHub PR 页面可见，与旧内联断言同款）
  if (verdict.code === 0) {
    console.log(`判定：${verdict.reason}`);
  } else {
    console.error(`::error::${verdict.reason}`);
  }
  process.exit(verdict.code);
}
