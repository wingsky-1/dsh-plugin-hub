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
 *
 * 结构：原 `test(...)` 块 → 一个 describe，块内每条断言 → 一个 it；循环内的
 * 参数化断言按取值展开为多个 it。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

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

describe("fmtCompact：紧凑档位与零 usage null 语义", () => {
  it("null → \"-\"", () => {
    expect(fmtCompact(null)).toBe("-");
  });

  it("NaN → \"-\"", () => {
    expect(fmtCompact(Number.NaN)).toBe("-");
  });

  it("1234 → 千分位", () => {
    expect(fmtCompact(1234)).toBe("1,234");
  });

  it("12300 → 12.3K", () => {
    expect(fmtCompact(12300)).toBe("12.3K");
  });

  it("4560000 → 4.6M", () => {
    expect(fmtCompact(4_560_000)).toBe("4.6M");
  });

  it("1200000000 → 1.2B", () => {
    expect(fmtCompact(1_200_000_000)).toBe("1.2B");
  });
});

describe("trendDelta：prevComplete=false 时环比不可比（#503 M2.1）", () => {
  it("prevComplete=false → null", () => {
    expect(trendDelta(100, 50, false)).toBeNull();
  });

  it("上升：+100.0%", () => {
    expect(trendDelta(100, 50, true)).toEqual({ text: "+100.0%", up: true, down: false });
  });

  it("下降：-50.0%", () => {
    expect(trendDelta(25, 50, true)).toEqual({ text: "-50.0%", up: false, down: true });
  });

  it("基准 null → null", () => {
    expect(trendDelta(100, null, true)).toBeNull();
  });

  it("基准 0 → null", () => {
    expect(trendDelta(100, 0, true)).toBeNull();
  });
});

describe("fmtAxisLabel：月键 YY-MM（修复 M2 slice(5) 丢年份），日/周 MM-DD", () => {
  it("2026-02 / month → 26-02", () => {
    expect(fmtAxisLabel("2026-02", "month")).toBe("26-02");
  });

  it("2025-12 / month → 25-12", () => {
    expect(fmtAxisLabel("2025-12", "month")).toBe("25-12");
  });

  it("2026-02-03 / day → 02-03", () => {
    expect(fmtAxisLabel("2026-02-03", "day")).toBe("02-03");
  });

  it("2026-02-02 / week → 02-02", () => {
    expect(fmtAxisLabel("2026-02-02", "week")).toBe("02-02");
  });
});

describe("bucketStartKey：桶起点（边缘判定基准）", () => {
  it("day 键即桶起点", () => {
    expect(bucketStartKey("2026-02-03", "day")).toBe("2026-02-03");
  });

  it("week 键即周一首日", () => {
    expect(bucketStartKey("2026-02-02", "week")).toBe("2026-02-02");
  });

  it("month 键 → 当月 1 日", () => {
    expect(bucketStartKey("2026-02", "month")).toBe("2026-02-01");
  });
});

describe("trendRangeOptions：按粒度×留存生成（桶数≠天数口径）", () => {
  // 默认留存 180 天：日档封顶 90；周 ≤⌈180/7⌉=26；月 ≤⌈180/30⌉=6
  it("day / 180 → [7, 30, 90]", () => {
    expect(trendRangeOptions("day", 180)).toEqual([7, 30, 90]);
  });

  it("week / 180 → [4, 13, 26]", () => {
    expect(trendRangeOptions("week", 180)).toEqual([4, 13, 26]);
  });

  it("month / 180 → [3, 6]（月 12 跨度 365 天 > 180 天留存，裁掉）", () => {
    expect(trendRangeOptions("month", 180)).toEqual([3, 6]);
  });

  it("留存 365 天：month → [3, 6, 12]", () => {
    expect(trendRangeOptions("month", 365)).toEqual([3, 6, 12]);
  });

  it("留存 365 天：day 仍封顶 90（可读性）", () => {
    expect(trendRangeOptions("day", 365)).toEqual([7, 30, 90]);
  });

  it("极小留存：day / 5 → 空档回退单档 [5]", () => {
    expect(trendRangeOptions("day", 5)).toEqual([5]);
  });

  it("极小留存：month / 10 → [1]", () => {
    expect(trendRangeOptions("month", 10)).toEqual([1]);
  });
});

