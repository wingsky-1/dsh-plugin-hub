// @ts-nocheck
/**
 * dsh-provider-usage — unit：#503 会话用量趋势（M1 数据层）。
 *
 * 覆盖（方案定稿 v1.2 记账口径 + 两级聚合 + 分片存储 + tracker 组合）：
 * - collector：usage 定稿主信号 / text-delta 热路径不计 / 重复 usage 校正不重记 /
 *   retry 逐次计（新 header 边界）/ message 补记与校正 / interrupted /
 *   归属缺失入未识别桶 / message.source 副源 / turn-end 定稿记忆保留（防乱序双算）/
 *   turn 计数 / tool 计数 / 分级 TTL / 会话销毁清理
 * - 评审修复：P2-1 counter 记账 time 取 event.time / P2-2 message 补记定稿后
 *   headerSeen 对称重置（迟到 usage 不双算）/ P2-3 done 记忆 Map 化（retry 记忆 +
 *   TREND_DONE_MAX 淘汰）/ P2-6 归属不一致 onAnomaly 告警（不覆盖主源）
 * - aggregator：null 语义求和 / 日切压实（cells 不动）/ rebuild / mergeAggRows /
 *   日/周/月序列（周一锚点、月区间、空日 null、provider 过滤）/ 时钟回拨旧日落桶
 * - store：明细 roundtrip / 坏行跳过 / 聚合原子写 / prune /
 *   P1-3 appendRows 成功日集合（部分失败不重复 append）/ P2-4 坏行校验拒绝 /
 *   P2-7 writeAggDay 清理同日残留 tmp
 * - 交叉：P0-1 HistoryStore.pruneAll 不误删 trend 分片
 * - tracker：启动重建（聚合权威）/ 过去日明细自愈 / 当日明细防二次落盘 /
 *   防抖刷盘 / dispose await 刷盘 / 日切压实与重启不双算 / 迟到旧日行合并防覆盖
 * - config：trendRetentionDays 归一化
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "./helpers.ts";
import {
  TrendCollector,
  TrendAggregator,
  TrendStore,
  TrendTracker,
  HistoryStore,
  dayKey,
  sumToken,
  mergeAggRows,
  mergeDirRows,
  metricValue,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  TREND_DONE_MAX,
  isValidShardRow,
  normalizeConfig,
  DEFAULT_CONFIG,
} from "../lib/index.js";

// ---------------------------------------------------------------- 工具

/** 固定本地时刻：2026-09-04（周五）12:00。 */
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const DAY0 = dayKey(T0); // 2026-09-04
const HOUR = 3600_000;

function ev(type, data, time, seq = 1) {
  return { type, seq, time, data };
}
const HEADER = (provider = "deepseek", model = "deepseek-chat") => ({
  header: { config: { provider, model } },
  reason: "initial",
});
const USAGE = (input = 100, output = 50, cacheRead = 0, cacheWrite = 0) => ({
  turn: 1,
  step: 1,
  chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } },
});
const MESSAGE = (usage, opts = {}) => ({
  turn: 1,
  step: 1,
  message: { role: "assistant", source: { kind: "model", provider: "deepseek", model: "deepseek-chat" } },
  ...(usage !== null ? { usage } : {}),
  ...(opts.interrupted ? { interrupted: true } : {}),
});

function makeCollector(now = () => T0) {
  const emitted = [];
  const collector = new TrendCollector({ now, emit: (e) => emitted.push(e) });
  // collector 直接吃字符串 session id（id 提取在 tracker 层）；对象/null 经此解包以覆盖非法输入防御
  const send = (session, event) => collector.handleEvent(typeof session === "string" ? session : session?.id, event);
  return { collector, emitted, send };
}

const callsOf = (emitted) => emitted.filter((e) => e.type === "call").map((e) => e.record);
const correctsOf = (emitted) => emitted.filter((e) => e.type === "correct").map((e) => e.record);
const countersOf = (emitted) => emitted.filter((e) => e.type === "counter").map((e) => e.record);

// ---------------------------------------------------------------- collector：定稿主信号

{
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hi" } }, T0, 2));
  send(s, ev("assistant/chunk", USAGE(100, 50, 10, 5), T0 + 1000, 3));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 1, "usage chunk 到达即定稿：一次调用");
  assert.equal(calls[0].provider, "deepseek", "归属主源 = request/header 折叠");
  assert.equal(calls[0].model, "deepseek-chat", "归属 model");
  assert.deepEqual(calls[0].tokens, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, "token 计量");
  assert.equal(calls[0].retry, 1, "首调用 retry=1");
  assert.equal(calls[0].time, T0 + 1000, "定稿时间 = 事件 time");
  assert.equal(emitted.filter((e) => e.type === "correct").length, 0, "text-delta 与首定稿不产生校正");
}

// ---------------------------------------------------------------- collector：重复 usage 校正

{
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  send(s, ev("assistant/chunk", USAGE(200, 60), T0 + 10, 3));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 1, "同调用重复 usage 不重计调用");
  const corr = correctsOf(emitted);
  assert.equal(corr.length, 1, "重复 usage 产生校正");
  assert.deepEqual(corr[0].tokens, { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 }, "校正取后值");
  assert.equal(corr[0].retry, 1, "校正命中同 fold 键");
}

// ---------------------------------------------------------------- collector：retry 逐次计

{
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  // retry：复用同一 (turn,step)，新 request/header 后再 usage
  send(s, ev("request/header", HEADER(), T0 + 5000, 3));
  send(s, ev("assistant/chunk", USAGE(70, 30), T0 + 6000, 4));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 2, "重试消耗逐次独立入账");
  assert.equal(calls[0].retry, 1, "第一次 retry=1");
  assert.equal(calls[1].retry, 2, "第二次 retry=2");
  assert.deepEqual([calls[0].tokens.input, calls[1].tokens.input], [100, 70], "两次消耗各自保留");
}

// ---------------------------------------------------------------- collector：message 补记/校正/interrupted

{
  // 补记：usage chunk 缺失，message.usage 到达
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 30, outputTokens: 20 }), T0 + 100, 2));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 1, "message 补记一次调用");
  assert.deepEqual(calls[0].tokens, { input: 30, output: 20, cacheRead: null, cacheWrite: null }, "补记 token 来自 message.usage");
  assert.equal(calls[0].time, T0 + 100, "补记时间 = 事件 time");
}

{
  // 补记：无 usage（零 usage 语义）——调用照计、token null
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/message", MESSAGE(null), T0, 2));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 1, "零 usage 仍计一次调用");
  assert.equal(calls[0].tokens, null, "token 记 null 非 0");
}

{
  // interrupted 补记
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 5, outputTokens: 3 }, { interrupted: true }), T0, 2));
  assert.equal(callsOf(emitted)[0].interrupted, true, "interrupted 标记保留");
}

{
  // 校正：已定稿后 message 到达仅校正不重记
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 120, outputTokens: 60 }), T0 + 50, 3));
  assert.equal(callsOf(emitted).length, 1, "已定稿后 message 不重计");
  assert.equal(correctsOf(emitted).length, 1, "message 校正产生");
}

// ---------------------------------------------------------------- collector：归属

{
  // 归属缺失 → 未识别桶（不静默丢弃）
  const { emitted, send } = makeCollector();
  send({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 1));
  const calls = callsOf(emitted);
  assert.equal(calls[0].provider, TREND_UNIDENTIFIED, "归属缺失入未识别桶");
  assert.equal(calls[0].model, null, "未识别桶 model=null");
}

{
  // 副源：message.source（kind:"model"）在归属缺失时补齐
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("assistant/message", { ...MESSAGE({ inputTokens: 1, outputTokens: 1 }), turn: 1 }, T0, 1));
  // 后续调用（新 turn）：副源归属已折叠进会话状态
  send(s, ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } } }, T0 + 100, 2));
  assert.equal(callsOf(emitted).length, 2, "message 补记 + 后续 usage 各计一次");
  assert.equal(callsOf(emitted)[0].provider, "deepseek", "首条经副源归属");
  assert.equal(callsOf(emitted)[1].provider, "deepseek", "副源归属折叠对后续调用生效");
}

{
  // mid-session 切换：新 header 覆盖归属
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER("deepseek", "chat"), T0, 1));
  send(s, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } }, T0, 2));
  send(s, ev("request/header", HEADER("opencode", "glm-4"), T0 + 10, 3));
  send(s, ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 2 } } }, T0 + 20, 4));
  assert.deepEqual(callsOf(emitted).map((c) => c.provider), ["deepseek", "opencode"], "切换后归属更新");
}

// ---------------------------------------------------------------- collector：turn/end 与计数

{
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  send(s, ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }, T0, 3));
  send(s, ev("tool/call", { turn: 1, step: 1, callId: "c2", name: "bash", arguments: "{}" }, T0, 4));
  send(s, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 1000, 5));
  const counters = countersOf(emitted);
  assert.equal(counters.filter((c) => c.turns === 1).length, 1, "turn/end 计一轮");
  assert.equal(counters.filter((c) => c.toolCalls === 1).length, 2, "tool/call 计两次");
  assert.equal(callsOf(emitted).length, 1, "turn/end 不影响已定稿调用");
}

{
  // turn/end 丢弃未定稿缓冲；定稿记忆保留——同 turn 乱序迟到 message 不双算
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2)); // 已定稿 → done 记忆
  send(s, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 1000, 3));
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 999, outputTokens: 999 }), T0 + 2000, 4)); // 乱序迟到
  assert.equal(callsOf(emitted).length, 1, "turn/end 后迟到 message 不补记（防双算）");
  assert.equal(correctsOf(emitted).length, 1, "迟到 message 走校正路径");
}

// ---------------------------------------------------------------- collector：TTL 与销毁

{
  let nowMs = T0;
  const { emitted, send } = makeCollector(() => nowMs);
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  nowMs = T0 + 11 * 60 * 1000; // 推进 11min：fold 缓冲 TTL 到龄（定稿记忆保留）
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 42, outputTokens: 42 }), nowMs, 3));
  assert.equal(callsOf(emitted).length, 1, "fold TTL 后迟到 message 仍不双算（done 记忆在会话级保留）");
  assert.equal(correctsOf(emitted).length, 1, "走校正");
}

