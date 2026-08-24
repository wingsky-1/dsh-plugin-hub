// @ts-nocheck
/**
 * dsh-provider-usage — unit：内置 opencode-go 适配器纯函数群（#150 变异加固）。
 *
 * 覆盖：parseUsageResponse 双形状、fetchOpenCodeGoV2 错误链全分支、
 * miniChartSvgMarkup 结构断言（网格线/100% 参考线/重置线/x 轴刻度分档/
 * 降采样/平滑路径）、formatCapsule 三态、formatPanel 趋势三分支与空数据
 * 三分支。图表内部私有函数（niceDomain/timeTicks/downsample 等）一律经
 * 导出接口的 SVG 输出做行为级断言。
 */
import { assert } from "./helpers.ts";
import {
  parseUsageResponse,
  pickWindow,
  fetchOpenCodeGoV2,
  miniChartSvgMarkup,
  openCodeGoAdapter,
} from "../lib/index.js";

// ---------------------------------------------------------------- pickWindow 类型防御补充（#150）

assert.equal(pickWindow("str", "k", "n", 5), null, "字符串输入拒绝");
assert.equal(pickWindow(123, "k", "n", 5), null, "数字输入拒绝");
{
  const w = pickWindow({ percent: "42" }, "k", "名", 5);
  assert.ok(w !== null && w.percent === 42, "百分比字符串转数字");
}
{
  const w = pickWindow({ percent: "abc" }, "k", "名", 5);
  assert.ok(w !== null && w.percent === null, "非数字百分比归 null");
}
{
  const w = pickWindow({ raw: 123, resetsAt: 456 }, "k", "名", 5);
  assert.ok(w !== null && w.raw === undefined && w.resetsAt === undefined,
    "raw/resetsAt 非字符串丢弃");
}

// ---------------------------------------------------------------- parseUsageResponse 双形状（#150）

assert.equal(parseUsageResponse(null), null, "null 输入");
assert.equal(parseUsageResponse("body"), null, "字符串输入");
assert.equal(parseUsageResponse({}), null, "空对象无有效窗口");

{
  const direct = parseUsageResponse({
    rolling: { percent: 1 },
    weekly: { percent: 2 },
    monthly: { percent: 3 },
  });
  assert.ok(direct !== null && direct.rolling.percent === 1 && direct.weekly.percent === 2
    && direct.monthly.percent === 3, "直接三键形状解析");
}
{
  const wrapped = parseUsageResponse({ usage: { rolling: { percent: 7 } } });
  assert.ok(wrapped !== null && wrapped.rolling.percent === 7, "{usage:{}} 包裹形状解析");
  assert.ok(wrapped !== null && wrapped.weekly === undefined, "包裹形状下缺失窗口不产出键");
}

// ---------------------------------------------------------------- fetchOpenCodeGoV2 错误链（#150）

const baseCtx = (overrides = {}) => ({
  apiEndpoint: "https://api.test/zen",
  staticPath: "/usage",
  apiKey: "sk-test",
  provider: "opencode-go",
  timeoutMs: 500,
  ...overrides,
});

async function assertRejects(promise, message) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught !== null && String(caught.message) === message, `错误链：${message}`);
}

await assertRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: undefined }),), "no-api-key");
await assertRejects(fetchOpenCodeGoV2(baseCtx({ apiKey: "" })), "no-api-key");
await assertRejects(
  fetchOpenCodeGoV2(baseCtx(), async () => { throw new Error("boom"); }),
  "network",
);

const okBody = {
  rolling: { percent: 11 },
  weekly: { percent: 22 },
  monthly: { percent: 33 },
};
const makeFetch = (status, body, failJson = false, capture = []) => async (url, init) => {
  capture.push({ url, auth: init?.headers?.Authorization });
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (failJson) throw new Error("Unexpected token");
      return typeof body === "function" ? body() : body;
    },
  };
};

const captured = [];
{
  const data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, okBody, false, captured));
  assert.equal(data.rolling.percent, 11, "成功路径 rolling 百分比");
  assert.equal(data.weekly.percent, 22, "成功路径 weekly 百分比");
  assert.equal(data.monthly.percent, 33, "成功路径 monthly 百分比");
  assert.equal(captured[0].url, "https://api.test/zen/usage", "apiEndpoint + staticPath 拼接");
  assert.equal(captured[0].auth, "Bearer sk-test", "Bearer 鉴权头注入");
}
{
  // 缺失窗口补默认占位（percent null + limit）
  const data = await fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { rolling: { percent: 5 } }));
  assert.equal(data.weekly.percent, null, "缺失窗口补 percent null");
  assert.equal(data.monthly.limit, 60, "缺失窗口补默认限额");
}
{
  const data = await fetchOpenCodeGoV2(
    baseCtx({ apiEndpoint: "" }),
    makeFetch(200, okBody),
  );
  assert.equal(data.rolling.percent, 11, "空 apiEndpoint 回落默认地址仍成功");
}

