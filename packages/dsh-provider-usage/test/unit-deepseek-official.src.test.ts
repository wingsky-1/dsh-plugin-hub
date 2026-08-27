// @ts-nocheck
/**
 * dsh-provider-usage — unit：内置 DeepSeek 官方适配器（issue #198）。
 *
 * 覆盖（对照验收清单分组）：
 * - B 组：取数归一化 / 多币种过滤 / 无 CNY 修订版行为 / 错误码 / 请求形态
 * - C 组：区间记账分类（clean/disturbed/unavailable）+ 降幅口径 + is_available=false 端点策略
 * - E 组：三级密钥链（显式注入 → V1 链 env 推导 → DEEPSEEK_API_KEY 自查兜底）
 * - G 组：峰谷时段常量 / 半开区间 / 周末全谷 / 倒计时单调与钳制 / 徽标渲染
 * - K 组：原型对齐断言（严格解析 / 端点剥离 / 六态错误路径 / GAP 判定 / 分层渲染 /
 *   时区口径 / skipFirst / 面板结构 / 胶囊文案）
 *
 * 纪律：全程无网络（fetch 全部 mock 注入）；无真实凭据（env 用例 try/finally 恢复）；
 * 峰谷判定与倒计时全部以 timestamp 入参注入固定 epoch，判定路径无墙钟调用（T3）。
 */
console.error("EVAL-ORDER-TAG: DS-OFFICIAL");
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { assert } from "./helpers.ts";
import {
  esc,
  sanitizeHtml,
  isUsageStatsAdapter,
  resolveProviderConfig,
  runV2Pipeline,
  openCodeGoAdapter,
  OPENCODE_GO_ADAPTER_ID,
  deepSeekOfficialAdapter,
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_ADAPTER_ID,
  PEAK_WINDOWS_UTC,
  isPeakUtc,
  nextPeakTransition,
  peakBadgeHtml,
  parseAmount,
  resolveEndpoint,
  classifyIntervalDs,
  aggregateDaily,
  dayKey,
  lastNDayKeys,
  niceCeil,
  GAP_MS,
  TOL,
  ANOMALY_NEG,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 时间戳辅助（固定 epoch，T3）

/** UTC 时间戳便捷构造（月份 1–12）。 */
const utc = (y, mo, d, hh, mi, ss = 0, ms = 0) => Date.UTC(y, mo - 1, d, hh, mi, ss, ms);
// 2026-08-24 为周一（24/25/26/27/28 = 一至五；29/30 = 六/日）
const MON = (hh, mi, ss = 0, ms = 0) => utc(2026, 8, 24, hh, mi, ss, ms);
const SAT = (hh, mi, ss = 0, ms = 0) => utc(2026, 8, 29, hh, mi, ss, ms);
const SUN = (hh, mi, ss = 0, ms = 0) => utc(2026, 8, 30, hh, mi, ss, ms);

/** 构造 mock Response（官方文档示例 JSON 形态蓝本）。 */
function mockRes(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** 构造官方 balance 响应体。 */
function officialBody(cny = {}, extraInfos = [], isAvailable = true) {
  return {
    is_available: isAvailable,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "110.00",
        topped_up_balance: "90.00",
        granted_balance: "20.00",
        ...cny,
      },
      ...extraInfos,
    ],
  };
}

/** 捕获请求形态的 mock fetch。 */
function capturingFetch(res) {
  const calls = [];
  const f = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(typeof res === "function" ? res(url, init) : res);
  };
  return { f: f as unknown as typeof fetch, calls };
}

// ================================================================ B1 + 契约自检

{
  assert.equal(isUsageStatsAdapter(deepSeekOfficialAdapter), true, "内置 DeepSeek 适配器通过 v2 契约校验");
  assert.equal(deepSeekOfficialAdapter.name, DEEPSEEK_OFFICIAL_ADAPTER_ID);
  assert.equal(deepSeekOfficialAdapter.name, "deepseek-official-builtin", "name 加 -builtin 后缀（有意差异 K12）");
  assert.equal(deepSeekOfficialAdapter.version, 2, "version===2");
  assert.deepEqual(deepSeekOfficialAdapter.providers, ["deepseek-official"], "认领 deepseek-official provider");
  assert.equal(typeof deepSeekOfficialAdapter.fetchData, "function");
  assert.equal(typeof deepSeekOfficialAdapter.formatCapsule, "function");
  assert.equal(typeof deepSeekOfficialAdapter.formatPanel, "function");
}

// ================================================================ B2/K1 余额解析 + 归一化输出

{
  const { f, calls } = capturingFetch(mockRes(200, officialBody()));
  const out = await deepSeekOfficialAdapter.fetchData({
    apiEndpoint: "https://api.deepseek.com", staticPath: "", apiKey: "sk-unit",
    provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
  });
  assert.equal(out.isAvailable, true);
  assert.equal(out.balance, 110, 'total_balance:"110.00" → 数值 110');
  assert.equal(out.toppedUp, 90);
  assert.equal(out.grantedBalance, 20);
  // B6 请求形态：Bearer 密钥在头里，URL 与查询串不含密钥
  assert.match(calls[0].init.headers.Authorization, /^Bearer sk-unit$/, "Authorization: Bearer <key>");
  assert.ok(!String(calls[0].url).includes("sk-unit"), "URL 不携带密钥");
  assert.equal(calls[0].init.headers.Accept, "application/json");
}

