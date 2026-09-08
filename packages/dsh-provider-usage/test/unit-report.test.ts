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
 * - #633 分片 a D1：旧格式 trend 分片（无 cwd/dir 键）→ 启动重建 + buildStatsSnapshot
 *   报告链路不抛错；byDirectory 未识别桶数值正确；byProvider/byDay/派生维度与无 dir
 *   维度时完全一致（零回归）
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, utimesSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assert, pollUntil, callHandler } from "./helpers.ts";
import {
  candidateWindow,
  previousClosedWindow,
  pendingReports,
  presetLastRunForNewlyEnabled,
  parseHHMM,
  normalizeReportConfig,
  DEFAULT_REPORT_CONFIG,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  promptFor,
  readReportConfig,
  writeReportConfig,
  reportBodyToHtml,
  sanitizeHtml,
  generateReport,
  applyPromptTemplate,
  buildStatsSnapshot,
  ReportScheduler,
  readLastRun,
  writeLastRun,
  updateLastRun,
  __lastRunChainForTests,
  ensureLastRunMigrated,
  deriveLastRun,
  isClosedWindowRecord,
  LAST_RUN_SCHEMA,
  ReportTaskQueue,
  readReportIndex,
  parseReportIndexLines,
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
  handleReportStatus,
  TrendTracker,
  dayKey,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  persistReport,
  reportHtmlFile,
  reportMetaFile,
  notifyReport,
  runDueReport,
  normalizeReportDirectories,
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
  // daily：now 12:00 未过当日 22:00 → 最近已到达锚点为昨日 22:00，覆盖前日全天（2026-09-02）
  let due = candidateWindow("daily", cfg, T0);
  assert.equal(due.key, "2026-09-02", "daily 未过锚点 → 前日全天");
  assert.equal(due.startDay, "2026-09-02", "daily 起于前日");
  assert.equal(due.endDay, "2026-09-02", "daily 止于前日（单日窗口）");
  // daily：now 23:00 已过当日 22:00 → 当日锚点已到达，覆盖昨日全天（2026-09-03）
  due = candidateWindow("daily", cfg, T0 + 11 * HOUR);
  assert.equal(due.key, "2026-09-03", "daily 已过锚点 → 昨日全天");
  assert.equal(due.startDay, "2026-09-03", "daily 起于昨日");
  assert.equal(due.endDay, "2026-09-03", "daily 止于昨日");
  // previousClosedWindow：手动生成专用——无论当前时刻是否过锚点，恒定生成昨天（2026-09-03），消灭凌晨漂移
  const manualDue = previousClosedWindow("daily", cfg, T0);
  assert.equal(manualDue.key, "2026-09-03", "手动生成恒为昨日全天");
  assert.equal(manualDue.startDay, "2026-09-03", "手动生成起于昨日");
  assert.equal(manualDue.endDay, "2026-09-03", "手动生成止于昨日");
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
  const lastRun = { daily: "2026-09-02", weekly: "2026-08-24", monthly: "2026-08" };
  assert.deepEqual(pendingReports(cfg, T0, lastRun), [], "候选键 <= lastRun → 已扣期");
  // lastRun 为更晚窗口 → 该期跳过（日期序单调，防回退重复生成）；未记录期照常补跑
  assert.ok(!pendingReports(cfg, T0, { daily: "2026-09-10" }).some((d) => d.period === "daily"), "lastRun 更晚 → 该期跳过");
  // 跨过锚点（now 前移到 23:00 跨过 22:00）→ daily 新窗口（2026-09-03）补跑；weekly/monthly 无 lastRun 记录照常补跑
  const nextRun = pendingReports(CFG(), T0 + 11 * HOUR, { daily: "2026-09-02" });
  assert.deepEqual(nextRun.map((d) => d.period), ["daily", "weekly", "monthly"], "新锚点候选键 > lastRun → 补跑（未记录期同补）");
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
  // #532 年报派生维度
  assert.deepEqual(s.peakDay, { day: "2026-09-02", total: 100 }, "峰值日=byDay 最大（并列取最早）");
  assert.equal(s.activeDays, 2, "活跃天数=窗口内有数据天数");
  assert.equal(s.windowDays, 2, "窗口天数（含无数据日）");
  assert.equal(s.avgPerActiveDay, 90, "活跃日均=total/activeDays");
  assert.equal(s.longestStreak, 2, "最长连续=日历日差1 连续（09-02/09-03）");
  assert.equal(s.wowRatio, 1.5, "环比比值=total/prevTotal（180/120）");
  // 星期分布：2026-09-02=周三(idx2)、09-03=周四(idx3)
  assert.equal(s.byWeekday[2], 100, "byWeekday 周三桶");
  assert.equal(s.byWeekday[3], 80, "byWeekday 周四桶");
  assert.equal(s.byWeekday.reduce((a, b) => a + b, 0), 180, "byWeekday 总和=total");
}

// ---------------------------------------------------------------- #532 派生维度：边界条件

{
  const cell = (calls, input) => ({ input, output: null, cacheRead: null, cacheWrite: null, calls, turns: calls, toolCalls: 0 });
  // 空窗口：全 null/0，wowRatio null（防 Infinity），不抛
  const empty = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-01", endDay: "2026-09-07", buckets: [], prevTotal: null });
  assert.equal(empty.peakDay, null, "空窗口 peakDay=null");
  assert.equal(empty.activeDays, 0, "空窗口 activeDays=0");
  assert.equal(empty.windowDays, 7, "空窗口 windowDays=7");
  assert.equal(empty.avgPerActiveDay, null, "空窗口 avgPerActiveDay=null");
  assert.equal(empty.longestStreak, 0, "空窗口 streak=0");
  assert.equal(empty.wowRatio, null, "prevTotal=null → wowRatio=null");
  assert.deepEqual(empty.byWeekday, [0, 0, 0, 0, 0, 0, 0], "空窗口 byWeekday 全 0");
  // 除零：prevTotal=0 → null（防 Infinity 被 JSON.stringify 静默转 null 的语义错误）
  const zeroPrev = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-02", buckets: [{ day: "2026-09-02", providers: [{ provider: "p1", model: "m1", cell: cell(1, 50) }] }], prevTotal: 0 });
  assert.equal(zeroPrev.wowRatio, null, "prevTotal=0 → wowRatio=null（不做对比）");
  // 跨月连续：01-31 → 02-01 日历日差=1（streak=2，非字典序判断）
  const crossMonth = buildStatsSnapshot({ period: "weekly", startDay: "2026-01-31", endDay: "2026-02-01", buckets: [
    { day: "2026-01-31", providers: [{ provider: "p1", model: "m1", cell: cell(1, 10) }] },
    { day: "2026-02-01", providers: [{ provider: "p1", model: "m1", cell: cell(1, 20) }] },
  ], prevTotal: null });
  assert.equal(crossMonth.longestStreak, 2, "跨月 01-31→02-01 按日历日判定连续");
  // provider/model 名防御：控制字符剥离（C0 + DEL + C1）+ 80 字符截断
  const longName = "x".repeat(100);
  const hostile = buildStatsSnapshot({ period: "daily", startDay: "2026-09-02", endDay: "2026-09-02", buckets: [
    { day: "2026-09-02", providers: [{ provider: `a\u0000b${longName}`, model: `m\nevil\u009b`, cell: cell(1, 10) }] },
  ], prevTotal: null });
  assert.ok(!hostile.byProvider[0].provider.includes("\u0000"), "provider 控制字符已剥离");
  assert.equal(hostile.byProvider[0].provider.length, 80, "provider 截断至 80 字符");
  assert.ok(!hostile.byProvider[0].model.includes("\n"), "model 控制字符已剥离");
  assert.ok(!hostile.byProvider[0].model.includes("\u009b"), "model C1 控制字符已剥离（复核 P1-2）");
}

// ---------------------------------------------------------------- #532 per-period 提示词