describe("trendDefaultRange：默认档被留存裁掉时取最大可得档", () => {
  it("day / 180 → 30", () => {
    expect(trendDefaultRange("day", 180)).toBe(30);
  });

  it("week / 180 → 13", () => {
    expect(trendDefaultRange("week", 180)).toBe(13);
  });

  it("month / 180 → 6", () => {
    expect(trendDefaultRange("month", 180)).toBe(6);
  });

  it("week / 20 → 3（⌈20/7⌉=3，仅 [3] 可得）", () => {
    expect(trendDefaultRange("week", 20)).toBe(3);
  });
});

describe("niceTicks：按数据最大值动态推导步长与刻度序列（#503 M2.1 后续）", () => {
  // 零/异常输入：回退单刻度 [0,1]
  it("零输入 → 回退单刻度 [0,1]", () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], top: 1 });
  });

  // 792K → 步长 200K，顶格 800K 贴合数据（旧实现轴顶 1M，柱视觉只到 79%）
  it("792K → 顶格 800K 贴合数据", () => {
    expect(niceTicks(792_000).top).toBe(800_000);
  });

  it("792K → 刻度 [0, 200K, 400K, 600K, 800K]", () => {
    expect(niceTicks(792_000).ticks).toEqual([0, 200_000, 400_000, 600_000, 800_000]);
  });

  // 1.7M → 步长 500K，顶格 2M（5 条）
  it("1.7M → 顶格 2M", () => {
    expect(niceTicks(1_700_000).top).toBe(2_000_000);
  });

  it("1.7M → 刻度 [0, 500K, 1M, 1.5M, 2M]", () => {
    expect(niceTicks(1_700_000).ticks).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
  });

  // 2.5 步长：12.3K → 2.5K 步长，顶格 12.5K
  it("12.3K → 2.5K 步长，顶格 12.5K", () => {
    expect(niceTicks(12_300).ticks).toEqual([0, 2_500, 5_000, 7_500, 10_000, 12_500]);
  });

  // 小数值：45 → 步长 10，顶格 50
  it("小数值 45 → 步长 10，顶格 50", () => {
    expect(niceTicks(45).ticks).toEqual([0, 10, 20, 30, 40, 50]);
  });

  // 顶格必 ≥ 数据最大值
  for (const v of [7, 999, 123_456, 9_999_999]) {
    const { ticks, top } = niceTicks(v);

    it(`top ${top} >= maxV ${v}`, () => {
      expect(top >= v).toBeTruthy();
    });

    it(`niceTicks(${v})：末刻度=顶格（${top}）`, () => {
      expect(ticks[ticks.length - 1]).toBe(top);
    });

    it(`niceTicks(${v})：首刻度=0`, () => {
      expect(ticks[0]).toBe(0);
    });
  }
});

describe("trendYTicks：Y 域口径 = 桶堆叠合计 point.total（#589，#571 遗留）", () => {
  // 多段桶：单段最大 600K、桶合计 1.1M（= 汇总卡「峰值」）——旧单段口径轴顶 600K，
  // 堆叠柱顶溢出绘图区；正确口径轴顶 1.25M ≥ 峰值
  const a = trendYTicks([
    { total: 1_100_000 },
    { total: 600_000 },
  ]);

  it("桶合计 1.1M → 轴顶 1.25M", () => {
    expect(a.top).toBe(1_250_000);
  });

  it("轴顶 ≥ 峰值 1.1M", () => {
    expect(a.top >= 1_100_000).toBeTruthy();
  });

  it("与旧单段口径区分（回归护栏）", () => {
    expect(a.top).not.toBe(niceTicks(600_000).top);
  });

  it("单段桶场景与 niceTicks 直推一致", () => {
    // 单段桶场景与 niceTicks 直推一致（无堆叠时不改变 #571 已修的步长行为）
    expect(trendYTicks([{ total: 792_000 }])).toEqual(niceTicks(792_000));
  });

  it("全 null series → 回退单刻度 [0,1]", () => {
    expect(trendYTicks([{ total: null }, { total: null }])).toEqual({ ticks: [0, 1], top: 1 });
  });

  it("空窗口 → 回退单刻度 [0,1]", () => {
    expect(trendYTicks([])).toEqual({ ticks: [0, 1], top: 1 });
  });

  // 顶格 ≥ 每桶合计（任意数据形状）
  for (const v of [792_000, 1_700_000, 12_300]) {
    const { top } = trendYTicks([{ total: v }, { total: v / 2 }, { total: null }]);

    it(`top ${top} >= 桶合计 ${v}`, () => {
      expect(top >= v).toBeTruthy();
    });
  }
});