{
  // 金额非法形态 → null（杜绝 NaN 落盘）
  const { f } = capturingFetch(mockRes(200, officialBody({ total_balance: "abc", topped_up_balance: "", granted_balance: undefined })));
  const out = await deepSeekOfficialAdapter.fetchData({
    apiEndpoint: "", staticPath: "", apiKey: "sk-unit",
    provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
  });
  assert.equal(out.balance, null, "非法金额字符串 → null");
  assert.equal(out.toppedUp, null, "空串 → null");
  assert.equal(out.grantedBalance, null, "缺失字段 → null");
}

assert.equal(parseAmount("12.34"), 12.34);
assert.equal(parseAmount("  5 "), 5);
assert.equal(parseAmount(""), null);
assert.equal(parseAmount("abc"), null);
assert.equal(parseAmount("NaN"), null);
assert.equal(parseAmount(undefined), null);
assert.equal(parseAmount(null), null);
assert.equal(parseAmount("Infinity"), null, "Infinity 非有限数 → null");

// ================================================================ B3 多币种仅留 CNY

{
  const usd = { currency: "USD", total_balance: "15.50", topped_up_balance: "15.50", granted_balance: "0.00" };
  const { f } = capturingFetch(mockRes(200, officialBody({}, [usd])));
  const out = await deepSeekOfficialAdapter.fetchData({
    apiEndpoint: "", staticPath: "", apiKey: "sk-unit",
    provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
  });
  assert.equal(out.balance, 110, "USD 共存时仍取 CNY 余额");
}

// ================================================================ B4（修订版）无 CNY → null 正常帧

{
  for (const infos of [
    [{ currency: "USD", total_balance: "15.50" }],
    [],
  ]) {
    const { f } = capturingFetch(mockRes(200, { is_available: true, balance_infos: infos }));
    const out = await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "", staticPath: "", apiKey: "sk-unit",
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
    });
    assert.deepEqual(
      [out.balance, out.toppedUp, out.grantedBalance],
      [null, null, null],
      `无 CNY 条目（${JSON.stringify(infos).slice(0, 30)}…）→ 全 null 正常帧不抛错`,
    );
    assert.equal(out.isAvailable, true);
  }
}

// ================================================================ B5/K3 错误路径六态（参数化）

{
  const baseCtx = { apiEndpoint: "", staticPath: "", apiKey: "sk-unit", provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000 };

  // no-api-key
  await assert.rejects(
    () => deepSeekOfficialAdapter.fetchData({ ...baseCtx, apiKey: undefined }),
    (e) => e.message === "no-api-key",
  );

  // AbortError 重抛（超时取消不被吞成 network）
  const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const abortF = (() => Promise.reject(abortErr)) as unknown as typeof fetch;
  await assert.rejects(
    () => deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: abortF }),
    (e) => e.name === "AbortError" && e.message === "The operation was aborted",
    "AbortError 必须原样重抛",
  );

  // 连接异常 → network
  const boomF = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  await assert.rejects(() => deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: boomF }), (e) => e.message === "network");

  // 401 / 403 → unauthorized；其他非 2xx → http-<code>；非 JSON → bad-json
  for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [500, "http-500"], [429, "http-429"]]) {
    await assert.rejects(
      () => deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: (() => Promise.resolve(mockRes(status, {}))) as unknown as typeof fetch }),
      (e) => e.message === expected,
      `${status} → ${expected}`,
    );
  }
  const badJsonF = (() => Promise.resolve({ status: 200, ok: true, json: async () => { throw new Error("Unexpected token"); } })) as unknown as typeof fetch;
  await assert.rejects(
    () => deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: badJsonF }),
    (e) => e.message === "bad-json",
  );
}

// ================================================================ K2 端点解析（/v1 剥离）

{
  assert.equal(resolveEndpoint(undefined), "https://api.deepseek.com/user/balance", "缺省用官方基址");
  assert.equal(resolveEndpoint(""), "https://api.deepseek.com/user/balance");
  assert.equal(resolveEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/user/balance");
  assert.equal(resolveEndpoint("https://api.deepseek.com/v1"), "https://api.deepseek.com/user/balance", "官方域名剥 /v1");
  assert.equal(resolveEndpoint("https://api.deepseek.com/v1/"), "https://api.deepseek.com/user/balance", "剥 /v1/ 尾斜杠");
  assert.equal(resolveEndpoint("https://API.DEEPSEEK.COM/V1"), "https://API.DEEPSEEK.COM/user/balance", "大小写不敏感剥前缀");
  assert.equal(resolveEndpoint("http://127.0.0.1:9"), "http://127.0.0.1:9/user/balance", "非官方端点原样拼接");
  assert.equal(resolveEndpoint("http://127.0.0.1:9///"), "http://127.0.0.1:9/user/balance", "多尾斜杠归一");
  // 实际请求 URL 经捕获断言（mock 注入）
  const { f, calls } = capturingFetch(mockRes(200, officialBody()));
  await deepSeekOfficialAdapter.fetchData({
    apiEndpoint: "https://api.deepseek.com/v1/", staticPath: "", apiKey: "sk-unit",
    provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
  });
  assert.equal(String(calls[0].url), "https://api.deepseek.com/user/balance");
}

// ================================================================ E 组 三级密钥链

{
  // E1 显式注入优先，env 干扰不影响
  const savedEnvKey = process.env.DEEPSEEK_OFFICIAL_API_KEY;
  const savedDsKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_OFFICIAL_API_KEY = "sk-env-noise";
    process.env.DEEPSEEK_API_KEY = "sk-ds-noise";
    const resolved = await resolveProviderConfig(DEEPSEEK_OFFICIAL_PROVIDER, undefined, { apiKey: "sk-explicit" });
    assert.equal(resolved.apiKey, "sk-explicit", "ctx.apiKey 有值时不读 env");
  } finally {
    if (savedEnvKey === undefined) delete process.env.DEEPSEEK_OFFICIAL_API_KEY; else process.env.DEEPSEEK_OFFICIAL_API_KEY = savedEnvKey;
    if (savedDsKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedDsKey;
  }
}

{
  // E2 V1 链推导：provider deepseek-official → env DEEPSEEK_OFFICIAL_API_KEY
  const saved = { dsh: process.env.DSH_HOME, home: process.env.HOME, env: process.env.DEEPSEEK_OFFICIAL_API_KEY };
  try {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-e2-"));
    process.env.HOME = process.env.DSH_HOME;
    process.env.DEEPSEEK_OFFICIAL_API_KEY = "sk-from-derived-env";
    const resolved = await resolveProviderConfig(DEEPSEEK_OFFICIAL_PROVIDER, undefined, {});
    assert.equal(resolved.apiKey, "sk-from-derived-env", "大写+连字符转下划线规则推导 env");
  } finally {
    if (saved.dsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.dsh;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.env === undefined) delete process.env.DEEPSEEK_OFFICIAL_API_KEY; else process.env.DEEPSEEK_OFFICIAL_API_KEY = saved.env;
  }
}

{
  // E3 适配器内自查 DEEPSEEK_API_KEY 兜底（llm 能跑、余额接口 401 场景）
  const savedDs = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-ds-fallback";
    const { f, calls } = capturingFetch(mockRes(200, officialBody()));
    const out = await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "", staticPath: "", apiKey: undefined,
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
    });
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ds-fallback", "DEEPSEEK_API_KEY 自查兜底生效");
    assert.equal(out.balance, 110);
  } finally {
    if (savedDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedDs;
  }
}