{
  let nowMs = T0;
  const { emitted, send } = makeCollector(() => nowMs);
  const s1 = { id: "s1" };
  send(s1, ev("request/header", HEADER(), T0, 1));
  send(s1, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  nowMs = T0 + 61 * 60 * 1000; // 会话级 TTL（60min）到龄
  send(s1, ev("assistant/message", MESSAGE({ inputTokens: 7, outputTokens: 7 }), nowMs, 3));
  assert.equal(callsOf(emitted).length, 1, "闲置 61min 后首条迟到 message 仍走校正（不双算优先）");
  assert.equal(correctsOf(emitted).length, 1, "校正路径");
  // 其他会话的事件触发全局清扫 → s1（真闲置 61min）被回收
  send({ id: "s2" }, ev("assistant/chunk", USAGE(1, 1), nowMs, 4));
  // s1 回收后的迟到 message：全新会话态补记（60min 窗口外不追溯，口径文档化）
  send(s1, ev("assistant/message", MESSAGE({ inputTokens: 7, outputTokens: 7 }), nowMs, 5));
  assert.equal(callsOf(emitted).length, 2, "状态回收后的迟到 message 视为全新会话补记");
}

{
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  send(s, null); // 非法 session 不崩
  send({ id: "s1" }, null); // 非法 event 不崩
  send({ id: "s1" }, ev("assistant/chunk", { turn: "x", step: 1, chunk: { type: "usage" } }, T0, 3)); // 非法字段不崩
  assert.equal(callsOf(emitted).length, 1, "非法 payload 防御跳过，正常记账不受连坐");
}

// ---------------------------------------------------------------- aggregator

function cellTotals(agg, day, provider = "deepseek") {
  const b = agg.buckets().find((d) => d.day === day);
  if (!b) return null;
  const p = b.providers.find((x) => x.provider === provider);
  return p ? p.cell : null;
}

{
  const agg = new TrendAggregator();
  agg.apply({ type: "call", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", tokens: null } });
  agg.apply({ type: "call", record: { time: T0 + HOUR, session: "s1", turn: 2, step: 1, retry: 1, provider: "deepseek", model: "chat", tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null } } });
  const cell = cellTotals(agg, DAY0);
  assert.equal(cell.calls, 2, "calls 独立累加");
  assert.equal(cell.input, 100, "null-aware 求和：null 不污染数字");
  assert.equal(cell.output, null, "全 null 维度保持 null（非 0）");
  assert.equal(cell.turns, 0, "未计轮");
}

{
  // 日切压实：cells 不动、pending 移除、聚合行正确
  const agg = new TrendAggregator();
  agg.apply({ type: "call", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: T0 + HOUR, session: "s2", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", tokens: { input: 20, output: 5, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "counter", record: { time: T0, session: "s1", provider: "deepseek", model: "chat", turns: 1, toolCalls: 2 } });
  const before = JSON.stringify(agg.buckets());
  const aggRows = agg.rollupDay(DAY0);
  assert.equal(JSON.stringify(agg.buckets()), before, "压实只转落盘形态，cells 不动（不双算）");
  assert.equal(agg.pendingDays().length, 0, "压实后 pending 清空");
  assert.equal(aggRows.length, 1, "同 (provider,model) 折叠为一行");
  const row = aggRows[0];
  assert.equal(row.calls, 2, "聚合 calls");
  assert.equal(row.turns, 1, "聚合 turns");
  assert.equal(row.toolCalls, 2, "聚合 toolCalls");
  assert.equal(row.input, 30, "聚合 input 求和");
  assert.equal(row.v, TREND_ROW_VERSION, "聚合行带 schema 版本");
}

{
  // 时钟回拨：旧日事件按其本地日落桶（append-only 容忍）
  const agg = new TrendAggregator();
  const past = new Date(2026, 8, 1, 8, 0, 0).getTime(); // 09-01 < DAY0
  agg.apply({ type: "call", record: { time: past, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", tokens: { input: 7, output: 0, cacheRead: null, cacheWrite: null } } });
  assert.ok(agg.buckets().some((d) => d.day === dayKey(past)), "旧日事件落旧日桶");
}

{
  // rebuild：agg 行 + 明细/计数行重建 cells；persisted 标记防二次落盘
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      { v: 1, kind: "agg", day: DAY0, provider: "deepseek", model: "chat", input: 100, output: 50, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 3 },
      { v: 1, kind: "detail", time: T0, day: DAY0, session: "s9", turn: 9, step: 1, retry: 1, provider: "deepseek", model: "chat", input: 7, output: 7, cacheRead: null, cacheWrite: null, calls: 1 },
      { v: 1, kind: "counter", time: T0, day: DAY0, session: "s9", provider: "deepseek", model: "chat", turns: 1, toolCalls: 0 },
    ],
    true,
  );
  const cell = cellTotals(agg, DAY0);
  assert.equal(cell.calls, 3, "重建 calls = agg + 明细");
  assert.equal(cell.input, 107, "重建 token 合并");
  assert.equal(cell.turns, 2, "重建 turns 合并");
  assert.equal(cell.toolCalls, 3, "重建 toolCalls 合并");
}

{
  // mergeAggRows：同键累加、null-aware
  const merged = mergeAggRows(
    [{ v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 10, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 }],
    [{ v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 5, output: 3, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 0 }],
  );
  assert.equal(merged.length, 1, "同键合并");
  assert.equal(merged[0].input, 15, "token 合并");
  assert.equal(merged[0].output, 3, "null + 数字 = 数字");
  assert.equal(merged[0].calls, 3, "calls 合并");
}

// ---------------------------------------------------------------- aggregator：序列

{
  const agg = new TrendAggregator();
  const d1 = new Date(2026, 8, 3, 10, 0, 0).getTime(); // 周四
  const d2 = T0; // 09-04 周五
  agg.apply({ type: "call", record: { time: d1, session: "s", turn: 1, step: 1, retry: 1, provider: "a", model: "m", tokens: { input: 10, output: 0, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: d2, session: "s", turn: 1, step: 1, retry: 1, provider: "b", model: "m", tokens: { input: 20, output: 0, cacheRead: null, cacheWrite: null } } });
  const days = agg.seriesDays(3, d2, "input");
  assert.deepEqual(days.map((d) => d.value), [null, 10, 20], "日序列空日 null、按日取值");
  const onlyB = agg.seriesDays(3, d2, "input", "b");
  assert.deepEqual(onlyB.map((d) => d.value), [null, null, 20], "provider 过滤");
  assert.equal(metricValue({ input: 1, output: 2, cacheRead: 3, cacheWrite: null, calls: 9, turns: 0, toolCalls: 0 }, "total"), 6, "total = 非空 token 之和");
}

{
  // 周序列：2026-09-04 为周五，周一起点 = 08-31
  const agg = new TrendAggregator();
  const monday = new Date(2026, 7, 31, 10, 0, 0).getTime(); // 08-31 周一
  agg.apply({ type: "call", record: { time: monday, session: "s", turn: 1, step: 1, retry: 1, provider: "a", model: "m", tokens: { input: 10, output: 0, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: T0, session: "s", turn: 1, step: 1, retry: 1, provider: "a", model: "m", tokens: { input: 5, output: 0, cacheRead: null, cacheWrite: null } } });
  const weeks = agg.seriesWeeks(2, T0, "input");
  assert.deepEqual(weeks.map((w) => w.day), ["2026-08-24", "2026-08-31"], "周首日键（周一锚点）");
  assert.deepEqual(weeks.map((w) => w.value), [null, 15], "同周聚合（08-31 与 09-04 同周）");
}

{
  // 月序列：月区间跨自然月
  const agg = new TrendAggregator();
  const aug = new Date(2026, 7, 15, 10, 0, 0).getTime();
  agg.apply({ type: "call", record: { time: aug, session: "s", turn: 1, step: 1, retry: 1, provider: "a", model: "m", tokens: { input: 8, output: 0, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: T0, session: "s", turn: 1, step: 1, retry: 1, provider: "a", model: "m", tokens: { input: 4, output: 0, cacheRead: null, cacheWrite: null } } });
  const months = agg.seriesMonths(2, T0, "input");
  assert.deepEqual(months.map((m) => m.day), ["2026-08", "2026-09"], "月键");
  assert.deepEqual(months.map((m) => m.value), [8, 4], "月区间聚合");
}

// ---------------------------------------------------------------- aggregator：堆叠柱序列 / 窗口摘要（#503 M2 查询面）

{
  // 场景：3 个 provider/model 组合、跨 3 天；dPrev 落在上一窗口（环比基准）
  const agg = new TrendAggregator();
  const d1 = new Date(2026, 8, 3, 10, 0, 0).getTime(); // 周四 09-03
  const dPrev = new Date(2026, 7, 31, 10, 0, 0).getTime(); // 周一 08-31
  const call = (time, provider, model, input) => ({
    type: "call",
    record: { time, session: "s", turn: 1, step: 1, retry: 1, provider, model, tokens: { input, output: 0, cacheRead: null, cacheWrite: null } },
  });
  agg.apply(call(dPrev, "deepseek", "chat", 7));
  agg.apply(call(d1, "deepseek", "chat", 10));
  agg.apply(call(T0, "deepseek", "reasoner", 20));
  agg.apply(call(T0, "deepseek", "chat", 3));
  agg.apply(call(T0, "openai", "gpt", 5));

  // seriesStacked（day，byModel=false）：同 provider 跨 model 并段；空桶 null
  const day = agg.seriesStacked(3, "day", "input", undefined, false, T0);
  assert.deepEqual(day.series.map((p) => p.key), ["2026-09-02", "2026-09-03", "2026-09-04"], "day 桶键（升序含今日）");
  assert.deepEqual(day.series[0], { key: "2026-09-02", parts: [], total: null }, "空桶 parts 空且 total=null");
  assert.deepEqual(day.series[1].parts, [{ provider: "deepseek", model: null, value: 10 }], "byModel=false 段 model=null");
  assert.deepEqual(
    day.series[2].parts.map((p) => [p.provider, p.value]),
    [["deepseek", 23], ["openai", 5]],
    "同 provider 跨 model 并段（20+3）",
  );
  assert.equal(day.series[2].total, 28, "桶 total = 段之和");
  assert.deepEqual(day.providers, [{ provider: "deepseek", model: null }, { provider: "openai", model: null }], "图例并集（窗口内出现过的段）");

  // seriesStacked（day，byModel=true）：细到 provider+model
  const byModel = agg.seriesStacked(3, "day", "input", undefined, true, T0);
  assert.deepEqual(
    byModel.series[2].parts.map((p) => [p.provider, p.model, p.value]),
    [["deepseek", "reasoner", 20], ["deepseek", "chat", 3], ["openai", "gpt", 5]],
    "byModel 拆段含 model",
  );
  assert.deepEqual(
    byModel.providers.map((p) => `${p.provider}/${p.model}`).sort(),
    ["deepseek/chat", "deepseek/reasoner", "openai/gpt"],
    "byModel 图例并集细到 model",
  );

  // seriesStacked：provider 过滤（段与图例同收）
  const filtered = agg.seriesStacked(3, "day", "input", "deepseek", false, T0);
  assert.deepEqual(filtered.series[2].parts, [{ provider: "deepseek", model: null, value: 23 }], "provider 过滤只剩该 provider 段");
  assert.deepEqual(filtered.providers, [{ provider: "deepseek", model: null }], "过滤后图例");
  assert.equal(filtered.series[2].total, 23, "过滤后桶 total");

  // seriesStacked（week / month）：跨桶聚合与键形态（08-31/09-03/09-04 同一周）
  const weeks = agg.seriesStacked(2, "week", "input", undefined, false, T0);
  assert.deepEqual(weeks.series.map((p) => p.key), ["2026-08-24", "2026-08-31"], "week 桶键（周一锚点）");
  assert.deepEqual(weeks.series.map((p) => p.total), [null, 45], "week 桶聚合（7+10+20+3+5）");
  const months = agg.seriesStacked(2, "month", "input", undefined, false, T0);
  assert.deepEqual(months.series.map((p) => p.key), ["2026-08", "2026-09"], "month 桶键");
  assert.deepEqual(months.series.map((p) => p.total), [7, 38], "month 桶聚合（08-31 入 8 月桶）");

  // windowSummary：total/calls/peakKey/top/prevTotal（上一窗口 08-30..09-01 含 08-31 的 7）
  const sum = agg.windowSummary(3, "day", "input", undefined, T0);
  assert.equal(sum.total, 38, "窗口 total（09-02..09-04）");
  assert.equal(sum.calls, 4, "窗口 calls 计数（d1 1 次 + 当日 3 次）");
  assert.equal(sum.peakKey, DAY0, "峰值桶 = 取值最大的日桶");
  assert.deepEqual(sum.top, { provider: "deepseek", model: null, value: 23 }, "top 段（byModel=false 视角）");
  assert.equal(sum.turns, 0, "turns 无 counter 记录为 0");
  assert.equal(sum.prevTotal, 7, "上一窗口指标总量（环比基准）");

  // windowSummary：metric=calls 切换（上一窗口 08-31 的调用计入 prevTotal）
  const sumCalls = agg.windowSummary(3, "day", "calls", undefined, T0);
  assert.equal(sumCalls.total, 4, "calls 指标窗口总量");
  assert.equal(sumCalls.prevTotal, 1, "calls 指标环比基准");

  // windowSummary：provider 过滤（摘要口径与序列同源收窄）
  const sumFiltered = agg.windowSummary(3, "day", "input", "openai", T0);
  assert.equal(sumFiltered.total, 5, "过滤后窗口 total");
  assert.equal(sumFiltered.calls, 1, "过滤后 calls");
  assert.deepEqual(sumFiltered.top, { provider: "openai", model: null, value: 5 }, "过滤后 top 段");
  assert.equal(sumFiltered.prevTotal, null, "过滤后上一窗口无数据 prevTotal=null");

  // #503 M2.1：prevComplete（上一窗口起点早于内存数据起点 → 基准不完整，环比不可比）
  assert.equal(sum.prevComplete, false, "prev 窗口起点 08-30 早于数据起点 08-31 → 不完整");
  const aggFull = new TrendAggregator();
  aggFull.apply(call(d1, "deepseek", "chat", 10)); // 数据起点 09-03，prev 窗口 08-30..09-01 整体在其之前
  aggFull.apply(call(T0, "deepseek", "chat", 20));
  const sumComplete = aggFull.windowSummary(3, "day", "input", undefined, T0);
  assert.equal(sumComplete.prevComplete, false, "数据起点 09-03 晚于 prev 窗口起点 08-30 → 不完整");
  assert.equal(sumComplete.prevTotal, null, "不完整时 prevTotal 仍按数据实况返回（null 语义不变）");

  // 正例：n=1 时 prev 窗口 = 昨日单桶；数据起点 09-02 早于 09-03 → 完整
  const aggSpan = new TrendAggregator();
  aggSpan.apply(call(d1, "deepseek", "chat", 10)); // 09-03
  aggSpan.apply(call(T0, "deepseek", "chat", 20)); // 09-04
  const sumSpan = aggSpan.windowSummary(1, "day", "input", undefined, T0);
  assert.equal(sumSpan.prevComplete, true, "prev 单桶 09-03 不早于数据起点 09-03 → 完整");
  assert.equal(sumSpan.prevTotal, 10, "完整场景 prevTotal 正常返回");

  // #503 M2.1：windowSummary 复用路由已算 stack 序列（结果一致性，消双算）
  const stackForReuse = agg.seriesStacked(3, "day", "input", undefined, false, T0).series;
  const sumReused = agg.windowSummary(3, "day", "input", undefined, T0, stackForReuse);
  assert.deepEqual(
    { total: sumReused.total, calls: sumReused.calls, peakKey: sumReused.peakKey, top: sumReused.top, prevTotal: sumReused.prevTotal, prevComplete: sumReused.prevComplete },
    { total: sum.total, calls: sum.calls, peakKey: sum.peakKey, top: sum.top, prevTotal: sum.prevTotal, prevComplete: sum.prevComplete },
    "复用 stack 序列与自算结果全等",
  );
}

// ---------------------------------------------------------------- store

{
  const root = mkdtempSync(join(tmpdir(), "dou-trend-store-"));
  const store = new TrendStore({ root });
  const rows = [
    { v: 1, kind: "detail", time: T0, day: DAY0, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 2, cacheRead: null, cacheWrite: null, calls: 1 },
    { v: 1, kind: "counter", time: T0, day: DAY0, session: "s1", provider: "p", model: "m", turns: 1, toolCalls: 0 },
  ];
  const ok = await store.appendRows(rows);
  assert.ok(ok instanceof Set && ok.has(DAY0), "appendRows 返回成功日集合");
  const back = await store.readDetailShard(DAY0);
  assert.deepEqual(back, rows, "明细分片 roundtrip");
  assert.equal((await store.hasAggShard(DAY0)), false, "聚合分片未写不存在");

  await store.writeAggDay(DAY0, [{ v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 3, output: 2, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 0 }]);
  assert.equal((await store.hasAggShard(DAY0)), true, "聚合分片写入");
  assert.equal((await store.readAggShard(DAY0)).length, 1, "聚合分片读回");

  await store.deleteDetailShard(DAY0);
  assert.deepEqual(await store.readDetailShard(DAY0), [], "明细分片删除");

  // prune：旧日删除、当日保留
  mkdirSync(join(root, "agg"), { recursive: true });
  writeFileSync(join(root, "agg", "2026-01-01.jsonl"), '{"v":1,"kind":"agg","day":"2026-01-01","provider":"p","model":null,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"calls":0,"turns":0,"toolCalls":0}\n');
  const removed = await store.prune("2026-06-01");
  assert.equal(removed, 1, "prune 删除过期聚合分片");
  assert.equal(existsSync(join(root, "agg", "2026-01-01.jsonl")), false, "过期文件已删");
}

{
  // 坏行跳过
  const root = mkdtempSync(join(tmpdir(), "dou-trend-badline-"));
  const store = new TrendStore({ root, warn: () => {} });
  mkdirSync(join(root, "agg"), { recursive: true });
  writeFileSync(
    join(root, "agg", DAY0 + ".jsonl"),
    `not-json\n{"v":99,"kind":"agg","day":"${DAY0}","provider":"p","model":null,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"calls":0,"turns":0,"toolCalls":0}\n{"v":1,"kind":"agg","day":"${DAY0}","provider":"p","model":null,"input":1,"output":1,"cacheRead":null,"cacheWrite":null,"calls":1,"turns":0,"toolCalls":0}\n`,
  );
  const rows = await store.readAggShard(DAY0);
  assert.equal(rows.length, 1, "坏行/异版本行跳过，仅收当前 schema 版本");
}

// ---------------------------------------------------------------- tracker

function writeAggShardLine(row) {
  return `${JSON.stringify(row)}\n`;
}

{
  // 启动重建：聚合分片权威——同日明细分片为压实残留，忽略并自愈删除
  const root = mkdtempSync(join(tmpdir(), "dou-trend-rebuild-"));
  const day1 = "2026-09-03";
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(aggDir, { recursive: true });
  mkdirSync(detDir, { recursive: true });
  writeFileSync(join(aggDir, `${day1}.jsonl`), writeAggShardLine({ v: 1, kind: "agg", day: day1, provider: "p", model: "m", input: 10, output: 5, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 0 }));
  writeFileSync(join(detDir, `${day1}.jsonl`), `${JSON.stringify({ v: 1, kind: "detail", time: T0, day: day1, session: "sx", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 999, output: 999, cacheRead: null, cacheWrite: null, calls: 1 })}\n`);
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 50 });
  const b = tracker.buckets().find((d) => d.day === day1);
  assert.equal(b.providers[0].cell.calls, 2, "聚合权威：残留明细不计入（不双算）");
  assert.equal(b.providers[0].cell.input, 10, "聚合权威 token");
  assert.equal(existsSync(join(detDir, `${day1}.jsonl`)), false, "残留明细分片自愈删除");
  await tracker.dispose();
}

{
  // 自愈压实：过去日明细分片无聚合分片 → 重建后立即压实
  const root = mkdtempSync(join(tmpdir(), "dou-trend-heal-"));
  const day1 = "2026-09-03";
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  writeFileSync(join(detDir, `${day1}.jsonl`), [
    JSON.stringify({ v: 1, kind: "detail", time: T0, day: day1, session: "sx", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 7, output: 0, cacheRead: null, cacheWrite: null, calls: 1 }),
    JSON.stringify({ v: 1, kind: "counter", time: T0, day: day1, session: "sx", provider: "p", model: "m", turns: 1, toolCalls: 1 }),
    "", // 尾空行容忍
  ].join("\n"));
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 50 });
  const b = tracker.buckets().find((d) => d.day === day1);
  assert.equal(b.providers[0].cell.calls, 1, "明细权威：重建进 cells");
  assert.equal(existsSync(join(aggDir, `${day1}.jsonl`)), true, "自愈压实写出聚合分片");
  assert.equal(existsSync(join(detDir, `${day1}.jsonl`)), false, "明细分片压实后删除");
  await tracker.dispose();
}

{
  // 当日明细重建 + 新事件 flush：既有行不二次落盘
  const root = mkdtempSync(join(tmpdir(), "dou-trend-today-"));
  const today = dayKey(T0);
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  const preRow = { v: 1, kind: "detail", time: T0 - HOUR, day: today, session: "s0", turn: 0, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 1, cacheRead: null, cacheWrite: null, calls: 1 };
  writeFileSync(join(detDir, `${today}.jsonl`), `${JSON.stringify(preRow)}\n`);
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 50 });
  tracker.handleEvent({ id: "s1" }, ev("request/header", { header: { config: { provider: "p", model: "m" } }, reason: "initial" }, T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 2 } } }, T0, 2));
  await tracker.flushNow();
  const lines = readFileSync(join(detDir, `${today}.jsonl`), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2, "当日分片 = 既有 1 行 + 新增 1 行（重建行不二次 append）");
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed.filter((r) => r.session === "s0").length, 1, "既有行仅一份");
  assert.equal(parsed.filter((r) => r.session === "s1").length, 1, "新行落盘");
  assert.equal(tracker.buckets().find((d) => d.day === today).providers[0].cell.calls, 2, "cells 含重建 + 新事件");
  await tracker.dispose();
}

