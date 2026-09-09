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
 * - 复核 M1（#633）：混存分片重启重建 dirDays 恢复（dir 行真读回）/ 自愈压实
 *   dir 行 pending 同源折算不丢 / pruneDays 联动删除 dirDays
 * - 复核 P1-1（#633）：dirDays 单源化——过去日不随 dropPending 删除（跨天柱
 *   不失）/ rebuild 明细计数行平行折算（同日重启续 apply 双算防线）/ correct
 *   校正双面同步（dirDays 与 cells 不漂移）
 * - config：trendRetentionDays 归一化
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "../../helpers.ts";
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
  mergeHourRows,
  metricValue,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  TREND_DONE_MAX,
  isValidShardRow,
  sanitizeDirName,
  normalizeConfig,
  DEFAULT_CONFIG,
} from "../../../lib/index.js";

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
// 不变量1：身份快照（event 归属折叠正确）——request/header 折叠为 per-session 归属主源，
// usage chunk 定稿按当前折叠归属出账（R8 四不变量归组；台账守恒见 layer-architecture.md §2 E2）。

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
// 不变量2：防双计（同 fold 键不重复记账、压实不二次累加）——同调用重复 usage 只校正 token、不重计调用。

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
// 不变量2：防双计——retry 复用同一 (turn,step)，新 header 边界后逐次独立入账（重试消耗不合并、不丢）。

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
// 不变量2：防双计——未定稿 message 补记、已定稿仅校正不重记；零 usage 调用照计（token 记 null 非 0）。

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
// 不变量1+3：身份快照与残差归未识别——归属缺失显式入 TREND_UNIDENTIFIED 桶（不静默丢弃）；
// message.source 副源仅缺失时补齐、不一致告警不覆盖主源（主源权威）。

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
// 不变量2：防双计——turn/end 只丢未定稿缓冲，定稿记忆保留（同 turn 乱序迟到 message 不双算）；
// turn/tool 计数独立 +1（与调用计数互不干扰）。

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
// 不变量2：防双计——fold/会话 TTL 回收后迟到 message 仍经 done 定稿记忆走校正路径（不双算）。

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
// 不变量2：防双计——apply 实时累加 cells，压实只做「落盘形态转换」绝不二次累加；
// 重建时 agg 分片权威 + 明细/计数行二选一来源（不双算）。null 语义：null 不参与求和。

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
  const rolled = agg.rollupDay(DAY0, DAY0);
  const aggRows = rolled.filter((r) => r.kind === "agg");
  assert.equal(JSON.stringify(agg.buckets()), before, "压实只转落盘形态，cells 不动（不双算）");
  assert.equal(agg.pendingDays().length, 0, "压实后 pending 清空");
  assert.equal(aggRows.length, 1, "同 (provider,model) 折叠为一行");
  const row = aggRows[0];
  assert.equal(row.calls, 2, "聚合 calls");
  assert.equal(row.turns, 1, "聚合 turns");
  assert.equal(row.toolCalls, 2, "聚合 toolCalls");
  assert.equal(row.input, 30, "聚合 input 求和");
  assert.equal(row.v, TREND_ROW_VERSION, "聚合行带 schema 版本");
  // #662：rollupDay 同源产出 hour 行（T0=12:00 → hour12、T0+HOUR=13:00 → hour13）
  const hourRows = rolled.filter((r) => r.kind === "hour");
  assert.equal(hourRows.length, 2, "rollupDay 产出 hour 行（同源折算）");
  assert.equal(hourRows[0].hour, 12, "hour12 档（T0 本地 12:00）");
  assert.equal(hourRows[1].hour, 13, "hour13 档（T0+1h 本地 13:00）");
  assert.equal(hourRows[0].calls, 1, "hour12 calls 独立");
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
// 不变量2：防双计——启动重建（聚合权威）/ 当日明细防二次落盘 / 自愈压实 / 迟到旧日行合并防覆盖丢数。

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
  const aggRow = readFileSync(join(root, "agg", `${day0}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "agg").at(-1);
  assert.equal(aggRow.calls, 2, "迟到旧日行合并进聚合分片（calls=1+1）");
  assert.equal(aggRow.input, 107, "token 合并 100+7");
  // #662：混存分片尾行是 hour 行（写入约定 agg→dir→hour），末行断言须按 kind 定位
  const lastLine = JSON.parse(readFileSync(join(root, "agg", `${day0}.jsonl`), "utf8").trimEnd().split("\n").at(-1));
  assert.equal(lastLine.kind, "hour", "聚合分片尾行 = hour 行（混存写入顺序约定）");
  assert.equal(lastLine.calls, 1, "迟到行 hour13（T0+HOUR）独立档");

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
// 不变量2：防双计——message 补记定稿后对称重置 headerSeen（迟到 usage 不被误判为新调用双算）。

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
// 不变量2：防双计——done 定稿记忆（retry 记忆 + TREND_DONE_MAX 淘汰）防乱序迟到 message 双算。

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
// 不变量1：身份快照——主源在场且与副源不一致时仅告警不覆盖（主源 header 是记账归属权威）。

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
// 不变量1+3：身份快照 / 残差归未识别——dir 归属经 resolveCwd 惰性单查、sanitizeDirName 净化落盘；
// store 无 session / cwd 缺失 / 抛错显式归 TREND_UNIDENTIFIED 桶（不静默丢弃、不重复查询）。

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
  // 净化后的 basename（数据层即存净化值，B1 可区分性约定）；POSIX '/' 与
  // Windows '\' 分隔符同取（复核闸 P1：反斜杠路径整串落盘即泄漏绝对路径）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-dir-sanitize-"));
  let flip = 0;
  const tracker = await TrendTracker.start({
    root,
    now: () => T0,
    flushDebounceMs: 60000,
    resolveCwd: () => ["/home/u/my proj/v2/", "C:\\Users\\alice\\repo", "D:\\work\\my app\\", "/mixed/slash\\back"][flip++ % 4],
  });
  // 四个会话各一次定稿调用 + turn/end（覆盖 POSIX 尾斜杠 / Windows 反斜杠 / Windows 尾反斜杠 / 混合分隔符）
  for (let s = 1; s <= 4; s += 1) {
    tracker.handleEvent({ id: `s${s}` }, ev("request/header", HEADER(), T0, s * 3 - 2));
    tracker.handleEvent({ id: `s${s}` }, ev("assistant/chunk", USAGE(10, 5), T0, s * 3 - 1));
    tracker.handleEvent({ id: `s${s}` }, ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, s * 3));
  }
  await tracker.flushNow();
  const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  const dirOf = (sid) => rows.find((r) => r.kind === "detail" && r.session === sid).dir;
  assert.equal(dirOf("s1"), "v2", "POSIX 尾斜杠 → basename（末段）");
  assert.equal(dirOf("s2"), "repo", "Windows 反斜杠路径 → basename（复核闸 P1：整串落盘即绝对路径泄漏）");
  assert.equal(dirOf("s3"), "my app", "Windows 尾反斜杠 → basename（前段）");
  assert.equal(dirOf("s4"), "back", "混合分隔符取最深一段（lastIndexOf 两系较大者）");
  const counters = rows.filter((r) => r.kind === "counter");
  assert.ok(counters.length === 4 && counters.every((r) => !r.dir.includes("\\") && !r.dir.includes("/")), "counter 行 dir 同口径：四例全 basename 化，无任何分隔符残留");
  await tracker.dispose();
  // 纯函数面直测（复核闸 P1 锁定 sanitizeDirName 本体语义）
  assert.equal(sanitizeDirName("C:\\Users\\bob\\proj"), "proj", "sanitizeDirName: Windows 反斜杠 basename");
  assert.equal(sanitizeDirName("C:\\"), null, "sanitizeDirName: 盘符根路径 → null（未识别）");
  assert.equal(sanitizeDirName("\\\\server\\share\\notes"), "notes", "sanitizeDirName: UNC 形态取末段");
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
// 不变量3+4：残差归未识别 / 台账守恒边界——旧格式（无 dir 键）行只进 cells（agg 面）、
// 不补造 dir 行；其目录事实由「每日残差归未识别」投影承担（目录面守恒以有 dir 事实为界）。

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
// 不变量2：防双计——dir 维度平行累加（同 record 不二次 emit）；rebuild 时 dir 行只进
// dirDays、不进 cells（防双计）、不进 pending（不二次落盘）。

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
    ["agg", "dir", "dir", "dir", "hour"],
    "混存分片：agg 行在前、dir 行居中、hour 行在后（#662 写入顺序约定）",
  );
  assert.deepEqual(
    shard.filter((r) => r.kind === "hour"),
    [
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 12, input: 22, output: 17, cacheRead: 0, cacheWrite: 0, calls: 4, turns: 1, toolCalls: 0 },
    ],
    "混存分片 hour 行：同在 12:00 的 4 次调用折叠为 hour12（input 10+7+3+2）",
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
  const rows = agg.rollupDay(DAY0, DAY0);
  assert.deepEqual(
    rows.filter((r) => r.kind === "agg" || r.kind === "dir"),
    [
      { v: TREND_ROW_VERSION, kind: "agg", day: DAY0, provider: "deepseek", model: "chat", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, calls: 2, turns: 1, toolCalls: 2 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "proj", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, calls: 2, turns: 1, toolCalls: 2 },
    ],
    "rollupDay 产物 agg+dir 行逐字段 deepEqual（null token 不污染、calls 独立累计）",
  );
  // #662：同源 hour 行——T0(12:00)→hour12 合并两次调用（含 null token 行 calls 独立计数、
  // token 记 null）；T0+HOUR(13:00)→hour13 单行
  assert.deepEqual(
    rows.filter((r) => r.kind === "hour"),
    [
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 12, input: 100, output: 50, cacheRead: 10, cacheWrite: 5, calls: 1, turns: 1, toolCalls: 2 },
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 13, input: null, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    ],
    "rollupDay 同源 hour 行（null token 行独立计入 calls、token 记 null）",
  );
  assert.deepEqual(agg.rollupDay(DAY0, DAY0), [], "消费后二次 rollup 不重复产出（pending/dir/hour 素材同源消费）");
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
    ["agg", "dir", "dir", "hour"],
    "首次压实混存形态（agg→dir→hour）",
  );
  assert.deepEqual(
    round1.filter((r) => r.kind === "hour"),
    [
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 12, input: 17, output: 12, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 1, toolCalls: 1 },
    ],
    "首次压实 hour 行：同在 12:00 的计数并入 hour12",
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
    ["agg", "dir", "dir", "hour", "hour"],
    "二次压实：既有 agg/dir/hour 行不抹掉，迟到行折出新 hour 档并入尾段",
  );
  assert.deepEqual(
    round2.filter((r) => r.kind === "hour"),
    [
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 12, input: 17, output: 12, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 1, toolCalls: 1 },
      { v: TREND_ROW_VERSION, kind: "hour", day: DAY0, hour: 13, input: 3, output: 3, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
    ],
    "迟到行（13:00）折为新 hour13 档（hour12 既有行不受连坐）",
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
    ["agg", "dir", "dir", "hour", "hour"],
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

{
  // M1(a)：复核 M1 修复——混存分片（agg+dir）重启重建后内存 dirDays 恢复：
  // rebuildFromDisk 走 readAggDayShard 真读回 dir 行（经 rebuild dir 分支进
  // dirDays，该分支由死分支变可达）；dir 行不进 cells/pending（防双计语义不变）。
  // dirDays 当前无查询面消费，恢复断言走白盒（tracker.aggregator.dirDays）+
  // cells 行为面锚定（读回不双算）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-m1-rebuild-"));
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
  await tracker.flushNow(); // 压实：agg+dir 混存落盘、明细分片删除
  await tracker.dispose();
  tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, resolveCwd: () => undefined });
  const dirMap = tracker.aggregator.dirDays.get(DAY0);
  assert.ok(dirMap, "重启重建：dirDays 恢复该日目录桶（M1 修复前恒空）");
  assert.deepEqual(
    [...dirMap.entries()].map(([dir, c]) => ({ dir, input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, calls: c.calls, turns: c.turns, toolCalls: c.toolCalls })),
    [
      { dir: "alpha", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 1, toolCalls: 0 },
      { dir: "beta", input: 7, output: 7, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 1 },
    ],
    "dirDays 恢复值与分片 dir 行逐字段一致（读回不丢不变形）",
  );
  const cell = tracker.buckets().find((d) => d.day === DAY0).providers[0].cell;
  assert.deepEqual(
    { input: cell.input, output: cell.output, calls: cell.calls, turns: cell.turns, toolCalls: cell.toolCalls },
    { input: 17, output: 12, calls: 2, turns: 1, toolCalls: 1 },
    "dir 行读回不双算进 cells（agg 行权威，calls=2 而非 4）",
  );
  assert.equal(tracker.aggregator.stats().pendingRows, 0, "dir 行不进 pending（不二次落盘）");
  await tracker.dispose();
}

{
  // M1(b)：复核 M1 修复——自愈压实路径 dir 行为 + pruneDays 联动删除（P1-1 口径更新）。
  // 自愈：过去日明细（含 dir）无聚合分片 → start 重建 + rollupDay 压实；dir 折算
  // 同源走 pending 行（takeDirUnpersisted 不过滤 persisted），重建行折算不丢——
  // P1-1 后 rebuild 明细/计数分支平行折算进 dirDays（与 cells 同策略双面入账，
  // dirDays 为唯一事实源、dirRows 纯快照），自愈后内存查询面立即恢复该日目录
  // 行（修复前随 dropPending 消失，须重启读回）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-m1-heal-"));
  const day1 = "2026-09-03";
  const detDir = join(root, "details");
  mkdirSync(detDir, { recursive: true });
  writeFileSync(join(detDir, `${day1}.jsonl`), [
    JSON.stringify({ v: 1, kind: "detail", time: T0 - 24 * HOUR, day: day1, session: "sx", turn: 1, step: 1, retry: 1, provider: "p", model: "m", dir: "heal", input: 7, output: 3, cacheRead: null, cacheWrite: null, calls: 1 }),
    JSON.stringify({ v: 1, kind: "counter", time: T0 - 24 * HOUR, day: day1, session: "sx", provider: "p", model: "m", dir: "heal", turns: 1, toolCalls: 1 }),
    "",
  ].join("\n"));
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
  assert.deepEqual(
    (await new TrendStore({ root }).readAggDayShard(day1)).filter((r) => r.kind === "dir"),
    [{ v: TREND_ROW_VERSION, kind: "dir", day: day1, dir: "heal", input: 7, output: 3, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 1 }],
    "自愈压实：dir 行从 pending 重建行同源折算，calls/turns/toolCalls 不丢",
  );
  assert.deepEqual(
    tracker.aggregator.dirDays.get(day1)?.get("heal"),
    { input: 7, output: 3, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 1 },
    "rebuild 明细/计数行平行折算进 dirDays（P1-1：过去日桶保留，与分片 dir 行值一致不重）",
  );
  assert.deepEqual(
    tracker.dirRows().filter((r) => r.day === day1),
    [{ v: TREND_ROW_VERSION, kind: "dir", day: day1, dir: "heal", input: 7, output: 3, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 1 }],
    "自愈后目录查询面立即恢复（不随 dropPending 消失，修复前须重启读回）",
  );
  assert.equal(tracker.buckets().find((d) => d.day === day1).providers[0].cell.calls, 1, "自愈重建 cells 行为不变");
  await tracker.dispose();

  // pruneDays 联动（单元面）：dirDays 与 days 同生命周期，cutoff 前日桶同步删除
  // （M1 修复前只删 days，dirDays 泄漏有界但违背同生命周期口径）。
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      { v: 1, kind: "agg", day: day1, provider: "p", model: "m", input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
      { v: 1, kind: "dir", day: day1, dir: "stale", input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
      { v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 2, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
      { v: 1, kind: "dir", day: DAY0, dir: "keep", input: 2, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    ],
    false,
  );
  assert.equal(agg.pruneDays(DAY0), 1, "pruneDays 返回 days 侧删除日数（语义不变）");
  assert.equal(agg.days.has(day1), false, "pruneDays：cutoff 前 days 日桶删除");
  assert.equal(agg.dirDays.has(day1), false, "pruneDays：dirDays 联动删除（与 dropPending 对称）");
  assert.equal(agg.dirDays.get(DAY0)?.get("keep")?.input, 2, "cutoff 内 dirDays 日桶不受连坐");
}

// ---------------------------------------------------------------- #662 hour 维度（day×hour 聚合行数据链路）
// 不变量2：防双计——小时面与 agg/dir 同一批事实的第三个投影（同源折算，不二次累加）。

{
  // #662(a)：apply 平行累加 hourDays（hourOfDay 本地时区现算）+ rollupDay 同源产出
  // hour 行（与 agg/dir 同一批事实，天然不双算）
  const agg = new TrendAggregator();
  const t9 = new Date(2026, 8, 4, 9, 30, 0).getTime(); // 本地 09:30 → hour 9
  const t21 = new Date(2026, 8, 4, 21, 0, 0).getTime(); // 本地 21:00 → hour 21
  agg.apply({ type: "call", record: { time: t9, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: t9 + 60000, session: "s2", turn: 1, step: 1, retry: 1, provider: "p", model: "m", tokens: { input: 20, output: 10, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "call", record: { time: t21, session: "s3", turn: 1, step: 1, retry: 1, provider: "p", model: "m", tokens: { input: 5, output: 5, cacheRead: null, cacheWrite: null } } });
  // 内存小时面（apply 平行累加，未压实亦可见）
  const rows = agg.hourRows();
  assert.equal(rows.length, 2, "hourRows 按 (day,hour) 折叠：9 点与 21 点两行");
  const h9 = rows.find((r) => r.hour === 9);
  assert.equal(h9.calls, 2, "hour9 calls 跨会话合并");
  assert.equal(h9.input, 120, "hour9 input 合并（100+20）");
  assert.equal(h9.output, 60, "hour9 output 合并（50+10）");
  const h21 = rows.find((r) => r.hour === 21);
  assert.equal(h21.input, 5, "hour21 input 独立");
  // rollupDay 同源产出三组（agg + dir + hour），hour 行与内存 hourRows 同值
  const rolled = agg.rollupDay(DAY0, DAY0);
  const rolledHours = rolled.filter((r) => r.kind === "hour");
  assert.equal(rolledHours.length, 2, "rollupDay 产出 hour 行（同源折算）");
  assert.deepEqual(JSON.parse(JSON.stringify(rolledHours)), JSON.parse(JSON.stringify(rows)), "压实 hour 行 = 内存 hourRows（同源单源，无重无漏）");
  assert.equal(agg.hourRows().length, 2, "压实消费不删 hourDays（与 dirDays 同生命周期，跨天历史保留）");
}

{
  // #662(b)：rebuild 双分支——hour 行直接入桶（信落盘字段）；当日 detail/counter 行
  // 折算入桶（hourOfDay 现算，与 apply 同源）
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      { v: 1, kind: "hour", day: DAY0, hour: 9, input: 100, output: 50, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 0 },
      { v: 1, kind: "detail", time: new Date(2026, 8, 4, 21, 0, 0).getTime(), day: DAY0, session: "s9", turn: 9, step: 1, retry: 1, provider: "p", model: "m", input: 7, output: 7, cacheRead: null, cacheWrite: null, calls: 1 },
      { v: 1, kind: "counter", time: new Date(2026, 8, 4, 21, 0, 0).getTime(), day: DAY0, session: "s9", provider: "p", model: "m", turns: 1, toolCalls: 2 },
    ],
    true,
  );
  const rows = agg.hourRows();
  const h9 = rows.find((r) => r.hour === 9);
  assert.equal(h9.calls, 2, "hour 行 rebuild 直接入桶（信落盘 hour 字段，不重算）");
  const h21 = rows.find((r) => r.hour === 21);
  assert.equal(h21.calls, 1, "detail/counter 行 rebuild 折算进小时桶");
  assert.equal(h21.input, 7, "detail 行 token 折算进小时桶");
  assert.equal(h21.turns, 1, "counter 行 turns 折算进小时桶");
  assert.equal(h21.toolCalls, 2, "counter 行 toolCalls 折算进小时桶");
}

{
  // #662(c)：mergeHourRows 纯函数——同 hour 键累加（null-aware）、异 hour 独立、保序
  const base = [
    { v: 1, kind: "hour", day: DAY0, hour: 9, input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
  ];
  const add = [
    { v: 1, kind: "hour", day: DAY0, hour: 9, input: 50, output: 20, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 1 },
    { v: 1, kind: "hour", day: DAY0, hour: 21, input: 7, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
  ];
  const merged = mergeHourRows(base, add);
  assert.equal(merged.length, 2, "同 hour 键合并、异 hour 独立");
  const h9 = merged.find((r) => r.hour === 9);
  assert.equal(h9.input, 150, "mergeHourRows 同键 input 累加（100+50）");
  assert.equal(h9.output, 20, "null-aware：null 不污染数字");
  assert.equal(h9.calls, 3, "同键 calls 累加");
  assert.equal(merged[0].hour, 9, "保序：base 在前");
}

{
  // #662(d)：applyCorrect 第三面——修正明细 token 同步回退/累加小时桶（防小时面漂移）
  const agg = new TrendAggregator();
  const t9 = new Date(2026, 8, 4, 9, 30, 0).getTime();
  agg.apply({ type: "call", record: { time: t9, session: "s1", turn: 1, step: 1, retry: 1, provider: "p", model: "m", tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null } } });
  agg.apply({ type: "correct", record: { time: t9 + 1000, session: "s1", turn: 1, step: 1, retry: 1, tokens: { input: 200, output: 50, cacheRead: null, cacheWrite: null } } });
  const h9 = agg.hourRows().find((r) => r.hour === 9);
  assert.equal(h9.input, 200, "applyCorrect 后小时桶同步为校正值（回退 100 → 累加 200）");
  assert.equal(agg.buckets()[0].providers[0].cell.input, 200, "cells 同步校正（对照面）");
}

{
  // #662(e)：pruneDays 联动删除 hourDays（与 days/dirDays 同生命周期）
  const day1 = "2026-09-03";
  const agg = new TrendAggregator();
  agg.rebuild(
    [
      { v: 1, kind: "hour", day: day1, hour: 9, input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
      { v: 1, kind: "hour", day: DAY0, hour: 9, input: 2, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    ],
    false,
  );
  assert.equal(agg.hourRows().length, 2, "hourDays 重建后两日可见");
  agg.pruneDays(DAY0);
  const rows = agg.hourRows();
  assert.equal(rows.length, 1, "pruneDays：cutoff 前 hourDays 联动删除");
  assert.equal(rows[0].day, DAY0, "cutoff 内 hour 日桶不受连坐");
}

{
  // #662(f)：store 白名单——聚合分片写读 hour 行 round-trip（readAggDayShard 白名单
  // 漏加 hour → 重启重建后小时数据静默全丢，P0）+ isValidShardRow 校验
  const root = mkdtempSync(join(tmpdir(), "dou-trend-hour-store-"));
  const store = new TrendStore({ root });
  const aggRow = { v: 1, kind: "agg", day: DAY0, provider: "p", model: "m", input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 0 };
  const hourRow = { v: 1, kind: "hour", day: DAY0, hour: 9, input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 1, toolCalls: 0 };
  await store.writeAggDay(DAY0, [aggRow, hourRow]);
  const back = await store.readAggDayShard(DAY0);
  assert.equal(back.filter((r) => r.kind === "hour").length, 1, "readAggDayShard 白名单含 hour 行（漏改会静默丢）");
  assert.equal(back.filter((r) => r.kind === "agg").length, 1, "agg 行照常");
  assert.equal(isValidShardRow(aggRow), true, "isValidShardRow 认可 agg 行");
  assert.equal(isValidShardRow(hourRow), true, "isValidShardRow 认可 hour 行");
  assert.equal(isValidShardRow({ ...hourRow, hour: 24 }), false, "hour=24 越界拒绝");
  assert.equal(isValidShardRow({ ...hourRow, hour: -1 }), false, "hour=-1 越界拒绝");
  assert.equal(isValidShardRow({ ...hourRow, hour: 9.5 }), false, "hour 非整数拒绝");
  // prune 语义：删除 cutoff 日（不含）之前的分片——day1(<DAY0) 整日删除、DAY0 保留
  const day1 = "2026-09-03";
  await store.writeAggDay(day1, [aggRow, hourRow]);
  await store.prune(DAY0);
  assert.equal((await store.readAggDayShard(day1)).length, 0, "prune 后 cutoff 前聚合分片（含 hour 行）删除");
  assert.equal((await store.readAggDayShard(DAY0)).length, 2, "cutoff 当日分片（agg+hour）保留");
}

{
  // 复核 P1-1(a)：常驻运行期跨天——Day0 写入并压实（flushInner 日切）→ 不重启
  // 继续 Day1 apply → byDir 面（dirStacked）Day0 柱非 null 且数值正确。
  // 修复前：dropPending 联动删除过去日 dirDays，dirRows 纯内存无分片回读 →
  // Day0 柱恒 null（实测空柱）；修复后 dirDays 只随 pruneDays 收缩。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-p11-crossday-"));
  let nowMs = T0;
  const tracker = await TrendTracker.start({
    root,
    now: () => nowMs,
    flushDebounceMs: 60000,
    resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
  });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 3));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 4));
  nowMs = T0 + 24 * HOUR; // Day1 日切
  await tracker.flushNow(); // Day0 压实（修复前此处联动删除 dirDays[Day0]）
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), nowMs, 5));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(3, 3), nowMs, 6));
  assert.deepEqual(
    tracker.dirRows().filter((r) => r.day === DAY0),
    [
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "alpha", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "beta", input: 7, output: 7, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
    ],
    "跨天不重启：压实后 Day0 目录行保留（修复前恒空）",
  );
  const stacked = tracker.dirStacked(2, "day", "input", undefined, nowMs);
  assert.deepEqual(
    stacked.series.find((p) => p.key === DAY0),
    { key: DAY0, parts: [{ provider: "alpha", model: null, value: 10 }, { provider: "beta", model: null, value: 7 }], total: 17 },
    "byDir 面 Day0 柱非 null：alpha=10/beta=7 按 dir 拆段",
  );
  assert.deepEqual(
    stacked.series.find((p) => p.key === dayKey(nowMs))?.parts,
    [{ provider: "alpha", model: null, value: 3 }],
    "Day1 当日柱照常（跨天压实不波及当日目录桶）",
  );
  await tracker.dispose();
}

{
  // 复核 P1-1(b)：重启恢复后同日继续 apply——dirRows()/dirStacked 当日数值 =
  // 真实值（重启前 10 + 重启后 7 = 17，非 2× 非丢数）。
  // 修复前：重启后当日重建明细行（persisted=true）与 dirDays（apply 事实）并存
  // 两个事实源，折算侧 seen 按键去重只挡同键——互补事实被挡掉（实测 dirRows=7
  // 丢重启前 10），同事实并存则 2×。P1-1 后 rebuild 明细行平行折算进 dirDays、
  // dirRows 纯快照单源，结构性无重无漏。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-p11-sameday-"));
  const nowMs = T0; // 当日（detail 分片 day === today，不走自愈压实）
  let tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, resolveCwd: () => "/w/alpha" });
  tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
  tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
  await tracker.flushNow(); // 当日明细落盘（persisted=true，pending 保留）
  await tracker.dispose();
  tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, resolveCwd: () => "/w/alpha" });
  // 重启后：当日无聚合分片 → dirDays 该日为空，重建明细行的 dir 事实在 rebuild
  // 时折算入桶；同日续 apply 在同桶上平行累加（单源相加 = 真实值）。
  tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0 + HOUR, 3));
  tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0 + HOUR, 4));
  assert.deepEqual(
    tracker.dirRows(),
    [{ v: TREND_ROW_VERSION, kind: "dir", day: DAY0, dir: "alpha", input: 17, output: 12, cacheRead: 0, cacheWrite: 0, calls: 2, turns: 0, toolCalls: 0 }],
    "同日重启+续 apply：dirRows 当日 = 真实值 17（非 2× 非丢数）",
  );
  assert.equal(tracker.dirStacked(1, "day", "input", undefined, nowMs).series[0].total, 17, "dirStacked 当日 total=17（双算防线下真实值）");
  await tracker.dispose();
}

{
  // 复核 P1-1(c)：correct 校正双面同步——dirDays 随 retokenCell 修正，目录查询
  // 面与 cells/落盘明细一致（旧实现只修 cells、靠折算侧取 pending 新值掩盖漂移，
  // 单源化后不同步即固化错值）。
  const agg = new TrendAggregator();
  agg.apply({ type: "call", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "chat", dir: "proj", tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } });
  agg.apply({ type: "correct", record: { time: T0, session: "s1", turn: 1, step: 1, retry: 1, tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 } } });
  const cell = cellTotals(agg, DAY0);
  assert.deepEqual({ input: cell.input, output: cell.output }, { input: 200, output: 60 }, "correct：cells 修正（既有语义零回归）");
  assert.deepEqual(
    agg.dirDays.get(DAY0)?.get("proj"),
    { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, calls: 1, turns: 0, toolCalls: 0 },
    "correct：dirDays 同步修正（目录查询面不漂移）",
  );
}

// ---------------------------------------------------------------- #654 压实快照消费
// 不变量2：防双计——折算与消费取同一份身份快照（await 间隙新到行不连带删除、不丢行不重算）。

{
  // 单元级：rollupSnapshot 的 consumed 与折算行严格同源；consume 只删快照内 entry。
  const agg = new TrendAggregator();
  const past = T0 - 24 * HOUR;
  const pastDay = dayKey(past);
  const call = (session, input, output) => ({
    type: "call",
    record: { time: past, session, turn: 1, step: 1, retry: 1, provider: "p", model: "m", dir: "d", tokens: { input, output, cacheRead: 0, cacheWrite: 0 } },
  });
  agg.apply(call("sA", 10, 5));
  const snap = agg.rollupSnapshot(pastDay);
  assert.equal(snap.consumed.length, 1, "快照含先到行");
  assert.deepEqual(snap.aggRows.map((r) => ({ calls: r.calls, input: r.input })), [{ calls: 1, input: 10 }], "折算行只含先到行（同源）");
  // 模拟压实 await 窗口内到达的同日行
  agg.apply(call("sB", 7, 7));
  agg.consume(snap.consumed);
  assert.equal(agg.stats().pendingRows, 1, "consume 只消费快照内 entry，迟到行保留");
  assert.equal(agg.stats().unpersistedRows, 1, "迟到行仍未落盘（留待下一轮）");
  const snap2 = agg.rollupSnapshot(pastDay);
  assert.equal(snap2.consumed.length, 1, "二次快照含迟到行");
  assert.deepEqual(snap2.aggRows.map((r) => ({ calls: r.calls, input: r.input })), [{ calls: 1, input: 7 }], "二次折算只含迟到行（不重复折算已消费行）");
  agg.consume(snap2.consumed);
  assert.equal(agg.stats().pendingRows, 0, "二次消费后排空");
  // 边界：空数组 no-op、重复 entry 幂等
  agg.consume([]);
  agg.consume([{ row: { kind: "detail" }, persisted: true }]);
  assert.equal(agg.stats().pendingRows, 0, "空/异物 entry 消费安全（幂等 no-op）");
}

{
  // 集成级（#654 竞态）：压实 await 窗口内到达的过去日行不得被连带消费。
  // 用 gate 卡住 readAggDayShard 的返回，把「迟到行」精确插入 await 窗口内；
  // 等待用 setImmediate 轮询（不是固定 sleep），符合防 flake 纪律。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-654-"));
  const nowMs = T0; // 当日 09-04，迟到行落 09-03（时钟回拨形态）
  const pastDay = dayKey(T0 - 24 * HOUR);
  const tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, warn: () => {} });
  const store = tracker.store;
  const origReadAggDayShard = store.readAggDayShard.bind(store);
  let release;
  const gate = new Promise((r) => { release = r; });
  let gateHit = false;
  store.readAggDayShard = async (day) => {
    const rows = await origReadAggDayShard(day);
    if (day === pastDay && !gateHit) {
      gateHit = true;
      await gate;
    }
    return rows;
  };

  tracker.handleEvent({ id: "sA" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 1));
  tracker.handleEvent({ id: "sA" }, ev("assistant/chunk", USAGE(10, 5), T0 - 24 * HOUR, 2));

  const flushing = tracker.flushNow();
  for (let i = 0; i < 2000 && !gateHit; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(gateHit, true, "压实已进入 readAggDayShard await 窗口");

  // await 窗口内到达的迟到行（同过去日、未落盘）
  tracker.handleEvent({ id: "sB" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 3));
  tracker.handleEvent({ id: "sB" }, ev("assistant/chunk", USAGE(7, 7), T0 - 24 * HOUR, 4));
  release();
  await flushing;

  assert.equal(tracker.stats().pendingRows, 1, "迟到行保留在 pending（修复前 dropPending 按日键连带删除 → 0）");

  // 下一轮 flush：迟到行落盘 → 压实 → 两行都进 agg 分片（端到端无丢行）
  await tracker.flushNow();
  const aggRows = (await store.readAggDayShard(pastDay)).filter((r) => r.kind === "agg");
  assert.equal(aggRows.length, 1, "同 (provider,model) 折叠为一行");
  assert.deepEqual(
    { calls: aggRows[0].calls, input: aggRows[0].input, output: aggRows[0].output },
    { calls: 2, input: 17, output: 12 },
    "先到行 + 迟到行都入账（calls=2 / input=17）",
  );
  assert.equal(tracker.stats().pendingRows, 0, "二次压实后 pending 排空");
  await tracker.dispose();
}

{
  // #654 同域：deleteDetailShard 失败不得导致下一轮磁盘双算。
  // 消费提前到删除之前——聚合事实落盘即消费，残留明细分片留待重启的「聚合权威」自愈。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-654-del-"));
  const nowMs = T0;
  const pastDay = dayKey(T0 - 24 * HOUR);
  const tracker = await TrendTracker.start({ root, now: () => nowMs, flushDebounceMs: 60000, warn: () => {} });
  const store = tracker.store;
  const origDelete = store.deleteDetailShard.bind(store);
  tracker.handleEvent({ id: "sA" }, ev("request/header", HEADER(), T0 - 24 * HOUR, 1));
  tracker.handleEvent({ id: "sA" }, ev("assistant/chunk", USAGE(10, 5), T0 - 24 * HOUR, 2));
  store.deleteDetailShard = async () => { throw new Error("EACCES simulated"); }; // 删除失败，其余步骤成功
  await tracker.flushNow();
  assert.equal(tracker.stats().pendingRows, 0, "聚合事实落盘后即消费（不等待删除成功）");
  store.deleteDetailShard = origDelete;
  await tracker.flushNow();
  const aggRows = (await store.readAggDayShard(pastDay)).filter((r) => r.kind === "agg");
  assert.deepEqual(
    aggRows.map((r) => ({ calls: r.calls, input: r.input })),
    [{ calls: 1, input: 10 }],
    "二次 flush 不双算（消费在删除之前 → 磁盘与内存一致）",
  );
  await tracker.dispose();
}

// ---------------------------------------------------------------- #655 fold 清理后重复记账
// 不变量2：防双计——fold 被 TTL 清理后迟到 usage 只校正不重记（done 记忆取真实 retry）。

{
  // fold 被 fold TTL 清理后，同一 fold 键的迟到 usage 不得重复记账（与 onMessage 对称）。
  // 真实数据形态：同一 (session,turn,step) 的 usage 间隔 13~19 分钟陆续到达，
  // token 从 0/0 递增到真实值——修复前每次 fold 重建都多记一次 call。
  let nowT = new Date(2026, 8, 8, 4, 22, 7).getTime();
  const { emitted, send } = makeCollector(() => nowT);
  const U = (input, output) => ev("assistant/chunk", { turn: 1, step: 9, chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output } } }, nowT, 1);
  send("s1", ev("request/header", HEADER("commandcode", "z-ai/glm-5.3-flash"), nowT, 0));
  send("s1", U(0, 0));
  nowT += 13 * 60_000; send("s1", U(0, 0));
  nowT += 13 * 60_000; send("s1", U(0, 0));
  nowT += 12 * 60_000; send("s1", U(118593, 41240));
  assert.equal(callsOf(emitted).length, 1, "同一 fold 键只记一次调用（fold 被 TTL 清理后不重记）");
  const corrects = correctsOf(emitted);
  assert.equal(corrects.length, 3, "后续迟到 usage 走校正（不重记调用）");
  assert.deepEqual(
    corrects[2].tokens,
    { input: 118593, output: 41240, cacheRead: null, cacheWrite: null },
    "最后一次校正带真实 token（token 收敛到最新值）",
  );
}

{
  // 反例防线：fold 被清理后若出现新 header，同键 usage 仍按重试递增（不误判为重复块）。
  let nowT = T0;
  const { emitted, send } = makeCollector(() => nowT);
  const U = (input, output) => ev("assistant/chunk", { turn: 1, step: 9, chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output } } }, nowT, 1);
  send("s1", ev("request/header", HEADER(), nowT, 0));
  send("s1", U(10, 5));
  nowT += 13 * 60_000;
  send("s1", ev("request/header", HEADER(), nowT, 2)); // 重试边界：新 header
  send("s1", U(20, 6));
  const calls = callsOf(emitted);
  assert.equal(calls.length, 2, "新 header 后的同键 usage 记为新一次调用（重试）");
  assert.equal(calls[1].retry, 2, "retry 从定稿记忆递增为 2（不回落为 1 重号）");
}

assert.equal(sumToken(null, 5), 5, "sumToken null+数字");
assert.equal(sumToken(null, null), null, "sumToken null+null");

// ---------------------------------------------------------------- #633 修复：目录面残差投影
// 不变量3+4：残差归未识别 / 台账守恒——目录面 = dirDays 快照 + 每日残差（聚合面 − 目录面），
// 残差归 TREND_UNIDENTIFIED 桶；∀day 目录面日合计 == 聚合面日合计（本段断言 (e) 即该恒等的纯函数面）。
// 背景（实测）：分片 a/b 上线后目录维度全链路失效——(1) inject 缺 sessions 致
// resolveCwd 恒 undefined，所有会话归未识别桶；(2) 旧 agg 分片（无 kind:"dir" 行）
// 重建时目录面全空，历史柱消失（实测目录面/聚合面总量差 20 倍）。
// 修法：目录面 = dirDays 快照 + 每日残差（聚合面 − 目录面），残差归未识别桶；
// **禁止**在 rebuild 里对 agg 行补造（同一事实的 agg/dir 两个投影会双算）。

{
  // 残差投影纯函数面：cells（聚合面）与 dirDays（目录面）的关系决定是否补造。
  const day = "2026-09-03";
  const mkAgg = () => new TrendAggregator();
  const call = (dir, input, output) => ({ time: T0 - 24 * HOUR, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "deepseek-chat", dir, tokens: { input, output, cacheRead: null, cacheWrite: null } });
  const counter = (dir) => ({ time: T0 - 24 * HOUR, session: "s1", provider: "deepseek", model: "deepseek-chat", dir, turns: 1, toolCalls: 1 });

  // (a) 目录面已覆盖全量（apply 平行累加）→ 残差 0 → 不补造未识别行
  const a = mkAgg();
  a.apply({ type: "call", record: call("alpha", 100, 20) });
  a.apply({ type: "counter", record: counter("alpha") });
  assert.deepEqual(
    a.dirRows().map((r) => r.dir),
    ["alpha"],
    "残差为 0（目录面已含全量）→ 不补造未识别桶（不双算）",
  );

  // (b) 只有聚合面事实（旧格式 agg 行重建）→ 残差 = 全量 → 补造一条未识别行
  const b = mkAgg();
  b.rebuild([{ v: TREND_ROW_VERSION, kind: "agg", day, provider: "deepseek", model: "deepseek-chat", input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 }], false);
  const bRows = b.dirRows();
  assert.equal(bRows.length, 1, "旧格式 agg-only 日 → 恰补造一条残差行（历史不再消失）");
  assert.equal(bRows[0].dir, TREND_UNIDENTIFIED, "残差行归未识别桶（该日无目录信息）");
  assert.deepEqual(
    { input: bRows[0].input, output: bRows[0].output, cacheRead: bRows[0].cacheRead, cacheWrite: bRows[0].cacheWrite, calls: bRows[0].calls, turns: bRows[0].turns, toolCalls: bRows[0].toolCalls },
    { input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 },
    "残差数值 = 聚合面全量（逐字段）",
  );

  // (c) 混版日（旧 agg 行 + 新 dir 行并存）→ 残差 = 旧 agg 部分，新 dir 行照常分目录
  const c = mkAgg();
  c.rebuild([
    { v: TREND_ROW_VERSION, kind: "agg", day, provider: "deepseek", model: "deepseek-chat", input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 },
    { v: TREND_ROW_VERSION, kind: "dir", day, dir: "alpha", input: 2000, output: 300, cacheRead: 0, cacheWrite: 0, calls: 10, turns: 4, toolCalls: 12 },
  ], false);
  assert.deepEqual(
    c.dirRows().map((r) => [r.dir, r.input, r.calls]).sort(),
    [["(unidentified)", 3000, 20], ["alpha", 2000, 10]],
    "混版日：残差 = agg − dir（归未识别），新 dir 行照常分目录，两者不重叠",
  );

  // (d) 只有目录面事实（无聚合面）→ 不补造（残差行只在聚合面 > 目录面时产生）
  const d = mkAgg();
  d.rebuild([{ v: TREND_ROW_VERSION, kind: "dir", day, dir: "alpha", input: 900, output: 90, cacheRead: 0, cacheWrite: 0, calls: 9, turns: 3, toolCalls: 9 }], false);
  assert.deepEqual(d.dirRows().map((r) => r.dir), ["alpha"], "仅目录面事实原样输出，不补造未识别行");

  // (e) 双面总量守恒（本修复的核心不变量）：∀day 目录面合计 == 聚合面合计
  for (const agg of [a, b, c]) {
    const byDay = new Map();
    for (const r of agg.dirRows()) {
      const cur = byDay.get(r.day) ?? { input: 0, calls: 0, turns: 0, toolCalls: 0 };
      cur.input += r.input ?? 0; cur.calls += r.calls; cur.turns += r.turns; cur.toolCalls += r.toolCalls;
      byDay.set(r.day, cur);
    }
    for (const bucket of agg.buckets()) {
      let pInput = 0; let pCalls = 0; let pTurns = 0; let pTool = 0;
      for (const p of bucket.providers) {
        pInput += p.cell.input ?? 0; pCalls += p.cell.calls; pTurns += p.cell.turns; pTool += p.cell.toolCalls;
      }
      const dir = byDay.get(bucket.day) ?? { input: 0, calls: 0, turns: 0, toolCalls: 0 };
      assert.deepEqual(
        { input: dir.input, calls: dir.calls, turns: dir.turns, toolCalls: dir.toolCalls },
        { input: pInput, calls: pCalls, turns: pTurns, toolCalls: pTool },
        `日总量守恒（${bucket.day}）：目录面 == 聚合面`,
      );
    }
  }

  // (f) 同键唯一：该日 dirDays 已有 (unidentified) 桶 + 残差 > 0（混版日）→ 合并为一行
  const f = mkAgg();
  f.rebuild([
    { v: TREND_ROW_VERSION, kind: "agg", day, provider: "deepseek", model: "deepseek-chat", input: 5000, output: 0, cacheRead: null, cacheWrite: null, calls: 30, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day, dir: TREND_UNIDENTIFIED, input: 100, output: 0, cacheRead: null, cacheWrite: null, calls: 10, turns: 0, toolCalls: 0 },
  ], false);
  const fRows = f.dirRows();
  assert.equal(fRows.length, 1, "同 (day, dir) 键唯一（残差并入既有未识别桶，不另起一行）");
  assert.deepEqual(
    [fRows[0].dir, fRows[0].input, fRows[0].calls],
    [TREND_UNIDENTIFIED, 5000, 30],
    "合并后数值 = 目录桶 + 残差（100+4900 / 10+20），无双行",
  );

  // (g) 负残差（目录面 > 聚合面，数据异常征兆）→ 不产行、不产生负值，恒等不成立
  const g = mkAgg();
  g.rebuild([
    { v: TREND_ROW_VERSION, kind: "agg", day, provider: "deepseek", model: "deepseek-chat", input: 100, output: 0, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day, dir: "alpha", input: 300, output: 0, cacheRead: null, cacheWrite: null, calls: 3, turns: 0, toolCalls: 0 },
  ], false);
  assert.deepEqual(
    g.dirRows().map((r) => [r.dir, r.input, r.calls]),
    [["alpha", 300, 3]],
    "负残差不补造行（按 0 处理）：目录面 300/3 > 聚合面 100/1，仅保留既有目录行",
  );

  // (h) 行序契约：时钟回拨把旧日事件落进过去日桶（cells 插入序乱）→ dirRows 仍按 day 升序
  const h = mkAgg();
  h.apply({ type: "call", record: { ...call("beta", 10, 0), time: new Date(2026, 8, 6, 12).getTime() } });
  h.apply({ type: "call", record: { ...call("alpha", 10, 0), time: new Date(2026, 8, 8, 12).getTime() } });
  h.apply({ type: "call", record: { ...call("gamma", 10, 0), time: new Date(2026, 8, 7, 12).getTime() } });
  assert.deepEqual(
    h.dirRows().map((r) => r.day),
    ["2026-09-06", "2026-09-07", "2026-09-08"],
    "行序契约：残差行按 day 升序（不依赖 cells 插入序）",
  );

  // (i) prune 后：被裁日的残差行同步消失（dirRows 不残留已裁剪日）
  const i = mkAgg();
  i.rebuild([
    { v: TREND_ROW_VERSION, kind: "agg", day: "2026-09-01", provider: "deepseek", model: "m", input: 1, output: 0, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "agg", day: "2026-09-03", provider: "deepseek", model: "m", input: 2, output: 0, cacheRead: null, cacheWrite: null, calls: 2, turns: 0, toolCalls: 0 },
  ], false);
  assert.equal(i.dirRows().length, 2, "prune 前两日残差行都在");
  i.pruneDays("2026-09-03");
  assert.deepEqual(i.dirRows().map((r) => r.day), ["2026-09-03"], "prune 后被裁日的残差行同步消失（无残留）");

  // (j) 校正后：旧格式（无 dir 键）明细行 correct → 残差吸收增量（dirRows 随之变化）
  const j = mkAgg();
  j.rebuild([{ v: TREND_ROW_VERSION, kind: "detail", time: T0 - 24 * HOUR, day, session: "s1", turn: 1, step: 1, retry: 1, provider: "deepseek", model: "deepseek-chat", input: 10, output: 0, cacheRead: null, cacheWrite: null, calls: 1 }], false);
  assert.equal(j.dirRows()[0].input, 10, "无 dir 键明细行 → 残差 = 10");
  j.apply({ type: "correct", record: { session: "s1", turn: 1, step: 1, retry: 1, tokens: { input: 50, output: 0, cacheRead: null, cacheWrite: null } } });
  assert.equal(j.dirRows()[0].input, 50, "correct 校正后残差同步为 50（无 dir 键行不进 dirDays，经残差反映）");
}

{
  // 真实升级场景端到端：旧 agg-only 过去日分片 → 重启后目录面恢复历史（此前全 null）。
  const root = mkdtempSync(join(tmpdir(), "dou-trend-residual-"));
  mkdirSync(join(root, "agg"), { recursive: true });
  writeFileSync(join(root, "agg", "2026-09-03.jsonl"), `${JSON.stringify(A2_LEGACY_AGG)}\n`);
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000, warn: () => {} });
  const rows = tracker.dirRows();
  assert.equal(rows.length, 1, "旧 agg-only 分片重启后目录面有行（不再全空）");
  assert.equal(rows[0].day, "2026-09-03", "残差行落回历史日（不是今日）");
  assert.equal(rows[0].dir, TREND_UNIDENTIFIED, "历史无目录信息 → 未识别桶");
  assert.equal(rows[0].calls, 30, "历史调用数恢复（= agg 行 calls）");
  // 分片不被改写（纯读侧投影，不落盘补造）
  assert.equal(
    readFileSync(join(root, "agg", "2026-09-03.jsonl"), "utf8"),
    `${JSON.stringify(A2_LEGACY_AGG)}\n`,
    "残差投影纯读侧：分片文件逐字节不变（不落盘补造、不改用户数据）",
  );
  // dirStacked（趋势面板数据源）历史柱不再为 null
  const stacked = tracker.dirStacked(7, "day", "total");
  const past = stacked.series.find((p) => p.key === "2026-09-03");
  assert.ok(past !== undefined && past.total === 5930, "目录面历史柱有值（5000+800+120+10 = 5930）");
  assert.deepEqual(stacked.dirs, [{ dir: TREND_UNIDENTIFIED }], "历史柱目录图例 = 未识别桶（无目录信息）");
  await tracker.dispose();
}

console.log("unit-trend: all assertions passed");
