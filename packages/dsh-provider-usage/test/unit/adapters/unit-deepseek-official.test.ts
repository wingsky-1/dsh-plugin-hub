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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  dailyBarTitle,
} from "../../../src/apply/index.ts";

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

/** 捕获 rejection 的 error 对象（未 reject 时返回 undefined，断言随即 fail-loud）。 */
async function catchErr(p) {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

const fetchCtx = (over = {}) => ({
  apiEndpoint: "", staticPath: "", apiKey: "sk-unit",
  provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, ...over,
});

// ================================================================ B1 + 契约自检

describe("B1 + 契约自检", () => {
  it("内置 DeepSeek 适配器通过 v2 契约校验", () => {
    expect(isUsageStatsAdapter(deepSeekOfficialAdapter)).toBe(true);
  });

  it("适配器 name === DEEPSEEK_OFFICIAL_ADAPTER_ID 常量", () => {
    expect(deepSeekOfficialAdapter.name).toBe(DEEPSEEK_OFFICIAL_ADAPTER_ID);
  });

  it("name 加 -builtin 后缀（有意差异 K12）", () => {
    expect(deepSeekOfficialAdapter.name).toBe("deepseek-official-builtin");
  });

  it("version===2", () => {
    expect(deepSeekOfficialAdapter.version).toBe(2);
  });

  it("认领 deepseek-official provider", () => {
    expect(deepSeekOfficialAdapter.providers).toEqual(["deepseek-official"]);
  });

  it("fetchData 为函数", () => {
    expect(typeof deepSeekOfficialAdapter.fetchData).toBe("function");
  });

  it("formatCapsule 为函数", () => {
    expect(typeof deepSeekOfficialAdapter.formatCapsule).toBe("function");
  });

  it("formatPanel 为函数", () => {
    expect(typeof deepSeekOfficialAdapter.formatPanel).toBe("function");
  });
});

// ================================================================ B2/K1 余额解析 + 归一化输出

describe("B2/K1 余额解析 + 归一化输出", () => {
  let out, calls;

  beforeAll(async () => {
    const captured = capturingFetch(mockRes(200, officialBody()));
    calls = captured.calls;
    out = await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "https://api.deepseek.com", staticPath: "", apiKey: "sk-unit",
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: captured.f,
    });
  });

  it("isAvailable 透传为 true", () => {
    expect(out.isAvailable).toBe(true);
  });

  it('total_balance:"110.00" → 数值 110', () => {
    expect(out.balance).toBe(110);
  });

  it('topped_up_balance:"90.00" → 数值 90', () => {
    expect(out.toppedUp).toBe(90);
  });

  it('granted_balance:"20.00" → 数值 20', () => {
    expect(out.grantedBalance).toBe(20);
  });

  // B6 请求形态：Bearer 密钥在头里，URL 与查询串不含密钥
  it("Authorization: Bearer <key>", () => {
    expect(calls[0].init.headers.Authorization).toMatch(/^Bearer sk-unit$/);
  });

  it("URL 不携带密钥", () => {
    expect(!String(calls[0].url).includes("sk-unit")).toBeTruthy();
  });

  it("Accept: application/json", () => {
    expect(calls[0].init.headers.Accept).toBe("application/json");
  });
});

describe("B2 金额非法形态 → null（杜绝 NaN 落盘）", () => {
  let out;

  beforeAll(async () => {
    // 金额非法形态 → null（杜绝 NaN 落盘）
    const { f } = capturingFetch(mockRes(200, officialBody({ total_balance: "abc", topped_up_balance: "", granted_balance: undefined })));
    out = await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "", staticPath: "", apiKey: "sk-unit",
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: f,
    });
  });

  it("非法金额字符串 → null", () => {
    expect(out.balance).toBe(null);
  });

  it("空串 → null", () => {
    expect(out.toppedUp).toBe(null);
  });

  it("缺失字段 → null", () => {
    expect(out.grantedBalance).toBe(null);
  });
});

describe("parseAmount", () => {
  it("合法小数字符串解析", () => {
    expect(parseAmount("12.34")).toBe(12.34);
  });

  it("前后空白容忍", () => {
    expect(parseAmount("  5 ")).toBe(5);
  });

  it("空串 → null", () => {
    expect(parseAmount("")).toBe(null);
  });

  it("非数字字符串 → null", () => {
    expect(parseAmount("abc")).toBe(null);
  });

  it("字符串 NaN → null", () => {
    expect(parseAmount("NaN")).toBe(null);
  });

  it("undefined → null", () => {
    expect(parseAmount(undefined)).toBe(null);
  });

  it("null → null", () => {
    expect(parseAmount(null)).toBe(null);
  });

  it("Infinity 非有限数 → null", () => {
    expect(parseAmount("Infinity")).toBe(null);
  });
});

// ================================================================ B3 多币种仅留 CNY

describe("B3 多币种仅留 CNY", () => {
  let out;

  beforeAll(async () => {
    const usd = { currency: "USD", total_balance: "15.50", topped_up_balance: "15.50", granted_balance: "0.00" };
    const { f } = capturingFetch(mockRes(200, officialBody({}, [usd])));
    out = await deepSeekOfficialAdapter.fetchData(fetchCtx({ fetch: f }));
  });

  it("USD 共存时仍取 CNY 余额", () => {
    expect(out.balance).toBe(110);
  });
});

// ================================================================ B4（修订版）无 CNY → null 正常帧

describe("B4（修订版）无 CNY → null 正常帧", () => {
  for (const infos of [
    [{ currency: "USD", total_balance: "15.50" }],
    [],
  ]) {
    let out;

    beforeAll(async () => {
      const { f } = capturingFetch(mockRes(200, { is_available: true, balance_infos: infos }));
      out = await deepSeekOfficialAdapter.fetchData(fetchCtx({ fetch: f }));
    });

    it(`无 CNY 条目（${JSON.stringify(infos).slice(0, 30)}…）→ 全 null 正常帧不抛错`, () => {
      expect([out.balance, out.toppedUp, out.grantedBalance]).toEqual([null, null, null]);
    });

    it(`无 CNY 条目（${JSON.stringify(infos).slice(0, 30)}…）→ isAvailable 仍为 true`, () => {
      expect(out.isAvailable).toBe(true);
    });
  }
});

// ================================================================ B5/K3 错误路径六态（参数化）

