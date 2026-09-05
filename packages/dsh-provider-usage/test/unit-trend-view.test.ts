/**
 * dsh-provider-usage — 使用趋势纯函数单测（#503 M2.1）。
 *
 * 覆盖方案 §3.5 要求的客户端判定面：范围档位矩阵（粒度 × retentionDays）、
 * 月键标签、部分桶起点、nice 上界、空桶/部分桶的 SVG 形态断言。
 * 被测对象为 src/client/trend-math.ts 真实源码（esbuild 即时打包，同 unit-detect
 * 先例；trend.ts 顶部 import react，node 测试环境不可直载）。i18n 未装配时回落
 * key 本体（shared/client/i18n.js 行为零变化），SVG 断言不依赖文案。
 * provider 名不受信——escHtml 注入面一并覆盖。
 */
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---- 即时打包 src/client/trend-math.ts（真实源码直测；无 __DSH_ROUTES__ 消费面）----
const mathBundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/trend-math.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const math = await import(
  `data:text/javascript;base64,${Buffer.from(mathBundle.outputFiles[0].text).toString("base64")}`
);
const {
  fmtCompact,
  trendDelta,
  fmtAxisLabel,
  bucketStartKey,
  trendRangeOptions,
  trendDefaultRange,
  niceTicks,
  seriesColor,
  stackedBarsSvg,
  stackedAreasSvg,
} = math;

test("fmtCompact：紧凑档位与零 usage null 语义", () => {
  assert.equal(fmtCompact(null), "-");
  assert.equal(fmtCompact(Number.NaN), "-");
  assert.equal(fmtCompact(1234), "1,234");
  assert.equal(fmtCompact(12300), "12.3K");
  assert.equal(fmtCompact(4_560_000), "4.6M");
  assert.equal(fmtCompact(1_200_000_000), "1.2B");
});

test("trendDelta：prevComplete=false 时环比不可比（#503 M2.1）", () => {
  assert.equal(trendDelta(100, 50, false), null);
  assert.deepEqual(trendDelta(100, 50, true), { text: "+100.0%", up: true, down: false });
  assert.deepEqual(trendDelta(25, 50, true), { text: "-50.0%", up: false, down: true });
  assert.equal(trendDelta(100, null, true), null);
  assert.equal(trendDelta(100, 0, true), null);
});

test("fmtAxisLabel：月键 YY-MM（修复 M2 slice(5) 丢年份），日/周 MM-DD", () => {
  assert.equal(fmtAxisLabel("2026-02", "month"), "26-02");
  assert.equal(fmtAxisLabel("2025-12", "month"), "25-12");
  assert.equal(fmtAxisLabel("2026-02-03", "day"), "02-03");
  assert.equal(fmtAxisLabel("2026-02-02", "week"), "02-02");
});

test("bucketStartKey：桶起点（边缘判定基准）", () => {
  assert.equal(bucketStartKey("2026-02-03", "day"), "2026-02-03");
  assert.equal(bucketStartKey("2026-02-02", "week"), "2026-02-02"); // week 键即周一首日
  assert.equal(bucketStartKey("2026-02", "month"), "2026-02-01");
});

test("trendRangeOptions：按粒度×留存生成（桶数≠天数口径）", () => {
  // 默认留存 180 天：日档封顶 90；周 ≤⌈180/7⌉=26；月 ≤⌈180/30⌉=6
  assert.deepEqual(trendRangeOptions("day", 180), [7, 30, 90]);
  assert.deepEqual(trendRangeOptions("week", 180), [4, 13, 26]);
  assert.deepEqual(trendRangeOptions("month", 180), [3, 6]); // 月 12 跨度 365 天 > 180 天留存，裁掉
  // 留存 365 天：月 12 可得
  assert.deepEqual(trendRangeOptions("month", 365), [3, 6, 12]);
  assert.deepEqual(trendRangeOptions("day", 365), [7, 30, 90]); // 日档仍封顶 90（可读性）
  // 极小留存：空档回退单档
  assert.deepEqual(trendRangeOptions("day", 5), [5]);
  assert.deepEqual(trendRangeOptions("month", 10), [1]);
});

test("trendDefaultRange：默认档被留存裁掉时取最大可得档", () => {
  assert.equal(trendDefaultRange("day", 180), 30);
  assert.equal(trendDefaultRange("week", 180), 13);
  assert.equal(trendDefaultRange("month", 180), 6);
  assert.equal(trendDefaultRange("week", 20), 3); // ⌈20/7⌉=3，仅 [3] 可得
});

