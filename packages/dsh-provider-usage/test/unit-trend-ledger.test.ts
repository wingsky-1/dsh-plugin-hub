// @ts-nocheck
/**
 * dsh-provider-usage — unit：R8 台账守恒（不变量4）事件回放式端到端对账（阶段三 #670）。
 *
 * 为什么要端到端回放（真缺口定位，layer-architecture.md §3 R8）：不变量 1/2/3（身份快照 /
 * 防双计 / 残差归未识别）已被 unit-trend.test.ts 分段覆盖；唯「台账守恒」从未被断言——
 * Σ事件 == buckets == agg == dirRows + unidentified 是 D2 aggregator 拆分的前置安全网
 * （拆分后若压实/折算逻辑漂移，本文件应第一时间红）。
 *
 * 对账口径（四视角，与 aggregator 记账语义一一对应）：
 * - a. Σ事件：emitted 中 call 事件数（correct 只覆盖 token 不新增调用计数）；token 按
 *   最终值求和——同一 fold 键 (session,turn,step,retry) 的 call 先入账、后续 correct
 *   覆盖为该键的最终 tokens（与 applyCorrect 的「回退旧值再累加新值」语义等价，
 *   因为正确路径下 correct 必命中 pending 内该键的最后一条 detail）。
 * - b. buckets：aggregator 内存聚合面（days 桶 cells 合计，buckets() 公开查询面）。
 * - c. agg：rollupSnapshot(day).aggRows 合计——压实折算只做「落盘形态转换」，
 *   与 cells 同源（apply 已累加，折算不二次累加）。
 * - d. dirRows + unidentified：rollupSnapshot(day).dirRows 合计（pending 中带 dir 键的
 *   事实折算）与 dirRows() 快照（dirDays 桶 + 每日残差投影）双线对齐；unidentified
 *   份额逐键对齐（归属/目录缺失的事实不静默丢弃、不双计）。无 dir 键的行只进 agg 不进
 *   dir（旧格式 rebuild 行），目录守恒以「有 dir 事实」为界——本回放全部经 collector
 *   apply 路径，collector.dirOf 恒返回 string（缺失时 TREND_UNIDENTIFIED），
 *   故目录守恒基准 == 聚合面基准。
 * - null 语义：缺失维度（null）不参与求和（sumToken）；0 是有效数字参与求和。
 *   校正若把数字改为 null，cell 增量修正 sub(v,null)=-v 会把值折回（0 残留为 0 属
 *   既有 null-aware 增量语义），故本回放中 correct 一律带完整四维 token，避免该
 *   既有边界干扰守恒判定（该边界不在本文件范围，unit-trend 校正段已覆盖其行为）。
 *
 * 场景清单（单次回放全覆盖）：request/header 归属折叠、assistant/chunk usage 定稿、
 * 同调用重复 usage（产生 correct 校正）、message 补记（含零 usage 与 interrupted）、
 * retry 逐次计（同 fold 键新 header 后 retry+1）、turn/end 与 tool/call（counter 事件）、
 * 归属缺失（provider/model 缺失 → TREND_UNIDENTIFIED）、#633 目录归属两条线
 * （合法 dir 经 resolveCwd 净化、缺失归 TREND_UNIDENTIFIED）、跨天（DAY0/DAY1 逐日对账）。
 */
import { assert } from "./helpers.ts";
import { TrendCollector, TrendAggregator, dayKey, sumToken, TREND_UNIDENTIFIED } from "../lib/index.js";

// ---------------------------------------------------------------- 工具（与 unit-trend.test.ts 同口径）

/** 固定本地时刻：2026-09-04（周五）12:00 与次日（跨天对账）。 */
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const T1 = T0 + 86400000; // 2026-09-05（DAY1）
const DAY0 = dayKey(T0);
const DAY1 = dayKey(T1);
const HOUR = 3600_000;