describe("B5/K3 错误路径六态（参数化）", () => {
  const baseCtx = { apiEndpoint: "", staticPath: "", apiKey: "sk-unit", provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000 };

  it("no-api-key", async () => {
    const e = await catchErr(deepSeekOfficialAdapter.fetchData({ ...baseCtx, apiKey: undefined }));
    expect(e?.message).toBe("no-api-key");
  });

  it("AbortError 必须原样重抛（超时取消不被吞成 network）", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const abortF = (() => Promise.reject(abortErr)) as unknown as typeof fetch;
    const e = await catchErr(deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: abortF }));
    expect(e?.name).toBe("AbortError");
    expect(e?.message).toBe("The operation was aborted");
  });

  it("连接异常 → network", async () => {
    const boomF = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const e = await catchErr(deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: boomF }));
    expect(e?.message).toBe("network");
  });

  // 401 / 403 → unauthorized；其他非 2xx → http-<code>；非 JSON → bad-json
  for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [500, "http-500"], [429, "http-429"]]) {
    it(`${status} → ${expected}`, async () => {
      const e = await catchErr(deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: (() => Promise.resolve(mockRes(status, {}))) as unknown as typeof fetch }));
      expect(e?.message).toBe(expected);
    });
  }

  it("非 JSON 响应 → bad-json", async () => {
    const badJsonF = (() => Promise.resolve({ status: 200, ok: true, json: async () => { throw new Error("Unexpected token"); } })) as unknown as typeof fetch;
    const e = await catchErr(deepSeekOfficialAdapter.fetchData({ ...baseCtx, fetch: badJsonF }));
    expect(e?.message).toBe("bad-json");
  });
});

// ================================================================ K2 端点解析（/v1 剥离）

describe("K2 端点解析（/v1 剥离）", () => {
  it("缺省用官方基址", () => {
    expect(resolveEndpoint(undefined)).toBe("https://api.deepseek.com/user/balance");
  });

  it("空串用官方基址", () => {
    expect(resolveEndpoint("")).toBe("https://api.deepseek.com/user/balance");
  });

  it("官方基址拼接", () => {
    expect(resolveEndpoint("https://api.deepseek.com")).toBe("https://api.deepseek.com/user/balance");
  });

  it("官方域名剥 /v1", () => {
    expect(resolveEndpoint("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/user/balance");
  });

  it("剥 /v1/ 尾斜杠", () => {
    expect(resolveEndpoint("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/user/balance");
  });

  it("大小写不敏感剥前缀", () => {
    expect(resolveEndpoint("https://API.DEEPSEEK.COM/V1")).toBe("https://API.DEEPSEEK.COM/user/balance");
  });

  it("非官方端点原样拼接", () => {
    expect(resolveEndpoint("http://127.0.0.1:9")).toBe("http://127.0.0.1:9/user/balance");
  });

  it("多尾斜杠归一", () => {
    expect(resolveEndpoint("http://127.0.0.1:9///")).toBe("http://127.0.0.1:9/user/balance");
  });
});

describe("K2 实际请求 URL 经捕获断言（mock 注入）", () => {
  let calls;

  beforeAll(async () => {
    const captured = capturingFetch(mockRes(200, officialBody()));
    calls = captured.calls;
    await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "https://api.deepseek.com/v1/", staticPath: "", apiKey: "sk-unit",
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: captured.f,
    });
  });

  it("实际请求 URL 剥 /v1 后拼接", () => {
    expect(String(calls[0].url)).toBe("https://api.deepseek.com/user/balance");
  });
});

// ================================================================ E 组 三级密钥链

describe("E1 显式注入优先，env 干扰不影响", () => {
  let restore, resolved;

  beforeAll(async () => {
    const savedEnvKey = process.env.DEEPSEEK_OFFICIAL_API_KEY;
    const savedDsKey = process.env.DEEPSEEK_API_KEY;
    restore = () => {
      if (savedEnvKey === undefined) delete process.env.DEEPSEEK_OFFICIAL_API_KEY; else process.env.DEEPSEEK_OFFICIAL_API_KEY = savedEnvKey;
      if (savedDsKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedDsKey;
    };
    process.env.DEEPSEEK_OFFICIAL_API_KEY = "sk-env-noise";
    process.env.DEEPSEEK_API_KEY = "sk-ds-noise";
    resolved = await resolveProviderConfig(DEEPSEEK_OFFICIAL_PROVIDER, undefined, { apiKey: "sk-explicit" });
  });

  afterAll(() => restore?.());

  it("ctx.apiKey 有值时不读 env", () => {
    expect(resolved.apiKey).toBe("sk-explicit");
  });
});

describe("E2 V1 链推导：provider deepseek-official → env DEEPSEEK_OFFICIAL_API_KEY", () => {
  let restore, resolved;

  beforeAll(async () => {
    const saved = { dsh: process.env.DSH_HOME, home: process.env.HOME, env: process.env.DEEPSEEK_OFFICIAL_API_KEY };
    restore = () => {
      if (saved.dsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.dsh;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      if (saved.env === undefined) delete process.env.DEEPSEEK_OFFICIAL_API_KEY; else process.env.DEEPSEEK_OFFICIAL_API_KEY = saved.env;
    };
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-e2-"));
    process.env.HOME = process.env.DSH_HOME;
    process.env.DEEPSEEK_OFFICIAL_API_KEY = "sk-from-derived-env";
    resolved = await resolveProviderConfig(DEEPSEEK_OFFICIAL_PROVIDER, undefined, {});
  });

  afterAll(() => restore?.());

  it("大写+连字符转下划线规则推导 env", () => {
    expect(resolved.apiKey).toBe("sk-from-derived-env");
  });
});

describe("E3 适配器内自查 DEEPSEEK_API_KEY 兜底（llm 能跑、余额接口 401 场景）", () => {
  let restore, calls, out;

  beforeAll(async () => {
    const savedDs = process.env.DEEPSEEK_API_KEY;
    restore = () => {
      if (savedDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedDs;
    };
    process.env.DEEPSEEK_API_KEY = "sk-ds-fallback";
    const captured = capturingFetch(mockRes(200, officialBody()));
    calls = captured.calls;
    out = await deepSeekOfficialAdapter.fetchData({
      apiEndpoint: "", staticPath: "", apiKey: undefined,
      provider: DEEPSEEK_OFFICIAL_PROVIDER, timeoutMs: 2000, fetch: captured.f,
    });
  });

  afterAll(() => restore?.());

  it("DEEPSEEK_API_KEY 自查兜底生效", () => {
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-ds-fallback");
  });

  it("兜底后取数余额正常解析", () => {
    expect(out.balance).toBe(110);
  });
});

// ================================================================ C/K4 区间记账分类（classifyIntervalDs，不做代数相消）

describe("C/K4 区间记账分类（classifyIntervalDs，不做代数相消）", () => {
  const pt = (t, balance, toppedUp, granted, available = true) => ({ t, balance, toppedUp, granted, available });

  it("无扰动区间 → clean", () => {
    // C1 纯消费区间：topped/granted 不变 → clean，消耗 = 余额降幅（可与平台账单对账）
    const c1 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 95, 90, 10));
    expect(c1.type).toBe("clean");
  });

  it("消耗 = 余额降幅 5", () => {
    const c1 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 95, 90, 10));
    expect(c1.drop).toBe(5);
  });

  it("充值上涨 → 扰动混合区间", () => {
    // C2 充值混合区间：topped 90→130（入账 +40，余额同步上涨）→ disturbed 提取事件额
    const c2 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 135, 130, 10));
    expect(c2.type).toBe("disturbed");
  });

  it("提取充值事件额 +40（不与消耗混算）", () => {
    const c2 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 135, 130, 10));
    expect(c2.topup).toBe(40);
  });

  it("赠款变动 granted 10→20 → disturbed", () => {
    // C3 赠款变动：granted 10→20 → disturbed
    const c3 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 110, 90, 20));
    expect(c3.type).toBe("disturbed");
  });

  it("赠款变动额 grantDelta=10", () => {
    const c3 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 110, 90, 20));
    expect(c3.grantDelta).toBe(10);
  });

  it("不可用端点：任一帧 is_available=false → 整段跳过", () => {
    // C4 不可用端点：任一帧 is_available=false → 整段跳过
    const c4 = classifyIntervalDs(pt(0, 100, 90, 10), pt(1, 95, 90, 10, false));
    expect(c4.type).toBe("unavailable");
  });

  it("分量缺失退化为净变动口径", () => {
    // C5 分量缺失（旧分片 toppedUp/granted 为 null）→ 纯净变动口径仍可计
    const c5 = classifyIntervalDs(pt(0, 100, null, null), pt(1, 93, null, null));
    expect(c5.type).toBe("clean");
  });

  it("分量缺失时降幅按净变动计", () => {
    const c5 = classifyIntervalDs(pt(0, 100, null, null), pt(1, 93, null, null));
    expect(c5.drop).toBe(7);
  });
});