await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(401, {})), "unauthorized");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(403, {})), "unauthorized");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(500, {})), "http-500");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, {}, true)), "bad-json");
await assertRejects(fetchOpenCodeGoV2(baseCtx(), makeFetch(200, { foo: 1 })), "bad-data");

// ---------------------------------------------------------------- miniChartSvgMarkup 结构断言（#150）

const T0 = new Date(2026, 5, 15, 10, 0, 0).getTime();
const MIN = 60000;

assert.equal(miniChartSvgMarkup({
  samples: [{ x: T0, y: 10 }], color: "#000", lo: 0, hi: 100,
  resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
}), "", "少于 2 个采样点返回空串");

{
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100">'),
    "SVG 头与固定视口尺寸");
  assert.ok(svg.endsWith("</svg>"), "SVG 闭合标签");
  assert.ok(svg.includes('fill:#abc;fill-opacity:.13'), "面积填充使用传入色与固定透明度");
  assert.ok(svg.includes('stroke:#abc;stroke-width:1.6'), "折线描边样式");
  assert.ok(svg.includes("<circle"), "末点圆标记存在");
  assert.ok(svg.includes(">10%</text>") || svg.includes(">0%</text>"),
    "y 轴刻度含整数百分比文案");
  assert.ok(svg.includes('stroke-dasharray:4 3;stroke-opacity:.65'), "100% 参考线虚线样式");
  assert.ok(svg.includes('font-size:9px">100%</text>'),
    "lo<=100<=hi 时绘制 100% 配额参考线（与 y 轴 9.5px 刻度字号区分）");
}
{
  // hi < 100：无参考线；刻度出现小数格式
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 1 }, { x: T0 + 30 * MIN, y: 2 }],
    color: "#abc", lo: 0.5, hi: 99, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(!svg.includes(">100%</text>"), "hi<100 无 100% 参考线");
  assert.ok(svg.includes(">0.5%</text>"), "非整数刻度保留一位小数");
}
{
  // 重置线：resetsAt 落在采样区间内
  const resetsAt = new Date(T0 + 10 * MIN).toISOString();
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 5 * 3600000,
    dateOnly: false,
  });
  assert.ok(svg.includes("<title>窗口重置点</title>"), "区间内重置点画虚线并带标题");
  assert.ok(svg.includes('stroke-dasharray:2 3'), "重置线短虚线样式");
  assert.ok(svg.includes('l 3.5 3.5 l -7 0 z'), "重置点三角标记");
}
{
  // resetsAt 在区间外（早于 t0 一个周期以上）：无重置线
  const resetsAt = new Date(T0 - 48 * 3600000).toISOString();
  const svg = miniChartSvgMarkup({
    samples: [{ x: T0, y: 10 }, { x: T0 + 30 * MIN, y: 20 }],
    color: "#abc", lo: 0, hi: 100, resetsAt, resetPeriodMs: 3600000, dateOnly: false,
  });
  assert.ok(!svg.includes("<title>窗口重置点</title>"), "历史周期点全部落在区间外时不画重置线");
}
{
  // x 轴刻度格式分档：span<1 天 → HH:mm；dateOnly → M-D
  const short = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 30 * MIN, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(/>\d{2}:\d{2}<\/text>/.test(short), "短跨度刻度为 HH:mm");
  const dateOnly = miniChartSvgMarkup({
    samples: [{ x: T0, y: 0 }, { x: T0 + 26 * 3600000, y: 5 }],
    color: "#c", lo: 0, hi: 10, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  assert.ok(/>\d+-\d\d<\/text>/.test(dateOnly), "dateOnly 刻度为 M-DD（月不补零日补零）");
}
{
  // 降采样：超过 300 点仍产出合法 SVG 并保留最后一点
  const many = [];
  for (let i = 0; i < 320; i += 1) {
    many.push({ x: T0 + i * MIN, y: i % 50 });
  }
  const svg = miniChartSvgMarkup({
    samples: many, color: "#c", lo: 0, hi: 100,
    resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.startsWith("<svg") && svg.includes("<circle"), "超量采样降采样后仍有折线与末点");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatCapsule（#150）

const capsBase = { time: T0, status: "fresh", esc: (s) => String(s) };

{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: {
      rolling: { percent: 3 },
      weekly: { percent: 1 },
      monthly: { percent: 0 },
    },
  });
  assert.equal(html, "<span>5h 3% · 周 1% · 月 0%</span>", "三窗口短名按序拼接");
}
{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: { monthly: { percent: 4 } },
  });
  assert.equal(html, "<span>月 4%</span>", "仅单一窗口有值");
}
{
  const html = openCodeGoAdapter.formatCapsule({ ...capsBase, data: {} });
  assert.equal(html, "<span>无数据</span>", "全窗口缺失回退无数据文案");
}
{
  const html = openCodeGoAdapter.formatCapsule({
    ...capsBase,
    data: { rolling: { percent: null } },
  });
  assert.equal(html, "<span>无数据</span>", "percent null 不计入展示");
}