{
  // 新格式 prompts 优先；promptTemplate 回填为月报镜像
  const n = normalizeReportConfig({ prompts: { daily: "日模板{stats}", weekly: "周模板{stats}", monthly: "月模板{stats}" } });
  assert.deepEqual(n.prompts, { daily: "日模板{stats}", weekly: "周模板{stats}", monthly: "月模板{stats}" }, "prompts 新格式直读");
  assert.equal(n.promptTemplate, "月模板{stats}", "promptTemplate=月报镜像");
  // 旧默认模板 → 自动升级三份新默认（存量用户拿得到年报体验）
  const legacyDefault = normalizeReportConfig({ promptTemplate: LEGACY_PROMPT_TEMPLATE });
  assert.equal(legacyDefault.prompts.daily, DEFAULT_DAILY_PROMPT, "旧默认 → 升级日报新默认");
  assert.equal(legacyDefault.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "旧默认 → 升级周报新默认");
  assert.equal(legacyDefault.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "旧默认 → 升级月报新默认");
  // 自定义旧模板 → 三周期以该文本起始（不丢用户文本）
  const custom = normalizeReportConfig({ promptTemplate: "我的自定义模板 {stats}" });
  assert.deepEqual(custom.prompts, { daily: "我的自定义模板 {stats}", weekly: "我的自定义模板 {stats}", monthly: "我的自定义模板 {stats}" }, "自定义旧模板三周期继承");
  // 存量老用户三周期旧默认提示词（V1：含“今天/本周/本月”）自动无损升级为新版默认（昨日/上周/上月）
  const legacyV1 = normalizeReportConfig({
    prompts: {
      daily: LEGACY_DAILY_PROMPT_V1,
      weekly: LEGACY_WEEKLY_PROMPT_V1,
      monthly: LEGACY_MONTHLY_PROMPT_V1,
    },
  });
  assert.equal(legacyV1.prompts.daily, DEFAULT_DAILY_PROMPT, "未自定义的旧版日报模板自动升级");
  assert.equal(legacyV1.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "未自定义的旧版周报模板自动升级");
  assert.equal(legacyV1.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "未自定义的旧版月报模板自动升级");
  // 存量老用户过渡单段提示词（V2：未分块单段）同样自动升级为最新语义块结构
  const legacyV2 = normalizeReportConfig({
    prompts: {
      daily: LEGACY_DAILY_PROMPT_V2,
      weekly: LEGACY_WEEKLY_PROMPT_V2,
      monthly: LEGACY_MONTHLY_PROMPT_V2,
    },
  });
  assert.equal(legacyV2.prompts.daily, DEFAULT_DAILY_PROMPT, "V2 单段日报模板自动升级为语义块");
  assert.equal(legacyV2.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "V2 单段周报模板自动升级为语义块");
  assert.equal(legacyV2.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "V2 单段月报模板自动升级为语义块");
  // 存量老用户 V3 三周期模板（#633 分片 b 引入的旧默认：无目录观察句）自动升级为
  // 含目录观察的新默认（复核 P1-4：V3 进 legacyTemplates 后零测试，盲区补齐）
  const legacyV3 = normalizeReportConfig({
    prompts: {
      daily: LEGACY_DAILY_PROMPT_V3,
      weekly: LEGACY_WEEKLY_PROMPT_V3,
      monthly: LEGACY_MONTHLY_PROMPT_V3,
    },
  });
  assert.equal(legacyV3.prompts.daily, DEFAULT_DAILY_PROMPT, "V3 无目录观察日报模板自动升级");
  assert.equal(legacyV3.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "V3 无目录观察周报模板自动升级");
  assert.equal(legacyV3.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "V3 无目录观察月报模板自动升级");
  // V3 混合形态：单周期自定义保留、其余周期平滑升级（防整表覆盖回退）
  const mixedV3 = normalizeReportConfig({
    prompts: {
      daily: LEGACY_DAILY_PROMPT_V3,
      weekly: "我的周报模板 {stats}",
      monthly: LEGACY_MONTHLY_PROMPT_V3,
    },
  });
  assert.equal(mixedV3.prompts.daily, DEFAULT_DAILY_PROMPT, "V3 混合：未自定义日报仍升级");
  assert.equal(mixedV3.prompts.weekly, "我的周报模板 {stats}", "V3 混合：自定义周报保留原样");
  assert.equal(mixedV3.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "V3 混合：未自定义月报仍升级");
  // 三周期 V3→新默认 落盘 round-trip（存量用户磁盘形态：旧版本写下的 V3 文本，
  // 绕过 writeReportConfig 的写侧归一化直接手写 JSON——读侧自动升级为新默认）
  {
    const v3Root = mkdtempSync(join(tmpdir(), "dou-report-v3-migrate-"));
    const reportsDir = join(v3Root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, "config.json"), JSON.stringify({
      daily: { enabled: true, time: "09:30" },
      prompts: { daily: LEGACY_DAILY_PROMPT_V3, weekly: LEGACY_WEEKLY_PROMPT_V3, monthly: LEGACY_MONTHLY_PROMPT_V3 },
      push: { enabled: false },
    }));
    const loaded = await readReportConfig(v3Root);
    assert.equal(loaded.prompts.daily, DEFAULT_DAILY_PROMPT, "V3 落盘读回：日报自动升级新默认");
    assert.equal(loaded.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "V3 落盘读回：周报自动升级新默认");
    assert.equal(loaded.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "V3 落盘读回：月报自动升级新默认");
    assert.equal(loaded.daily.time, "09:30", "V3 落盘读回：其余字段不受迁移影响");
    rmSync(v3Root, { recursive: true, force: true });
  }
  // 若老用户对日报有自定义修改，则保留自定义内容，不被覆写
  const userCustomPrompts = normalizeReportConfig({
    prompts: {
      daily: "用户自定义日报：{stats}",
      weekly: LEGACY_WEEKLY_PROMPT_V1,
      monthly: LEGACY_MONTHLY_PROMPT_V1,
    },
  });
  assert.equal(userCustomPrompts.prompts.daily, "用户自定义日报：{stats}", "自定义修改过的模板保留原样");
  assert.equal(userCustomPrompts.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "同时存在的未自定义周报仍平滑升级");
  // 非法 prompts 值回退各周期自身默认模板
  const bad = normalizeReportConfig({ prompts: { daily: "", weekly: 42, monthly: "x".repeat(20001) } });
  assert.equal(bad.prompts.daily, DEFAULT_DAILY_PROMPT, "空串回退该周期默认");
  assert.equal(bad.prompts.weekly, DEFAULT_WEEKLY_PROMPT, "非字符串回退该周期默认");
  assert.equal(bad.prompts.monthly, DEFAULT_MONTHLY_PROMPT, "超长回退该周期默认");
  // promptFor 按周期取模板
  assert.equal(promptFor(n, "daily"), "日模板{stats}", "promptFor daily");
  assert.equal(promptFor(n, "weekly"), "周模板{stats}", "promptFor weekly");
  assert.equal(promptFor(n, "monthly"), "月模板{stats}", "promptFor monthly");
  // 三份默认模板各含 {stats} 且内容互不相同
  assert.ok(DEFAULT_DAILY_PROMPT.includes("{stats}") && DEFAULT_WEEKLY_PROMPT.includes("{stats}") && DEFAULT_MONTHLY_PROMPT.includes("{stats}"), "三默认模板含 {stats}");
  assert.ok(DEFAULT_DAILY_PROMPT !== DEFAULT_WEEKLY_PROMPT && DEFAULT_WEEKLY_PROMPT !== DEFAULT_MONTHLY_PROMPT, "三默认模板互不相同");
  assert.deepEqual(DEFAULT_PROMPTS.daily, DEFAULT_DAILY_PROMPT, "DEFAULT_PROMPTS 表与单常量一致");
  // #544 年报化定稿断言：日报禁 ##（渲染白名单外）；三份均含全局 null 降级纪律与渲染禁项
  assert.ok(!DEFAULT_DAILY_PROMPT.includes("##"), "日报模板禁小标题（白名单无 ##）");
  for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
    assert.ok(tpl.includes("null/0/NaN"), "模板含全局 null 降级纪律");
    assert.ok(tpl.includes("除占比与倍数外不得推算"), "模板含推算边界（占比与倍数豁免）");
    assert.ok(tpl.includes("以 JSON 为准"), "模板含日期以 JSON 为准");
    assert.ok(!tpl.includes("```"), "模板无代码围栏示例");
  }
  assert.ok(DEFAULT_WEEKLY_PROMPT.includes("分母大于 0"), "周报含占比分母除零护栏");
  assert.ok(DEFAULT_MONTHLY_PROMPT.includes("仅一个模型时"), "月报含 byProvider 单条降级");
}

// ---------------------------------------------------------------- #532 渲染管线（escape-then-transform）