function ev(type, data, time, seq = 1) {
  return { type, seq, time, data };
}
const HEADER = (provider, model) => ({ header: { config: { provider, model } }, reason: "initial" });
/** usage chunk：cacheRead/cacheWrite 省略时为 undefined → parseTokens 记 null（缺失维度语义）。 */
const USAGE = (turn, step, input, output, cacheRead, cacheWrite) => ({
  turn,
  step,
  chunk: { type: "usage", usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } },
});
/** assistant/message：source 缺省 = 无副源（归属缺失路径）；usage 为 null = 零 usage 补记。 */
const MESSAGE = (turn, step, usage, opts = {}) => ({
  turn,
  step,
  message: { role: "assistant", ...(opts.source === undefined ? {} : { source: opts.source }) },
  ...(usage === null ? {} : { usage }),
  ...(opts.interrupted ? { interrupted: true } : {}),
});

function makeCollector(resolveCwd) {
  const emitted = [];
  const collector = new TrendCollector({ now: () => T0, resolveCwd, emit: (e) => emitted.push(e) });
  const send = (session, event) => collector.handleEvent(typeof session === "string" ? session : session?.id, event);
  return { collector, emitted, send };
}

/** #633 目录归属：s1/s3 合法 cwd（净化 basename），s2/s4 缺失（归未识别桶）。 */
const resolveCwd = (session) => ({ s1: "/home/u/proj-a", s3: "/home/u/proj-b" })[session];

// ---------------------------------------------------------------- 回放序列

const { emitted, send } = makeCollector(resolveCwd);

// DAY0 —— s1：合法归属 + 合法目录 + correct 校正 + retry 逐次计 + turn/tool 计数
send("s1", ev("request/header", HEADER("deepseek", "deepseek-chat"), T0, 1)); // 归属主源折叠
send("s1", ev("assistant/chunk", USAGE(1, 1, 100, 50, 10, 5), T0 + 1000, 2)); // 定稿 call#1（retry1）
send("s1", ev("assistant/chunk", USAGE(1, 1, 120, 60, 0, 0), T0 + 2000, 3)); // 同调用重复 usage → correct
send("s1", ev("assistant/message", MESSAGE(1, 1, { inputTokens: 200, outputTokens: 80, cacheReadTokens: 2, cacheWriteTokens: 1 }), T0 + 3000, 4)); // 已定稿 message → correct（覆盖）
send("s1", ev("request/header", HEADER("deepseek", "deepseek-chat"), T0 + 5000, 5)); // 重试边界
send("s1", ev("assistant/chunk", USAGE(1, 1, 70, 30), T0 + 6000, 6)); // retry2 逐次入账
send("s1", ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }, T0 + 7000, 7)); // counter toolCalls
send("s1", ev("tool/call", { turn: 1, step: 1, callId: "c2", name: "bash", arguments: "{}" }, T0 + 8000, 8)); // counter toolCalls
send("s1", ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 9000, 9)); // counter turns

// DAY0 —— s2：归属缺失（无 header 无 source）+ interrupted 补记 + 后续 usage（未识别桶）
send("s2", ev("assistant/message", MESSAGE(1, 1, { inputTokens: 30, outputTokens: 20 }, { interrupted: true }), T0 + 10000, 10)); // 补记 call（interrupted）
send("s2", ev("assistant/chunk", USAGE(2, 1, 10, 5), T0 + 11000, 11)); // 未识别 call
send("s2", ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }, T0 + 12000, 12)); // counter toolCalls（未识别）
send("s2", ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 13000, 13)); // counter turns（未识别）

// DAY1 —— s3：合法 dir（proj-b）+ 零 usage 补记；s4：目录缺失归未识别 + 合法归属
send("s3", ev("request/header", HEADER("deepseek", "deepseek-reasoner"), T1, 14));
send("s3", ev("assistant/chunk", USAGE(1, 1, 50, 25, 0, 50), T1 + 1000, 15)); // call（dir=proj-b）
send("s3", ev("assistant/message", MESSAGE(2, 1, null), T1 + 2000, 16)); // 零 usage 补记：调用照计、token null
send("s3", ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T1 + 3000, 17)); // counter turns（dir=proj-b）
send("s4", ev("request/header", HEADER("opencode", "glm-4"), T1 + 3100, 18));
send("s4", ev("assistant/chunk", USAGE(1, 1, 8, 4, 1, 0), T1 + 4000, 19)); // call（dir=unidentified）