// ================================================================ C/K5/K6/K7/K9 日聚合（闭环基线 / GAP / 分层 / skipFirst）
// ================================================================ 日聚合 v2.3 区间记账（归属结束端日 / GAP 注记 / 分层 / 冷启动 / 充值列示）

describe("G1b 跨度 >27h 的区间落在某日 → 该日 ok/0 + 「中断」注记", () => {
  let recs;

  beforeAll(() => {
    const t0 = MON(22, 0);
    const t1 = t0 + 30 * 3600000; // 周二 04:00（跨日）
    const pts = [
      { t: t0, balance: 100, toppedUp: 90, granted: 10 },
      { t: t1, balance: 95, toppedUp: 90, granted: 10 },
    ];
    recs = aggregateDaily(pts, [dayKey(t1)], false);
  });

  it("中断区间不产生异常态", () => {
    expect(recs[0].status).toBe("ok");
  });

  it("中断区间不计消耗", () => {
    expect(recs[0].u).toBe(0);
  });

  it("注记数据中断段数", () => {
    expect(String(recs[0].extra).includes("中断")).toBeTruthy();
  });
});

describe("G2 归属规则：区间计入结束端所在日——跨午夜隔夜消费不丢失（旧基线法整段掉落）", () => {
  let satRec, sunRec;

  beforeAll(() => {
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
    satRec = recs.find((r) => r.key === dayKey(satNight));
    sunRec = recs.find((r) => r.key === dayKey(sunEarly));
  });

  it("周六仅起点帧、无结束于当日的区间 → 无可计区间", () => {
    expect(satRec.status).toBe("insufficient");
  });

  it("周日内有可计区间 → ok", () => {
    expect(sunRec.status).toBe("ok");
  });

  it("周日合计 = 隔夜段 1 + 日内段 5（跨午夜连续归账）", () => {
    expect(sunRec.u).toBe(6);
  });
});

describe("G3 冷启动自然成立：当日 ≥2 帧即出数（无需旧版跨日基线/日内兜底标记）", () => {
  let recs;

  beforeAll(() => {
    const d0 = utc(2026, 8, 24, 9, 0);
    const d1 = utc(2026, 8, 24, 15, 0);
    recs = aggregateDaily(
      [
        { t: d0, balance: 50, toppedUp: 50, granted: 0 },
        { t: d1, balance: 47, toppedUp: 47, granted: 0 },
      ],
      [dayKey(d0)],
      false,
    );
  });

  it("冷启动首日按日内区间直接出数", () => {
    expect(recs[0].status).toBe("ok");
  });

  it("消耗 = 日内区间降幅 50−47=3", () => {
    expect(recs[0].u).toBe(3);
  });

  it("v2.3 无需 intraday 标记", () => {
    expect(recs[0].intraday).toBe(undefined);
  });
});

describe("C6 单帧历史：当日有帧但无可计区间 → insufficient（不得把余额绝对值误计为用量）", () => {
  let recs;

  beforeAll(() => {
    const only = { t: MON(8, 0), balance: 88, toppedUp: 80, granted: 8 };
    recs = aggregateDaily([only], [dayKey(MON(8, 0))], false);
  });

  it("无可计区间 → 样本不足", () => {
    expect(recs[0].status).toBe("insufficient");
  });

  it("样本不足时消耗为 0", () => {
    expect(recs[0].u).toBe(0);
  });
});

describe("G4 充值事件独立列示：充值区间漏计、事件额 toppedUpIn 汇出", () => {
  let recs;

  beforeAll(() => {
    const d0 = utc(2026, 8, 24, 10, 0);
    const d1 = utc(2026, 8, 24, 11, 0);   // 充值 +45.62（余额 10→55.62）
    const d2 = utc(2026, 8, 24, 12, 0);   // 纯消费 1 元
    const pts = [
      { t: d0, balance: 10, toppedUp: 10, granted: 0 },
      { t: d1, balance: 55.62, toppedUp: 55.62, granted: 0 },
      { t: d2, balance: 54.62, toppedUp: 55.62, granted: 0 },
    ];
    recs = aggregateDaily(pts, [dayKey(d2)], false);
  });

  it("存在可计区间 → ok", () => {
    expect(recs[0].status).toBe("ok");
  });

  it("仅纯消费区间落账 1 元（充值区间漏计）", () => {
    expect(Math.abs(recs[0].u - 1) < 1e-9).toBe(true);
  });

  it("充值额在 extra 注明", () => {
    expect(String(recs[0].extra).includes("充值 +¥45.62 未计入")).toBeTruthy();
  });

  it("充值事件额供汇总行独立展示", () => {
    expect(recs[0].toppedUpIn).toBe(45.62);
  });
});

describe("G5 分层渲染映射到 clean 降幅之和：容差归零 / 轻微负值 neg 绿柱 / 大额负值异常", () => {
  let zero, gainSmall, anom;

  beforeAll(() => {
    const d0 = utc(2026, 8, 25, 9, 0);
    const d1 = utc(2026, 8, 25, 19, 0);
    const mk = (bPrev, bCur) => [
      { t: d0, balance: bPrev, toppedUp: 90, granted: 10 },
      { t: d1, balance: bCur, toppedUp: 90, granted: 10 },
    ];
    zero = aggregateDaily(mk(100, 100 - TOL / 2), [dayKey(d1)], false)[0];
    gainSmall = aggregateDaily(mk(100, 100.5), [dayKey(d1)], false)[0];
    anom = aggregateDaily(mk(100, 102.5), [dayKey(d1)], false)[0];
  });

  it("|u|≤TOL → ok", () => {
    expect(zero.status).toBe("ok");
  });

  it("容差内归零", () => {
    expect(zero.u).toBe(0);
  });

  it("轻微负值（余额小涨且无扰动）→ neg 绿柱", () => {
    expect(gainSmall.neg).toBe(true);
  });

  it("轻微负值落在 (ANOMALY_NEG, 0) 区间", () => {
    expect(gainSmall.u < 0 && gainSmall.u >= ANOMALY_NEG).toBeTruthy();
  });

  it("大额净增 → 异常标注", () => {
    expect(anom.status).toBe("anomaly");
  });

  it("异常态消耗归零", () => {
    expect(anom.u).toBe(0);
  });

  it("异常注记含「异常」", () => {
    expect(String(anom.note).includes("异常")).toBeTruthy();
  });
});