{
  // 防抖刷盘 + dispose await 刷盘
  const root = mkdtempSync(join(tmpdir(), "dou-trend-flush-"));
  const today = dayKey(T0);
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 30 });
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 5, outputTokens: 5 } } }, T0, 1));
  assert.equal(tracker.stats().unpersistedRows, 1, "未落盘行计数");
  const detailFile = join(root, "details", `${today}.jsonl`);
  let flushed = existsSync(detailFile);
  const deadline = Date.now() + 3000;
  while (!flushed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    flushed = existsSync(detailFile);
  }
  assert.ok(flushed, "防抖窗口后自动刷盘");
  await tracker.dispose();
}

{
  // 日切压实：跨天后旧日压实为聚合分片、明细分片删除、重启不双算
  const root = mkdtempSync(join(tmpdir(), "dou-trend-rollup-"));
  let nowMs = T0; // 09-04
  let tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 50 });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(100, 50), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  nowMs = T0 + 24 * HOUR; // 次日 09-05
  await tracker.flushNow();
  const day0 = dayKey(T0);
  assert.equal(existsSync(join(root, "agg", `${day0}.jsonl`)), true, "旧日聚合分片落盘");
  assert.equal(existsSync(join(root, "details", `${day0}.jsonl`)), false, "旧日明细分片压实后删除");
  assert.equal(tracker.buckets().find((d) => d.day === day0).providers[0].cell.calls, 1, "压实后 cells 不变");

  // 迟到旧日行（时钟回拨）：append + 二次压实合并，不覆盖既有聚合
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0 + HOUR, 4)); // time 仍在 09-04
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 7 } } }, T0 + HOUR, 5));
  await tracker.flushNow();
  const aggRows = JSON.parse(readFileSync(join(root, "agg", `${day0}.jsonl`), "utf8").trimEnd().split("\n").at(-1));
  assert.equal(aggRows.calls, 2, "迟到旧日行合并进聚合分片（calls=1+1）");
  assert.equal(aggRows.input, 107, "token 合并 100+7");

  // 重启重建：聚合权威载入，cells 与重启前一致
  const beforeBuckets = JSON.stringify(tracker.buckets());
  await tracker.dispose();
  tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 50 });
  const afterCells = tracker.buckets().find((d) => d.day === day0).providers[0].cell;
  assert.equal(afterCells.calls, 2, "重启重建 calls 不双算");
  assert.equal(afterCells.input, 107, "重启重建 token 一致");
  assert.equal(afterCells.turns, 1, "turns 经聚合行保留");
  void beforeBuckets;
  await tracker.dispose();
}

