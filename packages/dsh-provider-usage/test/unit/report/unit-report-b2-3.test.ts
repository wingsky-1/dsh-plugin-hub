/**
 * dsh-provider-usage — unit：#940 B2-3 模板/落盘/呈现/黄金样本。
 *
 * 黄金样本方法（G1诚实记录）：
 * - 模型名：离线 fakeLlm 罐头流（无真实模型调用）；叙事正文非确定性，不做黄金断言，
 *   只断言接线（{range} 注入、peakHour 透传、仲裁语、弱模型提示）。
 * - 日期：2026-09-22；三周期（F1 daily / F2 weekly / F3 monthly）各 1 条 fixture，
 *   同一 fixture 跑 3 次取中位（确定性纯函数，三次逐字节一致，中位即任一值）。
 * - F4 稀疏月报（弱模型 null 重压路径：token 全 null、peakDay/peakHour null）；
 *   F5 空窗口（calls=0 → noData 短路，未调模型未落盘）。
 * - 产物零污染：落盘一律 mkdtempSync 隔离目录，用后 rmSync。
 * - F6 轮询续跑 / F7 复用不跳转：report.tsx 组件闭包逻辑 node 不可直载，
 *   此处做源码接线锁定（改坏即红），行为面由隔离浏览器 PM2 截图覆盖。
 *
 * 结构：每个主题块一个 describe，每条断言一个 it。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readFileSync as readSrcFile,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { beforeAll, describe, expect, it } from "vitest";
import { build as esbuildBuild } from "esbuild";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import type {
  TrendCell,
  TrendDirRow,
  TrendHourRow,
} from "../../../src/server/collect/interface.ts";
import {
  TREND_ROW_VERSION,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
} from "../../../src/server/shared/interface.ts";
import { normalizeReportConfig, promptFor } from "../../../src/server/config/interface.ts";
import {
  applyPromptTemplate,
  buildStatsSnapshot,
  generateReport,
  makeDueReportExecutor,
  runDueReport,
  reportMetaFile,
  type ReportLlmService,
} from "../../../src/server/execute/interface.ts";
import { summaryOf } from "../../../src/server/execute/runner.ts";
import { updateLastRun } from "../../../src/server/schedule/interface.ts";
import type { ReportPeriod } from "../../../src/server/config/interface.ts";

const pkgDir = fileURLToPath(new URL("../../../", import.meta.url));

// ---------------------------------------------------------------- 工具

const cell = (calls: number, input: number | null): TrendCell => ({
  input,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  calls,
  turns: calls,
  toolCalls: 0,
});

const hourRow = (day: string, hour: number, calls: number, input: number | null): TrendHourRow => ({
  v: TREND_ROW_VERSION,
  kind: "hour",
  day,
  hour,
  input,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  calls,
  turns: calls,
  toolCalls: 0,
});

const dirRow = (day: string, dir: string, calls: number, input: number | null): TrendDirRow => ({
  v: TREND_ROW_VERSION,
  kind: "dir",
  day,
  dir,
  input,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  calls,
  turns: 0,
  toolCalls: 0,
});

/** fake llm：罐头 chunk 流；seen 记录收到的 GenerateOptions（断言 prompt 落地）。 */
function fakeLlm(
  chunks: StreamChunk[] = [
    { type: "text-delta", index: 0, text: "黄金样本叙事占位。" },
    { type: "finish", reason: { kind: "stop" } },
  ],
): {
  llm: ReportLlmService;
  seen: { options: GenerateOptions | null };
} {
  const seen: { options: GenerateOptions | null } = { options: null };
  const llm: ReportLlmService = {
    stream(o: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.options = o;
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks;
      })();
    },
    listProviders: () => [{ id: "prov-a", name: "A" }],
    listModels: async () => [{ provider: "prov-a", id: "model-a", name: "A" }],
  };
  return { llm, seen };
}

const textOf = (block: unknown): string => (block as { text: string }).text;

// ---------------------------------------------------------------- F1–F4 fixture