test("niceTicks：按数据最大值动态推导步长与刻度序列（#503 M2.1 后续）", () => {
  // 零/异常输入：回退单刻度 [0,1]
  assert.deepEqual(niceTicks(0), { ticks: [0, 1], top: 1 });
  // 792K → 步长 200K，顶格 800K 贴合数据（旧实现轴顶 1M，柱视觉只到 79%）
  const a = niceTicks(792_000);
  assert.equal(a.top, 800_000);
  assert.deepEqual(a.ticks, [0, 200_000, 400_000, 600_000, 800_000]);
  // 1.7M → 步长 500K，顶格 2M（5 条）
  const b = niceTicks(1_700_000);
  assert.equal(b.top, 2_000_000);
  assert.deepEqual(b.ticks, [0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
  // 2.5 步长：12.3K → 2.5K 步长，顶格 12.5K
  const c = niceTicks(12_300);
  assert.deepEqual(c.ticks, [0, 2_500, 5_000, 7_500, 10_000, 12_500]);
  // 小数值：45 → 步长 10，顶格 50
  assert.deepEqual(niceTicks(45).ticks, [0, 10, 20, 30, 40, 50]);
  // 顶格必 ≥ 数据最大值
  for (const v of [7, 999, 123_456, 9_999_999]) {
    const { ticks, top } = niceTicks(v);
    assert.ok(top >= v, `top ${top} >= maxV ${v}`);
    assert.equal(ticks[ticks.length - 1], top);
    assert.equal(ticks[0], 0);
  }
});

test("seriesColor：跨调用稳定", () => {
  assert.equal(seriesColor("deepseek"), seriesColor("deepseek"));
  assert.notEqual(seriesColor("a"), seriesColor("b"));
});

test("stackedBarsSvg：空桶虚位 / 部分桶描边 / data-bucket 委托锚点", () => {
  const bars = [
    { key: "2026-02-01", segs: [], visibleTotal: null, none: true, mark: null },
    { key: "2026-02-02", segs: [{ id: "p1", value: 100 }], visibleTotal: 100, none: false, mark: "edge" },
    { key: "2026-02-03", segs: [{ id: "p1", value: 60 }, { id: "p2", value: 40 }], visibleTotal: 100, none: false, mark: "ongoing" },
  ];
  const svg = stackedBarsSvg({ bars, gran: "day", ticks: niceTicks(100).ticks });
  assert.ok(svg.includes('data-bucket="0"') && svg.includes('data-bucket="2"'), "每桶带 data-bucket 委托锚点");
  assert.ok(svg.includes("stroke-dasharray:3 2"), "进行中桶警示虚线");
  assert.ok(svg.includes("stroke-dasharray:1.5 2.5"), "边缘桶灰点线");
  assert.ok(svg.includes("26-02") || svg.includes("02-0"), "X 轴日键 MM-DD");
  // 空桶虚位（fill-opacity .45 的细条）存在
  assert.ok(svg.includes('fill-opacity:.45'), "空桶虚位渲染");
});

test("stackedAreasSvg：连续段 / null 桶断开 / 命中区同构", () => {
  const bars = [
    { key: "2026-01", segs: [{ id: "p1", value: 30 }], visibleTotal: 30, none: false, mark: null },
    { key: "2026-02", segs: [], visibleTotal: null, none: true, mark: null }, // p1 断开点
    { key: "2026-03", segs: [{ id: "p1", value: 50 }, { id: "p2", value: 20 }], visibleTotal: 70, none: false, mark: null },
  ];
  const svg = stackedAreasSvg({ bars, gran: "month", ticks: niceTicks(70).ticks, stackOrder: ["p1", "p2"] });
  assert.equal(svg.match(/<path /g)?.length, 3, "p1 两段 + p1 一段 = 3 条 path（null 桶断开）");
  assert.ok(svg.includes('data-bucket="1"'), "面积模式同样有整列命中区");
  assert.ok(svg.includes("26-01") && svg.includes("26-03"), "月键 YY-MM 标签");
});

test("SVG 注入面：受信外文本不进 SVG（M2 的 <title> 注入面在 M2.1 已移除）", () => {
  // M2.1 的 SVG 内没有任何段 id/明细文本（id 仅哈希取色；明细走 React tooltip 文本节点自动转义）
  const evil = '<img src=x onerror=alert(1)>';
  const bars = [
    { key: "2026-02-01", segs: [{ id: evil, value: 10 }], visibleTotal: 10, none: false, mark: null },
  ];
  const svg = stackedBarsSvg({ bars, gran: "day", ticks: niceTicks(10).ticks });
  assert.ok(!svg.includes("<img"), "恶意段 id 不以任何形态进 SVG");
  assert.ok(!svg.includes("onerror"), "事件属性 payload 不存在");
  const areaSvg = stackedAreasSvg({ bars, gran: "day", ticks: niceTicks(10).ticks, stackOrder: [evil] });
  assert.ok(!areaSvg.includes("<img") && !areaSvg.includes("onerror"), "面积图同构");
});