describe("G6 truncated 参数保留但不再弃首日（区间记账天然不受截断影响）", () => {
  let withTruncated, withoutTruncated;

  beforeAll(() => {
    const d0 = utc(2026, 8, 26, 9, 0);
    const d1 = utc(2026, 8, 26, 15, 0);
    const pts = [
      { t: d0, balance: 50, toppedUp: 50, granted: 0 },
      { t: d1, balance: 46, toppedUp: 50, granted: 0 },
    ];
    const keys = [dayKey(d1)];
    withTruncated = aggregateDaily(pts, keys, true).map((r) => [r.status, r.u]);
    withoutTruncated = aggregateDaily(pts, keys, false).map((r) => [r.status, r.u]);
  });

  it("truncated 与否结果一致（v2.3 无 skipFirst）", () => {
    expect(withTruncated).toEqual(withoutTruncated);
  });
});

describe("G7 不可用端点策略：is_available=false 帧两侧区间均跳过（帧值不可信），注记承载", () => {
  let recs, okRecs;

  beforeAll(() => {
    const d0 = utc(2026, 8, 27, 8, 0);
    const d1 = utc(2026, 8, 27, 9, 0);   // 该帧不可用：d0→d1 与 d1→d2 两段都跳过
    const d2 = utc(2026, 8, 27, 10, 0);
    const pts = [
      { t: d0, balance: 100, toppedUp: 90, granted: 10, available: true },
      { t: d1, balance: 60, toppedUp: 90, granted: 10, available: false },
      { t: d2, balance: 56, toppedUp: 90, granted: 10, available: true },
    ];
    recs = aggregateDaily(pts, [dayKey(d2)], false);
    // 对照：全部可用时同日两段降幅均按 clean 落账（40+4=44；无不可用帧则账面降幅即口径）
    const okPts = pts.map((p) => ({ ...p, available: true }));
    okRecs = aggregateDaily(okPts, [dayKey(d2)], false);
  });

  it("跳过不产生异常态", () => {
    expect(recs[0].status).toBe("ok");
  });

  it("不可用帧相邻区间不计（含本应可疑的 40 元降幅）", () => {
    expect(recs[0].u).toBe(0);
  });

  it("注记说明未计原因", () => {
    expect(String(recs[0].extra).includes("不可用区间不计")).toBeTruthy();
  });

  it("全可用时同日区间链式落账 40+4=44", () => {
    expect(okRecs[0].u).toBe(44);
  });
});

// ================================================================ K8 日聚合时区口径

describe("K8 日聚合时区口径", () => {
  it("本地时区归组（禁 toISOString 的 UTC 归组）", () => {
    // dayKey 用宿主进程本地时区：本地某日 07:00（东八区即 UTC 前一日 23:00）不得划入前一天
    const localMorning = new Date(2026, 7, 24, 7, 0, 0).getTime();
    expect(dayKey(localMorning)).toBe("2026-08-24");
  });

  it("本地零点当日归组", () => {
    // 本地零点前后各一秒同日
    const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
    expect(dayKey(midnight)).toBe("2026-08-24");
  });

  it("零点前一秒属前一日（本地口径）", () => {
    const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
    expect(dayKey(midnight - 1)).toBe("2026-08-23");
  });

  describe("lastNDayKeys 逐日 setDate 回退：跨月/数量/升序/今日收尾", () => {
    let keys;

    beforeAll(() => {
      const now = new Date(2026, 2, 1, 12, 0).getTime(); // 2026-03-01 本地
      keys = lastNDayKeys(15, now);
    });

    it("数量正确", () => {
      expect(keys.length).toBe(15);
    });

    it("末日=今日", () => {
      expect(keys[14]).toBe("2026-03-01");
    });

    it("跨月回退正确（2026 非闰年）", () => {
      expect(keys[13]).toBe("2026-02-28");
    });

    it("无重复日", () => {
      expect(new Set(keys).size).toBe(15);
    });

    it("升序排列", () => {
      expect([...keys].sort()).toEqual(keys);
    });
  });
});

// ================================================================ niceCeil

describe("niceCeil", () => {
  it("非正数回默认 10", () => {
    expect(niceCeil(0)).toBe(10);
  });

  it("负数回默认 10", () => {
    expect(niceCeil(-5)).toBe(10);
  });

  it("0.7 → 1", () => {
    expect(niceCeil(0.7)).toBe(1);
  });

  it("1.4 → 2", () => {
    expect(niceCeil(1.4)).toBe(2);
  });

  it("3.2 → 5", () => {
    expect(niceCeil(3.2)).toBe(5);
  });

  it("7 → 10", () => {
    expect(niceCeil(7)).toBe(10);
  });

  it("17 → 20", () => {
    expect(niceCeil(17)).toBe(20);
  });

  it("140 → 200", () => {
    expect(niceCeil(140)).toBe(200);
  });
});

// ================================================================ G 组 峰谷时段常量与倒计时

describe("G1 常量存在 + 源码注释附官方定价 URL 与核实日期", () => {
  let src;

  beforeAll(() => {
    src = readFileSync(join(here, "..", "..", "..", "src", "domain1", "adapters", "deepseek-official.mjs"), "utf8");
  });

  it("PEAK_WINDOWS_UTC=[[01:00,04:00],[06:00,10:00]]（分钟）", () => {
    expect(PEAK_WINDOWS_UTC.map(([s, e]) => [s, e])).toEqual([[60, 240], [360, 600]]);
  });

  it("注释附官方定价 URL", () => {
    expect(src.includes("https://api-docs.deepseek.com/quick_start/pricing")).toBeTruthy();
  });

  it("注释附核实日期", () => {
    expect(src.includes("2026-08-26")).toBeTruthy();
  });
});

describe("G2 半开区间（毫秒精度）", () => {
  it("01:00:00.000 属峰（左闭）", () => {
    expect(isPeakUtc(MON(1, 0, 0, 0))).toBe(true);
  });

  it("03:59:59.999 属峰", () => {
    expect(isPeakUtc(MON(3, 59, 59, 999))).toBe(true);
  });

  it("04:00:00.000 即属谷（右开）", () => {
    expect(isPeakUtc(MON(4, 0, 0, 0))).toBe(false);
  });

  it("06:00 开峰", () => {
    expect(isPeakUtc(MON(6, 0, 0, 0))).toBe(true);
  });

  it("09:59:59.999 属峰", () => {
    expect(isPeakUtc(MON(9, 59, 59, 999))).toBe(true);
  });

  it("10:00 切谷", () => {
    expect(isPeakUtc(MON(10, 0, 0, 0))).toBe(false);
  });

  it("00:59:59.999 属谷", () => {
    expect(isPeakUtc(MON(0, 59, 59, 999))).toBe(false);
  });
});