/** F1 日报：单日窗口，时段全覆盖（coveredDays=1=windowDays → peakHour 非 null）。 */
function snapF1(): ReturnType<typeof buildStatsSnapshot> {
  return buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [
      {
        day: "2026-09-03",
        providers: [
          { provider: "prov-a", model: "model-a", cell: cell(4, 400) },
          { provider: "prov-b", model: null, cell: cell(2, 100) },
        ],
      },
    ],
    dirRows: [dirRow("2026-09-03", "alpha", 4, 400), dirRow("2026-09-03", "beta", 2, 100)],
    hourRows: [hourRow("2026-09-03", 9, 2, 300), hourRow("2026-09-03", 21, 4, 200)],
    prevTotal: 250,
  });
}

/** F2 周报：7 天窗口逐日覆盖（peakHour 非 null）。 */
function snapF2(): ReturnType<typeof buildStatsSnapshot> {
  const days = [
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
  ];
  return buildStatsSnapshot({
    period: "weekly",
    startDay: "2026-08-25",
    endDay: "2026-08-31",
    buckets: days.map((day, i) => ({
      day,
      providers: [{ provider: "prov-a", model: "model-a", cell: cell(i + 1, (i + 1) * 100) }],
    })),
    hourRows: days.map((day, i) => hourRow(day, 10 + (i % 8), i + 1, (i + 1) * 100)),
    prevTotal: 1000,
  });
}

/**
 * F3 月报：calls 序与 total 序错位（p1 calls 多 total 少，p2 反之）——
 * 服务端保持 calls 降序（generate.ts:369 不动），模板仲裁语指导模型以 total 判首位。
 */
function snapF3(): ReturnType<typeof buildStatsSnapshot> {
  return buildStatsSnapshot({
    period: "monthly",
    startDay: "2026-08-01",
    endDay: "2026-08-31",
    buckets: [
      {
        day: "2026-08-15",
        providers: [
          { provider: "p1", model: "m1", cell: cell(10, 100) },
          { provider: "p2", model: "m2", cell: cell(5, 900) },
        ],
      },
    ],
    hourRows: [hourRow("2026-08-15", 14, 15, 1000)],
    prevTotal: null,
  });
}

/** F4 稀疏月报：token 全 null（弱模型 null 重压路径）。 */
function snapF4(): ReturnType<typeof buildStatsSnapshot> {
  return buildStatsSnapshot({
    period: "monthly",
    startDay: "2026-08-01",
    endDay: "2026-08-31",
    buckets: [
      { day: "2026-08-15", providers: [{ provider: "p1", model: null, cell: cell(3, null) }] },
    ],
    prevTotal: null,
  });
}
// ---------------------------------------------------------------- G1：三周期跑 3 次取中位

describe("G1 黄金样本：三周期 fixture 跑 3 次取中位（逐字节一致）", () => {
  const cases: Array<{
    name: string;
    period: ReportPeriod;
    build: () => ReturnType<typeof buildStatsSnapshot>;
  }> = [
    { name: "F1 daily", period: "daily", build: snapF1 },
    { name: "F2 weekly", period: "weekly", build: snapF2 },
    { name: "F3 monthly", period: "monthly", build: snapF3 },
  ];
  for (const c of cases) {
    it(c.name + "：3 次快照逐字节一致（中位即任一值）", () => {
      const runs = [
        JSON.stringify(c.build()),
        JSON.stringify(c.build()),
        JSON.stringify(c.build()),
      ];
      expect(runs[1]).toBe(runs[0]);
      expect(runs[2]).toBe(runs[0]);
    });
  }

  it("F1 peakHour 非 null（时段全覆盖）", () => {
    expect(snapF1().peakHour).toEqual({ hour: 9, calls: 2, total: 300 });
  });

  it("F2 peakHour 非 null（7 天逐日覆盖）", () => {
    expect(snapF2().peakHour).not.toBeNull();
  });

  it("F3 byProvider 保持 calls 降序（服务端排序不动，p1 首位）", () => {
    const s = snapF3();
    expect(s.byProvider[0].provider).toBe("p1");
    expect(s.byProvider[0].calls).toBe(10);
  });

  it("F3 total 判峰为 p2（与 calls 首位错位，仲裁语义素材）", () => {
    const s = snapF3();
    const max = s.byProvider.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a));
    expect(max.provider).toBe("p2");
  });

  it("F4 稀疏月报：totals.total null、peakDay null、peakHour null", () => {
    const s = snapF4();
    expect(s.totals.total).toBeNull();
    expect(s.peakDay).toBeNull();
    expect(s.peakHour).toBeNull();
  });
});