// ================================================================ C/K4 区间记账分类（classifyIntervalDs，不做代数相消）

{
  const pt = (t, balance, toppedUp, granted, available = true) => ({ t, balance, toppedUp, granted, available });

  // C1 纯消费区间：topped/granted 不变 → clean，消耗 = 余额降幅（可与平台账单对账）
  const c1 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 95, 90, 10));
  assert.equal(c1.type, "clean", "无扰动区间 → clean");
  assert.equal(c1.drop, 5, "消耗 = 余额降幅 5");

  // C2 充值混合区间：topped 90→130（入账 +40，余额同步上涨）→ disturbed 提取事件额
  const c2 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 135, 130, 10));
  assert.equal(c2.type, "disturbed", "充值上涨 → 扰动混合区间");
  assert.equal(c2.topup, 40, "提取充值事件额 +40（不与消耗混算）");

  // C3 赠款变动：granted 10→20 → disturbed
  const c3 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 110, 90, 20));
  assert.equal(c3.type, "disturbed");
  assert.equal(c3.grantDelta, 10);

  // C4 不可用端点：任一帧 is_available=false → 整段跳过
  const c4 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 95, 90, 10, false));
  assert.equal(c4.type, "unavailable");

  // C5 分量缺失（旧分片 toppedUp/granted 为 null）→ 纯净变动口径仍可计
  const c5 = classifyIntervalDs(pt(0, 100, null, null), pt(1, 93, null, null));
  assert.equal(c5.type, "clean", "分量缺失退化为净变动口径");
  assert.equal(c5.drop, 7);
}

// ================================================================ C/K5/K6/K7/K9 日聚合（闭环基线 / GAP / 分层 / skipFirst）
// ================================================================ 日聚合 v2.3 区间记账（归属结束端日 / GAP 注记 / 分层 / 冷启动 / 充值列示）

{
  // G1 GAP 区间不计消耗但保留提示注记（旧版产出 gap 柱状态；新口径按区间记账）
  const far = 30 * 3600000;
  const pts = [
    { t: MON(0, 0), balance: 100, toppedUp: 90, granted: 10 },
    { t: MON(23, 0) + far - MON(0, 0), balance: 95, toppedUp: 90, granted: 10 }, // 相距 30h
  ];
  void far;
}

{
  // G1b 跨度 >27h 的区间落在某日 → 该日 ok/0 + 「中断」注记
  const t0 = MON(22, 0);
  const t1 = t0 + 30 * 3600000; // 周二 04:00（跨日）
  const pts = [
    { t: t0, balance: 100, toppedUp: 90, granted: 10 },
    { t: t1, balance: 95, toppedUp: 90, granted: 10 },
  ];
  const recs = aggregateDaily(pts, [dayKey(t1)], false);
  assert.equal(recs[0].status, "ok", "中断区间不产生异常态");
  assert.equal(recs[0].u, 0, "中断区间不计消耗");
  assert.ok(String(recs[0].extra).includes("中断"), "注记数据中断段数");
}

{
  // G2 归属规则：区间计入结束端所在日——跨午夜隔夜消费不丢失（旧基线法整段掉落）
  // 本地时区构造（dayKey 归组口径）：避免 UTC 助手与本地日切错位
  const satNight = new Date(2026, 7, 29, 22, 30).getTime(); // 本地周六
  const sunEarly = new Date(2026, 7, 30, 0, 30).getTime();  // 本地周日（隔夜段，2h ≤ GAP）
  const sunNoon = new Date(2026, 7, 30, 10, 30).getTime();
  const pts = [
    { t: satNight, balance: 100, toppedUp: 90, granted: 10 },
    { t: sunEarly, balance: 99, toppedUp: 90, granted: 10 },  // 隔夜消耗 1 → 计入周日
    { t: sunNoon, balance: 94, toppedUp: 90, granted: 10 },   // 周日内消耗 5
  ];
  const recs = aggregateDaily(pts, [dayKey(satNight), dayKey(sunEarly)], false);
  const satRec = recs.find((r) => r.key === dayKey(satNight));
  const sunRec = recs.find((r) => r.key === dayKey(sunEarly));
  assert.equal(satRec.status, "insufficient", "周六仅起点帧、无结束于当日的区间 → 无可计区间");
  assert.equal(sunRec.status, "ok");
  assert.equal(sunRec.u, 6, "周日合计 = 隔夜段 1 + 日内段 5（跨午夜连续归账）");
}

