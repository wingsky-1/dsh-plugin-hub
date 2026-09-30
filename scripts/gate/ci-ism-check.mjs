#!/usr/bin/env node
/**
 * ci-ism-check —— CI-ism 未跟踪文件残留的**执行点**（#843 评论侧 L4，批次二项 1）。
 *
 * 判据本体在 `scripts/lib/ci-ism-denylist.mjs`（denylist + 载体自证 + `ciIsmVerdict` 三态映射）。
 * 本文件是**薄 CLI**：只做「解析参数 → 扫仓库根 → 消费裁决 → 落退出码」，判定一行都不重写。
 * 为什么要单独一个文件：执行点必须是「以路径字符串被调用的脚本」（接线断言 A8 按此判覆盖面），
 * 而库只被 import、不算执行点；把裁决与入口分家，也让「改判据」与「改判据的接线」在 diff 里分开。
 *
 * 退出码三态（语义见 AGENTS.md 门禁一节，唯一出口是 `ciIsmVerdict`）：
 *   0 = 通过（仓库根没有 CI-ism 残留）；
 *   1 = 判红可信（确有未跟踪/被忽略的 CI-ism 残留）；
 *   2 = 门禁故障（探测失败 / 载体自证不通过：面不是仓库根、denylist 漏了自证样本）——
 *       与 1 分属两码，`::error::` 注解由 failClosed 给出。
 *
 * 门禁故障优先于违规（`ciIsmVerdict` 内的顺序）：自证失败意味着判据自己不可信，此时按违规数
 * 报 1 会让读者把「门禁坏了」读成「改动不达标」——#843 P-2 那次事故正是这么被读错的。
 *
 * 用法：node scripts/gate/ci-ism-check.mjs [--root <dir>]
 */
import { join } from "node:path";

import { ciIsmVerdict, scanRepoRoot } from "../lib/ci-ism-denylist.mjs";
import { failClosed } from "../lib/gate-exit.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

function main(argv) {
  const root = argValue(argv, "--root", ROOT);
  // 探测失败（git 不可用 / 不是仓库 / 根不可读）一律走 fail-closed：退回「看不见即通过」
  // 正是本判据要消灭的那条静默通道。
  let result;
  try {
    result = scanRepoRoot(root);
  } catch (e) {
    failClosed(`[ci-ism-check] 仓库根探测失败（${root}）：${e.message}`);
  }
  const { code, verdict, lines } = ciIsmVerdict(result);
  const stream = code === 0 ? console.log : console.error;
  if (code !== 0) {
    stream(`ci-ism-check: ${verdict}（扫描面 ${result.scanned} 个目录项）：`);
    for (const line of lines) stream(`  - ${line}`);
  } else {
    stream(
      `ci-ism-check: ${verdict}（扫描面 ${result.scanned} 个目录项，无 CI-ism 残留；${result.notes.length} 条已跟踪同名项进 diff 由评审接手）`,
    );
  }
  return code;
}

process.exit(main(process.argv.slice(2)));
