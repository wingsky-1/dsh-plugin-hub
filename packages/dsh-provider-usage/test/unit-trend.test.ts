// @ts-nocheck
/**
 * dsh-provider-usage — unit：#503 会话用量趋势（M1 数据层）。
 *
 * 覆盖（方案定稿 v1.2 记账口径 + 两级聚合 + 分片存储 + tracker 组合）：
 * - collector：usage 定稿主信号 / text-delta 热路径不计 / 重复 usage 校正不重记 /
 *   retry 逐次计（新 header 边界）/ message 补记与校正 / interrupted /
 *   归属缺失入未识别桶 / message.source 副源 / turn-end 定稿记忆保留（防乱序双算）/
 *   turn 计数 / tool 计数 / 分级 TTL / 会话销毁清理
 * - aggregator：null 语义求和 / 日切压实（cells 不动）/ rebuild / mergeAggRows /
 *   日/周/月序列（周一锚点、月区间、空日 null、provider 过滤）/ 时钟回拨旧日落桶
 * - store：明细 roundtrip / 坏行跳过 / 聚合原子写 / prune
 * - tracker：启动重建（聚合权威）/ 过去日明细自愈 / 当日明细防二次落盘 /
 *   防抖刷盘 / dispose await 刷盘 / 日切压实与重启不双算 / 迟到旧日行合并防覆盖
 * - config：trendRetentionDays 归一化
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "./helpers.ts";
import {
  TrendCollector,
  TrendAggregator,
  TrendStore,
  TrendTracker,
  dayKey,
  sumToken,
  mergeAggRows,
  metricValue,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
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

// ---------------------------------------------------------------- store

{
  const root = mkdtempSync(join(tmpdir(), "dou-trend-store-"));
  const store = new TrendStore({ root });
  const rows = [
    { v: 1, kind: "detail", time: T0, day: DAY0, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", input: 1, output: 2, cacheRead: null, cacheWrite: null, calls: 1 },
    { v: 1, kind: "counter", time: T0, day: DAY0, session: "s1", provider: "p", model: "m", turns: 1, toolCalls: 0 },
  ];
  const ok = await store.appendRows(rows);
  assert.equal(ok, true, "appendRows 成功");
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

// ---------------------------------------------------------------- config

{
  assert.equal(normalizeConfig({}).trendRetentionDays, DEFAULT_CONFIG.trendRetentionDays, "trendRetentionDays 默认 180");
  assert.equal(normalizeConfig({ trendRetentionDays: 0 }).trendRetentionDays, 180, "非法（0）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: -3 }).trendRetentionDays, 180, "非法（负数）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: 1.5 }).trendRetentionDays, 180, "非法（非整数）回落默认");
  assert.equal(normalizeConfig({ trendRetentionDays: 99999 }).trendRetentionDays, 3650, "上界 3650");
  assert.equal(normalizeConfig({ trendRetentionDays: 30 }).trendRetentionDays, 30, "合法透传");
}

assert.equal(sumToken(null, 5), 5, "sumToken null+数字");
assert.equal(sumToken(null, null), null, "sumToken null+null");
console.log("unit-trend: all assertions passed");