{
  // G3 冷启动自然成立：当日 ≥2 帧即出数（无需旧版跨日基线/日内兜底标记）
  const d0 = utc(2026, 8, 24, 9, 0);
  const d1 = utc(2026, 8, 24, 15, 0);
  const recs = aggregateDaily(
    [
      { t: d0, balance: 50, toppedUp: 50, granted: 0 },
      { t: d1, balance: 47, toppedUp: 47, granted: 0 },
    ],
    [dayKey(d0)],
    false,
  );
  assert.equal(recs[0].status, "ok", "冷启动首日按日内区间直接出数");
  assert.equal(recs[0].u, 3, "消耗 = 日内区间降幅 50−47=3");
  assert.equal(recs[0].intraday, undefined, "v2.3 无需 intraday 标记");
}

{
  // C6 单帧历史：当日有帧但无可计区间 → insufficient（不得把余额绝对值误计为用量）
  const only = { t: MON(8, 0), balance: 88, toppedUp: 80, granted: 8 };
  const recs = aggregateDaily([only], [dayKey(MON(8, 0))], false);
  assert.equal(recs[0].status, "insufficient", "无可计区间 → 样本不足");
  assert.equal(recs[0].u, 0);
}

{
  // G4 充值事件独立列示：充值区间漏计、事件额 toppedUpIn 汇出
  const d0 = utc(2026, 8, 24, 10, 0);
  const d1 = utc(2026, 8, 24, 11, 0);   // 充值 +45.62（余额 10→55.62）
  const d2 = utc(2026, 8, 24, 12, 0);   // 纯消费 1 元
  const pts = [
    { t: d0, balance: 10, toppedUp: 10, granted: 0 },
    { t: d1, balance: 55.62, toppedUp: 55.62, granted: 0 },
    { t: d2, balance: 54.62, toppedUp: 55.62, granted: 0 },
  ];
  const recs = aggregateDaily(pts, [dayKey(d2)], false);
  assert.equal(recs[0].status, "ok");
  assert.equal(Math.abs(recs[0].u - 1) < 1e-9, true, "仅纯消费区间落账 1 元（充值区间漏计）");
  assert.ok(String(recs[0].extra).includes("充值 +¥45.62 未计入"), "充值额在 extra 注明");
  assert.equal(recs[0].toppedUpIn, 45.62, "充值事件额供汇总行独立展示");
}

{
  // G5 分层渲染映射到 clean 降幅之和：容差归零 / 轻微负值 neg 绿柱 / 大额负值异常
  const d0 = utc(2026, 8, 25, 9, 0);
  const d1 = utc(2026, 8, 25, 19, 0);
  const mk = (bPrev, bCur) => [
    { t: d0, balance: bPrev, toppedUp: 90, granted: 10 },
    { t: d1, balance: bCur, toppedUp: 90, granted: 10 },
  ];
  const zero = aggregateDaily(mk(100, 100 - TOL / 2), [dayKey(d1)], false)[0];
  assert.equal(zero.status, "ok", "|u|≤TOL → ok");
  assert.equal(zero.u, 0, "容差内归零");

  const gainSmall = aggregateDaily(mk(100, 100.5), [dayKey(d1)], false)[0];
  assert.equal(gainSmall.neg, true, "轻微负值（余额小涨且无扰动）→ neg 绿柱");
  assert.ok(gainSmall.u < 0 && gainSmall.u >= ANOMALY_NEG);

  const anom = aggregateDaily(mk(100, 102.5), [dayKey(d1)], false)[0];
  assert.equal(anom.status, "anomaly", "大额净增 → 异常标注");
  assert.equal(anom.u, 0);
  assert.ok(String(anom.note).includes("异常"));
}

{
  // G6 truncated 参数保留但不再弃首日（区间记账天然不受截断影响）
  const d0 = utc(2026, 8, 26, 9, 0);
  const d1 = utc(2026, 8, 26, 15, 0);
  const pts = [
    { t: d0, balance: 50, toppedUp: 50, granted: 0 },
    { t: d1, balance: 46, toppedUp: 50, granted: 0 },
  ];
  const keys = [dayKey(d1)];
  assert.deepEqual(
    aggregateDaily(pts, keys, true).map((r) => [r.status, r.u]),
    aggregateDaily(pts, keys, false).map((r) => [r.status, r.u]),
    "truncated 与否结果一致（v2.3 无 skipFirst）",
  );
}

{
  // G7 不可用端点策略：is_available=false 帧两侧区间均跳过（帧值不可信），注记承载
  const d0 = utc(2026, 8, 27, 8, 0);
  const d1 = utc(2026, 8, 27, 9, 0);   // 该帧不可用：d0→d1 与 d1→d2 两段都跳过
  const d2 = utc(2026, 8, 27, 10, 0);
  const pts = [
    { t: d0, balance: 100, toppedUp: 90, granted: 10, available: true },
    { t: d1, balance: 60, toppedUp: 90, granted: 10, available: false },
    { t: d2, balance: 56, toppedUp: 90, granted: 10, available: true },
  ];
  const recs = aggregateDaily(pts, [dayKey(d2)], false);
  assert.equal(recs[0].status, "ok", "跳过不产生异常态");
  assert.equal(recs[0].u, 0, "不可用帧相邻区间不计（含本应可疑的 40 元降幅）");
  assert.ok(String(recs[0].extra).includes("不可用区间不计"), "注记说明未计原因");
  // 对照：全部可用时同日两段降幅均按 clean 落账（40+4=44；无不可用帧则账面降幅即口径）
  const okPts = pts.map((p) => ({ ...p, available: true }));
  const okRecs = aggregateDaily(okPts, [dayKey(d2)], false);
  assert.equal(okRecs[0].u, 44, "全可用时同日区间链式落账 40+4=44");
}

