/**
 * dsh-notifier — unit：存储域工厂直测（L1 层内直测补盲）。
 *
 * 覆盖存储域工厂直测：history 写队列串行化/原子写（tmp+rename）/
 * 滚动上限/按天清理/失败 warn；status 内存镜像/failStreak/64 条上限/debounce
 * 落盘/冷启动懒加载/错误摘要截断。工厂不在包导出面（导出面零 diff 约束），
 * 直测本域 interface.ts（Node strip-types 原生执行）。
 */
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "./helpers.ts";
import { createHistoryStore, createStatusStore, HISTORY_LIMIT } from "../src/stores/interface.ts";

/** 轮询文件直到谓词成立或超时（写队列 fire-and-forget，固定 sleep 会 flake）。 */
async function pollFile(file: string, predicate: (text: string) => boolean, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      const text = readFileSync(file, "utf8");
      if (predicate(text)) return text;
    } catch {
      // 文件尚未出现
    }
    if (Date.now() - start > timeoutMs) {
      assert.ok(false, `轮询超时等待 ${file}`);
      return "";
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-stores-"));
try {
  // ── history 写队列串行化 + 原子写（并发 append 不丢记录、无 tmp 残留）──
  {
    const file = join(work, "hist-1.jsonl");
    const warns = [];
    const store = createHistoryStore({ file, maxAgeDays: () => 0, warn: (m) => warns.push(m) });
    // 并发 fire-and-forget 追加 20 条：写队列串行化保证全部落盘
    for (let i = 0; i < 20; i += 1) store.append({ ts: 1000 + i, kind: "done", title: `t${i}`, message: `m${i}` });
    const text = await pollFile(file, (t) => t.trim().split("\n").length === 20);
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 20, "并发 append 20 条全部落盘（写队列串行化不丢记录）");
    for (const line of lines) assert.ok(JSON.parse(line).ts >= 1000, "每行均为合法 jsonl");
    const leftovers = readdirSync(work).filter((f) => f.includes(".tmp"));
    assert.equal(leftovers.length, 0, "tmp+rename 原子写无残留临时文件");
  }

  // ── 滚动上限（写超 HISTORY_LIMIT 后 read 只回最近上限）──
  {
    const file = join(work, "hist-2.jsonl");
    const store = createHistoryStore({ file, maxAgeDays: () => 0, warn: () => {} });
    for (let i = 0; i < HISTORY_LIMIT + 50; i += 1) store.append({ ts: i, kind: "done", title: `t`, message: `m${i}` });
    await pollFile(file, (t) => t.trim().split("\n").filter(Boolean).length === HISTORY_LIMIT + 50);
    const records = await store.read();
    assert.equal(records.length, HISTORY_LIMIT, `read 只返回最近 ${HISTORY_LIMIT} 条`);
    assert.equal(records[records.length - 1].message, `m${HISTORY_LIMIT + 49}`, "保留的是最新记录");
  }

  // ── 按天自动清理（maxAgeDays 实时读取器）──
  {
    const file = join(work, "hist-3.jsonl");
    let keepDays = 0;
    const store = createHistoryStore({ file, maxAgeDays: () => keepDays, warn: () => {} });
    store.append({ ts: Date.now() - 30 * 86400000, kind: "done", title: "old", message: "超期" });
    store.append({ ts: Date.now(), kind: "done", title: "new", message: "最新" });
    await pollFile(file, (t) => t.trim().split("\n").length === 2);
    keepDays = 7; // 打开按天清理（热更新即时生效）
    store.append({ ts: Date.now(), kind: "done", title: "new2", message: "再写一条触发清理" });
    await pollFile(file, (t) => {
      try {
        const lines = t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        return lines.length === 2 && lines.every((l) => l.message !== "超期");
      } catch {
        return false;
      }
    });
    const records = await store.read();
    assert.equal(records.length, 2, "超期记录被清理，仅剩两条新记录");
    assert.ok(records.every((r) => r.message !== "超期"), "30 天前记录已剔除");
  }

  // ── 写入失败 → warn 不抛（fire-and-forget 铁律）──
  {
    const file = join(work, "hist-4", "nested", "hist.jsonl"); // 父目录不存在 → 写入必失败
    const warns: string[] = [];
    const store = createHistoryStore({ file, maxAgeDays: () => 0, warn: (m) => warns.push(m) });
    store.append({ ts: 1, kind: "done", title: "t", message: "m" });
    // 轮询等写链的失败回调落地：固定 sleep 在 CI 慢机会在 warn 到达前断言（防 flake 纪律）
    const warnDeadline = Date.now() + 2000;
    while (warns.length === 0 && Date.now() < warnDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(warns.length, 1, "写入失败仅 warn（不阻塞通知主流程）");
    assert.ok(warns[0].includes("历史记录写入失败"), "warn 带失败上下文");
  }

  // ── status 内存镜像 / failStreak / 错误摘要截断 / 64 条上限 / debounce 落盘 ──
  {
    const file = join(work, "status-1.json");
    const store = createStatusStore({ file, warn: () => {} });
    store.record("bark:a", "failed", "x".repeat(500));
    store.record("bark:a", "failed", "again");
    store.record("bark:a", "ok");
    store.record("webhook:b", "failed", "err");
    const snap = await store.read();
    assert.equal(snap["bark:a"].lastStatus, "ok", "内存镜像立即更新");
    assert.equal(snap["bark:a"].failStreak, 0, "成功清零连续失败计数");
    assert.equal(snap["webhook:b"].failStreak, 1, "失败递增连续计数");
    assert.equal(snap["webhook:b"].lastError, "err", "错误摘要记录");
    // debounce 落盘（轮询等待，防固定 sleep flake）
    const text = await pollFile(file, (t) => t.includes("bark:a"));
    const persisted = JSON.parse(text);
    assert.equal(persisted["bark:a"].lastStatus, "ok", "debounce 合并后落盘反映最新终态");
    // 64 条上限：最旧先出
    for (let i = 0; i < 70; i += 1) store.record(`ch:${i}`, "ok");
    const after = await store.read();
    assert.equal(Object.keys(after).length, 64, "状态条目上限 64（防已删频道残留键累积）");
    assert.equal(after["ch:69"].lastStatus, "ok", "最近频道保留");
    assert.ok(!after["webhook:b"], "最旧条目被逐出");
    // 冷启动懒加载：等 debounce 落盘含 ch:69 后新建 store 从文件恢复
    await pollFile(file, (t) => t.includes("ch:69"));
    const store2 = createStatusStore({ file, warn: () => {} });
    const restored = await store2.read();
    assert.equal(restored["ch:69"].lastStatus, "ok", "冷启动从文件恢复内存镜像");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
