// @ts-nocheck
/**
 * dsh-provider-usage — unit：#503 M3 用量报告（数据面纯逻辑 + 调度器）。
 *
 * 覆盖：
 * - schedule：candidateWindow/pendingReports（daily/weekly/monthly 窗口语义、
 *   lastRun 已扣期跳过、首次挂载补最近窗口、enabled 关闭不调度）
 * - config：parseHHMM 非法返回 null / normalizeReportConfig 非法值回退默认
 * - generate：正文拼接 / token 元数据 / 空串跟随默认路由解析 / 流异常失败元数据 /
 *   取消失败 / 空正文失败 / 路由不可解析失败 / {stats} 模板替换
 * - buildStatsSnapshot：窗口过滤 / totals 聚合 / byProvider calls 降序 / prevTotal 透传
 * - 前提断言（方案 §2.3）：报告生成走 ctx.llm.stream、不派发 session/event——
 *   单测以 fake llm（无 session 通道）验证生成路径不触达任何会话事件源；
 *   接线层 smoke 另以 emitEvent 计数显式断言「生成不产生 session 事件→不入统计」。
 * - scheduler（M3 接线补）：lastRun 读写 roundtrip / 单飞互斥（busy 期 tick 跳过）/
 *   失败不推进 lastRun（下轮重试同窗）/ 成功推进 / dispose 停 tick
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "./helpers.ts";
import {
  candidateWindow,
  pendingReports,
  presetLastRunForNewlyEnabled,
  parseHHMM,
  normalizeReportConfig,
  DEFAULT_REPORT_CONFIG,
  generateReport,
  applyPromptTemplate,
  buildStatsSnapshot,
  ReportScheduler,
  readLastRun,
  writeLastRun,
} from "../lib/index.js";

// ---------------------------------------------------------------- 工具

/** 固定本地时刻：2026-09-04（周五）12:00。 */
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const HOUR = 3600_000;

const CFG = (over = {}) => normalizeReportConfig({
  daily: { enabled: true, time: "22:00" },
  weekly: { enabled: true, time: "09:00", weekStartsOn: 1 },
  monthly: { enabled: true, time: "09:00", dayOfMonth: 1 },
  ...over,
});

const CHUNKS = [
  { type: "text-delta", index: 0, text: "第一段。" },
  { type: "text-delta", index: 0, text: "第二段。" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "finish", reason: "stop" },
];

/** fake llm：罐头 chunk 流；seen 记录收到的 GenerateOptions（断言路由/信号透传）。 */
function fakeLlm(chunks = CHUNKS, opts = {}) {
  const seen = { options: null, streamCalled: false };
  const llm = {
    stream(o) {
      seen.streamCalled = true;
      seen.options = o;
      return (async function* () {
        if (opts.throwInStream) throw new Error(opts.throwInStream);
        if (o.signal?.aborted) throw new Error("aborted before start");
        yield* chunks;
      })();
    },
    listProviders: () => (opts.noProviders ? [] : [{ id: "prov-a", name: "A" }, { id: "prov-b", name: "B" }]),
    listModels: async () => (opts.noModels ? [] : [{ provider: "prov-a", id: "model-a", name: "A" }]),
  };
  return { llm, seen };
}

const GEN = (over = {}) => ({
  llm: null,
  period: "daily",
  key: "2026-09-04",
  startDay: "2026-09-04",
  endDay: "2026-09-04",
  statsJson: '{"calls":1}',
  promptTemplate: "统计：{stats}",
  provider: "",
  model: "",
  ...over,
});

// ---------------------------------------------------------------- schedule：候选窗口

{
  const cfg = CFG();
  // daily：now 12:00 未过当日 22:00 → 候选=昨日全天
  let due = candidateWindow("daily", cfg, T0);
  assert.equal(due.key, "2026-09-03", "daily 未过锚点 → 昨日");
  assert.equal(due.startDay, "2026-09-03", "daily 起于锚点日");
  assert.equal(due.endDay, "2026-09-03", "daily 止于锚点日（单日窗口）");
  // daily：now 已过当日 22:00 → 候选=当日
  due = candidateWindow("daily", cfg, T0 + 11 * HOUR);
  assert.equal(due.key, "2026-09-04", "daily 已过锚点 → 当日");
  // weekly：2026-09-04 周五，本周锚点=周一 08-31 09:00（已过）→ 覆盖紧邻前 7 天 08-24..08-30
  due = candidateWindow("weekly", cfg, T0);
  assert.equal(due.key, "2026-08-24", "weekly 候选键=周起点-7（[runDay-7, runDay-1] 闭区间 7 天）");
  assert.equal(due.startDay, "2026-08-24", "weekly 起于锚点前 7 天");
  assert.equal(due.endDay, "2026-08-30", "weekly 止于锚点前 1 天");
  // monthly：9-1 09:00 已过 → 覆盖上一自然月 2026-08
  due = candidateWindow("monthly", cfg, T0);
  assert.equal(due.key, "2026-08", "monthly 候选键=上一自然月");
  assert.equal(due.startDay, "2026-08-01", "monthly 起于上月 1 日");
  assert.equal(due.endDay, "2026-08-31", "monthly 止于上月末");
}