// ================================================================ K8 日聚合时区口径

{
  // dayKey 用宿主进程本地时区：本地某日 07:00（东八区即 UTC 前一日 23:00）不得划入前一天
  const localMorning = new Date(2026, 7, 24, 7, 0, 0).getTime();
  assert.equal(dayKey(localMorning), "2026-08-24", "本地时区归组（禁 toISOString 的 UTC 归组）");
  // 本地零点前后各一秒同日
  const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
  assert.equal(dayKey(midnight), "2026-08-24");
  assert.equal(dayKey(midnight - 1), "2026-08-23", "零点前一秒属前一日（本地口径）");

  // lastNDayKeys 逐日 setDate 回退：跨月/数量/升序/今日收尾
  const now = new Date(2026, 2, 1, 12, 0).getTime(); // 2026-03-01 本地
  const keys = lastNDayKeys(15, now);
  assert.equal(keys.length, 15);
  assert.equal(keys[14], "2026-03-01", "末日=今日");
  assert.equal(keys[13], "2026-02-28", "跨月回退正确（2026 非闰年）");
  assert.equal(new Set(keys).size, 15, "无重复日");
  assert.deepEqual([...keys].sort(), keys, "升序排列");
}

// ================================================================ niceCeil

{
  assert.equal(niceCeil(0), 10, "非正数回默认 10");
  assert.equal(niceCeil(-5), 10);
  assert.equal(niceCeil(0.7), 1);
  assert.equal(niceCeil(1.4), 2);
  assert.equal(niceCeil(3.2), 5);
  assert.equal(niceCeil(7), 10);
  assert.equal(niceCeil(17), 20);
  assert.equal(niceCeil(140), 200);
}

// ================================================================ G 组 峰谷时段常量与倒计时

{
  // G1 常量存在 + 源码注释附官方定价 URL 与核实日期
  assert.deepEqual(PEAK_WINDOWS_UTC.map(([s, e]) => [s, e]), [[60, 240], [360, 600]], "PEAK_WINDOWS_UTC=[[01:00,04:00],[06:00,10:00]]（分钟）");
  const src = readFileSync(join(here, "..", "src", "adapters", "deepseek-official.mjs"), "utf8");
  assert.ok(src.includes("https://api-docs.deepseek.com/quick_start/pricing"), "注释附官方定价 URL");
  assert.ok(src.includes("2026-08-26"), "注释附核实日期");
}

{
  // G2 半开区间（毫秒精度）：周一 UTC 01:00:00.000 属峰；03:59:59.999 属峰；04:00:00.000 属谷；
  // 06:00 开峰；10:00:00.000 切谷
  assert.equal(isPeakUtc(MON(1, 0, 0, 0)), true, "01:00:00.000 属峰（左闭）");
  assert.equal(isPeakUtc(MON(3, 59, 59, 999)), true, "03:59:59.999 属峰");
  assert.equal(isPeakUtc(MON(4, 0, 0, 0)), false, "04:00:00.000 即属谷（右开）");
  assert.equal(isPeakUtc(MON(6, 0, 0, 0)), true, "06:00 开峰");
  assert.equal(isPeakUtc(MON(9, 59, 59, 999)), true, "09:59:59.999 属峰");
  assert.equal(isPeakUtc(MON(10, 0, 0, 0)), false, "10:00 切谷");
  assert.equal(isPeakUtc(MON(0, 59, 59, 999)), false, "00:59:59.999 属谷");
}

{
  // G3 工作日窗口外全谷
  assert.equal(isPeakUtc(MON(0, 30)), false, "周一 00:30 谷");
  assert.equal(isPeakUtc(MON(5, 0)), false, "04:00–06:00 间谷");
  assert.equal(isPeakUtc(MON(12, 0)), false, "午间谷");
  assert.equal(isPeakUtc(utc(2026, 8, 28, 23, 0)), false, "周五 23:00 谷");
  assert.equal(isPeakUtc(utc(2026, 8, 28, 15, 0)), false, "周五 15:00 谷（10:00 切谷后）");
}

{
  // G4 周末全天低谷（issue 点名用例）
  for (const [hh, mi] of [[0, 0], [2, 30], [7, 0], [8, 0], [12, 0], [23, 59]]) {
    assert.equal(isPeakUtc(SAT(hh, mi)), false, `周六 ${hh}:${mi} 谷`);
    assert.equal(isPeakUtc(SUN(hh, mi)), false, `周日 ${hh}:${mi} 谷`);
  }
  // 跨日衔接：周六 23:59:59.999 → 周日 00:00:00.000 均谷；周日 23:59:59.999 → 周一 00:00:00.000 均谷
  assert.equal(isPeakUtc(SAT(23, 59, 59, 999)), false);
  assert.equal(isPeakUtc(SUN(0, 0, 0, 0)), false);
  assert.equal(isPeakUtc(SUN(23, 59, 59, 999)), false);
  assert.equal(isPeakUtc(MON(0, 0, 0, 0)), false, "周一 00:00 仍谷（01:00 才开峰）");
}

