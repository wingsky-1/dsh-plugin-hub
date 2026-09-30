/**
 * scripts/lib/gate-baseline.mjs — 门禁「比对基准 ref」的单一常量（批次二项 3）。
 *
 * 为什么需要它：阈值单调性（threshold-monotonic）、变异面并集棘轮（gen-stryker-conf）、
 * CRAP 热点基线（crap-check）与本地档位编排（local-gate）此前各写一份 `"origin/main"`，
 * 而 CI 的 repo-gate 步骤又硬编码了第五份。**失效方向不是「某个值写错」，而是本地与 CI
 * 各比各的、静默分叉**：CI 改一个 ref、本地没改，两侧结论仍各自「全绿」，而它们量的根本
 * 不是同一件事。gate-steps.mjs 的注释此前就自承「与 CI 的硬编码一致」——那是**知情的重复，
 * 没有机器约束**。
 *
 * 收敛口径（本仓能给出的最强约束，不是「大家记得一致」）：
 *   - 四个本地判据改为 import 本常量，仓内 `"origin/main"` 字面量只剩本文件一处；
 *   - CI 侧**不再传参**：`threshold-monotonic` 不给 argv 时即取本常量，于是 CI 侧没有可改的
 *     第二份值；
 *   - 「CI 侧不许把 ref 写回命令行」由接线断言 A6 兜住：repo-gate 那一步带 `if:`，其步骤键
 *     （`ci.yml|repo-gate|script:scripts/gate/threshold-monotonic.mjs`）在
 *     `data/gate-wiring-exceptions.json` 的 stepIfs 里逐字登记，往命令行加回任何 ref 参数都会让
 *     步骤键失配 → 判红。实测见批次二报告的反证段。
 *
 * 边界（如实声明）：本常量只管**默认值**。`--base` / `GEN_STRYKER_BASE` 等显式覆盖通道保留
 * ——它们是「本地按别的基准跑」的正当事由，不是分叉。
 */

/** 门禁相对基准：PR 与本地默认档位的三点比起点。 */
export const GATE_BASELINE_REF = "origin/main";
