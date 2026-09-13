#!/usr/bin/env node
/**
 * repo-gate-assert — repo-gate 聚合闸 fail-closed 判定脚本（#187 收敛 + #217 解耦版）
 *
 * 取代原先内联在 ci.yml 的 bash 断言：判定逻辑收敛为纯函数后可被单元测试
 * 全组合锁死，避免内联 bash 只能靠 workflow 静态文本锚间接覆盖。
 *
 * 输入（由 ci.yml repo-gate 首步以 env 注入）：
 *   GATE_EVENT          github.event_name（pull_request / push / workflow_dispatch / …）
 *   GATE_CHANGES        needs.changes.result
 *   GATE_BUILD_TEST     needs.build-test.result
 *   GATE_COVERAGE       needs.coverage.result（#217：全局单次覆盖采集 job）
 *   GATE_MUTATION       needs.mutation-gate.result（#217：矩阵仅基线+stryker）
 *   GATE_VERDICT        needs.mutation-verdict.result（#217：聚合判分收尾 job）
 *   GATE_HAS_MUTATIONS  needs.changes.outputs.hasMutations（'true'/'false' 显式布尔）
 *   GATE_MUTATION_PKGS  needs.changes.outputs.mutationPackages（JSON 数组文本，恒为合法数组）
 *   GATE_FULL_REQUESTED needs.changes.outputs.fullGate（'true'/'false'；#722 门禁分层开关。
 *                       #742 阶段 1 起它只覆盖覆盖率与全仓产物闸——变异已改为 PR 强制跑）
 *
 * 判定表（fail-closed：任何未显式放行的组合一律红；维度：
 *   事件 × 全量开关(fullGate) × 切片(hasMutations) × coverage × 变异矩阵 × verdict）：
 *   1) changes != success → 红（一切切片判定的前提，#85 F2）；
 *   2) build-test != success → 红（构建/测试切片是全局门禁的产物前提，评审 F1）；
 *   3) mutationPackages 解析失败 / 非数组、hasMutations 非 'true'/'false'、
 *      fullGate 非 'true'/'false'、hasMutations 与切片非空性交叉矛盾 → 环境数据违约
 *      （exit 2，fail-closed）；
 *   4) pull_request（#742 阶段 1 起变异与 gate:full 标签解耦，本维度随之重写）：
 *      - hasMutations='true'（有变异对象包）：
 *        · coverage：打了 gate:full 标签必须 success（failure/cancelled = 覆盖失败连坐，
 *          skipped = 该跑没跑）；未打标签必须 skipped（#742 阶段 1.5 维持「覆盖率是全仓分母
 *          口径、不进 PR 默认路径」——出现非 skipped 说明 ci.yml 的 if 契约被改坏，同样判红）；
 *        · mutation-gate：不得 skipped（#742 阶段 1.3：PR 上按切片**强制**跑变异，
 *          该跑没跑即门禁绕过）；failure 容忍，由 verdict 统一裁决；
 *        · mutation-verdict：必须 success（skipped = 门禁绕过，cancelled = 未完成判分，
 *          failure = 判分未通过）。#742 阶段 1.2 起不再以 coverage success 为运行前提——
 *          覆盖率失败不再吞掉整份变异判分，两者由本表分别点名；
 *      - hasMutations='false'（空切片合法缺席）：coverage / 矩阵 / verdict 三者都必须
 *        skipped。矩阵 if 上的 hasMutations 条件使空切片时 job 根本不实例化，故 #742
 *        阶段 1 起不再宽容 #217 时代的「零实例动态矩阵回报 failure」形态（实证
 *        run 32802575298 属旧设计），任何非 skipped 都判红；
 *   5) 非 pull_request 事件（push / workflow_dispatch / 未来新增触发器）→ fullGate
 *      必须为 'false'，且 coverage / 变异矩阵 / verdict 三者全部必须 skipped。这是
 *      #187 触发面收敛不变量的 #217 扩展：主干覆盖与变异覆盖归 observe.yml 夜间全量、
 *      发版归 release.yml tag 管线；任一非 skipped 说明 ci.yml 中 if 的事件限制已被
 *      破坏，宁可显性红也不静默退化。
 *
 * 用法：node scripts/gate/repo-gate-assert.mjs   （无命令行参数，全部走 env）
 * 退出码：0 = 通过；1 = 门禁违约；2 = 环境/数据缺失错误（fail-closed）
 */
import { pathToFileURL } from "node:url";

/**
 * 判定核心（纯函数，供单元测试全组合覆盖）。
 * @param {{
 *   event: string,
 *   changes: string,
 *   buildTest: string,
 *   coverage: string,
 *   mutation: string,
 *   verdict: string,
 *   hasMutations: string,
 *   mutationPkgsJson: string,
 *   fullRequested: string,
 * }} input
 * @returns {{ ok: boolean, code: 0 | 1 | 2, reason: string }}
 */