{
  // G6 边界钳制翻转：边界后滞后时刻显示新状态且倒计时 ≥0，无负值/"-00:00"
  const justAfter = MON(4, 0, 0, 500); // 04:00:00.500
  assert.equal(isPeakUtc(justAfter), false, "已翻转到谷");
  const tr = nextPeakTransition(justAfter);
  assert.equal(tr.toPeak, true, "谷态下一次转换为开峰");
  assert.equal(tr.at, MON(6, 0), "转换点是 06:00");
  const badge = peakBadgeHtml(justAfter);
  assert.ok(!badge.includes("-00:"), "不出现负值形态");
  assert.ok(badge.includes("距峰 02:"), `倒计时约 2 小时（实际 ${badge}）`);

  // 边界前 1ms 仍属峰、指向切谷
  const justBefore = MON(4, 0, 0, 0) - 1;
  assert.equal(isPeakUtc(justBefore), true);
  assert.equal(nextPeakTransition(justBefore).at, MON(4, 0), "峰态下一切换为切谷");
}

{
  // G7 倒计时单调递减 + 长谷段有效非负
  const t1 = MON(1, 30);
  const t2 = MON(1, 31);
  const tr1 = nextPeakTransition(t1);
  const tr2 = nextPeakTransition(t2);
  assert.equal(tr1.at, tr2.at, "同时段转换点相同");
  assert.ok(tr1.at - t1 > tr2.at - t2, "t2>t1 → 剩余时长严格变小");
  // 长谷段：周日 12:00 UTC 距周一 01:00 约 13h
  const sunNoon = SUN(12, 0);
  const trSun = nextPeakTransition(sunNoon);
  assert.equal(trSun.toPeak, true);
  assert.equal(trSun.at, utc(2026, 8, 31, 1, 0), "周末谷的下一次开峰在下周一 01:00 UTC");
  const remainMin = Math.round((trSun.at - sunNoon) / 60000);
  assert.equal(remainMin, 13 * 60, "恰 13 小时");
  const badge = peakBadgeHtml(sunNoon);
  assert.match(badge, /距峰 13:00/, "长谷段产出有效非负倒计时");
  // 最长谷段：周五 10:00 切谷 → 下周一 01:00 = 63h
  const friAfter = utc(2026, 8, 28, 10, 0);
  assert.equal(nextPeakTransition(friAfter).at, utc(2026, 8, 31, 1, 0), "周五切谷后的下次开峰跨周末");
  assert.match(peakBadgeHtml(friAfter), /距峰 63:00/);
}

{
  // G5/G9 徽标渲染于胶囊余额文本之后 + tooltip 注明 UTC 定义与时区对照
  const caps = deepSeekOfficialAdapter.formatCapsule({
    time: SUN(12, 0),
    data: { balance: 110.5, isAvailable: true },
    status: "fresh",
    esc,
  });
  assert.ok(caps.includes("余额 ¥110.50"), "余额两位小数");
  assert.ok(caps.indexOf("余额 ¥") < caps.indexOf("dou-peak"), "徽标追加于余额文本之后");
  assert.match(caps, /⚡谷 · 距峰 \d{2,}:\d{2}/, "谷态显示距下次开峰倒计时");
  assert.ok(caps.includes("title="), "tooltip 存在");
  assert.ok(caps.includes("UTC"), "tooltip 注明 UTC 时段定义");
  assert.ok(caps.includes("服务器时区"), "tooltip 含服务器时区对照提示");

  const capsPeak = deepSeekOfficialAdapter.formatCapsule({
    time: MON(2, 0),
    data: { balance: 110.5, isAvailable: true },
    status: "fresh",
    esc,
  });
  assert.match(capsPeak, /⚡峰 · 距谷 \d{2,}:\d{2}/, "峰态显示距切谷倒计时");
  assert.ok(capsPeak.includes("dou-peak-on"), "峰态配色类");

  // K11 无数据 / 不可用 / 缓存标记
  const empty = deepSeekOfficialAdapter.formatCapsule({
    time: MON(2, 0), data: {}, status: "stale", esc,
  });
  assert.ok(empty.includes("DeepSeek 余额 --"), "无数据显示 -- 占位");
  assert.ok(empty.includes("(缓存)"), "stale 显示 (缓存) 标记");
  const unavail = deepSeekOfficialAdapter.formatCapsule({
    time: MON(2, 0), data: { balance: 5, isAvailable: false }, status: "fresh", esc,
  });
  assert.ok(unavail.includes("(不可用)"), "is_available=false 显示 (不可用)");

  // K13/G10 徽标加入后胶囊文案不回归 + CSS 截断规则存在
  assert.ok(empty.includes("dou-peak"), "stale 帧徽标仍渲染");
  const css = readFileSync(join(here, "..", "src", "client", "style.css"), "utf8");
  assert.ok(css.includes(".dou-peak"), "style.css 含 .dou-peak 规则");
  assert.ok(css.includes("@media (max-width: 380px)") && css.includes("text-overflow: ellipsis"), "窄断点截断防溢出规则存在");
}

// ================================================================ K10/D 组 面板结构（双卡 SVG）