// emitted 结构 sanity（correct 不新增调用计数；counter 独立）
const calls = emitted.filter((e) => e.type === "call").map((e) => e.record);
const corrects = emitted.filter((e) => e.type === "correct").map((e) => e.record);
const counters = emitted.filter((e) => e.type === "counter").map((e) => e.record);
assert.equal(calls.length, 7, "Σ事件：call 事件数 = 7（correct 不新增调用计数）");
assert.equal(corrects.length, 2, "同调用重复 usage + 已定稿 message 各产生一次校正");
assert.equal(counters.length, 6, "turn/end×3 + tool/call×3 = 6 个 counter 事件");
assert.equal(calls[0].provider, "deepseek", "归属折叠正确（s1 header 主源）");
assert.equal(calls[2].interrupted, true, "s2 补记带 interrupted 标记");
assert.equal(calls[2].provider, TREND_UNIDENTIFIED, "归属缺失 → TREND_UNIDENTIFIED 桶");
assert.equal(calls[2].model, null, "未识别桶 model=null");
assert.equal(calls[5].tokens, null, "零 usage 补记（s3 第二条 call）token 为 null");
assert.deepEqual(
  calls.map((c) => c.dir).sort(),
  [TREND_UNIDENTIFIED, TREND_UNIDENTIFIED, TREND_UNIDENTIFIED, "proj-a", "proj-a", "proj-b", "proj-b"],
  "#633 目录归属两条线：合法 basename 与缺失归未识别均落盘",
);

// ---------------------------------------------------------------- 对账

const agg = new TrendAggregator();
for (const e of emitted) agg.apply(e);

// ---- 期望值：Σ事件（a 视角）——fold 键最终 tokens（correct 覆盖语义）+ counter 计数 ----
const ZERO = () => ({ input: null, output: null, cacheRead: null, cacheWrite: null, calls: 0, turns: 0, toolCalls: 0 });
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const NUM_FIELDS = ["calls", "turns", "toolCalls"];
const ALL_FIELDS = [...TOKEN_FIELDS, ...NUM_FIELDS];

function addTokens(acc, tokens) {
  if (tokens === null) return acc;
  for (const f of TOKEN_FIELDS) acc[f] = sumToken(acc[f], tokens[f]);
  return acc;
}
/** 十数值字段同构行（cell / agg / dir 行）并入合计。 */
function addRowTotals(acc, row) {
  for (const f of TOKEN_FIELDS) acc[f] = sumToken(acc[f], row[f]);
  for (const f of NUM_FIELDS) acc[f] += row[f];
  return acc;
}

// 身份快照基准：fold 键 → { day, dir, tokens }（correct 覆盖 tokens；day/dir 取 call 定稿事实）
const finalByKey = new Map();
for (const e of emitted) {
  if (e.type === "call") {
    const r = e.record;
    finalByKey.set(`${r.session}\u0000${r.turn}\u0000${r.step}\u0000${r.retry}`, { day: dayKey(r.time), dir: r.dir, tokens: r.tokens });
  } else if (e.type === "correct") {
    const r = e.record;
    const cur = finalByKey.get(`${r.session}\u0000${r.turn}\u0000${r.step}\u0000${r.retry}`);
    if (cur !== undefined) cur.tokens = r.tokens; // 校正覆盖（与 applyCorrect 命中语义一致）
  }
}

const expectByDay = new Map(); // day → 全量合计
const expectByDayDir = new Map(); // day → Map<dir, 合计>
const dayTotals = (day) => {
  let t = expectByDay.get(day);
  if (t === undefined) {
    t = ZERO();
    expectByDay.set(day, t);
  }
  return t;
};
const dayDirTotals = (day, dir) => {
  let byDir = expectByDayDir.get(day);
  if (byDir === undefined) {
    byDir = new Map();
    expectByDayDir.set(day, byDir);
  }
  let t = byDir.get(dir);
  if (t === undefined) {
    t = ZERO();
    byDir.set(dir, t);
  }
  return t;
};
for (const { day, dir, tokens } of finalByKey.values()) {
  const e = dayTotals(day);
  e.calls += 1;
  addTokens(e, tokens);
  const d = dayDirTotals(day, dir);
  d.calls += 1;
  addTokens(d, tokens);
}
for (const c of counters) {
  const day = dayKey(c.time);
  const e = dayTotals(day);
  e.turns += c.turns;
  e.toolCalls += c.toolCalls;
  const d = dayDirTotals(day, c.dir);
  d.turns += c.turns;
  d.toolCalls += c.toolCalls;
}