describe("G3 工作日窗口外全谷", () => {
  it("周一 00:30 谷", () => {
    expect(isPeakUtc(MON(0, 30))).toBe(false);
  });

  it("04:00–06:00 间谷", () => {
    expect(isPeakUtc(MON(5, 0))).toBe(false);
  });

  it("午间谷", () => {
    expect(isPeakUtc(MON(12, 0))).toBe(false);
  });

  it("周五 23:00 谷", () => {
    expect(isPeakUtc(utc(2026, 8, 28, 23, 0))).toBe(false);
  });

  it("周五 15:00 谷（10:00 切谷后）", () => {
    expect(isPeakUtc(utc(2026, 8, 28, 15, 0))).toBe(false);
  });
});

describe("G4 周末全天低谷（issue 点名用例）", () => {
  for (const [hh, mi] of [[0, 0], [2, 30], [7, 0], [8, 0], [12, 0], [23, 59]]) {
    it(`周六 ${hh}:${mi} 谷`, () => {
      expect(isPeakUtc(SAT(hh, mi))).toBe(false);
    });

    it(`周日 ${hh}:${mi} 谷`, () => {
      expect(isPeakUtc(SUN(hh, mi))).toBe(false);
    });
  }

  it("跨日衔接：周六 23:59:59.999 谷", () => {
    expect(isPeakUtc(SAT(23, 59, 59, 999))).toBe(false);
  });

  it("跨日衔接：周日 00:00:00.000 谷", () => {
    expect(isPeakUtc(SUN(0, 0, 0, 0))).toBe(false);
  });

  it("跨日衔接：周日 23:59:59.999 谷", () => {
    expect(isPeakUtc(SUN(23, 59, 59, 999))).toBe(false);
  });

  it("周一 00:00 仍谷（01:00 才开峰）", () => {
    expect(isPeakUtc(MON(0, 0, 0, 0))).toBe(false);
  });
});

describe("G6 边界钳制翻转：边界后滞后时刻显示新状态且倒计时 ≥0，无负值/\"-00:00\"", () => {
  let justAfter, tr, badge, justBefore;

  beforeAll(() => {
    justAfter = MON(4, 0, 0, 500); // 04:00:00.500
    tr = nextPeakTransition(justAfter);
    badge = peakBadgeHtml(justAfter);
    justBefore = MON(4, 0, 0, 0) - 1;
  });

  it("已翻转到谷", () => {
    expect(isPeakUtc(justAfter)).toBe(false);
  });

  it("谷态下一次转换为开峰", () => {
    expect(tr.toPeak).toBe(true);
  });

  it("转换点是 06:00", () => {
    expect(tr.at).toBe(MON(6, 0));
  });

  it("不出现负值形态", () => {
    expect(!badge.includes("-00:")).toBeTruthy();
  });

  it("倒计时约 2 小时", () => {
    expect(badge.includes("距峰 02:"), `倒计时约 2 小时（实际 ${badge}）`).toBeTruthy();
  });

  it("边界前 1ms 仍属峰", () => {
    expect(isPeakUtc(justBefore)).toBe(true);
  });

  it("峰态下一切换为切谷", () => {
    expect(nextPeakTransition(justBefore).at).toBe(MON(4, 0));
  });
});

describe("G7 倒计时单调递减 + 长谷段有效非负", () => {
  let t1, t2, tr1, tr2, sunNoon, trSun, remainMin, badge, friAfter;

  beforeAll(() => {
    t1 = MON(1, 30);
    t2 = MON(1, 31);
    tr1 = nextPeakTransition(t1);
    tr2 = nextPeakTransition(t2);
    sunNoon = SUN(12, 0);
    trSun = nextPeakTransition(sunNoon);
    remainMin = Math.round((trSun.at - sunNoon) / 60000);
    badge = peakBadgeHtml(sunNoon);
    friAfter = utc(2026, 8, 28, 10, 0);
  });

  it("同时段转换点相同", () => {
    expect(tr1.at).toBe(tr2.at);
  });

  it("t2>t1 → 剩余时长严格变小", () => {
    expect(tr1.at - t1 > tr2.at - t2).toBeTruthy();
  });

  it("周末谷的下一次转换为开峰", () => {
    expect(trSun.toPeak).toBe(true);
  });

  it("周末谷的下一次开峰在下周一 01:00 UTC", () => {
    expect(trSun.at).toBe(utc(2026, 8, 31, 1, 0));
  });

  it("恰 13 小时", () => {
    expect(remainMin).toBe(13 * 60);
  });

  it("长谷段产出有效非负倒计时", () => {
    expect(badge).toMatch(/距峰 13:00/);
  });

  it("周五切谷后的下次开峰跨周末", () => {
    expect(nextPeakTransition(friAfter).at).toBe(utc(2026, 8, 31, 1, 0));
  });

  it("最长谷段（周五 10:00 → 下周一 01:00）倒计时 63 小时", () => {
    expect(peakBadgeHtml(friAfter)).toMatch(/距峰 63:00/);
  });
});

describe("G5/G9 徽标渲染", () => {
  let caps, capsPeak, empty, unavail, css;

  beforeAll(() => {
    caps = deepSeekOfficialAdapter.formatCapsule({
      time: SUN(12, 0),
      data: { balance: 110.5, isAvailable: true },
      status: "fresh",
      esc,
    });
    capsPeak = deepSeekOfficialAdapter.formatCapsule({
      time: MON(2, 0),
      data: { balance: 110.5, isAvailable: true },
      status: "fresh",
      esc,
    });
    // K11 无数据 / 不可用 / 缓存标记
    empty = deepSeekOfficialAdapter.formatCapsule({
      time: MON(2, 0), data: {}, status: "stale", esc,
    });
    unavail = deepSeekOfficialAdapter.formatCapsule({
      time: MON(2, 0), data: { balance: 5, isAvailable: false }, status: "fresh", esc,
    });
    css = readFileSync(join(here, "..", "..", "..", "src", "client", "style.css"), "utf8");
  });

  it("余额两位小数", () => {
    expect(caps.includes("余额 ¥110.50")).toBeTruthy();
  });

  it("徽标追加于余额文本之后", () => {
    expect(caps.indexOf("余额 ¥") < caps.indexOf("dou-peak")).toBeTruthy();
  });

  it("谷态显示距下次开峰倒计时", () => {
    expect(caps).toMatch(/⚡谷 · 距峰 \d{2,}:\d{2}/);
  });

  it("tooltip 存在", () => {
    expect(caps.includes("title=")).toBeTruthy();
  });

  it("tooltip 注明 UTC 时段定义", () => {
    expect(caps.includes("UTC")).toBeTruthy();
  });

  it("tooltip 含服务器时区对照提示", () => {
    expect(caps.includes("服务器时区")).toBeTruthy();
  });

  it("峰态显示距切谷倒计时", () => {
    expect(capsPeak).toMatch(/⚡峰 · 距谷 \d{2,}:\d{2}/);
  });

  it("峰态配色类", () => {
    expect(capsPeak.includes("dou-peak-on")).toBeTruthy();
  });

  it("无数据显示 -- 占位", () => {
    expect(empty.includes("DeepSeek 余额 --")).toBeTruthy();
  });

  it("stale 显示 (缓存) 标记", () => {
    expect(empty.includes("(缓存)")).toBeTruthy();
  });

  it("is_available=false 显示 (不可用)", () => {
    expect(unavail.includes("(不可用)")).toBeTruthy();
  });

  // K13/G10 徽标加入后胶囊文案不回归 + CSS 截断规则存在
  it("stale 帧徽标仍渲染", () => {
    expect(empty.includes("dou-peak")).toBeTruthy();
  });

  it("style.css 含 .dou-peak 规则", () => {
    expect(css.includes(".dou-peak")).toBeTruthy();
  });

  it("窄断点截断防溢出规则存在", () => {
    expect(css.includes("@media (max-width: 380px)") && css.includes("text-overflow: ellipsis")).toBeTruthy();
  });
});