{
  // 基本结构：## → h3、- 组 ul/li、普通行 → p、空行断段
  const html = reportBodyToHtml("## 数据亮点\n- 第一项\n- 第二项\n\n正文段落，**强调**收尾。\n## 结语\n只此一句。");
  assert.ok(html.includes("<h3>数据亮点</h3>"), "## → h3");
  assert.ok(html.includes("<ul>") && html.includes("<li>第一项</li>") && html.includes("<li>第二项</li>") && html.includes("</ul>"), "连续 - 组包 ul/li");
  assert.ok(html.includes("<p>正文段落，<strong>强调</strong>收尾。</p>"), "普通行 → p + **x** → strong");
  assert.ok(html.includes("<h3>结语</h3>"), "第二标题");
  // XSS 向量集：转义在前，注入内容恒为实体文本
  const x1 = reportBodyToHtml("## x onerror=alert(1)");
  assert.ok(!/<h3[^>]+o/.test(x1), "h3 标签无属性位可利用（onerror 转义为实体文本）");
  const x2 = reportBodyToHtml('**a" onclick=b**');
  assert.ok(x2.includes("<strong>") && !/<strong[^>]+o/.test(x2), "strong 标签无属性位可利用");
  const x3 = reportBodyToHtml("<script>alert(1)</script>");
  assert.ok(x3.includes("&lt;script&gt;"), "script 标签为实体文本（读侧 sanitizeHtml 第二层兜底）");
  assert.ok(!x3.includes("<script"), "无明文 script 标签");
  const x4 = reportBodyToHtml("- img:<img src=x onerror=y>");
  assert.ok(!/<img/i.test(x4), "列表项内注入 img 被转义");
  // 未闭合 ** 回退字面
  assert.ok(reportBodyToHtml("未闭合 ** 加粗").includes("**"), "未闭合 ** 字面保留");
  // ### 与代码围栏字面显示（只认一档标题与 - 列表）
  const x5 = reportBodyToHtml("### 三级标题\n```code```");
  assert.ok(!x5.includes("<h3>三级标题</h3>"), "### 不当 h3（字面显示）");
  // 往返幂等：管线输出再过一次 sanitizeHtml 白名单标签存活（模拟读侧第二层）
  const sanitized = sanitizeHtml(reportBodyToHtml("## 标题\n- 列表\n**加粗**"));
  assert.ok(sanitized.includes("<h3>") && sanitized.includes("<ul>") && sanitized.includes("<strong>"), "落盘 → 读侧往返白名单标签存活");
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
// #629 P3：本文件不再引入固定 sleep——真后台异步一律 pollUntil 条件等待或链尾 await。

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-sched-"));
  assert.deepEqual(await readLastRun(root), {}, "缺失文件 → 空表");
  await writeLastRun(root, { daily: "2026-09-04", monthly: "2026-08" });
  const roundtrip = await readLastRun(root);
  assert.deepEqual(roundtrip, { daily: "2026-09-04", monthly: "2026-08" }, "writeLastRun → readLastRun roundtrip");
  assert.ok(existsSync(join(root, "reports", "last-run.json")), "last-run.json 落在 historyRoot/reports/ 下");
}

// ---------------------------------------------------------------- ReportTaskQueue：串行单飞 + 入队去重（#625/#626）

{
  let calls = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  const queue = new ReportTaskQueue({
    executor: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30)); // 慢执行：验证串行（不并发）
      concurrent -= 1;
      throw new Error("always-fail"); // 恒失败：任务 failed，不影响串行性
    },
    warn: () => {},
  });
  const due = { period: "daily", key: "2026-09-04", startDay: "2026-09-04", endDay: "2026-09-04" };
  // 同一窗口连续提交（模拟 tick 60s 一次 vs 手动并发）→ 只应有一个 queued/running（P0 入队去重）
  const first = queue.submit(due);
  const second = queue.submit(due);
  assert.equal(second.taskId, first.taskId, "同窗口任务去重：返回同一 taskId");
  // force 提交命中 queued/running → 既有任务 force 升级（#626：重新生成语义不因去重丢失）
  const third = queue.submit({ ...due, force: true });
  assert.equal(third.taskId, first.taskId, "force 提交去重：仍返回同一 taskId");
  assert.equal(queue.get(first.taskId).force, true, "force 升级既有任务");
  // #629 P3：条件等待替代固定 sleep（执行器入口计数是可观测事件）
  await pollUntil(() => calls >= 1, 5000, 5);
  assert.ok(calls >= 1, `至少执行一轮（实际 ${calls}）`);
  assert.equal(maxConcurrent, 1, `串行单飞：执行并发受控为 1（实际 ${maxConcurrent}）`);
  await pollUntil(() => queue.get(first.taskId)?.status === "failed", 5000, 5);
  assert.equal(queue.get(first.taskId).status, "failed", "执行器抛错 → 任务 failed");
  // failed 任务不在 queued/running → 可重新提交（新 taskId）
  const fourth = queue.submit(due);
  assert.notEqual(fourth.taskId, first.taskId, "failed 任务后可重新提交（新 taskId）");
}

// ---------------------------------------------------------------- tick→队列：失败不推进 lastRun + 下轮重试同窗

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-retry-"));
  let execCalls = 0;
  const failedKeys = [];
  const queue = new ReportTaskQueue({
    executor: async (input) => {
      execCalls += 1;
      if (execCalls < 3) {
        failedKeys.push(input.key);
        throw new Error(`boom-${execCalls}`); // 前两轮失败（失败不推进 lastRun）
      }
      // 第三轮成功：模拟 apply 接线的推进语义（执行器临界区内写 lastRun）
      const lastRun = await readLastRun(root);
      lastRun[input.period] = input.key;
      await writeLastRun(root, lastRun);
      return { meta: { period: input.period, key: input.key, startDay: input.startDay, endDay: input.endDay, generatedAt: Date.now(), ok: true } };
    },
    warn: () => {},
  });
  const scheduler = ReportScheduler.start({
    root,
    config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
    onDue: (due) => {
      queue.submit(due);
      return Promise.resolve();
    },
    tickMs: 15,
  });
  // 轮询直到成功路径把 lastRun 落盘（execCalls 计数在 executor 入口自增，
  // 需等写盘完成再断言，防 flake；上限 5s）——#629 P3：pollUntil 条件等待
  const lastRunDaily = await pollUntil(async () => (await readLastRun(root)).daily, 5000, 10);
  scheduler.dispose();
  assert.ok(execCalls >= 3, `失败后下轮重试（实际 ${execCalls} 次）`);
  assert.equal(new Set(failedKeys).size, 1, `重试同一窗口（键集 ${[...failedKeys].join(",")}）`);
  // 第三轮成功 → lastRun 推进为该窗口键（防 tick 重复生成的幂等标记）
  assert.ok(lastRunDaily !== undefined, "成功路径已推进 lastRun");
  assert.equal(lastRunDaily, failedKeys[0], "lastRun.daily === 窗口键");
}

// ---------------------------------------------------------------- scheduler：dispose 停 tick（#629 P3：事件驱动，无固定 sleep）

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-dispose-"));
  let calls = 0;
  let gate: () => void = () => {};
  const gated = new Promise<void>((r) => { gate = r; });
  const scheduler = ReportScheduler.start({
    root,
    config: CFG({ daily: { enabled: true, time: "00:00" }, weekly: { enabled: false, time: "09:00", weekStartsOn: 1 }, monthly: { enabled: false, time: "09:00", dayOfMonth: 1 } }),
    // 模拟 apply 接线的最小推进语义（onDue 提交 → 执行 → lastRun 推进）
    onDue: async (due) => {
      calls += 1;
      gate(); // 「首轮 tick 已发生」事件信号（onDue 入口同步触发）
      const lastRun = await readLastRun(root);
      lastRun[due.period] = due.key;
      await writeLastRun(root, lastRun);
    },
    tickMs: 200, // 拉大 tick 间隔：dispose 确定性赶在第二轮 timer 触发前
  });
  await gated; // 事件等待：首轮启动补跑已发生（不假设耗时，慢 runner 下自然延长）
  // 等首轮 lastRun 落盘收尾（在途 onDue 完成）再 dispose，防断言与写盘竞态
  await pollUntil(() => existsSync(join(root, "reports", "last-run.json")), 5000, 5);
  scheduler.dispose();
  const atDispose = calls;
  // 否定式条件等待（pollUntil 语义）：一个完整 tick 周期窗口内 onDue 不再触发
  // ——timer 已 clearInterval，窗口内泄漏 tick 若存在必然使 calls 增长而失败
  const leaked = await pollUntil(() => calls > atDispose, 250, 10);
  assert.notEqual(leaked, true, "dispose 后不再 tick（计数冻结）");
  // 成功路径推进过 lastRun（首轮启动补跑已生成并落盘）
  assert.ok(existsSync(join(root, "reports", "last-run.json")), "dispose 前的成功生成已推进 lastRun");
}

// ---------------------------------------------------------------- #624 lastRun 推导/闭环判定（纯函数）