describe("seriesColor：跨调用稳定", () => {
  it("同名 → 同色（跨调用稳定）", () => {
    expect(seriesColor("deepseek")).toBe(seriesColor("deepseek"));
  });

  it("不同名 → 不同色", () => {
    expect(seriesColor("a")).not.toBe(seriesColor("b"));
  });
});

describe("stackedBarsSvg：空桶虚位 / 部分桶描边 / data-bucket 委托锚点", () => {
  const bars = [
    { key: "2026-02-01", segs: [], visibleTotal: null, none: true, mark: null },
    { key: "2026-02-02", segs: [{ id: "p1", value: 100 }], visibleTotal: 100, none: false, mark: "edge" },
    { key: "2026-02-03", segs: [{ id: "p1", value: 60 }, { id: "p2", value: 40 }], visibleTotal: 100, none: false, mark: "ongoing" },
  ];
  const svg = stackedBarsSvg({ bars, gran: "day", ticks: niceTicks(100).ticks });

  it("每桶带 data-bucket 委托锚点", () => {
    expect(svg.includes('data-bucket="0"') && svg.includes('data-bucket="2"')).toBeTruthy();
  });

  it("进行中桶警示虚线", () => {
    expect(svg.includes("stroke-dasharray:3 2")).toBeTruthy();
  });

  it("边缘桶灰点线", () => {
    expect(svg.includes("stroke-dasharray:1.5 2.5")).toBeTruthy();
  });

  it("X 轴日键 MM-DD", () => {
    expect(svg.includes("26-02") || svg.includes("02-0")).toBeTruthy();
  });

  it("空桶虚位渲染", () => {
    // 空桶虚位（fill-opacity .45 的细条）存在
    expect(svg.includes("fill-opacity:.45")).toBeTruthy();
  });
});

describe("stackedAreasSvg：连续段 / null 桶断开 / 命中区同构", () => {
  const bars = [
    { key: "2026-01", segs: [{ id: "p1", value: 30 }], visibleTotal: 30, none: false, mark: null },
    { key: "2026-02", segs: [], visibleTotal: null, none: true, mark: null }, // p1 断开点
    { key: "2026-03", segs: [{ id: "p1", value: 50 }, { id: "p2", value: 20 }], visibleTotal: 70, none: false, mark: null },
  ];
  const svg = stackedAreasSvg({ bars, gran: "month", ticks: niceTicks(70).ticks, stackOrder: ["p1", "p2"] });

  it("p1 两段 + p1 一段 = 3 条 path（null 桶断开）", () => {
    expect(svg.match(/<path /g)?.length).toBe(3);
  });

  it("面积模式同样有整列命中区", () => {
    expect(svg.includes('data-bucket="1"')).toBeTruthy();
  });

  it("月键 YY-MM 标签", () => {
    expect(svg.includes("26-01") && svg.includes("26-03")).toBeTruthy();
  });
});