// ---------------------------------------------------------------- schedule：幂等与补跑

{
  const cfg = CFG();
  // 首次挂载（lastRun 空）→ 全部到期（补跑最近窗口）
  const due = pendingReports(cfg, T0, {});
  assert.deepEqual(due.map((d) => d.period), ["daily", "weekly", "monthly"], "lastRun 空 → 三期全部补生成");
  // lastRun 已记候选键 → 扣期跳过
  const lastRun = { daily: "2026-09-03", weekly: "2026-08-24", monthly: "2026-08" };
  assert.deepEqual(pendingReports(cfg, T0, lastRun), [], "候选键 <= lastRun → 已扣期");
  // lastRun 为更晚窗口 → 该期跳过（日期序单调，防回退重复生成）；未记录期照常补跑
  assert.ok(!pendingReports(cfg, T0, { daily: "2026-09-10" }).some((d) => d.period === "daily"), "lastRun 更晚 → 该期跳过");
  // 跨过锚点（now 前移到次日）→ daily 新窗口补跑；weekly/monthly 无 lastRun 记录照常补跑
  const nextDay = pendingReports(CFG(), T0 + 25 * HOUR, { daily: "2026-09-03" });
  assert.deepEqual(nextDay.map((d) => d.period), ["daily", "weekly", "monthly"], "新锚点候选键 > lastRun → 补跑（未记录期同补）");
  // enabled 关闭不调度
  const off = pendingReports(CFG({ weekly: { enabled: false, time: "09:00", weekStartsOn: 1 } }), T0, {});
  assert.ok(!off.some((d) => d.period === "weekly"), "weekly 关闭 → 不调度");
}

// ---------------------------------------------------------------- schedule：#531 首次启用扣期预置