// ---- 对账断言（失败消息给出视角 / 日 / 键 / 期望与实得，精确缺账多账定位）----
function assertEqualTotals(label, expected, actual) {
  for (const f of ALL_FIELDS) {
    assert.equal(actual[f], expected[f], `${label}：字段 ${f} 不守恒——期望 ${expected[f]}，实得 ${actual[f]}（${expected[f] === null || actual[f] === null ? "null 语义参与" : `差 ${actual[f] - expected[f]}`}）`);
  }
}

function bucketsTotalsOf(day) {
  const acc = ZERO();
  const b = agg.buckets().find((d) => d.day === day);
  if (b !== undefined) for (const p of b.providers) addRowTotals(acc, p.cell);
  return acc;
}
function aggRowsTotalsOf(day) {
  const acc = ZERO();
  for (const r of agg.rollupSnapshot(day).aggRows) addRowTotals(acc, r);
  return acc;
}
function dirRowsTotalsOf(day) {
  const acc = ZERO();
  for (const r of agg.rollupSnapshot(day).dirRows) addRowTotals(acc, r);
  return acc;
}
function dirSnapshotTotalsOf(day) {
  const acc = ZERO();
  for (const r of agg.dirRows()) if (r.day === day) addRowTotals(acc, r);
  return acc;
}
function dirRowsOfDirTotals(day, dir) {
  const acc = ZERO();
  for (const r of agg.rollupSnapshot(day).dirRows) if (r.dir === dir) addRowTotals(acc, r);
  return acc;
}
function dirSnapshotOfDirTotals(day, dir) {
  const acc = ZERO();
  for (const r of agg.dirRows()) if (r.day === day && r.dir === dir) addRowTotals(acc, r);
  return acc;
}

assert.equal(finalByKey.size, calls.length, "身份快照键数 == call 事件数（correct 不新增）");
const days = [...expectByDay.keys()].sort();
assert.deepEqual(days, [DAY0, DAY1], "回放覆盖两天（跨天逐日对账）");
for (const day of days) {
  const expected = expectByDay.get(day);
  // a. Σ事件 == b. buckets（内存聚合面）
  assertEqualTotals(`[${day}] a→b：Σ事件 vs 内存桶 buckets 合计`, expected, bucketsTotalsOf(day));
  // a. Σ事件 == c. agg（压实折算，不二次累加）
  assertEqualTotals(`[${day}] a→c：Σ事件 vs rollupSnapshot.aggRows 合计`, expected, aggRowsTotalsOf(day));
  // a. Σ事件 == d. dirRows（pending 折算）+ dirRows() 快照（dirDays+残差；有 dir 事实为界）
  assertEqualTotals(`[${day}] a→d：Σ事件 vs rollupSnapshot.dirRows 合计`, expected, dirRowsTotalsOf(day));
  assertEqualTotals(`[${day}] a→d：Σ事件 vs dirRows() 快照（残差应为 0）`, expected, dirSnapshotTotalsOf(day));
  // 未识别桶份额逐键对齐（归属/目录缺失不静默丢弃、不双计）
  const byDir = expectByDayDir.get(day);
  for (const [dir, expectedDir] of byDir) {
    assertEqualTotals(`[${day}] dir=${dir}（rollupSnapshot 折算）`, expectedDir, dirRowsOfDirTotals(day, dir));
    assertEqualTotals(`[${day}] dir=${dir}（dirRows() 快照）`, expectedDir, dirSnapshotOfDirTotals(day, dir));
  }
  assert.equal(byDir.has(TREND_UNIDENTIFIED), true, "该日未识别桶确有份额（防口径空转）");
}

// 台账守恒链完整表达式（终态抽查）：Σ事件 == buckets == agg == dirRows + unidentified
{
  const day = DAY0;
  const chain = [bucketsTotalsOf(day), aggRowsTotalsOf(day), dirRowsTotalsOf(day), dirSnapshotTotalsOf(day)];
  for (const t of chain) assertEqualTotals(`[${day}] 守恒链终态`, expectByDay.get(day), t);
  console.log(`unit-trend-ledger: DAY0/DAY1 四视角台账守恒全部通过（calls=${expectByDay.get(DAY0).calls + expectByDay.get(DAY1).calls}，corrects=${corrects.length}，counters=${counters.length}）`);
}