// ---------------------------------------------------------------- openCodeGoAdapter.formatPanel（#150）

const H5 = 3600000;
const mkEntry = (offsetMs, windows) => ({ time: T0 + offsetMs, data: windows });

assert.equal(openCodeGoAdapter.formatPanel({
  entries: [], range: { start: T0, end: T0 }, truncated: false, esc: (s) => String(s),
}), "<p>暂无历史数据</p>", "空历史返回占位段落");

{
  // 单条 entry：三点分支之「数据采集中」
  const html = openCodeGoAdapter.formatPanel({
    entries: [mkEntry(0, { rolling: { percent: 10 } })],
    range: { start: T0, end: T0 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("数据采集中：每次刷新记录一个采样点"), "单采样点提示积累文案");
  assert.ok((html.match(/dou-card/g) || []).length >= 3, "三窗口各一张卡片");
  assert.ok(html.includes(">10%</span>"), "卡片头当前百分比直出");
}
{
  // 两条 entry、第二窗口全 null：区分「采样不足」分支
  const html = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10 }, weekly: { percent: null } }),
      mkEntry(H5, { rolling: { percent: 20 }, weekly: { percent: null } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("该时间范围内采样不足"), "无有效点窗口提示采样不足");
  assert.ok(html.includes("dou-miniChart"), "有效点窗口渲染迷你图");
  assert.ok(html.includes("dou-trend-up") && html.includes("▲ +10%"), "上升趋势三角与增量");
}
{
  // 下降趋势与平坦趋势
  const down = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 20 } }),
      mkEntry(H5, { rolling: { percent: 10 } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(down.includes("dou-trend-down") && down.includes("▼ -10%"), "下降趋势负增量");
  const flat = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10 } }),
      mkEntry(H5, { rolling: { percent: 10 } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(flat.includes("dou-trend-flat") && flat.includes("— 0%"), "持平趋势零增量");
}
{
  // resetsAt 展示在卡片限额行；最新窗口 pct null 显示 --
  const resetsAtIso = new Date(T0 + H5).toISOString();
  const html = openCodeGoAdapter.formatPanel({
    entries: [
      mkEntry(0, { rolling: { percent: 10, resetsAt: resetsAtIso } }),
      mkEntry(H5, { rolling: { percent: 11, resetsAt: resetsAtIso }, monthly: { percent: null } }),
    ],
    range: { start: T0, end: T0 + H5 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("重置 "), "resetsAt 渲染重置文案");
  assert.ok(html.includes("限额 12"), "rolling 默认限额 12 出现在卡片头");
  assert.ok(html.includes(">--</span>"), "最新窗口无百分比显示 -- 占位");
}
{
  // 观察窗过滤：rolling 只看最近 12h，窗外采样不进趋势
  const old = mkEntry(-13 * H5, { rolling: { percent: 90 } });
  const recent1 = mkEntry(-H5, { rolling: { percent: 10 } });
  const recent2 = mkEntry(0, { rolling: { percent: 12 } });
  const html = openCodeGoAdapter.formatPanel({
    entries: [old, recent1, recent2],
    range: { start: T0 - 13 * H5, end: T0 }, truncated: false, esc: (s) => String(s),
  });
  assert.ok(html.includes("▲ +2%"), "窗外高百分比不参与趋势计算");
}