{
  // dispose await 最终刷盘：事件后立即 dispose，分片必落盘
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dispose-"));
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 9, outputTokens: 9 } } }, T0, 1));
  await tracker.dispose();
  assert.ok(existsSync(join(root, "details", `${dayKey(T0)}.jsonl`)), "dispose await 刷盘（防抖远未到期）");
}

{
  // session/flush 语义在 tracker 层等价 flushNow；handleDisposed 清理不崩
  const root = mkdtempSync(join(tmpdir(), "dou-trend-flushpt-"));
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3 } } }, T0, 1));
  await tracker.flushNow();
  assert.equal(tracker.stats().unpersistedRows, 0, "flushNow 排空后无未落盘行");
  tracker.handleDisposed({ id: "s1" });
  await tracker.dispose();
}

// ---------------------------------------------------------------- 评审修复：P0-1 交叉（HistoryStore×trend）

{
  // P0-1 交叉：HistoryStore.pruneAll（默认 30 天 retention）不得误删 trend 目录分片——
  // trend 留存由 TrendTracker.prune 按自身 cutoff 独立管理（分片名日期恰好命中
  // pruneAll 的日期启发，漏排会被 30 天 retention 静默误删）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-p0x-"));
  const detFile = join(root, "trend", "details", "2026-01-01.jsonl");
  const aggFile = join(root, "trend", "agg", "2026-01-01.jsonl");
  const usageFile = join(root, "p1", "n1", "2026-01-01.jsonl");
  mkdirSync(join(root, "trend", "details"), { recursive: true });
  mkdirSync(join(root, "trend", "agg"), { recursive: true });
  mkdirSync(join(root, "p1", "n1"), { recursive: true });
  const detailLine = JSON.stringify({ v: 1, kind: "detail", time: T0, day: "2026-01-01", session: "sx", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 1, cacheRead: null, cacheWrite: null, calls: 1 });
  const aggLine = JSON.stringify({ v: 1, kind: "agg", day: "2026-01-01", provider: "p", model: "m", input: 1, output: 1, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 });
  writeFileSync(detFile, `${detailLine}\n`);
  writeFileSync(aggFile, `${aggLine}\n`);
  writeFileSync(usageFile, '{"time":1,"data":{}}\n');
  // mtime 一律设 90 天前构造过期形态（历史实现若按 mtime 启发判过期同样视为过期）
  const old = new Date(Date.now() - 90 * 86400000);
  utimesSync(detFile, old, old);
  utimesSync(aggFile, old, old);
  utimesSync(usageFile, old, old);
  const hist = new HistoryStore({ root }); // 默认 maxAgeMs=30 天
  await hist.pruneAll();
  assert.ok(existsSync(detFile), "pruneAll 不误删 trend/details 分片");
  assert.ok(existsSync(aggFile), "pruneAll 不误删 trend/agg 分片");
  assert.ok(!existsSync(usageFile), "普通 usage 过期分片被删（对照组有效）");
  // TrendStore.prune 按自身 cutoff 正常清理 trend 分片
  const tstore = new TrendStore({ root: join(root, "trend") });
  const removed = await tstore.prune("2026-02-01");
  assert.equal(removed, 2, "TrendStore.prune 删除 cutoff 前的明细+聚合分片");
  assert.ok(!existsSync(detFile) && !existsSync(aggFile), "trend 过期分片被自身 prune 清理");
}

// ---------------------------------------------------------------- 评审修复：P1-3 appendRows 部分失败

{
  // P1-3 store 级：失败日 details/<day>.jsonl 预创建为目录 → appendFile 得 EISDIR，
  // appendRows 返回成功日集合只含成功日；移除障碍重试后失败日进入成功集。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-partial-"));
  const store = new TrendStore({ root, warn: () => {} });
  const dayB = "2026-09-03";
  mkdirSync(join(root, "details", `${dayB}.jsonl`), { recursive: true });
  const rowOf = (day, session) => ({ v: 1, kind: "detail", time: T0, day, session, turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 1, cacheRead: null, cacheWrite: null, calls: 1 });
  const okDays = await store.appendRows([rowOf(DAY0, "sA"), rowOf(dayB, "sB")]);
  assert.ok(okDays instanceof Set, "appendRows 返回成功日集合");
  assert.deepEqual([...okDays], [DAY0], "成功集只含成功日（失败日 EISDIR 不在集）");
  assert.equal((await store.readDetailShard(DAY0)).length, 1, "成功日已落盘");
  assert.equal((await store.readDetailShard(dayB)).length, 0, "失败日未落盘");
  rmdirSync(join(root, "details", `${dayB}.jsonl`)); // 移除障碍
  const okDays2 = await store.appendRows([rowOf(dayB, "sB")]);
  assert.deepEqual([...okDays2], [dayB], "移除障碍后失败日进入成功集");
  assert.equal((await store.readDetailShard(dayB)).length, 1, "失败日行补上");
}

{
  // P1-3 tracker 级：flush 部分失败后成功日不重写（不重复 append → 崩溃重建不双算）、
  // 失败日行待下轮补上（时钟回拨过去日 + 分片目录障碍构造 EISDIR）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-partial2-"));
  let nowMs = T0; // 09-04 today
  const tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000 });
  const H = { header: { config: { provider: "p", model: "m" } }, reason: "initial" };
  const today = dayKey(T0);
  const pastDay = dayKey(T0 - 24 * HOUR); // 09-03
  tracker.handleEvent({ id: "s1" }, ev("request/header", H, T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2)); // 今日行
  tracker.handleEvent({ id: "s2" }, ev("request/header", H, T0 - 24 * HOUR, 3));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0 - 24 * HOUR, 4)); // 过去日行
  mkdirSync(join(root, "details", `${pastDay}.jsonl`), { recursive: true }); // 失败日障碍
  await tracker.flushNow();
  assert.equal(readFileSync(join(root, "details", `${today}.jsonl`), "utf8").trimEnd().split("\n").length, 1, "成功日分片有行");
  assert.equal(tracker.stats().unpersistedRows, 1, "unpersisted 只剩失败日行");
  assert.equal(tracker.buckets().find((d) => d.day === today).providers[0].cell.calls, 1, "成功日 cells 不双算");
  rmdirSync(join(root, "details", `${pastDay}.jsonl`)); // 移除障碍
  await tracker.flushNow();
  assert.equal(readFileSync(join(root, "details", `${today}.jsonl`), "utf8").trimEnd().split("\n").length, 1, "成功日分片行数不变（不重写）");
  assert.equal(tracker.stats().unpersistedRows, 0, "失败日行已补上排空");
  assert.equal(existsSync(join(root, "agg", `${pastDay}.jsonl`)), true, "过去日补盘后自愈压实");
  await tracker.dispose();
}