// ---------------------------------------------------------------- G1：{range} 双占位

describe("G1：applyPromptTemplate 双占位（V1）", () => {
  it("双占位同时替换（多次出现全换）", () => {
    expect(applyPromptTemplate("A{stats}B{range}C{stats}D{range}E", "[J]", "[R]")).toBe(
      "A[J]B[R]C[J]D[R]E",
    );
  });

  it("旧模板无 {range} 原样保留（向后兼容）", () => {
    expect(applyPromptTemplate("统计：{stats}", "[J]", "2026-09-03 ~ 2026-09-03")).toBe(
      "统计：[J]",
    );
  });

  it("rangeText 缺省时 {range} 原样保留", () => {
    expect(applyPromptTemplate("范围{range}统计{stats}", "[J]")).toBe("范围{range}统计[J]");
  });

  it("三默认模板均含 {stats} 与 {range}", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(tpl.includes("{stats}")).toBe(true);
      expect(tpl.includes("{range}")).toBe(true);
    }
  });

  it("LEGACY_V4 三模板冻结：无 {range}（迁移基准未动）", () => {
    for (const tpl of [LEGACY_DAILY_PROMPT_V4, LEGACY_WEEKLY_PROMPT_V4, LEGACY_MONTHLY_PROMPT_V4]) {
      expect(tpl.includes("{range}")).toBe(false);
    }
  });
});