// ================================================================ K10/D 组 面板结构（双卡 SVG）

describe("K10/D 组 面板结构（双卡 SVG）", () => {
  let panel, panelMany, emptyPanel, panelGap, panelDense, barsInCard2, circleCount, now;

  beforeAll(() => {
    now = MON(12, 0);
    const entries = [];
    // 近 24h 内 5 个采样点（余额递减）+ 前 3 天历史
    const balances = [100, 99, 98.5, 98.2, 98];
    for (let i = 0; i < 5; i += 1) {
      entries.push({ time: now - (4 - i) * 3600000, data: { balance: balances[i], toppedUp: 90, grantedBalance: 10, isAvailable: true } });
    }
    entries.push({ time: now - 3 * 86400000, data: { balance: 120, toppedUp: 90, grantedBalance: 10, isAvailable: true } });
    entries.push({ time: now - 2 * 86400000, data: { balance: 112, toppedUp: 90, grantedBalance: 10, isAvailable: true } });
    entries.push({ time: now - 86400000, data: { balance: 101, toppedUp: 90, grantedBalance: 10, isAvailable: true } });

    panel = deepSeekOfficialAdapter.formatPanel({
      entries,
      range: { start: now - 86400000, end: now },
      truncated: false,
      esc,
    });

    // D2 注入 >15 天历史仅呈现最近 15 个自然日（SVG 内日期槽位数 = 15）
    const manyEntries = [];
    for (let i = 0; i <= 20; i += 1) {
      manyEntries.push({ time: now - i * 86400000, data: { balance: 100 - (20 - i), toppedUp: 90, grantedBalance: 10, isAvailable: true } });
    }
    panelMany = deepSeekOfficialAdapter.formatPanel({
      entries: manyEntries,
      range: { start: now - 21 * 86400000, end: now },
      truncated: false,
      esc,
    });
    barsInCard2 = (panelMany.match(/rx="1\.5"/g) || []).length;

    // D4 空 history 占位不抛错
    emptyPanel = deepSeekOfficialAdapter.formatPanel({
      entries: [], range: { start: 0, end: now }, truncated: false, esc,
    });

    // K10 mixedCaliber 提示（gap/insufficient 存在时）
    const gapEntries = [
      { time: now - 40 * 3600000, data: { balance: 100, toppedUp: 90, grantedBalance: 10, isAvailable: true } },
      { time: now, data: { balance: 95, toppedUp: 90, grantedBalance: 10, isAvailable: true } },
    ];
    panelGap = deepSeekOfficialAdapter.formatPanel({
      entries: gapEntries,
      range: { start: now - 86400000, end: now },
      truncated: false,
      esc,
    });

    // 降采样 ≤300 点（构造 400 点折线输入）
    const dense = [];
    for (let i = 0; i < 400; i += 1) {
      dense.push({ time: now - (400 - i) * 60000, data: { balance: 100 + Math.sin(i) , toppedUp: 90, grantedBalance: 10, isAvailable: true } });
    }
    panelDense = deepSeekOfficialAdapter.formatPanel({
      entries: dense,
      range: { start: now - 400 * 60000, end: now },
      truncated: false,
      esc,
    });
    circleCount = (panelDense.match(/<circle /g) || []).length;
  });

  // D1 双卡结构
  it("恰含两个 dou-card 容器", () => {
    expect((panel.match(/<div class="dou-card">/g) || []).length).toBe(2);
  });

  it("内嵌 SVG 图表", () => {
    expect(panel.includes("<svg")).toBeTruthy();
  });

  it("卡2 柱形图卡", () => {
    expect(panel.includes("近 15 日用量")).toBeTruthy();
  });

  it("卡1 余额波动卡", () => {
    expect(panel.includes("近 24 小时波动")).toBeTruthy();
  });

  // #345 卡片头部精简：来源标识折叠进 title 悬停提示，不占主行同排挤压
  it("卡1 来源标识折叠进 title 悬停提示", () => {
    expect(panel.includes('title="DeepSeek 官方（CNY）"')).toBeTruthy();
  });

  it("卡1 主行不再拼接来源标识", () => {
    expect(!panel.includes("DeepSeek 官方（CNY） · 近 24 小时波动")).toBeTruthy();
  });

  // D3 主题变量 + 浅色回退
  it("主题变量 + 浅色回退形态", () => {
    expect(panel.includes("var(--dsw-alias-") && panel.includes("#3b82f6")).toBeTruthy();
  });

  // K10 卡2 结构细节
  it("SVG role=img", () => {
    expect(panel.includes('role="img"')).toBeTruthy();
  });

  it("aria-label 汇总口径", () => {
    expect(panel.includes("aria-label=\"近15日每日用量柱形图")).toBeTruthy();
  });

  it("汇总行", () => {
    expect(panel.includes("近 15 日消耗约 ¥")).toBeTruthy();
  });

  // 卡1 消费徽章（v2.3 区间记账）：纯消费区间求和只统计消耗，本场景 100→98 → 「已用 ¥2.00」
  it("卡1 徽章显示消费金额而非余额涨跌", () => {
    expect(panel.includes("已用 ¥")).toBeTruthy();
  });

  it("余额上涨不再显示 ▲ 充值徽章", () => {
    expect(!panel.includes("▲ +")).toBeTruthy();
  });

  it("柱形槽位 ≤15+占位", () => {
    expect(barsInCard2 <= 16, `柱形槽位 ≤15+占位（实际 ${barsInCard2}）`).toBeTruthy();
  });

  it("20 天前日期不在窗口内", () => {
    expect(!panelMany.includes(dayKey(now - 20 * 86400000).slice(5))).toBeTruthy();
  });

  it("空 history 占位不抛错", () => {
    expect(emptyPanel.includes("暂无历史数据")).toBeTruthy();
  });

  it("缺口场景出现未计提示（v2.3 区间记账）", () => {
    expect(panelGap.includes("未计") || panelGap.includes("中断不计")).toBeTruthy();
  });

  it("折线仅末点高亮一个 circle（降采样后仍单线）", () => {
    expect(circleCount).toBe(1);
  });
});

