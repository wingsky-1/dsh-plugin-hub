/**
 * dsh-provider-usage — 使用趋势纯函数单测（#503 M2.1）。
 *
 * 覆盖方案 §3.5 要求的客户端判定面：范围档位矩阵（粒度 × retentionDays）、
 * 月键标签、部分桶起点、nice 上界、Y 域口径（#589 桶堆叠合计）、
 * 空桶/部分桶的 SVG 形态断言。
 * 被测对象为 src/client/trend-math.ts 真实源码（esbuild 即时打包，同 unit-detect
 * 先例；trend.tsx 顶部 import react，node 测试环境不可直载）。i18n 未装配时回落
 * key 本体（shared/client/i18n.js 行为零变化），SVG 断言不依赖文案。
 * provider 名不受信——escHtml 注入面一并覆盖。
 */
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..", "..", "..");

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
  trendYTicks,
  seriesColor,
  stackedBarsSvg,
  stackedAreasSvg,
  dirStackId,
  dirDisplayLabel,
  dirNeedsScopeNote,
  trendRequestParams,
  shouldShowDirSelect,
  shouldShowByModel,
} = math;

// #633 分片 b2：i18n 未装配时 t() 回落 key 本体（shared/client/i18n.js 约定），
// 本文件所有未识别展示断言均以 key 字面为预期值（运行时装配后即「未识别」译文）。

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

