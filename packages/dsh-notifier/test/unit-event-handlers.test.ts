// @ts-nocheck
/**
 * dsh-notifier — unit：event-handlers 核心判定直测（PR0 红测先行 4）。
 *
 * 现状 resolveTurnEvidence（push 优先/快照兜底/stale 冻结/rememberedTurn）是
 * 模块私有函数（event-handlers.ts），行为只有 e2e 黑盒覆盖——失败定位只能靠
 * 黑盒（T3-3 补充项）。PR0 导出并锁定判定矩阵基线；PR2 adjudicate 拆分时是
 * 行为对等判别网。
 */
import assert from "node:assert/strict";
import { resolveTurnEvidence } from "../src/events/interface.ts";
import { agentWithTitle } from "./helpers.ts";

function run(agent, state, streamEnds = new Map()) {
  return resolveTurnEvidence(agent, state, streamEnds);
}

// ---- 1：push 优先（session/event 推送条目胜于快照） ----
{
  const agent = agentWithTitle("a1", "任务X", { turnEnd: 5 });
  const state = { runningSeen: false, startedAt: 0, runningBaseline: { turn: 3, kind: "completed" } };
  const ev = run(agent, state, new Map([["a1", { turn: 6, kind: "completed" }]]));
  assert.equal(ev.pushed.turn, 6, "push 条目取回");
  assert.equal(ev.evidenceSource, "push", "证据源 = push");
  assert.equal(ev.best.turn, 6, "best = push（胜过快照 5）");
  assert.equal(ev.hasNewEnd, true, "push turn6 > 记忆 undefined → 新 closure");
  assert.equal(ev.snapshot, undefined, "push 命中时不读快照（快照仅兜底，防御侧零 IO）");
  console.log("1 resolveTurnEvidence push 优先: OK");
}

// ---- 2：快照兜底（无 push、无基线 → 快照为准） ----
{
  const agent = agentWithTitle("a2", "任务Y", { turnEnd: 4 });
  const state = { runningSeen: false, startedAt: 0, runningBaseline: undefined };
  const ev = run(agent, state);
  assert.equal(ev.pushed, undefined, "无 push");
  assert.equal(ev.evidenceSource, "快照兜底", "证据源 = 快照兜底");
  assert.equal(ev.best.turn, 4, "best = 快照 turn4");
  assert.equal(ev.hasNewEnd, true, "快照 turn4 > 记忆 undefined → 新 closure");
  console.log("2 resolveTurnEvidence 快照兜底: OK");
}

// ---- 3：stale 冻结（快照 ≤ running 基线 → abort-early 陈旧，冻结不误报） ----
{
  const agent = agentWithTitle("a3", "任务Z", { turnEnd: 3 });
  const state = { runningSeen: false, startedAt: 0, runningBaseline: { turn: 3, kind: "completed" } };
  const ev = run(agent, state);
  assert.equal(ev.evidenceSource, "快照冻结", "证据源 = 快照冻结");
  assert.equal(ev.best, undefined, "best 为空（陈旧快照不推进）");
  assert.equal(ev.hasNewEnd, false, "不当作新 closure");
  assert.equal(ev.snapshot.turn, 3, "snapshot 保留供日志");
  console.log("3 resolveTurnEvidence stale 冻结: OK");
}

// ---- 4：rememberedTurn 去重（hasNewEnd = best.turn > 记忆） ----
{
  const agent = agentWithTitle("a4", "任务W", { turnEnd: 5 });
  const base = { runningSeen: false, startedAt: 0, runningBaseline: undefined };
  const evSame = run(agent, { ...base, lastEndedTurn: 5 });
  assert.equal(evSame.hasNewEnd, false, "best.turn 5 = 记忆 5 → 不算新 closure");
  const evNew = run(agent, { ...base, lastEndedTurn: 4 });
  assert.equal(evNew.hasNewEnd, true, "best.turn 5 > 记忆 4 → 新 closure");
  const evEmpty = run(agent, base);
  assert.equal(evEmpty.hasNewEnd, true, "记忆为空 → 首轮即新 closure");
  console.log("4 resolveTurnEvidence rememberedTurn 去重: OK");
}

// ---- 5：无证据（pushed 与快照皆无 → 保守静默） ----
{
  const agent = agentWithTitle("a5"); // 无 turn/end 事件
  const ev = run(agent, { runningSeen: false, startedAt: 0 });
  assert.equal(ev.best, undefined, "best 为空");
  assert.equal(ev.evidenceSource, "无", "证据源 = 无");
  assert.equal(ev.hasNewEnd, false, "不当作新 closure（S1：无证据静默）");
  console.log("5 resolveTurnEvidence 无证据静默: OK");
}