describe("C8 集成面：is_available=false 帧不作为守恒端点（经 formatPanel 数据通路）", () => {
  let panel;

  beforeAll(() => {
    const now = utc(2026, 8, 26, 12, 0); // 周三
    const entries = [
      { time: now - 48 * 3600000, data: { balance: 100, toppedUp: 90, grantedBalance: 10, isAvailable: true } },   // 周一
      { time: now - 24 * 3600000, data: { balance: 40, toppedUp: 90, grantedBalance: 10, isAvailable: false } },  // 周二（不可用）
      { time: now, data: { balance: 38, toppedUp: 90, grantedBalance: 10, isAvailable: true } },                  // 周三
    ];
    panel = deepSeekOfficialAdapter.formatPanel({
      entries,
      range: { start: now - 3 * 86400000, end: now },
      truncated: false,
      esc,
    });
  });

  it("不可用端点相邻区间注记「含不可用区间不计」而非计入消耗", () => {
    expect(panel.includes("不可用区间不计")).toBeTruthy();
  });

  it("不可用帧的 60 元差额未被误计为用量", () => {
    expect(!panel.includes("消耗 ¥60")).toBeTruthy();
  });

  // 相邻两区间（周一→周二、周二→周三）均被跳过 → 汇总不含虚高值
  it("汇总仅含有效区间（本场景为 0）", () => {
    expect(panel.includes("消耗约 ¥0.00")).toBeTruthy();
  });
});

describe("v2.3 卡1 徽章消费口径：充值区间剔除后不再显示 ▲，余额上涨场景徽章显示消费≈0", () => {
  let panel;

  beforeAll(() => {
    const now = utc(2026, 8, 26, 12, 0);
    const entries = [
      { time: now - 5 * 3600000, data: { balance: 10, toppedUp: 10, grantedBalance: 0, isAvailable: true } },
      { time: now, data: { balance: 55.62, toppedUp: 55.62, grantedBalance: 0, isAvailable: true } },
    ];
    panel = deepSeekOfficialAdapter.formatPanel({
      entries,
      range: { start: now - 86400000, end: now },
      truncated: false,
      esc,
    });
  });

  it("余额上涨（充值）不再显示 ▲ 徽章", () => {
    expect(!panel.includes("▲")).toBeTruthy();
  });

  // 单一扰动区间下无可计账区间 → 消费未知（比强行声称 ≈0 更诚实）
  it("无可计区间时徽章显示消费未知", () => {
    expect(panel.includes("— 消费未知")).toBeTruthy();
  });

  it("徽章 title 注明未计入的充值额", () => {
    expect(panel.includes("另有充值 +¥45.62")).toBeTruthy();
  });
});

// ================================================================ A2 opencode-go 空 data 防御回归

describe("A2 opencode-go 空 data 防御回归", () => {
  let html, panelHtml;

  beforeAll(() => {
    html = openCodeGoAdapter.formatCapsule({
      time: Date.now(),
      data: {},
      status: "stale",
      error: "network",
      esc,
    });
    panelHtml = openCodeGoAdapter.formatPanel({ entries: [], range: { start: 0, end: 1 }, truncated: false, esc });
  });

  it("opencode-go 空 data + stale → 「无数据」占位不抛错", () => {
    expect(html).toBe("<span>无数据</span>");
  });

  it("opencode-go formatPanel 空 entries 回归", () => {
    expect(panelHtml.includes("暂无历史数据"), `opencode-go formatPanel 空 entries 回归（${OPENCODE_GO_ADAPTER_ID}）`).toBeTruthy();
  });
});

// ================================================================ 管线集成：runV2Pipeline 失败分支 stale 帧

describe("管线集成：runV2Pipeline 失败分支 stale 帧", () => {
  let result, resultWithHistory, resultBadHistory, okResult, sanitized;

  beforeAll(async () => {
    const netFail = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    result = await runV2Pipeline({
      adapter: deepSeekOfficialAdapter,
      provider: DEEPSEEK_OFFICIAL_PROVIDER,
      config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
      staticPath: "",
      timeoutMs: 2000,
      fetchImpl: netFail,
    });

    // 带值降级：注入 history 时失败帧用最后一条成功数据渲染胶囊（数值不跌 "--"，
    // 数据来源状态由客户端圆点 dou-dot-warn 表达）；status/error 语义不变。
    const lastOk = { time: Date.now() - 600000, data: { isAvailable: true, balance: 88.88, toppedUp: 88.88, grantedBalance: 0 } };
    resultWithHistory = await runV2Pipeline({
      adapter: deepSeekOfficialAdapter,
      provider: DEEPSEEK_OFFICIAL_PROVIDER,
      config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
      staticPath: "",
      timeoutMs: 2000,
      fetchImpl: netFail,
      history: { last: async () => lastOk },
    });

    // history 兜底读失败视同无历史：回退空 data 占位，绝不因兜底读失败放大错误
    resultBadHistory = await runV2Pipeline({
      adapter: deepSeekOfficialAdapter,
      provider: DEEPSEEK_OFFICIAL_PROVIDER,
      config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk-pipe" },
      staticPath: "",
      timeoutMs: 2000,
      fetchImpl: netFail,
      history: { last: async () => { throw new Error("disk-boom"); } },
    });

    // 成功分支 fresh 帧 rawData 正常
    okResult = await runV2Pipeline({
      adapter: deepSeekOfficialAdapter,
      provider: DEEPSEEK_OFFICIAL_PROVIDER,
      config: { apiEndpoint: "", apiKey: "sk-pipe" },
      staticPath: "",
      timeoutMs: 2000,
      fetchImpl: (() => Promise.resolve(mockRes(200, officialBody()))) as unknown as typeof fetch,
    });

    // D5 sanitizeHtml 后 SVG 结构存活且净化面干净（panelHtml 走同一 sanitize 出口）
    sanitized = sanitizeHtml('<svg role="img"><rect onmouseover="x()" fill="#fff"></rect></svg><a href="javascript:alert(1)">y</a>');
  });

  it("失败帧 ok=false", () => {
    expect(result.ok).toBe(false);
  });

  it("失败帧 status=stale", () => {
    expect(result.status).toBe("stale");
  });

  it("失败帧 error=network", () => {
    expect(result.error).toBe("network");
  });

  it("失败分支 capsuleHtml 非空", () => {
    expect(typeof result.capsuleHtml === "string" && result.capsuleHtml.length > 0).toBeTruthy();
  });

  it("空 data 渲染占位", () => {
    expect(result.capsuleHtml.includes("DeepSeek 余额 --")).toBeTruthy();
  });

  it("峰谷徽标 stale 帧常驻（G8）", () => {
    expect(result.capsuleHtml.includes("dou-peak")).toBeTruthy();
  });

  it("错误帧不带 rawData（不落盘前提）", () => {
    expect(result.rawData).toBe(undefined);
  });

  // I2 错误文案无插值注入面：净化后无脚本执行面
  it("capsuleHtml 无脚本载体", () => {
    expect(!result.capsuleHtml.includes("<script")).toBeTruthy();
  });

  it("带值降级仍为 stale 帧", () => {
    expect(resultWithHistory.status).toBe("stale");
  });

  it("胶囊渲染历史最后成功余额", () => {
    expect(resultWithHistory.capsuleHtml!.includes("¥88.88")).toBeTruthy();
  });

  it("不再跌无数据占位", () => {
    expect(!resultWithHistory.capsuleHtml!.includes("DeepSeek 余额 --")).toBeTruthy();
  });

  it("错误码保持原始取数错误", () => {
    expect(resultBadHistory.error).toBe("network");
  });

  it("兜底读失败回退占位", () => {
    expect(resultBadHistory.capsuleHtml!.includes("DeepSeek 余额 --")).toBeTruthy();
  });

  it("成功帧 ok=true", () => {
    expect(okResult.ok).toBe(true);
  });

  it("成功帧 status=fresh", () => {
    expect(okResult.status).toBe("fresh");
  });

  it("成功帧 rawData.balance=110", () => {
    expect(okResult.rawData?.balance).toBe(110);
  });

  it("成功帧胶囊渲染余额", () => {
    expect(okResult.capsuleHtml.includes("余额 ¥110.00")).toBeTruthy();
  });

  it("sanitize 后 svg 结构存活", () => {
    expect(sanitized.includes("<svg")).toBeTruthy();
  });

  it("on* 事件属性被移除", () => {
    expect(!sanitized.includes("onmouseover")).toBeTruthy();
  });

  it("javascript: URI 被移除", () => {
    expect(!sanitized.includes("javascript:")).toBeTruthy();
  });
});

