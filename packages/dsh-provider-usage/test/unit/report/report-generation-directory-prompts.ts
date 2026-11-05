/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CFG,
  GEN,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  buildStatsSnapshot,
  fakeLlm,
  generateReport,
  promptFor,
  textOf,
  type ReportPeriod,
} from "./report-generation-support.ts";

type DirectoryPromptState = {
  periods: ReportPeriod[];
  labels: Record<ReportPeriod, string>;
};

function registerTemplateRuleCases(state: DirectoryPromptState): void {
  for (const period of state.periods) {
    it(`${period} 模板含 byDirectory 目录观察指引`, () => {
      expect(promptFor(CFG(), period).includes("byDirectory")).toBeTruthy();
    });

    it(`${period} 模板含目录名 basename 硬规则（不展开为路径）`, () => {
      expect(promptFor(CFG(), period).includes("绝不展开为路径")).toBeTruthy();
    });

    it(`${period} 模板含占比分母硬规则`, () => {
      const tpl = promptFor(CFG(), period);
      expect(tpl.includes("totals.total > 0") || tpl.includes("分母大于 0")).toBeTruthy();
    });

    it(`${period} 模板保留 null 降级硬规则`, () => {
      expect(promptFor(CFG(), period).includes("绝不输出 null/0/NaN")).toBeTruthy();
    });

    it(`${period} 模板含时段观察指引（peakHour/byPeriod）`, () => {
      const tpl = promptFor(CFG(), period);
      // #662：时段观察指引 + 时段红线（原样引用字段、禁行为脑补、禁跨口径关联）
      expect(tpl.includes("peakHour") || tpl.includes("byPeriod")).toBeTruthy();
    });

    it(`${period} 模板含时段红线（禁行为脑补）`, () => {
      expect(promptFor(CFG(), period).includes("绝不把时段与行为、场景、情绪关联")).toBeTruthy();
    });

    it(`${period} 模板含时段红线（禁跨口径关联）`, () => {
      expect(promptFor(CFG(), period).includes("绝不与 byDirectory 交叉关联")).toBeTruthy();
    });
  }

  it("日报模板：可点 top 目录占比句式", () => {
    expect(promptFor(CFG(), "daily").includes("byDirectory 第一位（最活跃目录）")).toBeTruthy();
  });

  it("周报模板：目录分散中性句", () => {
    expect(promptFor(CFG(), "weekly").includes("工作分散在 N 个目录")).toBeTruthy();
  });

  it("月报模板：目录版图小节", () => {
    expect(promptFor(CFG(), "monthly").includes("目录版图")).toBeTruthy();
  });

  it("日报模板：时段一笔（可选）句式", () => {
    expect(promptFor(CFG(), "daily").includes("时段一笔（可选）")).toBeTruthy();
  });

  it("周报模板：时段观察一笔（可选）句式", () => {
    expect(promptFor(CFG(), "weekly").includes("时段观察一笔（可选）")).toBeTruthy();
  });

  it("月报模板：时段版图（可选一节）句式", () => {
    expect(promptFor(CFG(), "monthly").includes("时段版图（可选一节）")).toBeTruthy();
  });
}

function registerDirectoryPromptCases(state: DirectoryPromptState): void {
  const dirSnap = buildStatsSnapshot({
    period: "daily",
    startDay: "2026-09-03",
    endDay: "2026-09-03",
    buckets: [
      {
        day: "2026-09-03",
        providers: [
          {
            provider: "p",
            model: "m",
            cell: {
              input: 300,
              output: null,
              cacheRead: null,
              cacheWrite: null,
              calls: 3,
              turns: 3,
              toolCalls: 0,
            },
          },
        ],
      },
    ],
    dirRows: [
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: "alpha",
        input: 200,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 2,
        turns: 0,
        toolCalls: 0,
      },
      {
        v: TREND_ROW_VERSION,
        kind: "dir",
        day: "2026-09-03",
        dir: TREND_UNIDENTIFIED,
        input: 100,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        calls: 1,
        turns: 0,
        toolCalls: 0,
      },
    ],
    prevTotal: null,
  });

  it("快照 byDirectory calls 降序（占比素材）", () => {
    expect(dirSnap.byDirectory).toEqual([
      { dir: "alpha", calls: 2, total: 200 },
      { dir: TREND_UNIDENTIFIED, calls: 1, total: 100 },
    ]);
  });

  for (const period of state.periods) {
    describe(`#633 C1 端到端：${state.labels[period]}模板 {stats} 注入`, () => {
      let rMetaOk: boolean;
      let text: string;

      beforeAll(async () => {
        const { llm, seen } = fakeLlm();
        const r = await generateReport(
          GEN({
            llm,
            period,
            key: "2026-09-03",
            startDay: "2026-09-03",
            endDay: "2026-09-03",
            promptTemplate: promptFor(CFG(), period),
            statsJson: JSON.stringify(dirSnap),
          }),
        );
        rMetaOk = r.meta.ok;
        text = textOf(seen.calls[0]!.messages[0].content[0]);
      });

      it(`${period} 生成成功`, () => {
        expect(rMetaOk).toBe(true);
      });

      it(`${period} prompt 注入含目录维度的统计 JSON`, () => {
        expect(text.includes('"byDirectory"') && text.includes("alpha")).toBeTruthy();
      });

      it(`${period} prompt 携带目录硬规则`, () => {
        expect(text.includes("绝不展开为路径")).toBeTruthy();
      });
    });
  }
}

describe("#633 分片 b C1：三周期模板硬规则断言（fake llm 抓 prompt）", () => {
  const state = {} as DirectoryPromptState;
  state.periods = ["daily", "weekly", "monthly"];
  state.labels = { daily: "日报", weekly: "周报", monthly: "月报" };

  registerTemplateRuleCases(state);
  registerDirectoryPromptCases(state);
});