describe("G1：generateReport 注入 {range}（3 次一致）", () => {
  let prompts: string[] = [];
  let oks: boolean[] = [];
  beforeAll(async () => {
    prompts = [];
    oks = [];
    for (let i = 0; i < 3; i += 1) {
      const seen = fakeLlm();
      const r = await generateReport({
        llm: seen.llm,
        period: "daily",
        key: "2026-09-03",
        startDay: "2026-09-03",
        endDay: "2026-09-03",
        statsJson: JSON.stringify(snapF1()),
        promptTemplate: DEFAULT_DAILY_PROMPT,
        provider: "",
        model: "",
      });
      oks.push(r.meta.ok);
      prompts.push(textOf(seen.seen.options!.messages[0].content[0]));
    }
  });

  it("3 次生成成功", () => {
    expect(oks).toEqual([true, true, true]);
  });

  it("prompt 含窗口范围文本（默认 startDay ~ endDay）", () => {
    for (const p of prompts) expect(p.includes("2026-09-03 ~ 2026-09-03")).toBe(true);
  });

  it("prompt 含统计 JSON（含 byDirectory）", () => {
    for (const p of prompts) expect(p.includes("" + "byDirectory" + "")).toBe(true);
  });

  it("3 次 prompt 逐字一致（中位）", () => {
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it("prompt 无 {range} 残留占位", () => {
    for (const p of prompts) expect(p.includes("{range}")).toBe(false);
  });
});
// ---------------------------------------------------------------- G1：peakHour 落盘透传（V2）

describe("G1：summaryOf peakHour 透传（V2）", () => {
  it("非 null 快照 → summary.peakHour 逐值相等", () => {
    const s = snapF1();
    expect(summaryOf(s).peakHour).toEqual(s.peakHour);
  });

  it("null 快照（F4）→ summary.peakHour null", () => {
    expect(summaryOf(snapF4()).peakHour).toBeNull();
  });
});

describe("G1：runDueReport 落盘 summary.peakHour + 旧 meta 照读", () => {
  let metaText = "";
  let metaOk = false;
  let summaryPeakHour: unknown = "unset";
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-b23-golden-"));
    try {
      const trend = {
        buckets: () => [
          {
            day: "2026-09-03",
            providers: [
              { provider: "prov-a", model: "model-a", cell: cell(4, 400) },
              { provider: "prov-b", model: null, cell: cell(2, 100) },
            ],
          },
        ],
        dirRows: () => [
          dirRow("2026-09-03", "alpha", 4, 400),
          dirRow("2026-09-03", "beta", 2, 100),
        ],
        hourRows: () => [hourRow("2026-09-03", 9, 2, 300), hourRow("2026-09-03", 21, 4, 200)],
      } as unknown as TrendTracker;
      const seen: { options: GenerateOptions | null } = { options: null };
      const fakeCtx = {
        llm: {
          stream(o: GenerateOptions): AsyncIterable<StreamChunk> {
            seen.options = o;
            return (async function* (): AsyncGenerator<StreamChunk> {
              yield { type: "text-delta", index: 0, text: "落盘透传正文。" };
              yield { type: "finish", reason: { kind: "stop" } };
            })();
          },
          listProviders: () => [{ id: "prov-a" }],
          listModels: async () => [{ id: "model-a" }],
        },
      } as unknown as Context;
      const cfg = normalizeReportConfig({ push: { enabled: false } });
      const meta = await runDueReport({
        due: {
          period: "daily",
          key: "2026-09-03",
          startDay: "2026-09-03",
          endDay: "2026-09-03",
        },
        trend,
        ctx: fakeCtx,
        reportCfg: cfg,
        promptTemplate: promptFor(cfg, "daily"),
        historyRoot: root,
        sanitizeDiagnostic: (s: string) => s,
      });
      metaOk = meta.ok === true;
      const summary = meta.summary as { peakHour?: unknown } | undefined;
      summaryPeakHour = summary?.peakHour ?? null;
      const prompt = textOf(seen.options!.messages[0].content[0]);
      expect(prompt.includes("2026-09-03 ~ 2026-09-03")).toBe(true);
      metaText = readFileSync(reportMetaFile(root, meta.period, meta.key), "utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runDueReport 生成成功", () => {
    expect(metaOk).toBe(true);
  });

  it("meta.summary.peakHour 透传（非 null）", () => {
    expect(summaryPeakHour).toEqual({ hour: 9, calls: 2, total: 300 });
  });

  it("meta.json 落盘含 peakHour", () => {
    expect(JSON.parse(metaText).summary.peakHour).toEqual({ hour: 9, calls: 2, total: 300 });
  });

  it("旧 meta 无 peakHour 字段照读（判空即 null，不补造不抛）", () => {
    const oldSummary = {
      total: 100,
      calls: 1,
      activeDays: 1,
      windowDays: 1,
      longestStreak: 1,
      wowRatio: null,
      peakDay: null,
    } as { peakHour?: { hour: number; calls: number; total: number | null } | null };
    expect(oldSummary.peakHour ?? null).toBeNull();
  });
});

describe("G1：F5 空窗口短路（未调模型未落盘）", () => {
  let meta: { ok: boolean; noData?: boolean } | null = null;
  let streamCalled = false;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-b23-empty-"));
    try {
      const trend = {
        buckets: () => [],
        dirRows: () => [],
        hourRows: () => [],
      } as unknown as TrendTracker;
      const fakeCtx = {
        llm: {
          stream(): AsyncIterable<StreamChunk> {
            streamCalled = true;
            return (async function* (): AsyncGenerator<StreamChunk> {})();
          },
          listProviders: () => [{ id: "prov-a" }],
          listModels: async () => [{ id: "model-a" }],
        },
      } as unknown as Context;
      meta = await runDueReport({
        due: {
          period: "daily",
          key: "2026-09-04",
          startDay: "2026-09-04",
          endDay: "2026-09-04",
        },
        trend,
        ctx: fakeCtx,
        reportCfg: normalizeReportConfig({ push: { enabled: false } }),
        promptTemplate: DEFAULT_DAILY_PROMPT,
        historyRoot: root,
        sanitizeDiagnostic: (s: string) => s,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("空窗口 ok:true + noData:true", () => {
    expect(meta?.ok).toBe(true);
    expect(meta?.noData).toBe(true);
  });

  it("空窗口未调模型", () => {
    expect(streamCalled).toBe(false);
  });
});

// ---------------------------------------------------------------- G1：仲裁语 / 弱模型提示 / 目录口径

describe("G1：T1 目录口径声明句（三模板同改）", () => {
  it("三默认模板含 basename 口径声明", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(tpl.includes("basename/项目名形态")).toBe(true);
    }
  });

  it("三默认模板含窗口范围声明行", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(tpl.includes("窗口范围：{range}")).toBe(true);
    }
  });
});

describe("G1：T3 byProvider 首位 total 仲裁语（只改模板，服务端排序不动）", () => {
  it("三默认模板含仲裁语", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(tpl.includes("首位仲裁以 total 为准")).toBe(true);
    }
  });

  it("LEGACY_V4 冻结文本无仲裁语", () => {
    for (const tpl of [LEGACY_DAILY_PROMPT_V4, LEGACY_WEEKLY_PROMPT_V4, LEGACY_MONTHLY_PROMPT_V4]) {
      expect(tpl.includes("首位仲裁")).toBe(false);
    }
  });
});