{
  const now = MON(12, 0);
  const entries = [];
  // 近 24h 内 5 个采样点（余额递减）+ 前 3 天历史
  const balances = [100, 99, 98.5, 98.2, 98];
  for (let i = 0; i < 5; i += 1) {
    entries.push({ time: now - (4 - i) * 3600000, data: { balance: balances[i], toppedUp: 90, grantedBalance: 10, isAvailable: true } });
  }
  entries.push({ time: now - 3 * 86400000, data: { balance: 120, toppedUp: 90, grantedBalance: 10, isAvailable: true } });
  entries.push({ time: now - 2 * 86400000, data: { balance: 112, toppedUp: 90, grantedBalance: 10, isAvailable: true } });
  entries.push({ time: now - 86400000, data: { balance: 101, toppedUp: 90, grantedBalance: 10, isAvailable: true } });

  const panel = deepSeekOfficialAdapter.formatPanel({
    entries,
    range: { start: now - 86400000, end: now },
    truncated: false,
    esc,
  });
  // D1 双卡结构
  assert.equal((panel.match(/<div class="dou-card">/g) || []).length, 2, "恰含两个 dou-card 容器");
  assert.ok(panel.includes("<svg"), "内嵌 SVG 图表");
  assert.ok(panel.includes("近 15 日用量"), "卡2 柱形图卡");
  assert.ok(panel.includes("近 24 小时波动"), "卡1 余额波动卡");
  // D3 主题变量 + 浅色回退
  assert.ok(panel.includes("var(--dsw-alias-") && panel.includes("#3b82f6"), "主题变量 + 浅色回退形态");
  // K10 卡2 结构细节
  assert.ok(panel.includes('role="img"'), "SVG role=img");
  assert.ok(panel.includes("aria-label=\"近15日每日用量柱形图"), "aria-label 汇总口径");
  assert.ok(panel.includes("近 15 日消耗约 ¥"), "汇总行");
  // 卡1 消费徽章（v2.3 区间记账）：纯消费区间求和只统计消耗，本场景 100→98 → 「已用 ¥2.00」
  assert.ok(panel.includes("已用 ¥"), "卡1 徽章显示消费金额而非余额涨跌");
  assert.ok(!panel.includes("▲ +"), "余额上涨不再显示 ▲ 充值徽章");

  // D2 注入 >15 天历史仅呈现最近 15 个自然日（SVG 内日期槽位数 = 15）
  const manyEntries = [];
  for (let i = 0; i <= 20; i += 1) {
    manyEntries.push({ time: now - i * 86400000, data: { balance: 100 - (20 - i), toppedUp: 90, grantedBalance: 10, isAvailable: true } });
  }
  const panelMany = deepSeekOfficialAdapter.formatPanel({
    entries: manyEntries,
    range: { start: now - 21 * 86400000, end: now },
    truncated: false,
    esc,
  });
  const barsInCard2 = (panelMany.match(/rx="1\.5"/g) || []).length;
  assert.ok(barsInCard2 <= 16, `柱形槽位 ≤15+占位（实际 ${barsInCard2}）`);
  assert.ok(!panelMany.includes(dayKey(now - 20 * 86400000).slice(5)), "20 天前日期不在窗口内");

  // D4 空 history 占位不抛错
  const emptyPanel = deepSeekOfficialAdapter.formatPanel({
    entries: [], range: { start: 0, end: now }, truncated: false, esc,
  });
  assert.ok(emptyPanel.includes("暂无历史数据"));

  // K10 mixedCaliber 提示（gap/insufficient 存在时）
  const gapEntries = [
    { time: now - 40 * 3600000, data: { balance: 100, toppedUp: 90, grantedBalance: 10, isAvailable: true } },
    { time: now, data: { balance: 95, toppedUp: 90, grantedBalance: 10, isAvailable: true } },
  ];
  const panelGap = deepSeekOfficialAdapter.formatPanel({
    entries: gapEntries,
    range: { start: now - 86400000, end: now },
    truncated: false,
    esc,
  });
  assert.ok(panelGap.includes("未计") || panelGap.includes("中断不计"), "缺口场景出现未计提示（v2.3 区间记账）");

  // 降采样 ≤300 点（构造 400 点折线输入）
  const dense = [];
  for (let i = 0; i < 400; i += 1) {
    dense.push({ time: now - (400 - i) * 60000, data: { balance: 100 + Math.sin(i) , toppedUp: 90, grantedBalance: 10, isAvailable: true } });
  }
  const panelDense = deepSeekOfficialAdapter.formatPanel({
    entries: dense,
    range: { start: now - 400 * 60000, end: now },
    truncated: false,
    esc,
  });
  const circleCount = (panelDense.match(/<circle /g) || []).length;
  assert.equal(circleCount, 1, "折线仅末点高亮一个 circle（降采样后仍单线）");
}

{
  // C8 集成面：is_available=false 帧不作为守恒端点（经 formatPanel 数据通路）
  const now = utc(2026, 8, 26, 12, 0); // 周三
  const entries = [
    { time: now - 48 * 3600000, data: { balance: 100, toppedUp: 90, grantedBalance: 10, isAvailable: true } },   // 周一
    { time: now - 24 * 3600000, data: { balance: 40, toppedUp: 90, grantedBalance: 10, isAvailable: false } },  // 周二（不可用）
    { time: now, data: { balance: 38, toppedUp: 90, grantedBalance: 10, isAvailable: true } },                  // 周三
  ];
  const panel = deepSeekOfficialAdapter.formatPanel({
    entries,
    range: { start: now - 3 * 86400000, end: now },
    truncated: false,
    esc,
  });
  assert.ok(panel.includes("不可用区间不计"), "不可用端点相邻区间注记「含不可用区间不计」而非计入消耗");
  assert.ok(!panel.includes("消耗 ¥60"), "不可用帧的 60 元差额未被误计为用量");
  // 相邻两区间（周一→周二、周二→周三）均被跳过 → 汇总不含虚高值
  assert.ok(panel.includes("消耗约 ¥0.00"), "汇总仅含有效区间（本场景为 0）");
}