// ---------------------------------------------------------------- 评审修复：P2-2 补记定稿后 headerSeen 对称重置

{
  // P2-2 双算反例：header → message（带 usage）补记定稿 → 同 (turn,step) 迟到 usage chunk。
  // 修复前：补记定稿不重置 headerSeen → 迟到 usage 被误判为新调用（retry+1）重记 → 双算。
  const { emitted, send } = makeCollector();
  const agg = new TrendAggregator();
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 30, outputTokens: 20 }), T0 + 100, 2)); // 补记定稿
  send(s, ev("assistant/chunk", USAGE(300, 150), T0 + 200, 3)); // 迟到 usage chunk
  assert.equal(callsOf(emitted).length, 1, "补记定稿后迟到 usage 不重记（防双算）");
  const corr = correctsOf(emitted);
  assert.equal(corr.length, 1, "迟到 usage 走校正");
  assert.deepEqual(corr[0].tokens, { input: 300, output: 150, cacheRead: 0, cacheWrite: 0 }, "token 为校正值");
  // aggregator 端到端：correct 覆盖补记行 token，calls 仍 1
  for (const e of emitted) agg.apply(e);
  const cell = agg.buckets().find((d) => d.day === DAY0).providers[0].cell;
  assert.equal(cell.calls, 1, "aggregator calls=1（补记 1 + 校正不重计）");
  assert.equal(cell.input, 300, "aggregator token 被校正覆盖");
}

// ---------------------------------------------------------------- 评审修复：P2-3 done 定稿记忆 Map 化

{
  // P2-3(a)：retry=2 定稿后 folds 被 TTL 清空 → 迟到 message 校正的 retry
  // 从 done 记忆取真实值 2（修复前兜底 1，会错改 retry=1 行的归属）。
  let nowMs = T0;
  const { emitted, send } = makeCollector(() => nowMs);
  const s = { id: "s1" };
  send(s, ev("request/header", HEADER(), T0, 1));
  send(s, ev("assistant/chunk", USAGE(100, 50), T0, 2)); // retry=1 定稿 → done["1:1"]=1
  send(s, ev("request/header", HEADER(), T0 + 5000, 3)); // 重试边界
  send(s, ev("assistant/chunk", USAGE(70, 30), T0 + 6000, 4)); // retry=2 定稿 → done["1:1"]=2
  nowMs = T0 + 11 * 60 * 1000; // fold TTL 到龄：sweep 清 folds（done 记忆保留）
  send(s, ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, nowMs, 5)); // 触发 sweep
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 88, outputTokens: 66 }), nowMs, 6)); // 迟到校正
  const corr = correctsOf(emitted);
  assert.equal(corr.length, 1, "folds 清空后迟到 message 仍走校正（不双算）");
  assert.equal(corr[0].retry, 2, "retry 从 done 记忆取真实值 2（非兜底 1）");
}

{
  // P2-3(b)：done 超 TREND_DONE_MAX 按插入序淘汰最旧键（长命会话防无界增长）。
  // 行为观测：每 turn 定稿 1 键 + turn/end 清 folds → done 累积 MAX+1 键 →
  // 最旧键（turn=1）被淘汰（迟到 message 补记），最新键仍在（迟到 message 校正）。
  assert.equal(TREND_DONE_MAX, 200, "done 记忆上限常量");
  const { emitted, send } = makeCollector();
  const s = { id: "s1" };
  const usageAt = (turn) => ({ turn, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } });
  for (let turn = 1; turn <= TREND_DONE_MAX + 1; turn++) {
    send(s, ev("assistant/chunk", usageAt(turn), T0, turn));
    send(s, ev("turn/end", { turn, reason: { kind: "completed" } }, T0, turn));
  }
  send(s, ev("assistant/message", MESSAGE({ inputTokens: 9, outputTokens: 9 }), T0, 999)); // turn=1 step=1（被淘汰键）
  assert.equal(callsOf(emitted).length, TREND_DONE_MAX + 2, "被淘汰键的迟到 message 走补记（无记忆可校正）");
  const late = { ...MESSAGE({ inputTokens: 8, outputTokens: 8 }), turn: TREND_DONE_MAX + 1 };
  send(s, ev("assistant/message", late, T0, 1000)); // turn=MAX+1（最新键仍在记忆）
  const corr = correctsOf(emitted);
  assert.equal(corr.length, 1, "未淘汰键的迟到 message 走校正");
  assert.equal(corr[0].turn, TREND_DONE_MAX + 1, "校正命中最新键");
}

// ---------------------------------------------------------------- 评审修复：P2-4 分片行校验补强

{
  // P2-4：token 字符串 "x" / model 数字 / day 非零填充格式（"2026-9-4"）→
  // isValidShardRow 拒收、readDetailShard/readAggShard 跳过并逐行告警
  //（防垃圾值进 sumToken 拼接、垃圾日键进内存桶）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-badrow-"));
  const warns = [];
  const store = new TrendStore({ root, warn: (m) => warns.push(m) });
  const good = { v: 1, kind: "detail", time: T0, day: DAY0, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 1, cacheRead: null, cacheWrite: null, calls: 1 };
  const badToken = { ...good, session: "s2", input: "x" };
  const badModel = { ...good, session: "s3", model: 3 };
  const badDay = { ...good, session: "s4", day: "2026-9-4" };
  const badCounter = { v: 1, kind: "counter", time: T0, day: DAY0, session: "s5", provider: "p", model: 3, turns: 1, toolCalls: 0 };
  const badAgg = { v: 1, kind: "agg", day: DAY0, provider: "p", model: 3, input: "x", output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 };
  // 校验面单点断言
  assert.equal(isValidShardRow(badToken), false, "token 非有限数拒绝");
  assert.equal(isValidShardRow(badModel), false, "model 非字符串拒绝");
  assert.equal(isValidShardRow(badDay), false, "day 非零填充格式拒绝");
  assert.equal(isValidShardRow(badCounter), false, "counter 行 model 数字拒绝");
  assert.equal(isValidShardRow(badAgg), false, "agg 行坏 token/model 拒绝");
  assert.equal(isValidShardRow(good), true, "合法行通过");
  // 分片读取面：坏行跳过 + 告警
  mkdirSync(join(root, "details"), { recursive: true });
  mkdirSync(join(root, "agg"), { recursive: true });
  writeFileSync(join(root, "details", `${DAY0}.jsonl`), [good, badToken, badModel, badDay, badCounter].map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(root, "agg", `${DAY0}.jsonl`), `${JSON.stringify(badAgg)}\n`);
  const details = await store.readDetailShard(DAY0);
  assert.equal(details.length, 1, "4 坏行全拒，仅收合法行");
  assert.equal(details[0].session, "s1", "保留的是合法 detail 行");
  assert.equal((await store.readAggShard(DAY0)).length, 0, "agg 坏行拒收");
  assert.equal(warns.length, 5, "每个坏行均有告警");
}

// ---------------------------------------------------------------- 评审修复：P2-6 归属不一致告警

{
  // P2-6：主源在场且 message.source 解析结果与之不一致 → onAnomaly 告警（带上下文）、
  // attribution 保持主源不被副源覆盖。
  const anomalies = [];
  const emitted = [];
  const collector = new TrendCollector({ now: () => T0, emit: (e) => emitted.push(e), onAnomaly: (m) => anomalies.push(m) });
  collector.handleEvent("s1", ev("request/header", HEADER("deepseek", "deepseek-chat"), T0, 1));
  collector.handleEvent("s1", ev("assistant/message", {
    turn: 1, step: 1,
    message: { role: "assistant", source: { kind: "model", provider: "opencode", model: "glm-4" } },
    usage: { inputTokens: 10, outputTokens: 5 },
  }, T0 + 100, 2));
  assert.equal(anomalies.length, 1, "归属不一致触发 onAnomaly（provider 不同）");
  assert.ok(anomalies[0].includes("s1"), "告警带上下文");
  assert.equal(callsOf(emitted)[0].provider, "deepseek", "attribution 保持主源 provider");
  assert.equal(callsOf(emitted)[0].model, "deepseek-chat", "attribution 保持主源 model");
  // 回归：主副源一致不告警；归属缺失走副源补齐不告警（既有语义不回退）
  const silent = [];
  const c2 = new TrendCollector({ now: () => T0, emit: () => {}, onAnomaly: (m) => silent.push(m) });
  c2.handleEvent("s1", ev("request/header", HEADER(), T0, 1));
  c2.handleEvent("s1", ev("assistant/message", MESSAGE({ inputTokens: 1, outputTokens: 1 }), T0, 2));
  assert.equal(silent.length, 0, "主副源一致不告警");
  const missing = [];
  const c3 = new TrendCollector({ now: () => T0, emit: () => {}, onAnomaly: (m) => missing.push(m) });
  c3.handleEvent("s1", ev("assistant/message", MESSAGE({ inputTokens: 1, outputTokens: 1 }), T0, 1));
  assert.equal(missing.length, 0, "归属缺失走副源补齐不告警");
}

{
  // P2-6 tracker 接线：collector onAnomaly → tracker 统一 warn 出口
  const warns = [];
  const root = mkdtempSync(join(tmpdir(), "dou-trend-anomaly-"));
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, warn: (m) => warns.push(m) });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER("deepseek", "deepseek-chat"), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/message", {
    turn: 1, step: 1,
    message: { role: "assistant", source: { kind: "model", provider: "opencode", model: "glm-4" } },
    usage: { inputTokens: 1, outputTokens: 1 },
  }, T0, 2));
  assert.ok(warns.some((m) => m.includes("归属")), "tracker 侧 onAnomaly 接线到 warn");
  await tracker.dispose();
}

{
  // P2-7：writeAggDay 写 tmp 前清理同日 rename 前崩溃残留 tmp（前缀 `${day}.jsonl.` 且
  // 后缀 `.tmp`）；他日残留不受影响，主流程正常。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-tmp-"));
  const store = new TrendStore({ root, warn: () => {} });
  mkdirSync(join(root, "agg"), { recursive: true });
  writeFileSync(join(root, "agg", `${DAY0}.jsonl.1700000000000.tmp`), "stale\n"); // 同日残留
  writeFileSync(join(root, "agg", `2026-09-05.jsonl.1700000000000.tmp`), "other-day\n"); // 他日残留
  await store.writeAggDay(DAY0, [{ v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 }]);
  assert.equal(existsSync(join(root, "agg", `${DAY0}.jsonl.1700000000000.tmp`)), false, "同日残留 tmp 已清");
  assert.equal(existsSync(join(root, "agg", `2026-09-05.jsonl.1700000000000.tmp`)), true, "他日残留不受影响");
  assert.equal((await store.readAggShard(DAY0)).length, 1, "主流程不受清理影响");
}