{
  const allOff = normalizeReportConfig({
    daily: { enabled: false, time: "22:00" },
    weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
    monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
  });
  // 全关 → 全开（首次启用）：三期全部预置当前候选键，changed=true
  const r1 = presetLastRunForNewlyEnabled(allOff, CFG(), T0, {});
  assert.equal(r1.changed, true, "首次启用 → changed");
  const cand = {
    daily: candidateWindow("daily", CFG(), T0).key,
    weekly: candidateWindow("weekly", CFG(), T0).key,
    monthly: candidateWindow("monthly", CFG(), T0).key,
  };
  assert.deepEqual(r1.lastRun, cand, "预置键 === 各期当前候选键");
  // 预置后 pendingReports 立即为空（保存后 tick 不抢跑）
  assert.deepEqual(pendingReports(CFG(), T0, r1.lastRun), [], "预置扣期后 tick 无到期");
  // 跨过下一锚点后照常补跑（预置只扣当期，不扣未来）
  const later = pendingReports(CFG(), T0 + 25 * HOUR, r1.lastRun);
  assert.ok(later.some((d) => d.period === "daily" && d.key > r1.lastRun.daily), "下个锚点到期 → 照常生成");
  // 之前已启用（lastRun 缺失）→ 不预置（保持补跑语义：升级场景不吞当期）
  const r2 = presetLastRunForNewlyEnabled(CFG(), CFG(), T0, {});
  assert.equal(r2.changed, false, "已启用未变 → 不预置");
  // 停用再启用且 lastRun 已有值 → 不预置（补跑最近窗口为恢复语义）
  const halfRun = { daily: "2026-08-01" };
  const r3 = presetLastRunForNewlyEnabled(allOff, CFG(), T0, halfRun);
  assert.equal(r3.changed, true, "部分周期有记录 → 其余仍预置");
  assert.equal(r3.lastRun.daily, "2026-08-01", "已有记录的周期不覆写");
  // 部分启用：只预置新开的周期
  const onlyMonthly = CFG({ daily: { enabled: false, time: "22:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 } });
  const r4 = presetLastRunForNewlyEnabled(allOff, onlyMonthly, T0, {});
  assert.deepEqual(Object.keys(r4.lastRun), ["monthly"], "仅新启用周期预置");
}

// ---------------------------------------------------------------- config：归一化

{
  assert.deepEqual(parseHHMM("22:00"), { h: 22, m: 0 }, "22:00 合法");
  assert.equal(parseHHMM("24:00"), null, "24:00 非法");
  assert.equal(parseHHMM("9:5x"), null, "非数字非法");
  assert.equal(parseHHMM(900), null, "非字符串非法");
  const n = normalizeReportConfig({ daily: { enabled: true, time: "99:99" }, monthly: { dayOfMonth: 31 } });
  assert.equal(n.daily.time, DEFAULT_REPORT_CONFIG.daily.time, "非法 HH:MM 回退默认");
  assert.equal(n.monthly.dayOfMonth, DEFAULT_REPORT_CONFIG.monthly.dayOfMonth, "dayOfMonth>28 回退默认");
  assert.equal(n.weekly.weekStartsOn, 1, "weekStartsOn 非法回退周一");
  assert.ok(n.promptTemplate.length > 0, "promptTemplate 缺省取默认模板");
}

// ---------------------------------------------------------------- generate：成功路径

{
  const { llm, seen } = fakeLlm();
  const r = await generateReport(GEN({ llm }));
  assert.equal(r.meta.ok, true, "生成成功");
  assert.equal(r.body, "第一段。第二段。", "text-delta 顺序拼接");
  assert.deepEqual(r.meta.tokens, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null }, "usage chunk 记元数据");
  // 空串跟随默认：provider 解析为注册序首个，model 解析为该 provider 首个
  assert.equal(r.meta.provider, "prov-a", "空 provider → 注册序首个");
  assert.equal(r.meta.model, "model-a", "空 model → 该 provider 首个");
  assert.equal(seen.options.provider, "prov-a", "GenerateOptions 透传解析后路由");
  assert.equal(seen.options.messages.length, 1, "单条 user 消息");
  assert.equal(seen.options.messages[0].source.kind, "user", "user source");
  assert.ok(seen.options.messages[0].content[0].text.includes('{"calls":1}'), "{stats} 注入统计 JSON");
  assert.ok(seen.options.tools === undefined, "tools 不传 = 无工具面");
  assert.ok(r.meta.durationMs >= 0, "时长记录");
}

// ---------------------------------------------------------------- generate：显式路由透传

{
  const { llm, seen } = fakeLlm();
  const r = await generateReport(GEN({ llm, provider: "prov-b", model: "model-b" }));
  assert.equal(r.meta.provider, "prov-b", "显式 provider 直接透传");
  assert.equal(seen.options.model, "model-b", "显式 model 透传");
}

// ---------------------------------------------------------------- generate：失败路径

{
  // 流异常 → 失败元数据（不抛；正文空）
  const boom = fakeLlm(CHUNKS, { throwInStream: "stream boom" });
  const r1 = await generateReport(GEN({ llm: boom.llm }));
  assert.equal(r1.meta.ok, false, "流异常 → ok:false");
  assert.equal(r1.body, "", "失败正文为空");
  assert.ok(r1.meta.error.includes("stream boom"), "错误短句保留");
  // 取消 → 失败
  const ac = new AbortController();
  ac.abort();
  const r2 = await generateReport(GEN({ llm: fakeLlm().llm, signal: ac.signal }));
  assert.equal(r2.meta.ok, false, "已取消信号 → ok:false");
  // 空正文 → 失败
  const r3 = await generateReport(GEN({ llm: fakeLlm([{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }]).llm }));
  assert.equal(r3.meta.ok, false, "无正文 → ok:false");
  assert.ok(r3.meta.error.includes("正文"), "空正文错误说明");
  // 路由不可解析 → 失败
  const r4 = await generateReport(GEN({ llm: fakeLlm(CHUNKS, { noProviders: true }).llm }));
  assert.equal(r4.meta.ok, false, "无注册 provider → ok:false");
  const r5 = await generateReport(GEN({ llm: fakeLlm(CHUNKS, { noModels: true }).llm }));
  assert.equal(r5.meta.ok, false, "provider 无可用 model → ok:false");
}

// ---------------------------------------------------------------- generate：模板替换

{
  assert.equal(applyPromptTemplate("A{stats}B{stats}C", "[J]"), "A[J]B[J]C", "{stats} 多次出现全部替换");
  assert.equal(applyPromptTemplate("无占位", "[J]"), "无占位", "无占位原样返回");
}

// ---------------------------------------------------------------- buildStatsSnapshot

{
  const cell = (calls, input) => ({ input, output: null, cacheRead: null, cacheWrite: null, calls, turns: calls, toolCalls: 0 });
  const buckets = [
    { day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(2, 100) }] },
    { day: "2026-09-03", providers: [{ provider: "p1", model: "m1", cell: cell(1, 50) }, { provider: "p2", model: null, cell: cell(3, 30) }] },
    { day: "2026-09-10", providers: [{ provider: "p1", model: "m1", cell: cell(9, 999) }] }, // 窗口外
  ];
  const s = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-03", buckets, prevTotal: 120 });
  assert.equal(s.totals.calls, 6, "窗口内 calls 聚合（2+1+3）");
  assert.equal(s.totals.input, 180, "token null-aware 聚合（100+50+30）");
  assert.deepEqual(s.byDay, [{ day: "2026-09-02", total: 100 }, { day: "2026-09-03", total: 80 }], "逐日总量（窗口外不计）");
  assert.equal(s.byProvider[0].provider, "p1", "byProvider calls 降序（p1:3）");
  assert.equal(s.byProvider[1].calls, 3, "p2 次之");
  assert.equal(s.prevTotal, 120, "环比基准透传");
  assert.equal(s.totals.total, 180, "total=四项之和");
}

