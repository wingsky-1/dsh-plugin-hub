/**
 * dsh-provider-usage — #940 P0 报告 helpers 单测。
 *
 * 每条判据守护一条可改坏的事实（把对应实现改坏即红）：四段解析/合成往返、
 * 非标准回退、字数预算与约束计数、{stats} 注入点永不丢失、三区脏检查语义
 * （目录按集合比对）。被测对象为 src/client/report-helpers.ts 真实源码
 * （esbuild 即时打包，同 unit-trend-view 先例；report.tsx 顶部 import react，
 * node 环境不可直载，故只测纯逻辑层）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/report-helpers.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const h = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const {
  parsePrompt,
  composePrompt,
  promptSectionStats,
  defaultStructureHeader,
  isScheduleDirty,
  isRoutingDirty,
  isPromptsDirty,
  groupReportsByPeriod,
  filterReportsByStatus,
  locatePendingRow,
  HISTORY_PAGE_SIZE,
} = h;

// 第二事实源：手写标准四段模板（不从实现 import，避免同源期望）
const STD_DAILY = [
  "【任务目标】",
  "你是主笔。写一段 80–150 字的中文日报。",
  "",
  "【统计数据】",
  "{stats}",
  "",
  "【撰写结构（按顺序）】",
  "- 开场一句",
  "- 中间一个细节",
  "",
  "【硬性约束（违背将视为严重错误）】",
  "- 数据红线：只依据 JSON。",
  "- 排版白名单：仅 ** 与 - 列表。",
  "- 事实基准：日期以 JSON 为准。",
].join("\n");

const STD_WEEKLY = [
  "【任务目标】",
  "写一份 200–300 字的中文周报。",
  "",
  "【统计数据】",
  "{stats}",
  "",
  "【撰写结构】",
  "## 上周",
  "开场加列表。",
  "",
  "【硬性约束（违背将视为严重错误）】",
  "- 数据红线。",
].join("\n");

describe("parsePrompt：标准四段解析", () => {
  it("日报解析 ok，四块非空", () => {
    const r = parsePrompt(STD_DAILY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sections.goal).toBe("你是主笔。写一段 80–150 字的中文日报。");
      expect(r.sections.stats).toBe("{stats}");
      expect(r.sections.structure).toBe("- 开场一句\n- 中间一个细节");
      expect(r.sections.constraints).toContain("数据红线");
    }
  });

  it("日报结构头保留（按顺序）变体", () => {
    const r = parsePrompt(STD_DAILY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sections.structureHeader).toBe("【撰写结构（按顺序）】");
  });

  it("周报结构头为 plain 变体", () => {
    const r = parsePrompt(STD_WEEKLY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sections.structureHeader).toBe("【撰写结构】");
  });

  it("缺块即 ok:false 且 raw 原样保留", () => {
    const r = parsePrompt("只是普通文本，没有语义块");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe("只是普通文本，没有语义块");
  });

  it("块乱序即 ok:false（约束在目标之前）", () => {
    const bad = [
      "【硬性约束（违背将视为严重错误）】",
      "- 约束",
      "【任务目标】",
      "目标",
      "【统计数据】",
      "{stats}",
      "【撰写结构】",
      "结构",
    ].join("\n");
    expect(parsePrompt(bad).ok).toBe(false);
  });
});

describe("composePrompt：合成往返", () => {
  it("日报往返逐字一致", () => {
    const r = parsePrompt(STD_DAILY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(composePrompt(r.sections, "daily")).toBe(STD_DAILY);
  });

  it("周报往返逐字一致（plain 结构头不漂成日报变体）", () => {
    const r = parsePrompt(STD_WEEKLY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(composePrompt(r.sections, "weekly")).toBe(STD_WEEKLY);
  });

  it("stats 为空回填 {stats}（注入点永不丢失）", () => {
    const r = parsePrompt(STD_DAILY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = composePrompt({ ...r.sections, stats: "   " }, "daily");
      expect(out).toContain("{stats}");
    }
  });

  it("改 goal 后合成只动 goal 块", () => {
    const r = parsePrompt(STD_DAILY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = composePrompt({ ...r.sections, goal: "新目标" }, "daily");
      expect(out).toContain("新目标");
      expect(out).toContain("- 开场一句");
      expect(out).toContain("- 数据红线：只依据 JSON。");
    }
  });
});

describe("defaultStructureHeader", () => {
  it("daily 带（按顺序）", () => {
    expect(defaultStructureHeader("daily")).toBe("【撰写结构（按顺序）】");
  });

  it("weekly 为 plain", () => {
    expect(defaultStructureHeader("weekly")).toBe("【撰写结构】");
  });

  it("monthly 为 plain", () => {
    expect(defaultStructureHeader("monthly")).toBe("【撰写结构】");
  });
});

describe("promptSectionStats：预算与约束计数", () => {
  it("预算抽出 80–150", () => {
    expect(promptSectionStats(STD_DAILY).budget).toBe("80–150");
  });

  it("约束计数 3（只数约束块内 - 行）", () => {
    expect(promptSectionStats(STD_DAILY).constraintCount).toBe(3);
  });

  it("结构块的 - 行不计入约束数（周报约束为 1）", () => {
    expect(promptSectionStats(STD_WEEKLY).constraintCount).toBe(1);
  });

  it("含 {stats} 变量", () => {
    expect(promptSectionStats(STD_DAILY).hasStatsVar).toBe(true);
  });

  it("删掉 {stats} 即 false（改坏变量检测）", () => {
    expect(promptSectionStats("【任务目标】\n目标 80–150 字\n无变量").hasStatsVar).toBe(false);
  });

  it("无字数预算即 null", () => {
    expect(promptSectionStats("【任务目标】\n目标\n【统计数据】\n{stats}").budget).toBeNull();
  });
});

const schedOf = (time: string, weekStartsOn: 0 | 1, dayOfMonth: number) => ({
  daily: { enabled: true, time },
  weekly: { enabled: true, time, weekStartsOn },
  monthly: { enabled: false, time, dayOfMonth },
});

describe("isScheduleDirty", () => {
  it("完全一致即干净", () => {
    expect(isScheduleDirty(schedOf("08:00", 1, 1), schedOf("08:00", 1, 1))).toBe(false);
  });

  it("触发时刻漂移即脏", () => {
    expect(isScheduleDirty(schedOf("08:00", 1, 1), schedOf("09:00", 1, 1))).toBe(true);
  });

  it("周起点漂移即脏", () => {
    expect(isScheduleDirty(schedOf("08:00", 1, 1), schedOf("08:00", 0, 1))).toBe(true);
  });

  it("月内日漂移即脏", () => {
    expect(isScheduleDirty(schedOf("08:00", 1, 1), schedOf("08:00", 1, 2))).toBe(true);
  });
});

const routeOf = (provider: string, model: string, directories: string[], push: boolean) => ({
  provider,
  model,
  directories,
  push: { enabled: push },
});

describe("isRoutingDirty", () => {
  it("完全一致即干净", () => {
    expect(isRoutingDirty(routeOf("a", "m", [], false), routeOf("a", "m", [], false))).toBe(false);
  });

  it("目录顺序漂移不算脏（集合语义）", () => {
    expect(
      isRoutingDirty(routeOf("a", "m", ["x", "y"], false), routeOf("a", "m", ["y", "x"], false)),
    ).toBe(false);
  });

  it("目录增减即脏", () => {
    expect(
      isRoutingDirty(routeOf("a", "m", ["x"], false), routeOf("a", "m", ["x", "y"], false)),
    ).toBe(true);
  });

  it("provider 漂移即脏", () => {
    expect(isRoutingDirty(routeOf("a", "m", [], false), routeOf("b", "m", [], false))).toBe(true);
  });

  it("推送开关漂移即脏", () => {
    expect(isRoutingDirty(routeOf("a", "m", [], false), routeOf("a", "m", [], true))).toBe(true);
  });
});

describe("isPromptsDirty", () => {
  it("三周期一致即干净", () => {
    const p = { daily: "d", weekly: "w", monthly: "m" };
    expect(isPromptsDirty(p, { daily: "d", weekly: "w", monthly: "m" })).toBe(false);
  });

  it("任一周期漂移即脏", () => {
    expect(
      isPromptsDirty(
        { daily: "d", weekly: "w", monthly: "m" },
        { daily: "d2", weekly: "w", monthly: "m" },
      ),
    ).toBe(true);
  });
});

// 第二事实源：手写历史行（period/key/ok/noData 四字段，不从实现 import；
// 显式行类型——test/tsconfig noImplicitAny 下泛型约束可推导，删注解即红）。
const HIST_ROWS: Array<{
  period: "daily" | "weekly" | "monthly";
  key: string;
  ok: boolean;
  error?: string;
  noData?: boolean;
}> = [
  { period: "daily", key: "2026-03-12", ok: true },
  { period: "weekly", key: "2026-W10", ok: true },
  { period: "daily", key: "2026-03-11", ok: false, error: "boom" },
  { period: "monthly", key: "2026-02", ok: false, error: "x" },
  { period: "weekly", key: "2026-W09", ok: true, noData: true },
];

describe("HISTORY_PAGE_SIZE：分页步长锚（PM 认可 20/组，改值需同步验收）", () => {
  it("恒为 20", () => {
    expect(HISTORY_PAGE_SIZE).toBe(20);
  });
});

describe("groupReportsByPeriod：period 三组", () => {
  it("分组计数 2/2/1", () => {
    const g = groupReportsByPeriod(HIST_ROWS);
    expect(g.daily.length).toBe(2);
    expect(g.weekly.length).toBe(2);
    expect(g.monthly.length).toBe(1);
  });

  it("组内保持输入顺序（daily 先 03-12 后 03-11）", () => {
    const g = groupReportsByPeriod(HIST_ROWS);
    expect(g.daily.map((r: { key: string }) => r.key)).toEqual(["2026-03-12", "2026-03-11"]);
  });

  it("空输入三组全空（改坏分组键即红）", () => {
    const g = groupReportsByPeriod([]);
    expect([...g.daily, ...g.weekly, ...g.monthly]).toEqual([]);
  });
});

describe("filterReportsByStatus：状态筛选", () => {
  it("all 直通 5 行", () => {
    expect(filterReportsByStatus(HIST_ROWS, "all").length).toBe(5);
  });

  it("ok 排除失败与空窗口（剩 2 行）", () => {
    const out = filterReportsByStatus(HIST_ROWS, "ok");
    expect(out.map((r: { key: string }) => r.key)).toEqual(["2026-03-12", "2026-W10"]);
  });

  it("failed 只取 ok===false（2 行，含月报）", () => {
    const out = filterReportsByStatus(HIST_ROWS, "failed");
    expect(out.map((r: { key: string }) => r.key)).toEqual(["2026-03-11", "2026-02"]);
  });

  it("nodata 只取空窗口（W09 一行）", () => {
    const out = filterReportsByStatus(HIST_ROWS, "nodata");
    expect(out.map((r: { key: string }) => r.key)).toEqual(["2026-W09"]);
  });
});

describe("locatePendingRow：D1 跳转判定点（新窗口重拉后定位）", () => {
  it("stale 快照命中旧行（W10）", () => {
    const stale = HIST_ROWS.slice(0, 2);
    expect(locatePendingRow(stale, "weekly:2026-W10")?.key).toBe("2026-W10");
  });

  it("stale 快照缺新窗口行（改坏查找键即红）", () => {
    const stale = HIST_ROWS.slice(0, 2);
    expect(locatePendingRow(stale, "daily:2026-03-13")).toBeUndefined();
  });

  it("重拉后新行可定位（新窗口跳转路径）", () => {
    const fresh = [
      ...HIST_ROWS,
      { period: "daily", key: "2026-03-13", ok: true },
    ] as typeof HIST_ROWS;
    expect(locatePendingRow(fresh, "daily:2026-03-13")?.key).toBe("2026-03-13");
  });
});