// ---------------------------------------------------------------- config

{
  assert.equal(normalizeConfig({}).trendRetentionDays, DEFAULT_CONFIG.trendRetentionDays, "trendRetentionDays 默认 180");
  assert.equal(normalizeConfig({ trendRetentionDays: 0 }).trendRetentionDays, 180, "非法（0）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: -3 }).trendRetentionDays, 180, "非法（负数）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: 1.5 }).trendRetentionDays, 180, "非法（非整数）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: 99999 }).trendRetentionDays, 3650, "上界 3650");
  assert.equal(normalizeConfig({ trendRetentionDays: 30 }).trendRetentionDays, 30, "合法透传");
}

// ---------------------------------------------------------------- #633 A1 补全：dir 落盘映射与 resolveCwd 契约接线

{
  // A1(a)：per-session 惰性单查——同 session 多次 emit 事件（call 定稿/校正/counter/
  // 新 turn call），resolveCwd 恰查询 1 次（结果缓存进会话状态）
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-once-"));
  const cwdCalls = [];
  const tracker = await TrendTracker.start({
    root,
    now: () => T0,
    flushDebounceMs: 60000,
    resolveCwd: (session) => {
      cwdCalls.push(session);
      return "/home/u/project-a";
    },
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2)); // call 定稿（首次查询）
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(11, 6), T0, 3)); // 同 fold 校正
  tracker.handleEvent({ id: "s1" }, ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 4)); // counter
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 5)); // counter
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 6));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3 } } }, T0, 7)); // 新 turn call
  await tracker.flushNow();
  assert.deepEqual(cwdCalls, ["s1"], "同 session 多次 emit 事件，resolveCwd 恰查询 1 次");
  assert.equal(tracker.stats().unpersistedRows, 0, "事件正常入账（2 call + 2 counter）");
  await tracker.dispose();
}

{
  // A1(b)：resolveCwd 返回 undefined（store 无该 session / cwd 缺失）或抛错 →
  // 归 TREND_UNIDENTIFIED 且各自仅查询 1 次（未识别结果同样缓存，防重复查询）
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-miss-"));
  const counts = { s1: 0, s2: 0 };
  const tracker = await TrendTracker.start({
    root,
    now: () => T0,
    flushDebounceMs: 60000,
    resolveCwd: (session) => {
      counts[session] = (counts[session] ?? 0) + 1;
      if (session === "s1") return undefined;
      throw new Error("boom");
    },
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
  tracker.handleEvent({ id: "s2" }, ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 6));
  await tracker.flushNow();
  assert.equal(counts.s1, 1, "undefined 路径仅查询 1 次");
  assert.equal(counts.s2, 1, "抛错路径仅查询 1 次");
  const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.kind === "detail" && r.session === "s1").dir, TREND_UNIDENTIFIED, "undefined → 未识别桶");
  assert.equal(rows.find((r) => r.kind === "detail" && r.session === "s2").dir, TREND_UNIDENTIFIED, "抛错 → 未识别桶");
  await tracker.dispose();
}

{
  // A1(c)：resolveCwd 返回含路径分隔符/尾斜杠的 cwd → 落盘为 sanitizeDirName
  // 净化后的 basename（数据层即存净化值，B1 可区分性约定）
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-sanitize-"));
  const tracker = await TrendTracker.start({
    root,
    now: () => T0,
    flushDebounceMs: 60000,
    resolveCwd: () => "/home/u/my proj/v2/",
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  await tracker.flushNow();
  const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  const detail = rows.find((r) => r.kind === "detail");
  const counter = rows.find((r) => r.kind === "counter");
  assert.equal(detail.dir, "v2", "detail 行 dir = basename 净化值（尾斜杠剥除取末段）");
  assert.equal(counter.dir, "v2", "counter 行 dir 同口径");
  assert.ok(!detail.dir.includes("/"), "落盘 dir 不含路径分隔符");
  await tracker.dispose();
}

{
  // A1(d)：落盘 detail/counter 行均含 dir 字段且值正确（多 session 各自归属不串桶）
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-persist-"));
  const tracker = await TrendTracker.start({
    root,
    now: () => T0,
    flushDebounceMs: 60000,
    resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
  tracker.handleEvent({ id: "s2" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 6));
  await tracker.flushNow();
  const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  const dS1 = rows.find((r) => r.kind === "detail" && r.session === "s1");
  const dS2 = rows.find((r) => r.kind === "detail" && r.session === "s2");
  const cS1 = rows.find((r) => r.kind === "counter" && r.session === "s1");
  const cS2 = rows.find((r) => r.kind === "counter" && r.session === "s2");
  assert.equal(dS1.dir, "alpha", "s1 detail 行 dir=alpha");
  assert.equal(dS2.dir, "beta", "s2 detail 行 dir=beta（多 session 不串桶）");
  assert.equal(cS1.dir, "alpha", "s1 counter 行 dir=alpha");
  assert.equal(cS2.dir, "beta", "s2 counter 行 dir=beta");
  await tracker.dispose();
}

// ---------------------------------------------------------------- #633 A2 兼容割接：存量分片（无 cwd/dir 键）升级后首次启动重建

// A2 前提（图纸第 1 步已验证）：isValidShardRow 按 kind 校验必填键，无键白名单遍历
// ——未知键不拒绝；detail/counter 的 dir 为加性可选键（dir === undefined 放行）。
// 本节全部离线 mkdtempSync：手工构造旧格式分片文件（无 dir 键），零 src 改动断言实际行为。

/** 旧格式 detail 行（无 dir 键；含中文归属桶与中文目录语义无关的会话 id）。 */
const A2_LEGACY_DETAIL = {
  v: TREND_ROW_VERSION,
  kind: "detail",
  time: T0 - 24 * HOUR, // 2026-09-03 12:00（过去日）
  day: "2026-09-03",
  session: "旧会话-甲",
  turn: 3,
  step: 2,
  retry: 1,
  provider: "deepseek",
  model: "deepseek-chat",
  input: 1200,
  output: 300,
  cacheRead: 45,
  cacheWrite: 6,
  calls: 1,
};
/** 旧格式 counter 行（无 dir 键）。 */
const A2_LEGACY_COUNTER = {
  v: TREND_ROW_VERSION,
  kind: "counter",
  time: T0 - 24 * HOUR,
  day: "2026-09-03",
  session: "旧会话-甲",
  provider: "deepseek",
  model: "deepseek-chat",
  turns: 1,
  toolCalls: 1,
};
/** 旧格式聚合行（agg 行本就无 dir 键，升级前后形态一致）。 */
const A2_LEGACY_AGG = {
  v: TREND_ROW_VERSION,
  kind: "agg",
  day: "2026-09-03",
  provider: "deepseek",
  model: "deepseek-chat",
  input: 5000,
  output: 800,
  cacheRead: 120,
  cacheWrite: 10,
  calls: 30,
  turns: 12,
  toolCalls: 40,
};

{
  // A2(a)：旧格式 fixture 重建（真实升级场景）——过去日聚合分片（权威）+ 当日旧版
  // 明细分片（无 dir 键的 detail/counter 行）：升级后首次启动不抛错；两日内存聚合
  // 数值与写入值一致；当日旧 detail 分片逐字节不变（rebuild 不重写 = round-trip
  // 结构性安全；dispose 最终刷盘同样不触碰 persisted 行）。过去日同日并存的残留
  // 明细分片（聚合分片 + 残留明细）走聚合权威自愈删除，残留行不双算——一并覆盖。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-rebuild-"));
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(aggDir, { recursive: true });
  mkdirSync(detDir, { recursive: true });
  const today = dayKey(T0); // 2026-09-04
  const detFile = join(detDir, `${today}.jsonl`);
  const aggFile = join(aggDir, "2026-09-03.jsonl");
  const todayDetail = { ...A2_LEGACY_DETAIL, time: T0 - HOUR, day: today };
  const todayCounter = { ...A2_LEGACY_COUNTER, time: T0 - HOUR, day: today };
  const legacyDetailBytes = `${JSON.stringify(todayDetail)}\n${JSON.stringify(todayCounter)}\n`;
  writeFileSync(detFile, legacyDetailBytes);
  writeFileSync(aggFile, `${JSON.stringify(A2_LEGACY_AGG)}\n`);
  // 同日并存形态：过去日明细分片为压实残留（升级前崩溃于写聚合后、删明细前），
  // 聚合权威 → start 自愈删除（残留明细不双算；残留行同样无 dir 键）
  const residueFile = join(detDir, "2026-09-03.jsonl");
  writeFileSync(residueFile, `${JSON.stringify(A2_LEGACY_DETAIL)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`);

  const warns = [];
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, warn: (m) => warns.push(m) });
  const bPast = tracker.buckets().find((d) => d.day === "2026-09-03");
  assert.ok(bPast, "旧格式聚合分片重建出过去日内存桶（启动不抛错）");
  const cellPast = bPast.providers.find((p) => p.provider === "deepseek" && p.model === "deepseek-chat").cell;
  assert.deepEqual(
    { input: cellPast.input, output: cellPast.output, cacheRead: cellPast.cacheRead, cacheWrite: cellPast.cacheWrite, calls: cellPast.calls, turns: cellPast.turns, toolCalls: cellPast.toolCalls },
    { input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 },
    "过去日 agg 权威行数值与写入值一致",
  );
  const cellToday = tracker.buckets().find((d) => d.day === today).providers[0].cell;
  assert.deepEqual(
    { input: cellToday.input, output: cellToday.output, cacheRead: cellToday.cacheRead, cacheWrite: cellToday.cacheWrite, calls: cellToday.calls, turns: cellToday.turns, toolCalls: cellToday.toolCalls },
    { input: 1200, output: 300, cacheRead: 45, cacheWrite: 6, calls: 1, turns: 1, toolCalls: 1 },
    "当日旧格式明细/计数行重建数值与写入值一致",
  );
  assert.deepEqual(warns, [], "旧格式行（无 dir 键）全量通过校验，无坏行告警");
  assert.equal(existsSync(residueFile), false, "过去日残留明细分片被聚合权威自愈删除（不双算）");
  assert.equal(readFileSync(detFile, "utf8"), legacyDetailBytes, "当日旧 detail 分片文件逐字节不变（rebuild 不重写）");
  assert.equal(readFileSync(aggFile, "utf8"), `${JSON.stringify(A2_LEGACY_AGG)}\n`, "旧 agg 分片文件不变（persisted 行 flush 不重写）");
  await tracker.dispose();
  assert.equal(readFileSync(detFile, "utf8"), legacyDetailBytes, "dispose 最终刷盘后旧 detail 分片仍逐字节不变");
}

{
  // A2(b)：自愈压实路径——过去日明细无聚合分片（旧格式行无 dir 键）→ start 触发自愈，
  // 新写聚合分片数值正确、明细分片已删（该路径本来就会重写，断言重写产物而非原文件保留）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-heal-"));
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  writeFileSync(join(detDir, "2026-09-03.jsonl"), `${JSON.stringify(A2_LEGACY_DETAIL)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`);
  const warns = [];
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, warn: (m) => warns.push(m) });
  const b = tracker.buckets().find((d) => d.day === "2026-09-03");
  assert.ok(b, "旧格式明细重建进内存（不抛错）");
  const cell = b.providers.find((p) => p.provider === "deepseek" && p.model === "deepseek-chat").cell;
  assert.equal(cell.calls, 1, "明细权威：calls = 明细行数");
  assert.equal(cell.turns, 1, "counter 行 turns 重建");
  assert.equal(cell.toolCalls, 1, "counter 行 toolCalls 重建");
  assert.equal(cell.input, 1200, "input 与明细值一致");
  assert.equal(cell.output, 300, "output 与明细值一致");
  assert.equal(cell.cacheRead, 45, "cacheRead 与明细值一致");
  assert.equal(cell.cacheWrite, 6, "cacheWrite 与明细值一致");
  assert.equal(existsSync(join(aggDir, "2026-09-03.jsonl")), true, "自愈压实写出聚合分片");
  assert.equal(existsSync(join(detDir, "2026-09-03.jsonl")), false, "明细分片压实后删除");
  const aggRows = (await new TrendStore({ root }).readAggShard("2026-09-03"));
  assert.equal(aggRows.length, 1, "压实产物恰一行（同 provider+model 折叠）");
  assert.deepEqual(
    { input: aggRows[0].input, output: aggRows[0].output, cacheRead: aggRows[0].cacheRead, cacheWrite: aggRows[0].cacheWrite, calls: aggRows[0].calls, turns: aggRows[0].turns, toolCalls: aggRows[0].toolCalls },
    { input: 1200, output: 300, cacheRead: 45, cacheWrite: 6, calls: 1, turns: 1, toolCalls: 1 },
    "压实产物数值与明细写入值一致（自愈不丢数不补造）",
  );
  assert.deepEqual(warns, [], "旧格式行全量通过校验，无坏行告警");
  await tracker.dispose();
}