export function evaluateGate(input) {
  const { event, changes, buildTest, coverage, mutation, verdict, hasMutations } = input;

  // 前提闸：changes 是所有切片判定的事实源，非 success 即红
  if (changes !== "success") {
    return { ok: false, code: 1, reason: `changes 作业未成功（${changes}）—— fail-closed` };
  }
  // build-test 矩阵 = 命中包（空切片时补 1 个哨兵实例：GHA 对零实例动态矩阵实测回报 failure，
  // 哨兵不匹配任何包、只跑一次 checkout+setup），任何实例失败/skipped 即红
  if (buildTest !== "success") {
    return {
      ok: false,
      code: 1,
      reason: `build-test 存在失败/skipped 实例（${buildTest}）—— fail-closed`,
    };
  }

  // 数据契约闸：切片清单与显式布尔必须同时合法且互相一致
  let pkgs;
  try {
    pkgs = JSON.parse(input.mutationPkgsJson);
  } catch (err) {
    return {
      ok: false,
      code: 2,
      reason: `mutationPackages 不是合法 JSON（${err.message}）—— 数据契约破坏`,
    };
  }
  if (!Array.isArray(pkgs)) {
    return { ok: false, code: 2, reason: "mutationPackages 不是 JSON 数组 —— 数据契约破坏" };
  }
  if (hasMutations !== "true" && hasMutations !== "false") {
    return {
      ok: false,
      code: 2,
      reason: `hasMutations 必须为 'true'/'false'（实际 "${hasMutations}"）—— 数据契约破坏`,
    };
  }
  if (input.fullRequested !== "true" && input.fullRequested !== "false") {
    return {
      ok: false,
      code: 2,
      reason: `fullGate 必须为 'true'/'false'（实际 "${input.fullRequested}"）—— 数据契约破坏`,
    };
  }
  // 交叉校验：hasMutations 与切片清单非空性由 changes 同一函数推导，不一致即违约
  if ((hasMutations === "true") !== pkgs.length > 0) {
    return {
      ok: false,
      code: 2,
      reason: `hasMutations=${hasMutations} 与切片长度 ${pkgs.length} 矛盾 —— 数据契约破坏`,
    };
  }

  if (event === "pull_request") {
    if (hasMutations === "true") {
      // ── 该跑必须真跑：覆盖率按标签裁决 + 变异链逐维锁定 ──
      // 维度一：coverage（全局单次采集，与变异矩阵平行）
      // #742 阶段 1.5：覆盖率是「全仓分母」口径，不进 PR 默认路径——所以这里按 fullGate
      // 分叉，而不是像 #722 那样无条件要求 success。两侧都是 fail-closed：
      //   打了标签：必须 success（否则覆盖率这道闸形同不存在）
      //   没打标签：必须 skipped（跑了说明 if 契约被改坏，防 CI 静默回到全量路径）
      if (input.fullRequested === "true") {
        if (coverage !== "success") {
          const why =
            coverage === "skipped"
              ? "coverage 作业缺席 —— gate:full 下该跑却没跑，ci.yml if 契约疑似被改坏"
              : "coverage 失败连坐（c8 全仓 smoke 同级硬信号）";
          return {
            ok: false,
            code: 1,
            reason: `PR 变异链前置 coverage 结果 ${coverage}（期望 success）—— ${why}`,
          };
        }
      } else if (coverage !== "skipped") {
        return {
          ok: false,
          code: 1,
          reason: `PR 未打 gate:full 标签，coverage 结果为 ${coverage}（期望 skipped）—— 增量门禁契约被破坏（覆盖率不进 PR 默认路径，#742 阶段 1.5；ci.yml if 的 fullGate 条件疑似失效）`,
        };
      }
      // 维度二：变异矩阵（#742 阶段 1.3——PR 上按切片强制跑，该跑没跑即门禁绕过；
      // failure 由 verdict 兜底裁决）
      if (mutation !== "success" && mutation !== "failure") {
        return {
          ok: false,
          code: 1,
          reason: `mutation-gate 切片 [${pkgs.join(", ")}] 结果为 ${mutation}（期望 success/failure）—— PR 下该跑没跑视为门禁绕过（#742 阶段 1：变异已与 gate:full 标签解耦）`,
        };
      }
      // 维度三：聚合判分 verdict（最终绿灯的唯一来源；#742 阶段 1.2 起不再以 coverage
      // success 为前提，故覆盖率失败也照样要求 verdict 产出结论）
      if (verdict !== "success") {
        const why =
          verdict === "skipped"
            ? "该跑没跑视为门禁绕过"
            : verdict === "cancelled"
              ? "被取消（未完成判分）"
              : "变异率判分未通过（变异率不达标或报告 artifact 链路违约）";
        return {
          ok: false,
          code: 1,
          reason: `mutation-verdict 结果 ${verdict}（期望 success）—— ${why}`,
        };
      }
      return {
        ok: true,
        code: 0,
        reason:
          `PR 门禁：变更切片 + 增量变异（[${pkgs.join(", ")}]）全部通过；` +
          (input.fullRequested === "true"
            ? "gate:full 追加的全局覆盖率亦通过"
            : "覆盖率按 #742 阶段 1.5 归 gate:full 标签，本次未跑"),
      };
    }

    // ── 空切片（合法缺席）：两个 job 的 if 都含 hasMutations，空切片时必然 skipped。
    // #217 时代这里宽容过 'failure'，理由是「GitHub 对零实例动态矩阵实测回报 failure 而非
    // 官方口径 skipped」（实证 run 32802575298）；该形态已被 if 上的 hasMutations 条件消除
    // （job 级 if 为假 → 矩阵根本不实例化 → 结论只能是 skipped），故 #742 阶段 1 起收紧为
    // 只收 skipped：failure/success/cancelled 都说明契约被改坏，属纵深防御。
    if (coverage !== "skipped") {
      return {
        ok: false,
        code: 1,
        reason: `空切片却得到 coverage 结果 ${coverage}（期望 skipped）—— ci.yml if 契约破坏`,
      };
    }
    for (const [name, result] of [
      ["mutation-gate", mutation],
      ["mutation-verdict", verdict],
    ]) {
      if (result !== "skipped") {
        return {
          ok: false,
          code: 1,
          reason: `空切片却得到 ${name} 结果 ${result}（期望 skipped）—— 无变异对象包却跑了变异链，ci.yml if 的切片条件疑似失效`,
        };
      }
    }
    return { ok: true, code: 0, reason: "PR 空切片：无变异对象包，覆盖/变异链合法缺席" };
  }

  // 非 PR 事件：触发面收敛不变量（#187 + #217 扩展）——fullGate 必须为 false
  // （changes job 里非 PR 一律 false），且覆盖/变异三段全部只允许 skipped（main 归
  // 夜间、发版归 release）；出现其他结果说明 ci.yml if 的事件限制已失效，显性红防
  // 静默退化
  if (input.fullRequested === "true") {
    return {
      ok: false,
      code: 1,
      reason: `${event} 事件下 fullGate=true（期望 false）—— #187 触发面收敛不变量被破坏（全量门禁只允许在 PR 上按标签触发）`,
    };
  }
  for (const [name, result] of [
    ["coverage", coverage],
    ["mutation-gate", mutation],
    ["mutation-verdict", verdict],
  ]) {
    if (result !== "skipped") {
      return {
        ok: false,
        code: 1,
        reason: `${event} 事件下 ${name} 结果为 ${result}（期望 skipped）—— #187 触发面收敛不变量被破坏（ci.yml if 事件限制疑似失效）`,
      };
    }
  }
  return {
    ok: true,
    code: 0,
    reason: "主干/手动触发：覆盖与变异门禁已收敛至夜间与发版管线（skipped 符合预期）",
  };
}