test("trendYTicks：Y 域口径 = 桶堆叠合计 point.total（#589，#571 遗留）", () => {
  // 多段桶：单段最大 600K、桶合计 1.1M（= 汇总卡「峰值」）——旧单段口径轴顶 600K，
  // 堆叠柱顶溢出绘图区；正确口径轴顶 1.25M ≥ 峰值
  const a = trendYTicks([
    { total: 1_100_000 },
    { total: 600_000 },
  ]);
  assert.equal(a.top, 1_250_000);
  assert.ok(a.top >= 1_100_000, `轴顶 ${a.top} ≥ 峰值 1.1M`);
  assert.notEqual(a.top, niceTicks(600_000).top, "与旧单段口径区分（回归护栏）");
  // 单段桶场景与 niceTicks 直推一致（无堆叠时不改变 #571 已修的步长行为）
  assert.deepEqual(trendYTicks([{ total: 792_000 }]), niceTicks(792_000));
  // 全 null series / 空窗口：回退单刻度 [0,1]
  assert.deepEqual(trendYTicks([{ total: null }, { total: null }]), { ticks: [0, 1], top: 1 });
  assert.deepEqual(trendYTicks([]), { ticks: [0, 1], top: 1 });
  // 顶格 ≥ 每桶合计（任意数据形状）
  for (const v of [792_000, 1_700_000, 12_300]) {
    const { top } = trendYTicks([{ total: v }, { total: v / 2 }, { total: null }]);
    assert.ok(top >= v, `top ${top} >= 桶合计 ${v}`);
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

// ---------------------------------------------------------------- #633 分片 b2 B2/B3：目录维度客户端防御（dirStackId / dirDisplayLabel / dirNeedsScopeNote）

test("#633 B3 dirStackId：异常目录值防御归未识别桶（不渲染空标签）", () => {
  assert.equal(dirStackId("(unidentified)"), "(unidentified)", "未识别桶键原样");
  assert.equal(dirStackId("dsh-plugin-hub"), "dsh-plugin-hub", "具名目录原样");
  assert.equal(dirStackId(null), "(unidentified)", "null 归未识别");
  assert.equal(dirStackId(undefined), "(unidentified)", "undefined 归未识别");
  assert.equal(dirStackId(42), "(unidentified)", "非字符串归未识别");
  assert.equal(dirStackId(""), "(unidentified)", "空串归未识别（杜绝空标签）");
  assert.equal(dirStackId("   "), "   ", "纯空白串键保留（id 唯一性；展示层经 dirDisplayLabel 归未识别）");
});

test("#633 B3 dirDisplayLabel：控制字符剥除 + 空值回退未识别展示", () => {
  assert.equal(dirDisplayLabel("proj"), "proj", "具名目录原样展示");
  assert.equal(dirDisplayLabel("pro\u0007ject"), "project", "C0 控制字符剥除（DOM 不出现控制字符）");
  assert.equal(dirDisplayLabel("pro\u009bject"), "project", "C1 控制字符剥除");
  assert.equal(dirDisplayLabel("a\u001fb\u007fc"), "abc", "多控制字符混合剥除");
  assert.equal(dirDisplayLabel(""), "trendDirUnidentified", "空串 → 未识别展示（不得渲染空标签）");
  assert.equal(dirDisplayLabel("\u0007\u001f"), "trendDirUnidentified", "剥后为空 → 未识别展示");
  assert.equal(dirDisplayLabel("   "), "trendDirUnidentified", "纯空白 → 未识别展示");
  assert.equal(dirDisplayLabel(null), "trendDirUnidentified", "null → 未识别展示");
  assert.equal(dirDisplayLabel(undefined), "trendDirUnidentified", "undefined → 未识别展示");
});

test("#633 B2 dirDisplayLabel：未识别桶恒有标签 + dirNeedsScopeNote 口径注明", () => {
  assert.equal(dirDisplayLabel("(unidentified)"), "trendDirUnidentified", "未识别桶 → 「未识别」人话（恒出现为有标签条目，不空串不消失）");
  assert.equal(dirNeedsScopeNote("(unidentified)"), true, "未识别桶注明口径（title=无目录信息的会话）");
  assert.equal(dirNeedsScopeNote("dsh-plugin-hub"), false, "具名目录不带口径注释");
  assert.equal(dirNeedsScopeNote(""), true, "异常空值同归未识别 → 注明口径");
  assert.equal(dirNeedsScopeNote(null), true, "null 同上");
});

test("#633 B2/B3 展示语义与值语义分离：dirStackId 与 dirDisplayLabel 组合行为", () => {
  // 筛选值/图例 id 用原始键（dirStackId）；展示文本用 dirDisplayLabel——
  // 未识别桶筛选参数仍传 "(unidentified)"（宿主桶键），UI 呈现「未识别」。
  const key = dirStackId(null);
  assert.equal(key, "(unidentified)", "值语义：null 归未识别桶键（筛选参数可直达宿主）");
  assert.equal(dirDisplayLabel(key), "trendDirUnidentified", "展示语义：同键呈现「未识别」");
  // 超长目录名（B3 >80 字符）：展示层不截断（宿主出口已按 C2 口径 basename+截断；
  // 客户端防御仅剥控制字符与空值回退——不截断不暗中合并目录桶，与宿主数据层一致）
  const long = "d".repeat(120);
  assert.equal(dirDisplayLabel(long), long, "超长键原样展示（不截断不合并，宿主出口负责口径）");
  assert.equal(dirStackId(long), long, "超长键值语义原样（独立目录桶，不并入未识别）");
});

// ---------------------------------------------------------------- #633 复核闸 P0：请求参数三态互斥与两维控件可见性

test("#633 P0 trendRequestParams：默认面 = byDir=1 且无 dir/provider（B1 入口可达）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "", 30);
  assert.equal(p.get("byDir"), "1", "默认（provider=\"\"、dirFilter=\"\"）→ byDir=1 全目录拆段面");
  assert.equal(p.get("dir"), null, "默认面不带 dir");
  assert.equal(p.get("provider"), null, "默认面不带 provider");
  assert.equal(p.get("byModel"), null, "默认面不带 byModel");
  assert.equal(p.get("granularity"), "day", "基础参数 granularity 原样");
  assert.equal(p.get("metric"), "total", "基础参数 metric 原样");
  assert.equal(p.get("n"), "30", "基础参数 n = 生效档位");
});

test("#633 P0 trendRequestParams：adapter 过滤面 = 纯 provider 参数（零目录参数）", () => {
  const p = trendRequestParams("day", "total", 30, "p1", false, "", 30);
  assert.equal(p.get("provider"), "p1", "provider=p1 请求带 provider");
  assert.equal(p.get("byDir"), null, "adapter 面无 byDir（修复前恒带 byDir=1 交叉）");
  assert.equal(p.get("dir"), null, "adapter 面无 dir（交叉面必空 → 参数层杜绝）");
  // byModel 细分同属 adapter 面：同样零目录参数
  const pm = trendRequestParams("week", "calls", 13, "p1", true, "", 13);
  assert.equal(pm.get("byModel"), "1", "byModel 细分参数正常携带");
  assert.equal(pm.get("provider"), "p1", "byModel 面带 provider");
  assert.equal(pm.get("byDir"), null, "byModel 面（adapter 过滤）同样无 byDir");
  assert.equal(pm.get("dir"), null, "byModel 面同样无 dir");
});

test("#633 P0 trendRequestParams：目录过滤面 = dir=<键>（无 byDir 无 provider）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "proj", 30);
  assert.equal(p.get("dir"), "proj", "dirFilter=proj → dir=proj 过滤面");
  assert.equal(p.get("byDir"), null, "过滤面不再发 byDir=1（三态互斥）");
  assert.equal(p.get("provider"), null, "目录面无 provider 参数（目录数据无 provider 维度）");
});

test("#633 P0 trendRequestParams：未识别桶键同为合法过滤值（B2 口径）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "(unidentified)", 30);
  assert.equal(p.get("dir"), "(unidentified)", "未识别桶键直传 dir（宿主桶键合法过滤值）");
  assert.equal(p.get("byDir"), null, "过滤面无 byDir");
});

test("#633 P0 shouldShowDirSelect/shouldShowByModel：两维控件互斥（状态真值渲染）", () => {
  assert.equal(shouldShowDirSelect(""), true, "默认面目录下拉恒可见（P0①：修复前 dirMode 恒真不可达）");
  assert.equal(shouldShowDirSelect("p1"), false, "adapter 过滤面隐藏目录下拉");
  assert.equal(shouldShowByModel("", ""), false, "默认面无 byModel checkbox");
  assert.equal(shouldShowByModel("p1", ""), true, "adapter 过滤面 checkbox 可见（修复前被 dirMode 恒真压制）");
  assert.equal(shouldShowByModel("", "proj"), false, "目录过滤面 checkbox 隐藏");
  assert.equal(shouldShowByModel("p1", "proj"), false, "防御：异常组合同样隐藏（状态联动保证不可达）");
});