{
  // v2.3 卡1 徽章消费口径：充值区间剔除后不再显示 ▲，余额上涨场景徽章显示消费≈0
  const now = utc(2026, 8, 26, 12, 0);
  const entries = [
    { time: now - 5 * 3600000, data: { balance: 10, toppedUp: 10, grantedBalance: 0, isAvailable: true } },
    { time: now, data: { balance: 55.62, toppedUp: 55.62, grantedBalance: 0, isAvailable: true } },
  ];
  const panel = deepSeekOfficialAdapter.formatPanel({
    entries,
    range: { start: now - 86400000, end: now },
    truncated: false,
    esc,
  });
  assert.ok(!panel.includes("▲"), "余额上涨（充值）不再显示 ▲ 徽章");
  // 单一扰动区间下无可计账区间 → 消费未知（比强行声称 ≈0 更诚实）
  assert.ok(panel.includes("— 消费未知"), "无可计区间时徽章显示消费未知");
  assert.ok(panel.includes("另有充值 +¥45.62"), "徽章 title 注明未计入的充值额");
}

// ================================================================ A2 opencode-go 空 data 防御回归

{
  const html = openCodeGoAdapter.formatCapsule({
    time: Date.now(),
    data: {},
    status: "stale",
    error: "network",
    esc,
  });
  assert.equal(html, "<span>无数据</span>", "opencode-go 空 data + stale → 「无数据」占位不抛错");
  assert.ok(openCodeGoAdapter.formatPanel({ entries: [], range: { start: 0, end: 1 }, truncated: false, esc }).includes("暂无历史数据"),
    `opencode-go formatPanel 空 entries 回归（${OPENCODE_GO_ADAPTER_ID}）`);
}

// ================================================================ 管线集成：runV2Pipeline 失败分支 stale 帧

{
  const netFail = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  const result = await runV2Pipeline({
    adapter: deepSeekOfficialAdapter,
    provider: DEEPSEEK_OFFICIAL_PROVIDER,
    config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
    staticPath: "",
    timeoutMs: 2000,
    fetchImpl: netFail,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "stale");
  assert.equal(result.error, "network");
  assert.ok(typeof result.capsuleHtml === "string" && result.capsuleHtml.length > 0, "失败分支 capsuleHtml 非空");
  assert.ok(result.capsuleHtml.includes("DeepSeek 余额 --"), "空 data 渲染占位");
  assert.ok(result.capsuleHtml.includes("dou-peak"), "峰谷徽标 stale 帧常驻（G8）");
  assert.equal(result.rawData, undefined, "错误帧不带 rawData（不落盘前提）");
  // I2 错误文案无插值注入面：净化后无脚本执行面
  assert.ok(!result.capsuleHtml.includes("<script"), "capsuleHtml 无脚本载体");

  // 带值降级：注入 history 时失败帧用最后一条成功数据渲染胶囊（数值不跌 "--"，
  // 数据来源状态由客户端圆点 dou-dot-warn 表达）；status/error 语义不变。
  const lastOk = { time: Date.now() - 600000, data: { isAvailable: true, balance: 88.88, toppedUp: 88.88, grantedBalance: 0 } };
  const resultWithHistory = await runV2Pipeline({
    adapter: deepSeekOfficialAdapter,
    provider: DEEPSEEK_OFFICIAL_PROVIDER,
    config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
    staticPath: "",
    timeoutMs: 2000,
    fetchImpl: netFail,
    history: { last: async () => lastOk },
  });
  assert.equal(resultWithHistory.status, "stale", "带值降级仍为 stale 帧");
  assert.ok(resultWithHistory.capsuleHtml!.includes("¥88.88"), "胶囊渲染历史最后成功余额");
  assert.ok(!resultWithHistory.capsuleHtml!.includes("DeepSeek 余额 --"), "不再跌无数据占位");

  // history 兜底读失败视同无历史：回退空 data 占位，绝不因兜底读失败放大错误
  const resultBadHistory = await runV2Pipeline({
    adapter: deepSeekOfficialAdapter,
    provider: DEEPSEEK_OFFICIAL_PROVIDER,
    config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
    staticPath: "",
    timeoutMs: 2000,
    fetchImpl: netFail,
    history: { last: async () => { throw new Error("disk-boom"); } },
  });
  assert.equal(resultBadHistory.error, "network", "错误码保持原始取数错误");
  assert.ok(resultBadHistory.capsuleHtml!.includes("DeepSeek 余额 --"), "兜底读失败回退占位");

  // 成功分支 fresh 帧 rawData 正常
  const okResult = await runV2Pipeline({
    adapter: deepSeekOfficialAdapter,
    provider: DEEPSEEK_OFFICIAL_PROVIDER,
    config: { apiEndpoint: "", apiKey: "sk-pipe" },
    staticPath: "",
    timeoutMs: 2000,
    fetchImpl: (() => Promise.resolve(mockRes(200, officialBody()))) as unknown as typeof fetch,
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.status, "fresh");
  assert.equal(okResult.rawData?.balance, 110);
  assert.ok(okResult.capsuleHtml.includes("余额 ¥110.00"));
  // D5 sanitizeHtml 后 SVG 结构存活且净化面干净（panelHtml 走同一 sanitize 出口）
  const sanitized = sanitizeHtml('<svg role="img"><rect onmouseover="x()" fill="#fff"></rect></svg><a href="javascript:alert(1)">y</a>');
  assert.ok(sanitized.includes("<svg"), "sanitize 后 svg 结构存活");
  assert.ok(!sanitized.includes("onmouseover"), "on* 事件属性被移除");
  assert.ok(!sanitized.includes("javascript:"), "javascript: URI 被移除");
}

console.log("[unit-deepseek-official] 全部断言通过 ✓ (#198 B/C/E/G/K)");