{
  // A2(c)：round-trip——旧格式行经 rebuild → flushNow → 重读分片：行数不增不减、
  // 原字段值不变、detail/counter 行不被补造 dir 键（当日明细重建路径）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-roundtrip-"));
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  const detFile = join(detDir, `${dayKey(T0)}.jsonl`); // 当日明细（rebuild(true) 路径）
  const legacyTodayDetail = { ...A2_LEGACY_DETAIL, time: T0 - HOUR, day: dayKey(T0) };
  const legacyTodayCounter = { ...A2_LEGACY_COUNTER, time: T0 - HOUR, day: dayKey(T0) };
  const legacyTodayDetail2 = { ...A2_LEGACY_DETAIL, time: T0 - 2 * HOUR, day: dayKey(T0), session: "旧会话-乙", turn: 1, step: 1, input: 50, output: 20, cacheRead: 3, cacheWrite: 4 };
  const originalBytes = `${JSON.stringify(legacyTodayDetail)}\n${JSON.stringify(legacyTodayCounter)}\n${JSON.stringify(legacyTodayDetail2)}\n`;
  writeFileSync(detFile, originalBytes);
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
  const cell = tracker.buckets().find((d) => d.day === dayKey(T0)).providers[0].cell;
  assert.equal(cell.calls, 2, "内存重建 calls = 旧明细行数");
  assert.equal(cell.turns, 1, "内存重建 turns");
  assert.equal(cell.toolCalls, 1, "内存重建 toolCalls");
  assert.equal(cell.input, 1250, "内存重建 input 求和（1200+50）");
  assert.equal(cell.output, 320, "内存重建 output 求和（300+20）");
  await tracker.flushNow();
  assert.equal(readFileSync(detFile, "utf8"), originalBytes, "flushNow 后分片逐字节不变（重建行 persisted=true 不二次落盘）");
  const back = await new TrendStore({ root }).readDetailShard(dayKey(T0));
  assert.equal(back.length, 3, "重读行数不增不减（3 行旧格式行全量读回）");
  assert.deepEqual(
    back.map((r) => ({ kind: r.kind, session: r.session, time: r.time, provider: r.provider, model: r.model, input: "input" in r ? r.input : undefined, turns: "turns" in r ? r.turns : undefined })),
    [
      { kind: "detail", session: "旧会话-甲", time: T0 - HOUR, provider: "deepseek", model: "deepseek-chat", input: 1200, turns: undefined },
      { kind: "counter", session: "旧会话-甲", time: T0 - HOUR, provider: "deepseek", model: "deepseek-chat", input: undefined, turns: 1 },
      { kind: "detail", session: "旧会话-乙", time: T0 - 2 * HOUR, provider: "deepseek", model: "deepseek-chat", input: 50, turns: undefined },
    ],
    "原字段值经读回不变（中文会话 id/数值逐字段一致）",
  );
  assert.ok(back.every((r) => !("dir" in r)), "旧格式行不被补造 dir 键（无 dir → 内存重建后落盘形态仍无 dir）");
  await tracker.dispose();
}

{
  // A2(d)：未知键容忍——detail 行附加未知字段 legacyFlag:"x" 不被拒绝、不抛错，
  // 其余行正常重建（isValidShardRow 无键白名单遍历，未知键不参与校验 = 通过；
  // 未知键随 JSON.parse 保留在行对象上，rebuild 只累加已知数值字段，无影响）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-unknown-"));
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  const withUnknown = { ...A2_LEGACY_DETAIL, legacyFlag: "x" };
  writeFileSync(join(detDir, "2026-09-03.jsonl"), `${JSON.stringify(withUnknown)}\n${JSON.stringify(A2_LEGACY_COUNTER)}\n`);
  const warns = [];
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, warn: (m) => warns.push(m) });
  const cell = tracker.buckets().find((d) => d.day === "2026-09-03").providers[0].cell;
  assert.equal(cell.calls, 1, "未知键行不拒绝：calls 正常重建");
  assert.equal(cell.input, 1200, "未知键行数值正常重建");
  assert.deepEqual(warns, [], "未知键行不触发坏行告警");
  await tracker.dispose();
}