// ── CLI 入口（仅直跑时执行；被测试 import 时只暴露 evaluateGate 不产生副作用）──
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const env = process.env;
  const verdict = evaluateGate({
    event: env.GATE_EVENT ?? "",
    changes: env.GATE_CHANGES ?? "",
    buildTest: env.GATE_BUILD_TEST ?? "",
    coverage: env.GATE_COVERAGE ?? "",
    mutation: env.GATE_MUTATION ?? "",
    verdict: env.GATE_VERDICT ?? "",
    hasMutations: env.GATE_HAS_MUTATIONS ?? "",
    mutationPkgsJson: env.GATE_MUTATION_PKGS ?? "",
    fullRequested: env.GATE_FULL_REQUESTED ?? "",
  });
  console.log(
    `event=${env.GATE_EVENT}  changes=${env.GATE_CHANGES}  ` +
      `build-test=${env.GATE_BUILD_TEST}  coverage=${env.GATE_COVERAGE}  ` +
      `mutation-gate=${env.GATE_MUTATION}  verdict=${env.GATE_VERDICT}  ` +
      `hasMutations=${env.GATE_HAS_MUTATIONS}  fullGate=${env.GATE_FULL_REQUESTED}`,
  );
  // 违约/环境错误走 ::error:: 注解（GitHub PR 页面可见，与旧内联断言同款）
  if (verdict.code === 0) {
    console.log(`判定：${verdict.reason}`);
  } else {
    console.error(`::error::${verdict.reason}`);
  }
  process.exit(verdict.code);
}