// ---------------------------------------------------------------- 生成不入统计前提（单测侧）

{
  // 前提（方案 §2.3 显式断言）：generateReport 只消费注入的 llm 服务面，
  // 不触达 session/event 通道（fake llm 无会话事件源；接线层 smoke 以
  // emitEvent 计数断言「生成不产生 session 事件→不入统计」）。
  const { llm, seen } = fakeLlm();
  await generateReport(GEN({ llm }));
  assert.ok(seen.streamCalled, "生成只经 llm.stream（无 session 事件源参与）");
}

// ---------------------------------------------------------------- scheduler：lastRun 读写 roundtrip

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-sched-"));
  assert.deepEqual(await readLastRun(root), {}, "缺失文件 → 空表");
  await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
  const roundtrip = await readLastRun(root);
  assert.deepEqual(roundtrip, { daily: "2026-09-04", monthly: "2026-08" }, "writeLastRun → readLastRun roundtrip");
  assert.ok(existsSync(join(root, "reports", "last-run.json")), "last-run.json 落在 historyRoot/reports/ 下");
}

// ---------------------------------------------------------------- scheduler：单飞互斥（busy 期 tick 跳过）

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-busy-"));
  let calls = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  const scheduler = ReportScheduler.start({
    root,
    config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
    onDue: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(50); // 慢生成：远超 tickMs=10，busy 标志应让后续 tick 直接跳过
      concurrent -= 1;
      throw new Error("always-fail"); // 恒失败：lastRun 不推进，tick 才会持续产生 onDue
    },
    tickMs: 10,
  });
  // 轮询等至少两轮 onDue 完成（时间驱动而非固定 sleep 推断轮数）
  await sleep(140);
  scheduler.dispose();
  assert.ok(maxConcurrent === 1, `单飞互斥：onDue 并发数受控为 1（实际 ${maxConcurrent}）`);
  assert.ok(calls >= 2, `多轮 tick 发生（实际 ${calls} 次）`);
  // busy 跳过：140ms 窗口内若无互斥，10ms tick 理论可发起十余轮；受 busy 限制
  // onDue 只能在前一轮完成后启动（每轮 ≥50ms）→ 调用数受窗口长度封顶
  assert.ok(calls <= 4, `busy 期 tick 跳过生效：onDue 调用数受控（实际 ${calls} 次）`);
  assert.ok(!existsSync(join(root, "reports", "last-run.json")), "恒失败 → lastRun 不落盘");
}

// ---------------------------------------------------------------- scheduler：失败不推进 + 下轮重试同窗

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-retry-"));
  let calls = 0;
  let sawKeys = [];
  const scheduler = ReportScheduler.start({
    root,
    config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
    onDue: async (due) => {
      calls += 1;
      sawKeys.push(due.key);
      if (calls < 3) throw new Error(`boom-${calls}`); // 前两轮失败
    },
    tickMs: 15,
  });
  await sleep(120);
  scheduler.dispose();
  assert.ok(calls >= 3, `失败后下轮重试（实际 ${calls} 次）`);
  assert.ok(new Set(sawKeys).size === 1, `重试同一窗口（键集 ${[...new Set(sawKeys)].join(",")}）`);
  // 第三轮成功 → lastRun 推进为该窗口键（防 tick 重复生成的幂等标记）
  const lastRun = await readLastRun(root);
  assert.equal(lastRun.daily, sawKeys[0], "成功后 lastRun.daily === 窗口键");
}

// ---------------------------------------------------------------- scheduler：dispose 停 tick

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-dispose-"));
  let calls = 0;
  const scheduler = ReportScheduler.start({
    root,
    config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
    onDue: async () => {
      calls += 1;
    },
    tickMs: 10,
  });
  await sleep(60);
  scheduler.dispose();
  const atDispose = calls;
  await sleep(60);
  assert.equal(calls, atDispose, "dispose 后不再 tick（计数冻结）");
  // 成功路径推进过 lastRun（首轮启动补跑已生成并落盘）
  assert.ok(existsSync(join(root, "reports", "last-run.json")), "dispose 前的成功生成已推进 lastRun");
}

console.log("unit-report: all assertions passed");
