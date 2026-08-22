// @ts-nocheck
/**
 * dsh-notifier — e2e：中断抑制与完成判定白名单。
 *
 * 覆盖：用户停止生成/中断（turn/end reason aborted）固定静默；
 * S1 本轮无新 turn/end closure 宁可静默；失败（error）/阻塞（blocked）/
 * 截断（max-tokens）/未知 kind 不误报「任务完成」；中断与失败后新一轮
 * 正常恢复通知。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, agentWithTitle, waitMergeWindow } from "./helpers.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-e2e-interrupt-"));
try {
  const infos = [];
  const { listeners } = await makeNotifier(work, {}, { logger: { warn: () => {}, info: (t) => infos.push(t) } });
  const status = listeners.get("agent/status")[0];

  // 用户停止生成（turn/end aborted）：不通知完成
  status({ agent: agentWithTitle("int-1", "被打断的任务", { turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-1", "被打断的任务", { turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 0, "中断（turn/end aborted）不通知完成");

  // S1：abort 早于本轮 turn/start 落盘——本轮无新 turn/end，读到的还是
  // 上一次的 completed → 必须静默（不能误报完成）
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 1, "正常完成一轮");
  assert.match(infos[0], /done/);
  // 第二轮被提前中断：events 无新 turn/end（仍停在 turn=1 completed），idle 照发 → 静默
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 1, "S1：本轮无新 turn/end closure 宁可静默");

  // 全新 agent 从未跑完一轮即 idle（首建即中断）：无 turn/end → 静默
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "running" });
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "idle" });
  assert.equal(infos.length, 1, "S1：无 turn/end 静默");

  // 中断后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 s1-1 场景的 3s 完成聚合窗口结束，避免本轮完成被并入旧窗口挂起）
  await waitMergeWindow();
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 1, "中断静默");
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 2 }), status: "running" });
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 2 }), status: "idle" });
  assert.equal(infos.length, 2, "中断后新一轮完成正常通知");
  assert.match(infos[1], /done/);

  // 子代理被中断（interrupt_agent → 子代理 turn/end aborted）：同样静默
  status({ agent: agentWithTitle("int-3", "子代理中断", { depth: 1, turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-3", "子代理中断", { depth: 1, turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 2, "子代理中断不通知");

  // 任务失败（turn/end reason error）：idle 不得误报「任务完成」——
  // 失败由 agent/error 单独负责「任务出错」，同一轮不得叠加「完成」。
  status({ agent: agentWithTitle("err-1", "失败的任务", { turnEnd: 1, turnEndKind: "error" }), status: "running" });
  status({ agent: agentWithTitle("err-1", "失败的任务", { turnEnd: 1, turnEndKind: "error" }), status: "idle" });
  assert.equal(infos.length, 2, "失败（turn/end error）不通知完成");

  // 任务被阻塞（turn/end reason blocked，如等待用户问题）：idle 也不得误报完成
  status({ agent: agentWithTitle("blk-1", "被阻塞的任务", { turnEnd: 1, turnEndKind: "blocked" }), status: "running" });
  status({ agent: agentWithTitle("blk-1", "被阻塞的任务", { turnEnd: 1, turnEndKind: "blocked" }), status: "idle" });
  assert.equal(infos.length, 2, "阻塞（turn/end blocked）不通知完成");

  // 失败后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 int-2 完成聚合窗口结束，避免本轮完成被并入旧窗口挂起）
  await waitMergeWindow();
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 1, turnEndKind: "error" }), status: "running" });
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 1, turnEndKind: "error" }), status: "idle" });
  assert.equal(infos.length, 2, "失败静默");
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 2 }), status: "running" });
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 2 }), status: "idle" });
  assert.equal(infos.length, 3, "失败后新一轮完成正常通知");
  assert.match(infos[2], /done/);

  // max-tokens：模型输出被截断（答案不完整）——白名单判定「不通知完成」
  status({ agent: agentWithTitle("mt-1", "截断的任务", { turnEnd: 1, turnEndKind: "max-tokens" }), status: "running" });
  status({ agent: agentWithTitle("mt-1", "截断的任务", { turnEnd: 1, turnEndKind: "max-tokens" }), status: "idle" });
  assert.equal(infos.length, 3, "max-tokens 不通知完成");
  // 未知 kind（未来扩展）：白名单对齐 DSH 保守语义，同样静默
  status({ agent: agentWithTitle("uk-1", "未知结束", { turnEnd: 1, turnEndKind: "mystery-kind" }), status: "running" });
  status({ agent: agentWithTitle("uk-1", "未知结束", { turnEnd: 1, turnEndKind: "mystery-kind" }), status: "idle" });
  assert.equal(infos.length, 3, "未知 kind 不通知完成");
} finally {
  rmSync(work, { recursive: true, force: true });
}
