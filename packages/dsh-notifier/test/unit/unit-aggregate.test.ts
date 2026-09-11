
/**
 * dsh-notifier — unit：完成风暴聚合批处理器直测（L1 层内直测补盲）。
 *
 * 覆盖完成风暴聚合直测：createDoneBatcher 首条即时 + 窗口聚合补发 +
 * kind 切换结算 + 关闭聚合直通 + dispose（含 titles 保留上限 4）。聚合窗口
 * 用 flush() 手动结算（不依赖真实定时器，测试零固定 sleep）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createDoneBatcher } from "../../src/events/interface.ts";
import type { DoneBatcherOptions } from "../../src/events/interface.ts";

type Sent = { kind: string; taskTitle?: string; durationMs?: number; mergedCount?: number };

function collect() {
  const sent: Sent[] = [];
  const notify: DoneBatcherOptions["notify"] = (kind, detail) => {
    sent.push({ kind, ...detail });
    return true;
  };
  return { sent, notify };
}

describe("mergeMs=0 → 每条完成即时通知（不聚合）", () => {
  let sent: Sent[];
  let batcher: ReturnType<typeof createDoneBatcher>;

  beforeEach(() => {
    const c = collect();
    sent = c.sent;
    batcher = createDoneBatcher({ getWindowMs: () => 0, notify: c.notify });
    batcher.enqueue("done", "任务A", 1000);
    batcher.enqueue("done", "任务B", 2000);
  });

  it("窗口关闭时每条完成即时通知", () => {
    expect(sent.length).toBe(2);
  });

  it("首条标题原样", () => {
    expect(sent[0].taskTitle).toBe("任务A");
  });

  it("即时通知携带耗时", () => {
    expect(sent[1].durationMs).toBe(2000);
  });
});

describe("窗口聚合——首条即时 + flush 补发聚合条（合并计数/标题拼接）", () => {
  let sent: Sent[];
  let batcher: ReturnType<typeof createDoneBatcher>;

  beforeEach(() => {
    const c = collect();
    sent = c.sent;
    batcher = createDoneBatcher({ getWindowMs: () => 3000, notify: c.notify });
    batcher.enqueue("done", "任务A", 1000);
  });

  it("首条完成立即通知（单条场景零延迟）", () => {
    expect(sent.length).toBe(1);
  });

  it("首条为单条通知", () => {
    expect(sent[0].taskTitle).toBe("任务A");
  });

  it("flush 结算补发一条聚合通知", () => {
    batcher.enqueue("done", "任务B", 2000);
    batcher.enqueue("done", "任务C", 3000);
    batcher.flush();
    expect(sent.length).toBe(2);
  });

  it("聚合条保持 kind", () => {
    batcher.enqueue("done", "任务B", 2000);
    batcher.enqueue("done", "任务C", 3000);
    batcher.flush();
    expect(sent[1].kind).toBe("done");
  });

  it("聚合计数 = 窗口内后续完成数", () => {
    batcher.enqueue("done", "任务B", 2000);
    batcher.enqueue("done", "任务C", 3000);
    batcher.flush();
    expect(sent[1].mergedCount).toBe(2);
  });

  it("聚合标题拼接（首条已单独通知，不含首条）", () => {
    batcher.enqueue("done", "任务B", 2000);
    batcher.enqueue("done", "任务C", 3000);
    batcher.flush();
    expect(sent[1].taskTitle).toBe("任务B、任务C");
  });
});

describe("kind 切换 → 前一窗口先结算再入新批次", () => {
  let sent: Sent[];
  let batcher: ReturnType<typeof createDoneBatcher>;

  beforeEach(() => {
    const c = collect();
    sent = c.sent;
    batcher = createDoneBatcher({ getWindowMs: () => 3000, notify: c.notify });
    batcher.enqueue("done", "任务A", 1000);
    batcher.enqueue("done", "任务B", 2000);
    batcher.enqueue("subagent-done", "子任务X", 500);
  });

  it("kind 切换触发前一窗口结算 + 新 kind 首条即时", () => {
    expect(sent.length).toBe(3);
  });

  it("切换处聚合条合并前一批次后续完成", () => {
    expect(sent[1].mergedCount).toBe(1);
  });

  it("新 kind 首条即时", () => {
    expect(sent[2].taskTitle).toBe("子任务X");
  });
});

describe("titles 上限 4（窗口内海量完成只保留最近 4 个标题）", () => {
  let sent: Sent[];
  let mergedTitle: string | undefined;

  beforeEach(() => {
    const c = collect();
    sent = c.sent;
    const batcher = createDoneBatcher({ getWindowMs: () => 3000, notify: c.notify });
    batcher.enqueue("done", "第一个", 1);
    for (let i = 2; i <= 8; i += 1) batcher.enqueue("done", `任务${i}`, i);
    batcher.flush();
    mergedTitle = sent[1].taskTitle;
  });

  it("首条 + 聚合条", () => {
    expect(sent.length).toBe(2);
  });

  it("聚合条携带合并标题", () => {
    expect(mergedTitle).toBeDefined();
  });

  it("聚合标题保留最近 4 个中排除首条后的 3 个（防长列表刷屏）", () => {
    expect(mergedTitle!.split("、").length).toBe(3);
  });

  it("保留的是窗口尾部最近标题", () => {
    expect(mergedTitle!.split("、")[0]).toBe("任务6");
  });

  it("计数不截断（仅标题展示上限）", () => {
    expect(sent[1].mergedCount).toBe(7);
  });
});

describe("dispose 清理批次（dispose = 立即结算当前窗口；结算后不再复发）", () => {
  let sent: Sent[];
  let batcher: ReturnType<typeof createDoneBatcher>;

  beforeEach(() => {
    const c = collect();
    sent = c.sent;
    batcher = createDoneBatcher({ getWindowMs: () => 3000, notify: c.notify });
  });

  it("dispose 即结算：首条 + 聚合条（防定时器悬空丢通知）", () => {
    batcher.enqueue("done", "任务A", 1);
    batcher.enqueue("done", "任务B", 2);
    batcher.dispose();
    expect(sent.length).toBe(2);
  });

  it("dispose 时窗口内后续完成补发聚合条", () => {
    batcher.enqueue("done", "任务A", 1);
    batcher.enqueue("done", "任务B", 2);
    batcher.dispose();
    expect(sent[1].mergedCount).toBe(1);
  });

  it("结算后 flush 不再补发（批次已清空）", () => {
    batcher.enqueue("done", "任务A", 1);
    batcher.enqueue("done", "任务B", 2);
    batcher.dispose();
    batcher.flush();
    expect(sent.length).toBe(2);
  });
});