{
  const closed = (period, key, generatedAt, endDay) => ({ period, key, generatedAt, endDay, ok: true });
  // 本地时刻 2026-09-07 06:00 → dayKey = "2026-09-07"
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  // 旧语义「当天」daily 记录：发起日 = endDay 当天（09-06 06:00 生成当天窗口）→ 未闭环（#624 根因记录）
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const legacySameDay = closed("daily", "2026-09-06", t606, "2026-09-06");
  // 新语义 daily 记录（发起日 = endDay+1）→ 已闭环
  const closedDaily = closed("daily", "2026-09-06", t607, "2026-09-05");
  assert.equal(isClosedWindowRecord(legacySameDay), false, "旧语义当天窗口 → 未闭环");
  assert.equal(isClosedWindowRecord(closedDaily), true, "新语义昨天窗口 → 已闭环");
  assert.equal(isClosedWindowRecord({ ...closedDaily, ok: false }), false, "失败记录不参与闭环");

  const derived = deriveLastRun([
    legacySameDay, // daily 09-06 旧污染（未闭环，被剔除）
    closedDaily, // daily 09-06 已闭环
    closed("weekly", "2026-08-31", t607, "2026-09-06"),
    closed("monthly", "2026-08", t607, "2026-08-31"),
    closed("daily", "2026-09-04", t607, "2026-09-03"),
  ]);
  assert.deepEqual(derived, { daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08" }, "各期取最近已闭环键");
  assert.deepEqual(deriveLastRun([legacySameDay]), {}, "仅旧污染记录 → 无键（恢复补跑）");
  const y = deriveLastRun([
    closed("monthly", "2026-01", t607, "2025-12-31"),
    closed("monthly", "2025-12", t607, "2025-11-30"),
  ]);
  assert.equal(y.monthly, "2026-01", "monthly 键序跨年正确");
}

// ---------------------------------------------------------------- #624 ensureLastRunMigrated：迁移写回 + 自愈 + 可重放

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-migrate-"));
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  const lastFile = join(reports, "last-run.json");
  const indexFile = join(reports, "index.jsonl");
  const t607 = new Date(2026, 8, 7, 6, 0, 0).getTime();
  const t606 = new Date(2026, 8, 6, 6, 0, 0).getTime();
  const line = (period, key, generatedAt, endDay) => JSON.stringify({ period, key, startDay: endDay, endDay, generatedAt, ok: true });

  // 场景 1：旧 schema + 旧语义污染键（#624 根因现场）→ 校准写回 schema:2
  writeFileSync(lastFile, JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-24", monthly: "2026-08", updatedAt: 1 }));
  writeFileSync(
    indexFile,
    [
      line("daily", "2026-09-04", t607, "2026-09-03"), // 已闭环
      line("daily", "2026-09-06", t606, "2026-09-06"), // 旧语义当天（发起日=endDay，未闭环，被剔除）
      line("weekly", "2026-08-31", t607, "2026-09-06"), // 已闭环
      line("monthly", "2026-08", t607, "2026-08-31"), // 已闭环
    ].join("\n") + "\n",
  );
  const res = await ensureLastRunMigrated(root, () => {});
  assert.equal(res.changed, true, "旧 schema + 污染键 → 发生校准");
  assert.deepEqual(res.after, { daily: "2026-09-04", weekly: "2026-08-31", monthly: "2026-08" }, "迁移后：daily 回退到最近已闭环 09-04（09-06 污染键剔除）");
  const migrated = JSON.parse(readFileSync(lastFile, "utf8"));
  assert.equal(migrated.schema, LAST_RUN_SCHEMA, "写回 schema 版本");
  assert.equal(migrated.daily, "2026-09-04", "写回内容 = 推导结果");

  // 场景 2：schema:2 且与事实一致 → 不再变化（幂等/可重放）
  const res2 = await ensureLastRunMigrated(root, () => {});
  assert.equal(res2.changed, false, "二次运行无变化（可重放幂等）");

  // 场景 3：schema:2 被旧污染键遮蔽（P0-4 自愈）→ 仍校准
  writeFileSync(lastFile, JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08", schema: LAST_RUN_SCHEMA }));
  const res3 = await ensureLastRunMigrated(root, () => {});
  assert.equal(res3.changed, true, "schema:2 遮蔽事故 → 自愈回退");
  assert.equal(res3.after.daily, "2026-09-04", "自愈后 daily 回退到最近已闭环键");

  // 场景 4：无 index（事实源缺失）→ 不动 lastRun
  const root2 = mkdtempSync(join(tmpdir(), "dou-report-migrate2-"));
  mkdirSync(join(root2, "reports"), { recursive: true });
  writeFileSync(join(root2, "reports", "last-run.json"), JSON.stringify({ daily: "2026-09-06", schema: 1 }));
  const res4 = await ensureLastRunMigrated(root2, () => {});
  assert.equal(res4.changed, false, "无 index 事实源 → 保持原状");
  const kept = JSON.parse(readFileSync(join(root2, "reports", "last-run.json"), "utf8"));
  assert.equal(kept.daily, "2026-09-06", "原 lastRun 未被改动");

  // 场景 5（#531 保护）：schema:2 + preset 键（index 无对应记录）→ 温和校准保留 preset 键，
  // 仅对齐「index 存在闭环记录」的期——首次启用不被启动校准删键、不被立即补跑
  {
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-migrate3-"));
    const reports3 = join(root3, "reports");
    mkdirSync(reports3, { recursive: true });
    // 模拟：保存配置时 #531 预置 daily/weekly/monthly 键（index 均无记录），之后手动生成过 weekly
    writeFileSync(join(reports3, "last-run.json"), JSON.stringify({ daily: "2026-09-06", weekly: "2026-08-31", monthly: "2026-08", schema: LAST_RUN_SCHEMA }));
    writeFileSync(join(reports3, "index.jsonl"), [line("weekly", "2026-08-31", t607, "2026-09-06")].join("\n") + "\n");
    const res5 = await ensureLastRunMigrated(root3, () => {});
    assert.equal(res5.changed, false, "preset 键保留 + weekly 已对齐 → 无变化");
    const kept5 = JSON.parse(readFileSync(join(reports3, "last-run.json"), "utf8"));
    assert.equal(kept5.daily, "2026-09-06", "daily preset 键不被删");
    assert.equal(kept5.monthly, "2026-08", "monthly preset 键不被删");
    assert.equal(kept5.weekly, "2026-08-31", "weekly 对齐到最新闭环键");
  }
}

// ---------------------------------------------------------------- #626 读侧投影：一行/窗口=最新版 + 坏行防御

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-proj-"));
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  const indexFile = join(reports, "index.jsonl");
  const line = (generatedAt, key, extra = {}) => JSON.stringify({ period: "daily", key, startDay: key, endDay: key, generatedAt, ok: true, ...extra });
  writeFileSync(
    indexFile,
    [
      line(100, "2026-09-06", { id: "v1" }), // 同日两次手动生成的旧版本
      line(200, "2026-09-06", { id: "v2" }), // 最新版本
      line(300, "2026-09-05", { id: "v3" }),
      "garbage-line", // 坏行跳过
    ].join("\n") + "\n",
  );
  const list = await readReportIndex(root);
  assert.equal(list.length, 2, "同窗口去重为一行");
  assert.equal(list[0].key, "2026-09-05", "倒序：最新 generatedAt 窗口在前");
  const d06 = list.find((m) => m.key === "2026-09-06");
  assert.equal(d06.id, "v2", "同窗口保留最新 generatedAt 版本");
  const parsed = parseReportIndexLines("bad\n" + JSON.stringify({ period: "weekly", key: "2026-08-31", generatedAt: 1, ok: true }));
  assert.equal(parsed.length, 1, "坏行跳过、合法行保留");
}

// ---------------------------------------------------------------- #629 P1 readReportIndex 解析记忆化（mtime 感知缓存）

{
  const root = mkdtempSync(join(tmpdir(), "dou-report-cache-"));
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  const indexFile = join(reports, "index.jsonl");
  __clearReportIndexCacheForTests(); // 隔离：清同进程其他块可能残留的缓存与计数
  // 缺失文件 → 空表（不缓存）
  assert.deepEqual(await readReportIndex(root), [], "index 缺失 → 空表");
  assert.deepEqual(await readReportIndex(root), [], "index 缺失 → 空表（二次调用语义不变）");
  // 首读建缓存
  const metaA = { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 100, ok: true };
  writeFileSync(indexFile, `${JSON.stringify(metaA)}\n`);
  const first = await readReportIndex(root);
  assert.equal(first.length, 1, "首读解析 1 条");
  // 二读命中缓存（投影一致即证，不重复解析语义漂移）
  const second = await readReportIndex(root);
  assert.deepEqual(second, first, "stat 未变 → 命中缓存，投影一致");
  // 计数器确定性证明：连续两读只解析一次（#629 P1「可测」——重复读不再线性重解析）
  {
    const stats = __reportIndexCacheStatsForTests();
    assert.deepEqual(stats, { hits: 1, misses: 1 }, "连续两读：miss=1（只解析一次）+ hit=1（第二读走缓存）");
  }
  // append 一行（size/mtime 双变）→ 重新解析读到新行
  appendFileSync(indexFile, `${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`);
  const third = await readReportIndex(root);
  assert.equal(third.length, 2, "append 后缓存失效并重解析");
  assert.equal(third[0].key, "2026-09-06", "倒序语义在缓存路径同样成立");
  // 原子替换改写（size 不变场景：同字节数内容替换 + utimes 显式设置不同 mtime，
  // 规避同毫秒粒度）→ mtime 变化独立失效
  const tmpSwap = `${indexFile}.swap`;
  writeFileSync(tmpSwap, `${JSON.stringify({ ...metaA, generatedAt: 999 })}\n${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`);
  utimesSync(tmpSwap, /* atime */ new Date(), /* mtime */ new Date(1_700_000_000_000)); // 显式旧 mtime：与 append 时刻必然不同
  renameSync(tmpSwap, indexFile);
  const fourth = await readReportIndex(root);
  assert.equal(fourth.find((m) => m.key === "2026-09-05")?.generatedAt, 999, "size 不变仅 mtime 变 → 仍失效重解析");
  // 命中路径返回浅拷贝——调用方改写返回值不污染缓存
  const before = (await readReportIndex(root)).length;
  const hit = await readReportIndex(root);
  hit.length = 0;
  assert.equal((await readReportIndex(root)).length, before, "命中路径返回的投影不被调用方改写污染");
  // miss 路径返回浅拷贝——与命中路径防御对称：首读（miss）返回值上就地突变不污染缓存
  {
    const missRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-miss-"));
    mkdirSync(join(missRoot, "reports"), { recursive: true });
    writeFileSync(join(missRoot, "reports", "index.jsonl"), `${JSON.stringify(metaA)}\n`);
    const missFirst = await readReportIndex(missRoot);
    assert.equal(missFirst.length, 1, "miss 首读解析 1 条");
    missFirst.push({ ...metaA, key: "MUTATED", generatedAt: 1 });
    const missSecond = await readReportIndex(missRoot);
    assert.equal(missSecond.length, 1, "miss 路径返回值就地 push 后，缓存不被污染");
    assert.ok(!missSecond.some((m) => m.key === "MUTATED"), "后续读不含调用方注入的污染项");
  }
  // root 隔离：不同 historyRoot 互不串缓存
  const otherRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-other-"));
  assert.deepEqual(await readReportIndex(otherRoot), [], "另一 root（无 index）→ 空表，不命中前 root 缓存");
  __clearReportIndexCacheForTests();
}

// ---------------------------------------------------------------- #629 P2 updateLastRun 单一临界区（注入时序验证 lost-update 修复）

{
  // 注入时序形态：patch 函数在临界区内执行，内部 await 一个可控 promise 即可把
  // 「read-modify-write 的中段」挂起——并发方整次更新（readLatest→write）只能排进
  // 串行链，精确复现原缺陷的交错窗（patch 挂起期间他方完成全量写）。
  // ESM 导出只读，不做模块 monkey-patch；导出绑定不可变是语言既有约束。

  // 场景 1（链上串行 + 写前重读）：A 的 patch 挂起期间 B 提交更新 → 修复后 B 基于链上
  // 最新文件态（含 A 已落盘的 daily）合并写；无临界区的旧实现下 B 与 A 各持快照整表
  // 覆盖，终态只剩后写者字段（lost-update）。
  {
    const rootA = mkdtempSync(join(tmpdir(), "dou-report-lra-"));
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let enteredA = false;
    const pa = updateLastRun(rootA, async (cur) => {
      enteredA = true;
      await gateA; // 挂起 A 的临界区（模拟 read-modify-write 中段的 IO 慢）
      return { ...cur, daily: "2026-09-05" };
    });
    await pollUntil(() => enteredA, 5000, 2);
    // A 挂起期间：B 提交 weekly 更新（此刻文件尚为空表——旧快照语义）
    const pb = updateLastRun(rootA, (cur) => ({ ...cur, weekly: "2026-08-31" }));
    // 先释放再收敛（pb 排在 pa 后，先 await pb 会死锁）
    releaseA();
    await Promise.all([pa, pb]);
    const afterA = await readLastRun(rootA);
    assert.equal(afterA.daily, "2026-09-05", "链首 A 的字段最终落盘");
    assert.equal(afterA.weekly, "2026-08-31", "B 排在 A 后写前重读：A 的 daily + B 的 weekly 双字段并存");
  }
  // 场景 2（既有字段不被后续更新覆盖——写前重读的直证）
  {
    const root2 = mkdtempSync(join(tmpdir(), "dou-report-lrseq-"));
    await updateLastRun(root2, (cur) => ({ ...cur, daily: "2026-09-05" }));
    await updateLastRun(root2, (cur) => ({ ...cur, weekly: "2026-08-31" }));
    await updateLastRun(root2, (cur) => ({ ...cur, monthly: "2026-08" }));
    const afterC = await readLastRun(root2);
    assert.deepEqual(
      { daily: afterC.daily, weekly: afterC.weekly, monthly: afterC.monthly },
      { daily: "2026-09-05", weekly: "2026-08-31", monthly: "2026-08" },
      "三字段并存：后续更新不覆盖既有字段（lost-update 不再发生）",
    );
  }
  // 场景 3（同任务交错窗实证——保存配置 preset vs 任务完成推进的双字段并写）：
  // preset 更新（slow patch 挂起）先入链，executor 推进更新在其后提交——
  // 修复后 executor 的 patch 在临界区内基于 preset 已落盘的最新态合并；
  // 原缺陷（无临界区）下 executor 会以空表快照整表覆盖，丢掉 preset 的 weekly。
  {
    const root4 = mkdtempSync(join(tmpdir(), "dou-report-lrrace-"));
    let releasePreset: () => void = () => {};
    const gatePreset = new Promise<void>((r) => { releasePreset = r; });
    let presetEntered = false;
    // 保存配置路径：preset 挂起（模拟 readLastRun IO 慢）
    const pPreset = updateLastRun(root4, async (cur) => {
      presetEntered = true;
      await gatePreset;
      return { ...cur, weekly: "2026-08-31" }; // preset weekly 首启用键
    });
    await pollUntil(() => presetEntered, 5000, 2);
    // 任务执行器路径：完成推进 daily（排在挂起的 preset 之后入链）
    const pExecutor = updateLastRun(root4, (cur) => ({ ...cur, daily: "2026-09-05" }));
    // 先释放再收敛（pExecutor 排在 pPreset 后，先 await pExecutor 会死锁）
    releasePreset();
    await Promise.all([pPreset, pExecutor]);
    const final = await readLastRun(root4);
    assert.equal(final.daily, "2026-09-05", "交错窗：executor 推进的 daily 保留");
    assert.equal(final.weekly, "2026-08-31", "交错窗：preset 的 weekly 保留（lost-update 修复实证）");
  }
  // 场景 4（并发风暴）：10 个并发 updateLastRun 各写各字段 → 终态 10 字段全保留
  {
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-lrstorm-"));
    const writes = Array.from({ length: 10 }, (_, i) =>
      updateLastRun(root3, (cur) => ({ ...cur, [`f${i}`]: `v${i}` })));
    await Promise.all(writes);
    await __lastRunChainForTests(root3);
    // readLastRun 只透出 daily/weekly/monthly 白名单键（schema:1 兼容过滤），
    // f0..f9 断言须读原始落盘文件观察
    const final = JSON.parse(readFileSync(join(root3, "reports", "last-run.json"), "utf8"));
    const kept = Array.from({ length: 10 }, (_, i) => final[`f${i}`]).filter((v) => v !== undefined).length;
    assert.equal(kept, 10, `并发风暴 10 字段全保留（实际保留 ${kept}）`);
    assert.equal(final.schema, 2, "临界区写沿用 schema 版本标记");
  }
  // 场景 5（patch 抛错不阻塞链上后续）
  {
    const root5 = mkdtempSync(join(tmpdir(), "dou-report-lrerr-"));
    await assert.rejects(
      updateLastRun(root5, () => { throw new Error("boom-patch"); }),
      /boom-patch/,
      "patch 抛错向调用方透传",
    );
    await updateLastRun(root5, (cur) => ({ ...cur, daily: "2026-09-04" }));
    const after = await readLastRun(root5);
    assert.equal(after.daily, "2026-09-04", "抛错的更新不落盘且不阻塞后续更新");
  }
}

// ---------------------------------------------------------------- #629 P2 executor 复用 → 队列记录 + status 响应透传 reused

{
  // executor 幂等短路（返回 reused:true）→ task.done 且 task.reused=true →
  // handleReportStatus 响应携带 reused（客户端轮询路径「已复用」提示的数据源）
  const queue = new ReportTaskQueue({
    executor: async () => ({ meta: { period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05", generatedAt: 1, ok: true }, reused: true }),
    warn: () => {},
  });
  const sub = queue.submit({ period: "daily", key: "2026-09-05", startDay: "2026-09-05", endDay: "2026-09-05" });
  const task = await pollUntil(() => {
    const t = queue.get(sub.taskId);
    return t?.status === "done" ? t : undefined;
  }, 5000, 2);
  assert.ok(task !== undefined, "复用任务到达 done");
  assert.equal(task.reused, true, "executor reused:true → task.reused=true");
  // status 路由响应透传 reused（直调 handler：包 {handler} 适配 helpers.callHandler
  // 的三参形态，补 context 实参——handleReportStatus 仅消费 reportQueue 字段）
  const payload = await callHandler(
    { handler: (req, res) => handleReportStatus(req, res, { reportQueue: queue }) },
    {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      method: "GET",
      url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub.taskId}`,
    },
  );
  assert.equal(payload.status, "done", "status done");
  assert.equal(payload.reused, true, "status 响应透传 reused（客户端轮询提示数据源）");
  // 对照：非复用任务（reused 缺省）不携带 reused 字段
  const queue2 = new ReportTaskQueue({
    executor: async () => ({ meta: { period: "daily", key: "2026-09-06", startDay: "2026-09-06", endDay: "2026-09-06", generatedAt: 2, ok: true } }),
    warn: () => {},
  });
  const sub2 = queue2.submit({ period: "daily", key: "2026-09-06", startDay: "2026-09-06", endDay: "2026-09-06" });
  await pollUntil(() => queue2.get(sub2.taskId)?.status === "done", 5000, 2);
  const payload2 = await callHandler(
    { handler: (req, res) => handleReportStatus(req, res, { reportQueue: queue2 }) },
    {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      method: "GET",
      url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub2.taskId}`,
    },
  );
  assert.equal(payload2.status, "done", "非复用任务 status done");
  assert.equal(payload2.reused, undefined, "非复用任务不携带 reused（新生成语义不变）");
}

// ---------------------------------------------------------------- #633 分片 a D1：旧格式（无 cwd/dir 键）报告生成链路回归

{
  // D1 spec：构造升级前格式（无 cwd/dir 键）分片 fixture，断言启动重建、统计/趋势查询、
  // 报告生成三条链路均不抛错且未识别桶计入正确数值。前两条链路由 unit-trend A2 用例
  // 覆盖；本块补报告生成链路：旧格式分片经真实 TrendTracker.start 重建（启动链路）→
  // buckets()（统计/趋势查询面）→ buildStatsSnapshot + generateReport（报告链路）逐级
  // 不抛错；byDirectory 未识别桶数值正确；既有维度与无 dir 维度时零回归。
  const root = mkdtempSync(join(tmpdir(), "dou-report-d1-legacy-"));
  const aggDir = join(root, "agg");
  const detDir = join(root, "details");
  mkdirSync(aggDir, { recursive: true });
  mkdirSync(detDir, { recursive: true });
  const today = dayKey(T0); // 2026-09-04
  // 旧格式行（无 dir 键；形态同 unit-trend A2 fixture）：过去日 agg 权威行 + 当日明细/计数行
  const legacyAgg = { v: TREND_ROW_VERSION, kind: "agg", day: "2026-09-03", provider: "deepseek", model: "deepseek-chat", input: 5000, output: 800, cacheRead: 120, cacheWrite: 10, calls: 30, turns: 12, toolCalls: 40 };
  const legacyDetail = { v: TREND_ROW_VERSION, kind: "detail", time: T0 - HOUR, day: today, session: "旧会话-甲", turn: 3, step: 2, retry: 1, provider: "deepseek", model: "deepseek-chat", input: 1200, output: 300, cacheRead: 45, cacheWrite: 6, calls: 1 };
  const legacyCounter = { v: TREND_ROW_VERSION, kind: "counter", time: T0 - HOUR, day: today, session: "旧会话-甲", provider: "deepseek", model: "deepseek-chat", turns: 1, toolCalls: 1 };
  writeFileSync(join(aggDir, "2026-09-03.jsonl"), `${JSON.stringify(legacyAgg)}\n`);
  writeFileSync(join(detDir, `${today}.jsonl`), `${JSON.stringify(legacyDetail)}\n${JSON.stringify(legacyCounter)}\n`);
  // 链路 1/2（启动重建 + 统计/趋势查询面）：不抛错、两日全量入内存
  const tracker = await TrendTracker.start({ root, now: () => T0, flushDebounceMs: 60000 });
  const buckets = tracker.buckets();
  assert.equal(buckets.length, 2, "旧格式分片重建：过去日 agg 权威行 + 当日明细两日全量入内存（不抛错）");
  // 链路 3（报告生成）：窗口覆盖两日（weekly 形态）——历史输出不缺失
  // dirRows 为升级后 A4 dir 行形态（store.readAggDayShard filter kind:"dir" 的输入面）：
  // 未识别桶由 collector 显式归桶产生（升级后无 cwd 会话），旧格式日无 dir 事实不补造。
  const dirRows = [
    { v: TREND_ROW_VERSION, kind: "dir", day: today, dir: TREND_UNIDENTIFIED, input: 22, output: 11, cacheRead: null, cacheWrite: null, calls: 1, turns: 1, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-10", dir: "窗口外", input: 999, output: 999, cacheRead: null, cacheWrite: null, calls: 9, turns: 9, toolCalls: 9 },
  ];
  const s = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-03", endDay: today, buckets, dirRows, prevTotal: null });
  assert.deepEqual(
    s.byDirectory,
    [{ dir: TREND_UNIDENTIFIED, calls: 1, total: 33 }],
    "byDirectory 未识别桶计入正确数值（窗口外 dir 行不计；旧格式日 09-03 无 dir 事实不补造）",
  );
  assert.equal(s.totals.calls, 31, "历史输出不缺失：calls 与升级前一致（30+1）");
  assert.equal(s.totals.total, 7481, "历史 token 总量不缺失（5930+1551，四项 null-aware 之和）");
  assert.deepEqual(
    s.byDay,
    [{ day: "2026-09-03", total: 5930 }, { day: today, total: 1551 }],
    "byDay 旧数据完整（两日总量一致）",
  );
  // 零回归：同 buckets 无 dir 维度（dirRows 缺省）时既有字段逐字段完全一致
  const s0 = buildStatsSnapshot({ period: "weekly", startDay: "2026-09-03", endDay: today, buckets, prevTotal: null });
  assert.deepEqual(s0.byDirectory, [], "无 dir 行 → byDirectory 空数组（加性可选维度，不补造）");
  const strip = (snap) => {
    const clone = { ...snap };
    delete clone.byDirectory;
    return clone;
  };
  assert.deepEqual(strip(s), strip(s0), "byProvider/byDay/totals/派生维度与无 dir 维度时完全一致（零回归）");
  // {stats} 注入 → generateReport（fake llm）不抛错且成功，byDirectory 进注入面
  const { llm, seen } = fakeLlm();
  const r = await generateReport(GEN({ llm, period: "weekly", key: "2026-09-03", startDay: "2026-09-03", endDay: today, statsJson: JSON.stringify(s) }));
  assert.equal(r.meta.ok, true, "旧格式数据报告生成不抛错且成功");
  assert.ok(seen.options.messages[0].content[0].text.includes(JSON.stringify(s.byDirectory[0])), "{stats} 注入面含未识别目录桶（dir=TREND_UNIDENTIFIED）");
  await tracker.dispose();
  // dir 键防御（与 provider/model 名同口径）：控制字符剥离 + 80 字符截断
  const hostile = buildStatsSnapshot({
    period: "daily",
    startDay: today,
    endDay: today,
    buckets: [],
    dirRows: [{ v: TREND_ROW_VERSION, kind: "dir", day: today, dir: `a\nb${"x".repeat(100)}`, input: 1, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 }],
    prevTotal: null,
  });
  assert.ok(!hostile.byDirectory[0].dir.includes("\n"), "dir 控制字符进快照前已剥离");
  assert.equal(hostile.byDirectory[0].dir.length, 80, "dir 截断至 80 字符（与 byProvider 同口径）");
}

// ---------------------------------------------------------------- #633 分片 b C2：脱敏出口逐条断言（basename 化 + 三出口）

{
  // C2 硬性：目录名进任何对外出口前统一 basename 化（禁完整绝对路径）→ 剥控制
  // 字符 → 截断 80。三出口逐条断言：1) {stats} 注入 JSON；2) 报告产物正文；
  // 3) notifier 推送摘要。
  // 伪造含路径分隔符的 dir 键（isValidDirKey 只查长度，恶意分片行可携带）——
  // 快照出口 basename 化必须锁死「无路径分隔符」承诺。
  const maliciousRows = [
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: "/home/alice/secret-project", input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: "C:\\Users\\bob\\work\\repo", input: 50, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: `x\n\t${"y".repeat(120)}`, input: 10, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: "pro\u009bj", input: 3, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: TREND_UNIDENTIFIED, input: 5, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
  ];
  const snap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [],
    dirRows: maliciousRows,
    prevTotal: null,
  });
  const allDirs = snap.byDirectory.map((r) => r.dir);
  // 出口 1：{stats} 注入 JSON（快照即注入形态；applyPromptTemplate 全文断言）
  const injected = applyPromptTemplate("统计：{stats}", JSON.stringify(snap));
  for (const d of allDirs) {
    assert.ok(!d.includes("/") && !d.includes("\\"), `注入 JSON 目录键无路径分隔符：${JSON.stringify(d)}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(d), `注入 JSON 目录键无 C0+DEL+C1 控制字符：${JSON.stringify(d)}`);
    assert.ok(d.length <= 80, `注入 JSON 目录键 ≤80 字符（实际 ${d.length}）`);
  }
  assert.ok(allDirs.includes("secret-project"), "POSIX 绝对路径出口 = basename");
  assert.ok(allDirs.includes("repo"), "Windows 绝对路径出口 = basename");
  assert.ok(allDirs.includes("proj"), "C1 形态（pro\\u009bj）剥除后 = proj（复核 P1-2）");
  const hostileDir = allDirs.find((d) => d.startsWith("x"));
  assert.ok(hostileDir !== undefined && hostileDir.length <= 80 && !/[\u0000-\u001f]/.test(hostileDir), "控制字符剥除 + 截断 80 形态（剥后残留字面字符保留）");
  assert.ok(!injected.includes("/home/alice"), "注入 JSON 全文不含原始绝对路径");
  assert.ok(!injected.includes("Users\\\\bob") && !injected.includes("Users\\bob"), "注入 JSON 全文不含 Windows 路径");
  // 出口 1.5：无 dir 事实（dirRows 缺省）时 byDirectory 空数组、注入面无目录句
  const noDirSnap = buildStatsSnapshot({ period: "daily", startDay: "2026-09-03", endDay: "2026-09-03", buckets: [], prevTotal: null });
  assert.deepEqual(noDirSnap.byDirectory, [], "无目录事实 → byDirectory 空数组（不补造）");
  // 出口 2：报告产物正文（fake llm 回显目录 basename 的叙事正文；正文为 LLM 叙事——
  // 断言落盘链路 HTML 文档 + meta 不含路径形态，正文载体经 format 净化）
  const { llm, seen } = fakeLlm([
    { type: "text-delta", index: 0, text: "昨天用量集中在 secret-project 与 repo 两个目录。" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: "finish", reason: "stop" },
  ]);
  const r = await generateReport(GEN({ llm, statsJson: JSON.stringify(snap) }));
  assert.equal(r.meta.ok, true, "带目录快照生成成功");
  const promptText = seen.options.messages[0].content[0].text;
  assert.ok(!promptText.includes("/home/alice") && !promptText.includes("Users\\bob"), "{stats} 注入 prompt 全文无绝对路径（出口 2 前置：模型只见 basename 形态）");
  assert.ok(promptText.includes("secret-project") && promptText.includes("repo"), "prompt 含 basename 形态目录名（模型可见面）");
  // 产物正文出口：persistReport 的 HTML 文档与 meta.json 落盘形态（临时目录隔离）
  const rootDir = mkdtempSync(join(tmpdir(), "dou-report-c2-"));
  await persistReport(rootDir, r.meta, r.body);
  const htmlText = readFileSync(reportHtmlFile(rootDir, r.meta.period, r.meta.key), "utf8");
  const metaText = readFileSync(reportMetaFile(rootDir, r.meta.period, r.meta.key), "utf8");
  for (const artifact of [htmlText, metaText]) {
    assert.ok(!artifact.includes("/home/alice") && !artifact.includes("Users\\bob"), "报告产物（HTML/meta）不含绝对路径");
    // 目录键不携带的排版性换行/制表除外（meta.json 为缩进 2 pretty JSON），其余 C0 控制字符不得出现
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(artifact), "报告产物无原始控制字符（排版 \\n/\\t 除外）");
  }
  assert.ok(htmlText.includes("secret-project"), "产物正文含 basename 目录名（LLM 叙事引用）");
  // 出口 3：notifier 推送摘要（notifyReport 捕获 send 请求体）
  const sent = [];
  const fakeCtx = {
    get: () => ({ send: async (req) => { sent.push(req); } }),
  };
  notifyReport(fakeCtx, CFG({ push: { enabled: true } }), r.meta, snap, (s) => s);
  assert.equal(sent.length, 1, "推送已发出");
  const pushBody = `${sent[0].title} ${sent[0].body}`;
  assert.ok(!pushBody.includes("/") && !pushBody.includes("\\"), "推送摘要不含任何路径分隔符（仅周期/窗口/数值）");
  assert.ok(!/[\u0000-\u001f\u007f]/.test(pushBody), "推送摘要无控制字符");
  assert.ok(pushBody.includes("daily"), "推送摘要含周期标识（数值型摘要形态）");
  rmSync(rootDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- #633 分片 b C3：注入面声明与 README 收敛（源码字面断言，#383 先例风格）

{
  // C3 硬性：声明与实现一致——防「注释宣称无路径、实现泄漏路径」的声明回退。
  // 1) generate.ts 注入面注释必须为准确口径（含「目录 basename」与「剥控制字符」）；
  // 2) README 安全模型注入面句必须收敛为 basename 口径，且不得残留旧句
  //    「注入面只含聚合数值（不含会话明细与路径」与裸「摘要不含项目路径；」。
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgDir = join(here, "..");
  const genSrc = readFileSync(join(pkgDir, "src/report/generate.ts"), "utf8");
  assert.ok(genSrc.includes("只含聚合数值与目录 basename"), "generate.ts 注入面注释为准确口径（含目录 basename）");
  assert.ok(genSrc.includes("剥控制字符 + 截断"), "generate.ts 注入面注释含剥控制字符 + 截断口径");
  // 出口实现哨兵：byDirectory 出口必须含 basename 化（两系分隔符切分），不回退
  assert.ok(genSrc.includes("lastIndexOf(\", c.lastIndexOf(\"\\\\\")") || /Math\.max\([^)]*lastIndexOf/.test(genSrc), "buildStatsSnapshot 出口 basename 化实现在场（lastIndexOf 切分）");
  assert.ok(genSrc.includes("TREND_UNIDENTIFIED : safeName"), "剥/切后空串归并未识别桶键（防空标签）");
  const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
  assert.ok(readme.includes("目录 basename"), "README 安全模型收敛为 basename 口径");
  assert.ok(readme.includes("剥控制字符 + 截断 80"), "README 注入口径含剥控制字符 + 截断 80");
  assert.ok(!readme.includes("注入面只含聚合数值（不含会话明细与路径）"), "README 旧句（无目录 basename）已收敛");
  assert.ok(!readme.includes("摘要不含项目路径；"), "README 裸「摘要不含项目路径」句已收敛为准确口径");
  // 模板目录硬规则哨兵（C1 模板升级防回退）
  const cfgSrc = readFileSync(join(pkgDir, "src/report/config.ts"), "utf8");
  for (const sentinel of ["byDirectory 第一位", "工作分散在 N 个目录", "目录版图", "绝不展开为路径、绝不推测目录内容"]) {
    assert.ok(cfgSrc.includes(sentinel), `三周期模板目录硬规则哨兵在场：${sentinel}`);
  }
}

// ---------------------------------------------------------------- #633 分片 b C1：三周期模板硬规则断言（fake llm 抓 prompt）

{
  // C1 硬性：模板输出经 fake llm 抓 prompt 断言目录句式与硬规则——三周期模板
  // 均含目录观察句式与硬规则（目录名 basename 口径、占比分母口径、缺失跳过）。
  const daily = promptFor(CFG(), "daily");
  const weekly = promptFor(CFG(), "weekly");
  const monthly = promptFor(CFG(), "monthly");
  for (const [name, tpl] of [["daily", daily], ["weekly", weekly], ["monthly", monthly]] as const) {
    assert.ok(tpl.includes("byDirectory"), `${name} 模板含 byDirectory 目录观察指引`);
    assert.ok(tpl.includes("绝不展开为路径"), `${name} 模板含目录名 basename 硬规则（不展开为路径）`);
    assert.ok(tpl.includes("totals.total > 0") || tpl.includes("分母大于 0"), `${name} 模板含占比分母硬规则`);
    assert.ok(tpl.includes("绝不输出 null/0/NaN"), `${name} 模板保留 null 降级硬规则`);
  }
  // 周期特有句式：日报可点 top 目录占比；周报「本周」节目录分布观察含中性句；
  // 月报含目录版图小节。
  assert.ok(daily.includes("byDirectory 第一位（最活跃目录）"), "日报模板：可点 top 目录占比句式");
  assert.ok(weekly.includes("工作分散在 N 个目录"), "周报模板：目录分散中性句");
  assert.ok(monthly.includes("目录版图"), "月报模板：目录版图小节");
  // 端到端：带目录快照 → 三周期模板 {stats} 注入 → prompt 落地断言（fake llm）
  const dirSnap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [{ day: "2026-09-03", providers: [{ provider: "p", model: "m", cell: { input: 300, output: null, cacheRead: null, cacheWrite: null, calls: 3, turns: 3, toolCalls: 0 } }] }],
    dirRows: [
      { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: "alpha", input: 200, output: null, cacheRead: null, cacheWrite: null, calls: 2, turns: 0, toolCalls: 0 },
      { v: TREND_ROW_VERSION, kind: "dir", day: "2026-09-03", dir: TREND_UNIDENTIFIED, input: 100, output: null, cacheRead: null, cacheWrite: null, calls: 1, turns: 0, toolCalls: 0 },
    ],
    prevTotal: null,
  });
  assert.deepEqual(dirSnap.byDirectory, [{ dir: "alpha", calls: 2, total: 200 }, { dir: TREND_UNIDENTIFIED, calls: 1, total: 100 }], "快照 byDirectory calls 降序（占比素材）");
  for (const period of ["daily", "weekly", "monthly"] as const) {
    const { llm, seen } = fakeLlm();
    const r = await generateReport(GEN({ llm, period, key: "2026-09-03", startDay: "2026-09-03", endDay: "2026-09-03", promptTemplate: promptFor(CFG(), period), statsJson: JSON.stringify(dirSnap) }));
    assert.equal(r.meta.ok, true, `${period} 生成成功`);
    const text = seen.options.messages[0].content[0].text;
    assert.ok(text.includes('"byDirectory"') && text.includes("alpha"), `${period} prompt 注入含目录维度的统计 JSON`);
    assert.ok(text.includes("绝不展开为路径"), `${period} prompt 携带目录硬规则`);
  }
}

// ---------------------------------------------------------------- #633 分片 b B4：目录范围配置归一化与 round-trip

{
  // B4 硬性：目录范围字段（默认「全部」= 空数组语义或显式 all）——归一化白名单 +
  // 持久化 round-trip + 口径影响（runDueReport 级集成在 smoke 覆盖）。
  // 1) 归一化：非法形态回退空数组（全部）
  assert.deepEqual(normalizeReportConfig({}).directories, [], "缺省 directories → 空数组（全部）");
  assert.deepEqual(normalizeReportConfig({ directories: "all" }).directories, [], "显式 all 字符串 → 空数组");
  assert.deepEqual(normalizeReportConfig({ directories: ["all"] }).directories, [], "all 数组项过滤 → 空数组");
  assert.deepEqual(normalizeReportConfig({ directories: "proj" }).directories, [], "非数组字符串 → 空数组（回退默认）");
  assert.deepEqual(normalizeReportConfig({ directories: [42, null, ""] }).directories, [], "非字符串/空串项全滤 → 空数组");
  // 2) basename 归一（与 C2 出口同口径）：反斜杠/正斜杠路径取末段，控制字符剥除
  assert.deepEqual(normalizeReportConfig({ directories: ["/home/u/proj", "C:\\w\\repo"] }).directories, ["proj", "repo"], "目录范围项 basename 化（两系分隔符）");
  assert.deepEqual(normalizeReportConfig({ directories: ["a\nb"] }).directories, ["ab"], "目录范围项控制字符剥除");
  assert.deepEqual(normalizeReportConfig({ directories: ["pro\u009bj", "x\u0080y"] }).directories, ["proj", "xy"], "目录范围项 C1 控制字符剥除（复核 P1-2）");
  // 3) 去重 + 上限 32（按归一化后的字面值去重；空白不 trim——basename 精确保留）
  assert.deepEqual(normalizeReportConfig({ directories: ["proj", "proj"] }).directories, ["proj"], "目录范围去重（归一化后字面一致）");
  assert.equal(normalizeReportConfig({ directories: Array.from({ length: 40 }, (_, i) => `d${i}`) }).directories.length, 32, "目录范围上限 32 项");
  assert.equal(normalizeReportConfig({ directories: [`x${"y".repeat(300)}`] }).directories[0].length, 256, "目录范围项截断 256（与 trend dir 键防御同口径）");
  // 4) 持久化 round-trip（临时目录隔离）
  const rootDir = mkdtempSync(join(tmpdir(), "dou-report-b4-"));
  const saved = normalizeReportConfig({ directories: ["proj", "repo"], push: { enabled: false } });
  await writeReportConfig(rootDir, saved);
  const loaded = await readReportConfig(rootDir);
  assert.deepEqual(loaded.directories, ["proj", "repo"], "directories 持久化 round-trip 一致");
  // 5) 未配置 directories 的存量配置文件读回 → 默认空数组（不缺键报错）
  const cfgFile = join(rootDir, "reports", "config.json");
  const legacyOnDisk = JSON.parse(readFileSync(cfgFile, "utf8"));
  delete legacyOnDisk.directories;
  writeFileSync(cfgFile, JSON.stringify(legacyOnDisk));
  const reloaded = await readReportConfig(rootDir);
  assert.deepEqual(reloaded.directories, [], "存量配置（无 directories 键）读回 → 默认空数组");
  assert.ok(reloaded.provider !== undefined && typeof reloaded.prompts === "object", "存量配置其余字段不受影响");
  rmSync(rootDir, { recursive: true, force: true });
  // 6) 口径影响：reportCfg.directories 非空 → runDueReport 快照 byDirectory 只含所选目录
  {
    const root = mkdtempSync(join(tmpdir(), "dou-report-b4-scope-"));
    let nowMs = T0;
    const tracker = await TrendTracker.start({
      root,
      now: () => nowMs,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/w/alpha" : "/w/beta"),
    });
    tracker.handleEvent({ id: "s1" }, { type: "request/header", seq: 1, time: T0, data: { header: { config: { provider: "p", model: "m" } } } });
    tracker.handleEvent({ id: "s1" }, { type: "assistant/chunk", seq: 2, time: T0, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } } } });
    tracker.handleEvent({ id: "s2" }, { type: "request/header", seq: 3, time: T0, data: { header: { config: { provider: "p", model: "m" } } } });
    tracker.handleEvent({ id: "s2" }, { type: "assistant/chunk", seq: 4, time: T0, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } } } });
    const fakeCtx = { llm: { stream: () => (async function* () { yield* CHUNKS; })(), listProviders: () => [{ id: "p" }], listModels: async () => [{ id: "m" }] } };
    const due = { period: "daily", key: "2026-09-03", startDay: "2026-09-03", endDay: "2026-09-03", force: true };
    // 全部（空数组）：两目录都在
    const allSnapDirs = await runDueReport({ due, trend: tracker, ctx: fakeCtx, reportCfg: normalizeReportConfig({ push: { enabled: false }, directories: [] }), historyRoot: root, sanitizeDiagnostic: (s) => s });
    assert.ok(allSnapDirs.ok === true, "目录范围=全部：生成成功");
    // 限定单目录（persistReport 已落盘，用 trend.dirRows 直接断言过滤口径）：
    const scoped = normalizeReportConfig({ directories: ["alpha"] }).directories;
    const dirRows = tracker.dirRows().filter((r) => scoped.includes(r.dir));
    assert.deepEqual(dirRows.map((r) => r.dir), ["alpha"], "目录范围激活：目录维度投影只含所选目录（runner 同口径）");
    assert.equal(dirRows[0].input, 100, "所选目录数值为该目录子集（不被其他目录污染）");
    await tracker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("unit-report: all assertions passed");