// ---- #592 dailyBarTitle 拆解：单日柱悬浮文案全分支（含聚合器不产出的防御态） ----

describe("#592 dailyBarTitle 拆解：单日柱悬浮文案全分支", () => {
  const R = (over) => ({ key: "2026-08-24", status: "ok", u: 1.5, ...over });

  it("empty 态", () => {
    expect(dailyBarTitle(R({ status: "empty", u: 0 }), 0, 3)).toBe("08-24 无采样");
  });

  it("insufficient 态", () => {
    expect(dailyBarTitle(R({ status: "insufficient", u: 0 }), 0, 3)).toBe("08-24 样本不足");
  });

  it("gap 态（防御分支）", () => {
    expect(dailyBarTitle(R({ status: "gap", u: 0 }), 0, 3)).toBe("08-24 数据中断");
  });

  it("unavailable 态（防御分支）", () => {
    expect(dailyBarTitle(R({ status: "unavailable", u: 0 }), 0, 3)).toBe("08-24 服务不可用区间不计");
  });

  it("anomaly 态带 note", () => {
    expect(dailyBarTitle(R({ status: "anomaly", u: 0, note: "余额净增 ¥1.20（异常）" }), 0, 3)).toBe("08-24 余额净增 ¥1.20（异常）");
  });

  it("anomaly 态 note 缺省", () => {
    expect(dailyBarTitle(R({ status: "anomaly", u: 0 }), 0, 3)).toBe("08-24 数值异常");
  });

  it("净增 + extra 括注", () => {
    expect(dailyBarTitle(R({ neg: true, u: -0.3, extra: "充值 +¥0.80 未计入" }), 0, 3)).toBe("08-24 余额净增 ¥0.30（充值 +¥0.80 未计入）");
  });

  it("消耗 + extra 括注", () => {
    expect(dailyBarTitle(R({ u: 1.5, extra: "1 段中断不计" }), 0, 3)).toBe("08-24 消耗 ¥1.50（1 段中断不计）");
  });

  it("末位记录判今日", () => {
    expect(dailyBarTitle(R({ u: 1.5 }), 2, 3)).toBe("今日 消耗 ¥1.50");
  });

  it("单记录窗口恒今日", () => {
    expect(dailyBarTitle(R({ u: 1.5 }), 0, 1)).toBe("今日 消耗 ¥1.50");
  });

  it("非末位为 MM-DD 标签", () => {
    expect(dailyBarTitle(R({ u: 1.5 }), 0, 3)).toBe("08-24 消耗 ¥1.50");
  });
});

// ---- #592 formatPanel 集成：柱图渲染路径（六态混合采样 → 全部柱形与文案落地） ----

describe("#592 formatPanel 集成：柱图渲染路径（六态混合采样）", () => {
  let panel, rectCount;

  beforeAll(() => {
    // 固定 now：UTC 正午。采样间隔全部 26~28h（>24h 保证任意时区下相邻区间
    // 结束端落不同日桶，断言与时区无关；首段 28h > GAP_MS 触发中断层）。
    const NOW = utc(2026, 9, 1, 12, 0);
    const en = (t, balance, toppedUp = 0) => ({ time: t, data: { balance, toppedUp, grantedBalance: null, isAvailable: true } });
    const H = 3600000;
    //   A(T-133h,100) → B(T-105h,90)：28h > GAP_MS → 中断层（A 所在日仅 1 帧 → 样本不足）
    //   B → C(T-79h,90.3)：免充值净增 0.3 ∈ (-1,-TOL) → 绿柱净增
    //   C → C2(T-53h,92.3)：免充值净增 2.0 < ANOMALY_NEG → 异常态
    //   C2 → D(T-27h,90.8)：消耗 1.5 → 蓝柱
    //   D → E(T-1h,90.3,toppedUp 0.8)：消耗 0.5 + 充值 0.8 → 今日柱带充值附注
    //   15 日窗口其余日 → 无采样
    const entries = [
      en(NOW - 133 * H, 100),
      en(NOW - 105 * H, 90),
      en(NOW - 79 * H, 90.3),
      en(NOW - 53 * H, 92.3),
      en(NOW - 27 * H, 90.8),
      en(NOW - 1 * H, 90.3, 0.8),
    ];
    panel = deepSeekOfficialAdapter.formatPanel({ entries, range: { end: NOW } });
    rectCount = (panel.match(/<rect /g) ?? []).length;
  });

  it("空日占位文案", () => {
    expect(panel.includes("无采样")).toBeTruthy();
  });

  it("单帧冷启动日文案", () => {
    expect(panel.includes("样本不足")).toBeTruthy();
  });

  it("异常态文案（note 口径）", () => {
    expect(panel.includes("余额净增 ¥2.00（异常）")).toBeTruthy();
  });

  it("净增绿柱文案", () => {
    expect(panel.includes("余额净增 ¥0.30")).toBeTruthy();
  });

  it("消耗蓝柱文案", () => {
    expect(panel.includes("消耗 ¥1.50")).toBeTruthy();
  });

  it("今日标签", () => {
    expect(panel.includes("今日")).toBeTruthy();
  });

  it("充值附注括注", () => {
    expect(panel.includes("充值 +¥0.80 未计入")).toBeTruthy();
  });

  it("柱形 rect 数 ≥ 4", () => {
    expect(rectCount >= 4, `柱形 rect 数 ≥ 4（实际 ${rectCount}）`).toBeTruthy();
  });

  it("日用量卡标题", () => {
    expect(panel.includes("近 15 日用量")).toBeTruthy();
  });
});

afterAll(() => {
  console.log("[unit-deepseek-official] 全部断言通过 ✓ (#198 B/C/E/G/K)");
});