describe("SVG 注入面：受信外文本不进 SVG（M2 的 <title> 注入面在 M2.1 已移除）", () => {
  // M2.1 的 SVG 内没有任何段 id/明细文本（id 仅哈希取色；明细走 React tooltip 文本节点自动转义）
  const evil = '<img src=x onerror=alert(1)>';
  const bars = [
    { key: "2026-02-01", segs: [{ id: evil, value: 10 }], visibleTotal: 10, none: false, mark: null },
  ];
  const svg = stackedBarsSvg({ bars, gran: "day", ticks: niceTicks(10).ticks });
  const areaSvg = stackedAreasSvg({ bars, gran: "day", ticks: niceTicks(10).ticks, stackOrder: [evil] });

  it("恶意段 id 不以任何形态进 SVG", () => {
    expect(svg.includes("<img")).toBeFalsy();
  });

  it("事件属性 payload 不存在", () => {
    expect(svg.includes("onerror")).toBeFalsy();
  });

  it("面积图同构", () => {
    expect(!areaSvg.includes("<img") && !areaSvg.includes("onerror")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #633 分片 b2 B2/B3：目录维度客户端防御（dirStackId / dirDisplayLabel / dirNeedsScopeNote）

describe("#633 B3 dirStackId：异常目录值防御归未识别桶（不渲染空标签）", () => {
  it("未识别桶键原样", () => {
    expect(dirStackId("(unidentified)")).toBe("(unidentified)");
  });

  it("具名目录原样", () => {
    expect(dirStackId("dsh-plugin-hub")).toBe("dsh-plugin-hub");
  });

  it("null 归未识别", () => {
    expect(dirStackId(null)).toBe("(unidentified)");
  });

  it("undefined 归未识别", () => {
    expect(dirStackId(undefined)).toBe("(unidentified)");
  });

  it("非字符串归未识别", () => {
    expect(dirStackId(42)).toBe("(unidentified)");
  });

  it("空串归未识别（杜绝空标签）", () => {
    expect(dirStackId("")).toBe("(unidentified)");
  });

  it("纯空白串键保留（id 唯一性；展示层经 dirDisplayLabel 归未识别）", () => {
    expect(dirStackId("   ")).toBe("   ");
  });
});

describe("#633 B3 dirDisplayLabel：控制字符剥除 + 空值回退未识别展示", () => {
  it("具名目录原样展示", () => {
    expect(dirDisplayLabel("proj")).toBe("proj");
  });

  it("C0 控制字符剥除（DOM 不出现控制字符）", () => {
    expect(dirDisplayLabel("pro\u0007ject")).toBe("project");
  });

  it("C1 控制字符剥除", () => {
    expect(dirDisplayLabel("pro\u009bject")).toBe("project");
  });

  it("多控制字符混合剥除", () => {
    expect(dirDisplayLabel("a\u001fb\u007fc")).toBe("abc");
  });

  it("空串 → 未识别展示（不得渲染空标签）", () => {
    expect(dirDisplayLabel("")).toBe("trendDirUnidentified");
  });

  it("剥后为空 → 未识别展示", () => {
    expect(dirDisplayLabel("\u0007\u001f")).toBe("trendDirUnidentified");
  });

  it("纯空白 → 未识别展示", () => {
    expect(dirDisplayLabel("   ")).toBe("trendDirUnidentified");
  });

  it("null → 未识别展示", () => {
    expect(dirDisplayLabel(null)).toBe("trendDirUnidentified");
  });

  it("undefined → 未识别展示", () => {
    expect(dirDisplayLabel(undefined)).toBe("trendDirUnidentified");
  });
});

describe("#633 B2 dirDisplayLabel：未识别桶恒有标签 + dirNeedsScopeNote 口径注明", () => {
  it("未识别桶 → 「未识别」人话（恒出现为有标签条目，不空串不消失）", () => {
    expect(dirDisplayLabel("(unidentified)")).toBe("trendDirUnidentified");
  });

  it("未识别桶注明口径（title=无目录信息的会话）", () => {
    expect(dirNeedsScopeNote("(unidentified)")).toBe(true);
  });

  it("具名目录不带口径注释", () => {
    expect(dirNeedsScopeNote("dsh-plugin-hub")).toBe(false);
  });

  it("异常空值同归未识别 → 注明口径", () => {
    expect(dirNeedsScopeNote("")).toBe(true);
  });

  it("null 同上", () => {
    expect(dirNeedsScopeNote(null)).toBe(true);
  });
});

describe("#633 B2/B3 展示语义与值语义分离：dirStackId 与 dirDisplayLabel 组合行为", () => {
  // 筛选值/图例 id 用原始键（dirStackId）；展示文本用 dirDisplayLabel——
  // 未识别桶筛选参数仍传 "(unidentified)"（宿主桶键），UI 呈现「未识别」。
  const key = dirStackId(null);
  // 超长目录名（B3 >80 字符）：展示层不截断（宿主出口已按 C2 口径 basename+截断；
  // 客户端防御仅剥控制字符与空值回退——不截断不暗中合并目录桶，与宿主数据层一致）
  const long = "d".repeat(120);

  it("值语义：null 归未识别桶键（筛选参数可直达宿主）", () => {
    expect(key).toBe("(unidentified)");
  });

  it("展示语义：同键呈现「未识别」", () => {
    expect(dirDisplayLabel(key)).toBe("trendDirUnidentified");
  });

  it("超长键原样展示（不截断不合并，宿主出口负责口径）", () => {
    expect(dirDisplayLabel(long)).toBe(long);
  });

  it("超长键值语义原样（独立目录桶，不并入未识别）", () => {
    expect(dirStackId(long)).toBe(long);
  });
});

// ---------------------------------------------------------------- #633 复核闸 P0：请求参数三态互斥与两维控件可见性

describe("#633 P0 trendRequestParams：默认面 = byDir=1 且无 dir/provider（B1 入口可达）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "", 30);

  it("默认（provider=\"\"、dirFilter=\"\"）→ byDir=1 全目录拆段面", () => {
    expect(p.get("byDir")).toBe("1");
  });

  it("默认面不带 dir", () => {
    expect(p.get("dir")).toBeNull();
  });

  it("默认面不带 provider", () => {
    expect(p.get("provider")).toBeNull();
  });

  it("默认面不带 byModel", () => {
    expect(p.get("byModel")).toBeNull();
  });

  it("基础参数 granularity 原样", () => {
    expect(p.get("granularity")).toBe("day");
  });

  it("基础参数 metric 原样", () => {
    expect(p.get("metric")).toBe("total");
  });

  it("基础参数 n = 生效档位", () => {
    expect(p.get("n")).toBe("30");
  });
});

describe("#633 P0 trendRequestParams：adapter 过滤面 = 纯 provider 参数（零目录参数）", () => {
  const p = trendRequestParams("day", "total", 30, "p1", false, "", 30);
  // byModel 细分同属 adapter 面：同样零目录参数
  const pm = trendRequestParams("week", "calls", 13, "p1", true, "", 13);

  it("provider=p1 请求带 provider", () => {
    expect(p.get("provider")).toBe("p1");
  });

  it("adapter 面无 byDir（修复前恒带 byDir=1 交叉）", () => {
    expect(p.get("byDir")).toBeNull();
  });

  it("adapter 面无 dir（交叉面必空 → 参数层杜绝）", () => {
    expect(p.get("dir")).toBeNull();
  });

  it("byModel 细分参数正常携带", () => {
    expect(pm.get("byModel")).toBe("1");
  });

  it("byModel 面带 provider", () => {
    expect(pm.get("provider")).toBe("p1");
  });

  it("byModel 面（adapter 过滤）同样无 byDir", () => {
    expect(pm.get("byDir")).toBeNull();
  });

  it("byModel 面同样无 dir", () => {
    expect(pm.get("dir")).toBeNull();
  });
});

describe("#633 P0 trendRequestParams：目录过滤面 = dir=<键>（无 byDir 无 provider）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "proj", 30);

  it("dirFilter=proj → dir=proj 过滤面", () => {
    expect(p.get("dir")).toBe("proj");
  });

  it("过滤面不再发 byDir=1（三态互斥）", () => {
    expect(p.get("byDir")).toBeNull();
  });

  it("目录面无 provider 参数（目录数据无 provider 维度）", () => {
    expect(p.get("provider")).toBeNull();
  });
});

describe("#633 P0 trendRequestParams：未识别桶键同为合法过滤值（B2 口径）", () => {
  const p = trendRequestParams("day", "total", 30, "", false, "(unidentified)", 30);

  it("未识别桶键直传 dir（宿主桶键合法过滤值）", () => {
    expect(p.get("dir")).toBe("(unidentified)");
  });

  it("过滤面无 byDir", () => {
    expect(p.get("byDir")).toBeNull();
  });
});

describe("#633 P0 shouldShowDirSelect/shouldShowByModel：两维控件互斥（状态真值渲染）", () => {
  it("默认面目录下拉恒可见（P0①：修复前 dirMode 恒真不可达）", () => {
    expect(shouldShowDirSelect("")).toBe(true);
  });

  it("adapter 过滤面隐藏目录下拉", () => {
    expect(shouldShowDirSelect("p1")).toBe(false);
  });

  it("默认面无 byModel checkbox", () => {
    expect(shouldShowByModel("", "")).toBe(false);
  });

  it("adapter 过滤面 checkbox 可见（修复前被 dirMode 恒真压制）", () => {
    expect(shouldShowByModel("p1", "")).toBe(true);
  });

  it("目录过滤面 checkbox 隐藏", () => {
    expect(shouldShowByModel("", "proj")).toBe(false);
  });

  it("防御：异常组合同样隐藏（状态联动保证不可达）", () => {
    expect(shouldShowByModel("p1", "proj")).toBe(false);
  });
});