{
  // A2 补充：dir 值域防御仍是有效防线（与「未知键容忍」正交）——dir 为空字符串/
  // 非字符串时按坏行拒绝并告警，同分片合法行不受连坐（A1 校验语义不因 A2 放宽回退）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a2-dirguard-"));
  const warns = [];
  const store = new TrendStore({ root, warn: (m) => warns.push(m) });
  mkdirSync(join(root, "details"), { recursive: true });
  const good = { ...A2_LEGACY_DETAIL, dir: "proj" };
  const badEmptyDir = { ...A2_LEGACY_DETAIL, session: "s-bad-1", dir: "" };
  const badNumDir = { ...A2_LEGACY_DETAIL, session: "s-bad-2", dir: 7 };
  writeFileSync(join(root, "details", "2026-09-03.jsonl"), [good, badEmptyDir, badNumDir].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rows = await store.readDetailShard("2026-09-03");
  assert.equal(rows.length, 1, "空串/非字符串 dir 按坏行拒绝（A1 值域防线不回退）");
  assert.equal(rows[0].session, "旧会话-甲", "保留的是合法行");
  assert.equal(warns.length, 2, "两个非法 dir 行均告警");
}

// ---------------------------------------------------------------- #633 A3/A4：dir 维度归并内存态与日汇总行生成

{
  // A3(a)：内存态归并（tracker 全链路）——apply 平行累加后压实产物 dir 行：
  // 双 session 同 cwd → 恰 1 条 calls 为和；不同 cwd 独立行；resolveCwd 缺失 →
  // 未识别桶独立成行。dir 行位于 agg 行之后（writeAggDay 写入顺序约定）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a3-merge-"));
  let nowMs = T0;
  const tracker = await TrendTracker.start({
    root,
    now: () => nowMs,
    flushDebounceMs: 60000,
    resolveCwd: (session) => (session === "s1" || session === "s2" ? "/home/u/shared" : session === "s3" ? "/home/u/other" : undefined),
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
  tracker.handleEvent({ id: "s3" }, ev("request/header", HEADER(), T0, 6));
  tracker.handleEvent({ id: "s3" }, ev("assistant/chunk", USAGE(3, 3), T0, 7));
  tracker.handleEvent({ id: "s4" }, ev("request/header", HEADER(), T0, 8));
  tracker.handleEvent({ id: "s4" }, ev("assistant/chunk", USAGE(2, 2), T0, 9));
  nowMs = T0 + 24 * HOUR; // 日切：DAY0 成过去日
  await tracker.flushNow();
  const shard = await new TrendStore({ root }).readAggDayShard(DAY0);
  assert.deepEqual(
    shard.map((r) => r.kind),
    ["agg", "dir", "dir", "dir"],
    "混存分片：agg 行在前、dir 行在后",
  );
  assert.deepEqual(
    shard.filter((r) => r.kind === "dir"),
    [
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "shared", input: 17, output: 12, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 1, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "other", input: 3, output: 3, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: TREND_UNIDENTIFIED, input: 2, output: 2, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
    ],
    "同 cwd 双 session 归并为恰 1 条（calls 为和）；不同 cwd/未识别桶独立行",
  );
  assert.deepEqual(
    shard.filter((r) => r.kind === "agg").map((r) => ({ input: r.input, output: r.output, calls: r.calls, turns: r.turns })),
    [{ input: 22, output: 17, calls: 4, turns: 1 }],
    "agg 行（provider 维度）不受 dir 平行累加影响",
  );
  assert.equal(existsSync(join(root, "details", `${DAY0}.jsonl`)), false, "明细分片压实后删除");
  await tracker.dispose();
}

{
  // A3(b)：rebuild 混存行——agg 行 + dir 行 + 当日 detail/counter 行重放：dir 行
  // 只进目录维度桶（dirDays），不进 cells（防双计）、不进 pending（不二次落盘）。
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      { v: 1, kind: "agg", day: DAY0, provider: "deepseek", model: "chat", input: 100, output: 50, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 3 },
      { v: 1, kind: "dir", day: DAY0, dir: "proj", input: 100, output: 50, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 3 },
      { v: 1, kind: "detail", time: T0, day: DAY0, session: "s9", turn: 9, step: 1, retry: 1, provider: "deepseek", model: "chat", dir: "proj", input: 7, output: 7, cacheRead: null, cacheWrite: null, calls: 1 },
      { v: 1, kind: "counter", time: T0, day: DAY0, session: "s9", provider: "deepseek", model: "chat", dir: "proj", turns: 1, toolCalls: 0 },
    ],
    true,
  );
  const cell = cellTotals(agg, DAY0);
  assert.deepEqual(
    { input: cell.input, output: cell.output, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite, calls: cell.calls, turns: cell.turns, toolCalls: cell.toolCalls },
    { input: 107, output: 57, cacheRead: null, cacheWrite: null, calls: 3, turns: 2, toolCalls: 3 },
    "rebuild：agg + detail/counter 进 cells；dir 行不进（calls=2+1 而非 +dir 的 2）",
  );
  assert.equal(agg.stats().pendingRows, 2, "dir 行不进 pending（不二次落盘）");
}

{
  // A4(c)：rollup 产物字段值 deepEqual——rollupDay 返回 [...aggRows, ...dirRows]，
  // dir 行十字段（v/kind/day/dir/input/output/cacheRead/cacheWrite/calls/turns/toolCalls）
  // 值与 pending 折算一致；tokens null 的行 null-aware 归并；消费后不重复产出。
  const agg = new TrendAggregator();
  agg.apply({ type: "call", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", dir: "proj", tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 } } });
  agg.apply({ type: "counter", record: { time: T0, session: "s1", provider: "deepseek", model: "chat", dir: "proj", turns: 1, toolCalls: 2 } });
  agg.apply({ type: "call", record: { time: T0 + HOUR, session: "s2", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", dir: "proj", tokens: null } });
  const rows = agg.rollupDay(DAY0);
  assert.deepEqual(
    rows,
    [
      { v: TREND_ROW_VERSION, kind: "agg", day: DAY0, provider: "deepseek", model: "chat", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, calls: 2, turns: 1, toolCalls: 2 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "proj", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, calls: 2, turns: 1, toolCalls: 2 },
    ],
    "rollupDay 产物 agg+dir 行逐字段 deepEqual（null token 不污染、calls 独立累计）",
  );
  assert.deepEqual(agg.rollupDay(DAY0), [], "消费后二次 rollup 不重复产出（pending/dir 素材同源消费）");
}

{
  // A4(d)：mergeDirRows 纯函数——同 dir 键累加（null-aware）、异 dir 独立、
  // 输出保序（base 在前：对应分片内既有 dir 行位置约定）。
  const merged = mergeDirRows(
    [
      { v: 1, kind: "dir", day: DAY0, dir: "a", input: null, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
      { v: 1, kind: "dir", day: DAY0, dir: "b", input: 7, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 1 },
    ],
    [{ v: 1, kind: "dir", day: DAY0, dir: "a", input: 5, output: 3, cacheRead: null, cacheWrite: null, calls: 2, turns: 0, toolCalls: 0 }],
  );
  assert.deepEqual(
    merged,
    [
      { v: 1, kind: "dir", day: DAY0, dir: "a", input: 5, output: 3, cacheRead: null, cacheWrite: null, calls: 3, turns: 0, toolCalls: 0 },
      { v: 1, kind: "dir", day: DAY0, dir: "b", input: 7, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 1 },
    ],
    "mergeDirRows 同键累加、null-aware、保序",
  );
}

{
  // A4(e)：混存 round-trip——压实（混存落盘）→ 重启重建（不丢不重，dir 行不双算
  // 进 cells）→ 迟到旧日行二次压实（既有 dir 行经 readAggDayShard 全量取回合并，
  // 不被整日重写抹掉）→ 再重启（分片不再被改写）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a4-roundtrip-"));
  let nowMs = T0;
  let tracker = await TrendTracker.start({
    root,
    now: () => nowMs,
    flushDebounceMs: 60000,
    resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s1" }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3));
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
  tracker.handleEvent({ id: "s2" }, ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 5));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 6));
  nowMs = T0 + 24 * HOUR;
  await tracker.flushNow(); // 第一次压实：agg + dir 混存落盘
  const store = new TrendStore({ root });
  const round1 = await store.readAggDayShard(DAY0);
  assert.deepEqual(
    round1.map((r) => r.kind),
    ["agg", "dir", "dir"],
    "首次压实混存形态",
  );
  const dirRows1 = round1.filter((r) => r.kind === "dir");
  assert.equal(existsSync(join(root, "details", `${DAY0}.jsonl`)), false, "明细分片已删（压实收尾）");
  await tracker.dispose();
  tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, resolveCwd: () => "/home/u/alpha" });
  const cellR1 = tracker.buckets().find((d) => d.day === DAY0).providers.find((p) => p.provider === "deepseek").cell;
  assert.deepEqual(
    { input: cellR1.input, output: cellR1.output, cacheRead: cellR1.cacheRead, cacheWrite: cellR1.cacheWrite, calls: cellR1.calls, turns: cellR1.turns, toolCalls: cellR1.toolCalls },
    { input: 17, output: 12, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 1, toolCalls: 1 },
    "重启重建：agg 行权威进 cells，dir 行不双算（calls=2 而非 4）",
  );
  // 迟到旧日行（时钟回拨）：s1 turn2 usage 落 DAY0 → 二次压实合并
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0 + HOUR, 7));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, T0 + HOUR, 8));
  await tracker.flushNow();
  const round2 = await store.readAggDayShard(DAY0);
  assert.deepEqual(
    round2.map((r) => r.kind),
    ["agg", "dir", "dir"],
    "二次压实后行数不增（既有 dir 行未被整日重写抹掉）",
  );
  assert.deepEqual(
    round2.filter((r) => r.kind === "dir"),
    [
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "alpha", input: 13, output: 8, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 1, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "beta", input: 7, output: 7, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 1 },
    ],
    "迟到行并入 dir 行（alpha calls=1+1、input 10+3）且 beta 不受连坐",
  );
  await tracker.dispose();
  tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, resolveCwd: () => "/home/u/alpha" });
  const cellR2 = tracker.buckets().find((d) => d.day === DAY0).providers.find((p) => p.provider === "deepseek").cell;
  assert.equal(cellR2.calls, 3, "再重启重建 calls=2+1（迟到行已并入 agg 行，不丢不重）");
  assert.deepEqual(
    (await store.readAggDayShard(DAY0)).map((r) => r.kind),
    ["agg", "dir", "dir"],
    "再重启后分片形态稳定（persisted 行 flush 不重写）",
  );
  await tracker.dispose();
}

{
  // A4(f)：查询面零变化——含 dir 记账 + dir 行 rebuild 后，buckets()/seriesDays()
  // 与固定 fixture 全等（dir 不出现在 provider 查询面，cells 数值不受平行累加影响）。
  const agg = new TrendAggregator();
  agg.apply({ type: "call", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", dir: "x", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
  agg.apply({ type: "call", record: { time: T0 + HOUR, session: "s2", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", tokens: { input: 3, output: 4, cacheRead: null, cacheWrite: null } } });
  agg.rebuild(
    [
      { v: 1, kind: "agg", day: DAY0, provider: "other", model: null, input: 5, output: 5, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 1 },
      { v: 1, kind: "dir", day: DAY0, dir: "x", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
    ],
    false,
  );
  assert.deepEqual(
    agg.buckets(),
    [
      {
        day: DAY0,
        providers: [
          { provider: "deepseek", model: "chat", cell: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 0, toolCalls: 0 } },
          { provider: "other", model: null, cell: { input: 5, output: 5, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 1 } },
        ],
      },
    ],
    "buckets() 固定 fixture 全等（dir 行 rebuild 不进 cells、apply 平行累加不污染）",
  );
  assert.deepEqual(
    agg.seriesDays(2, T0 + HOUR, "input").map((d) => d.value),
    [null, 9],
    "seriesDays 零变化（空日 null 语义保持；input=4+5 跨 provider 求和）",
  );
}

{
  // A4(g)：量级留痕——1000 事件 / 5 session：resolveCwd 恰 5 次（per-session 惰性
  // 单查缓存，与事件量无关）；start+dispose 耗时基线 stderr 一行注明取数时点。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-a4-scale-"));
  let cwdCalls = 0;
  const startAt = Date.now();
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, resolveCwd: () => { cwdCalls += 1; return "/home/u/scale"; } });
  const startMs = Date.now() - startAt;
  let seq = 0;
  for (let s = 1; s <= 5; s += 1) {
    const sid = `s${s}`;
    tracker.handleEvent({ id: sid }, ev("request/header", HEADER(), T0, (seq += 1)));
    for (let k = 0; k < 199; k += 1) {
      tracker.handleEvent({ id: sid }, ev("assistant/chunk", { turn: k + 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, T0, (seq += 1)));
    }
  }
  const cell = tracker.buckets().find((d) => d.day === DAY0).providers[0].cell;
  assert.equal(cell.calls, 995, "1000 事件（5 header + 995 usage）全量记账进 cells");
  const disposeAt = Date.now();
  await tracker.dispose();
  const disposeMs = Date.now() - disposeAt;
  assert.equal(cwdCalls, 5, "resolveCwd 调用数恰 5（每 session 惰性单查）");
  const rows = readFileSync(join(root, "details", `${DAY0}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 995, "995 条明细行全量落盘");
  assert.ok(rows.filter((r) => r.session === "s1").every((r) => r.dir === "scale"), "dir 落盘值逐行正确（抽查 s1 全量）");
  console.error(`[#633 A4 量级基线] 1000 事件/5 session：start=${startMs}ms dispose=${disposeMs}ms（resolveCwd=5，995 行落盘）；取数时点 ${new Date().toISOString()} node ${process.version}`);
}

assert.equal(sumToken(null, 5), 5, "sumToken null+数字");
assert.equal(sumToken(null, null), null, "sumToken null+null");
console.log("unit-trend: all assertions passed");