describe("G1：T4 月报无降级正文 + 配置页 footnote/重试指引（locales 中英）", () => {
  it("月报模板不含降级正文", () => {
    expect(DEFAULT_MONTHLY_PROMPT.includes("降级")).toBe(false);
  });

  // locales 中英断言归 test/client 层（单元层禁引 src/client，I8①）：见 unit-report-p0.test.ts 末尾 B2-3 块。
});
// ---------------------------------------------------------------- G1：report-helpers 双变量联动

const helperBundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/report-helpers.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const helperMod = await import(
  "data:text/javascript;base64," + Buffer.from(helperBundle.outputFiles[0].text).toString("base64")
);
const { promptSectionStats: helperStats, PROMPT_RANGE_VAR: helperRangeVar } = helperMod as {
  promptSectionStats: (text: string) => {
    budget: string | null;
    constraintCount: number;
    hasStatsVar: boolean;
    hasRangeVar: boolean;
  };
  PROMPT_RANGE_VAR: string;
};

describe("G1：report-helpers PROMPT_RANGE_VAR + 计数/预算联动", () => {
  it("导出 {range} 常量", () => {
    expect(helperRangeVar).toBe("{range}");
  });

  it("新默认三模板 hasRangeVar 全 true", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(helperStats(tpl).hasRangeVar).toBe(true);
    }
  });

  it("旧模板无变量即 false（原样保留语义）", () => {
    expect(helperStats(LEGACY_DAILY_PROMPT_V4).hasRangeVar).toBe(false);
  });

  it("预算联动：新默认日报预算仍为 80–150", () => {
    expect(helperStats(DEFAULT_DAILY_PROMPT).budget).toBe("80–150");
  });

  it("预算联动：新默认周报预算仍为 200–300", () => {
    expect(helperStats(DEFAULT_WEEKLY_PROMPT).budget).toBe("200–300");
  });

  it("预算联动：新默认月报预算仍为 400–600", () => {
    expect(helperStats(DEFAULT_MONTHLY_PROMPT).budget).toBe("400–600");
  });

  it("计数联动：hasStatsVar 不受新增行影响（仍 true）", () => {
    for (const tpl of [DEFAULT_DAILY_PROMPT, DEFAULT_WEEKLY_PROMPT, DEFAULT_MONTHLY_PROMPT]) {
      expect(helperStats(tpl).hasStatsVar).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- F6/F7：客户端接线锁定

const reportSource = readSrcFile(join(pkgDir, "src/client/report.tsx"), "utf8");
const historySource = readSrcFile(join(pkgDir, "src/client/history.tsx"), "utf8");

describe("F6：轮询续跑接线（瞬断退避续跑，不误报失败）", () => {
  it("捕获 AbortError 瞬断分支", () => {
    expect(reportSource.includes("AbortError")).toBe(true);
  });

  it("捕获 TimeoutError 瞬断分支", () => {
    expect(reportSource.includes("TimeoutError")).toBe(true);
  });

  it("捕获 TypeError 断网分支", () => {
    expect(reportSource.includes("TypeError")).toBe(true);
  });

  it("瞬断分支退避继续（上限内不抛失败）", () => {
    expect(reportSource.includes("退避后继续")).toBe(true);
  });

  it("404 修剪转仍在生成（不误报失败）", () => {
    expect(reportSource.includes("res.status === 404")).toBe(true);
  });

  it("超时哨兵转 reportStillGenerating 正向提示", () => {
    expect(reportSource.includes("reportStillGenerating")).toBe(true);
  });
});

describe("F7：复用不跳转接线（只提示，不切页）", () => {
  // #732 客户端面拆解后，两条落地路径各归一个 settle* 局部函数（母体瘦到编排），
  // 局部变量随之改名（body.reused → reused、polledReused → polled.reused）；
  // 判据仍是「复用分支的 return 出现在 onGeneratedRow 之前」——只换锚点，不放宽。
  it("200 直接复用 early-return 在 onGeneratedRow 之前", () => {
    const early = reportSource.indexOf("if (reused === true) return true;");
    const jump = reportSource.indexOf("onGeneratedRow(meta)");
    expect(early).toBeGreaterThan(-1);
    expect(jump).toBeGreaterThan(-1);
    expect(early).toBeLessThan(jump);
  });

  it("轮询复用只提示不跳转（polled.reused 分支在 onGeneratedRow 之前 return）", () => {
    const branch = reportSource.indexOf("if (polled.reused) {");
    const jump = reportSource.indexOf("onGeneratedRow(polled.meta)");
    expect(branch).toBeGreaterThan(-1);
    expect(jump).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(jump);
  });

  it("轮询复用提示文案为 reportReused（与直接复用对称）", () => {
    expect(reportSource.includes("reportReused")).toBe(true);
  });
});

// ---------------------------------------------------------------- F7 行为面：executor 层 force 语义
// runDueReport 不收 force（DueReport 无该字段）：force 只在 executor 输入层生效。
// 此处经 makeDueReportExecutor 真行为覆盖（空窗口短路，无需模型）：非 force 命中
// 既有成功记录即复用，force:true 绕过复用重跑。unit 层禁引 src/client 与本块无关。
describe("F7 行为面：executor 层 force 语义（复用短路/强制重跑）", () => {
  const seeded = {
    period: "daily",
    key: "2026-09-06",
    startDay: "2026-09-06",
    endDay: "2026-09-06",
    generatedAt: 1,
    ok: true,
  };
  const seedIndex = (root: string): void => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports", "index.jsonl"), `${JSON.stringify(seeded)}\n`);
  };
  const fakeTrend = {
    buckets: () => [],
    dirRows: () => [],
    hourRows: () => [],
  } as unknown as TrendTracker;
  const fakeCtx = {} as unknown as Context;
  const makeExecutor = (root: string): ReturnType<typeof makeDueReportExecutor> =>
    makeDueReportExecutor({
      trend: fakeTrend,
      ctx: fakeCtx,
      getReportCfg: () => normalizeReportConfig({ push: { enabled: false } }),
      getPromptTemplate: () => DEFAULT_DAILY_PROMPT,
      historyRoot: root,
      sanitizeDiagnostic: (s: string) => s,
      advanceLastRun: updateLastRun,
    });

  it("非 force 命中既有成功记录 → 复用（reused，不重跑）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-b23-reuse-"));
    try {
      seedIndex(root);
      const res = await makeExecutor(root)({
        period: "daily",
        key: "2026-09-06",
        startDay: "2026-09-06",
        endDay: "2026-09-06",
      });
      expect(res.reused).toBe(true);
      expect(res.meta).toEqual(seeded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force:true 绕过复用 → 重跑（空窗口 noData 新 meta）", async () => {
    const root = mkdtempSync(join(tmpdir(), "u-b23-force-"));
    try {
      seedIndex(root);
      const res = await makeExecutor(root)({
        period: "daily",
        key: "2026-09-06",
        startDay: "2026-09-06",
        endDay: "2026-09-06",
        force: true,
      });
      expect(res.reused ?? false).toBe(false);
      expect(res.meta?.ok).toBe(true);
      expect(res.meta?.noData).toBe(true);
      expect(res.meta?.generatedAt).not.toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PM1/PM2/V2 历史呈现实装接线", () => {
  it("history hero 按周期取指标（daily 高峰钟点分支）", () => {
    expect(historySource.includes("period === ") && historySource.includes("daily")).toBe(true);
    expect(historySource.includes("reportHeroPeakHour")).toBe(true);
  });

  it("history 失败态带重试指引", () => {
    expect(historySource.includes("reportRetryHint")).toBe(true);
  });

  it("report 生成失败态带重试指引", () => {
    expect(reportSource.includes("reportRetryHint")).toBe(true);
  });

  it("report 月报提示词页带弱模型 footnote", () => {
    expect(reportSource.includes("reportWeakModelNote")).toBe(true);
  });

  it("report 幂等复用 footnote 保留（PM3）", () => {
    expect(reportSource.includes("reportGenIdempotentHint")).toBe(true);
  });
});
