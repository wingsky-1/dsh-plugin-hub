
/**
 * dsh-notifier — unit：完成风暴聚合批处理器直测（L1 层内直测补盲）。
 *
 * 覆盖完成风暴聚合直测：createDoneBatcher 首条即时 + 窗口聚合补发 +
 * kind 切换结算 + 关闭聚合直通 + dispose（含 titles 保留上限 4）。聚合窗口
 * 用 flush() 手动结算（不依赖真实定时器，测试零固定 sleep）。
 */
import { assert } from "../helpers.ts";
import { createDoneBatcher } from "../../src/events/interface.ts";
import type { DoneBatcherOptions } from "../../src/events/interface.ts";

function collect() {
  const sent: Array<{ kind: string; taskTitle?: string; durationMs?: number; mergedCount?: number }> = [];
  const notify: DoneBatcherOptions["notify"] = (kind, detail) => {
    sent.push({ kind, ...detail });
    return true;
  };
  return { sent, notify };
}

// ── mergeMs=0 → 每条完成即时通知（不聚合）──
{
  const { sent, notify } = collect();
  const batcher = createDoneBatcher({ getWindowMs: () => 0, notify });
  batcher.enqueue("done", "任务A", 1000);
  batcher.enqueue("done", "任务B", 2000);
  assert.equal(sent.length, 2, "窗口关闭时每条完成即时通知");
  assert.equal(sent[0].taskTitle, "任务A", "首条标题原样");
  assert.equal(sent[1].durationMs, 2000, "即时通知携带耗时");
}

// ── 窗口聚合——首条即时 + flush 补发聚合条（合并计数/标题拼接）──
{
  const { sent, notify } = collect();
  const batcher = createDoneBatcher({ getWindowMs: () => 3000, notify });
  batcher.enqueue("done", "任务A", 1000);
  assert.equal(sent.length, 1, "首条完成立即通知（单条场景零延迟）");
  assert.equal(sent[0].taskTitle, "任务A", "首条为单条通知");
  batcher.enqueue("done", "任务B", 2000);
  batcher.enqueue("done", "任务C", 3000);
  batcher.flush();
  assert.equal(sent.length, 2, "flush 结算补发一条聚合通知");
  const merged = sent[1];
  assert.equal(merged.kind, "done", "聚合条保持 kind");
  assert.equal(merged.mergedCount, 2, "聚合计数 = 窗口内后续完成数");
  assert.equal(merged.taskTitle, "任务B、任务C", "聚合标题拼接（首条已单独通知，不含首条）");
}

// ── kind 切换 → 前一窗口先结算再入新批次 ──
{
  const { sent, notify } = collect();
  const batcher = createDoneBatcher({ getWindowMs: () => 3000, notify });
  batcher.enqueue("done", "任务A", 1000);
  batcher.enqueue("done", "任务B", 2000);
  batcher.enqueue("subagent-done", "子任务X", 500);
  assert.equal(sent.length, 3, "kind 切换触发前一窗口结算 + 新 kind 首条即时");
  assert.equal(sent[1].mergedCount, 1, "切换处聚合条合并前一批次后续完成");
  assert.equal(sent[2].taskTitle, "子任务X", "新 kind 首条即时");
}

// ── titles 上限 4（窗口内海量完成只保留最近 4 个标题）──
{
  const { sent, notify } = collect();
  const batcher = createDoneBatcher({ getWindowMs: () => 3000, notify });
  batcher.enqueue("done", "第一个", 1);
  for (let i = 2; i <= 8; i += 1) batcher.enqueue("done", `任务${i}`, i);
  batcher.flush();
  assert.equal(sent.length, 2, "首条 + 聚合条");
  const mergedTitle = sent[1].taskTitle;
  assert.ok(mergedTitle !== undefined, "聚合条携带合并标题");
  const titles = mergedTitle.split("、");
  assert.equal(titles.length, 3, "聚合标题保留最近 4 个中排除首条后的 3 个（防长列表刷屏）");
  assert.equal(titles[0], "任务6", "保留的是窗口尾部最近标题");
  assert.equal(sent[1].mergedCount, 7, "计数不截断（仅标题展示上限）");
}

// ── dispose 清理批次（dispose = 立即结算当前窗口；结算后不再复发）──
{
  const { sent, notify } = collect();
  const batcher = createDoneBatcher({ getWindowMs: () => 3000, notify });
  batcher.enqueue("done", "任务A", 1);
  batcher.enqueue("done", "任务B", 2);
  batcher.dispose();
  assert.equal(sent.length, 2, "dispose 即结算：首条 + 聚合条（防定时器悬空丢通知）");
  assert.equal(sent[1].mergedCount, 1, "dispose 时窗口内后续完成补发聚合条");
  batcher.flush();
  assert.equal(sent.length, 2, "结算后 flush 不再补发（批次已清空）");
}