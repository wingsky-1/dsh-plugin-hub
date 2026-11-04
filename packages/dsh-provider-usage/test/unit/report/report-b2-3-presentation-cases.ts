/** B2-3 客户端提示词与呈现接线；由原入口在原顺序同步注册，不新增 hook 或资源生命周期。 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  LEGACY_DAILY_PROMPT_V4,
} from "../../../src/server/shared/interface.ts";

interface PromptSectionStats {
  budget: string | null;
  constraintCount: number;
  hasStatsVar: boolean;
  hasRangeVar: boolean;
}

export function registerReportHelperCases(
  helperStats: (text: string) => PromptSectionStats,
  helperRangeVar: string,
): void {
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
}

export function registerPollingReuseCases(reportSource: string): void {
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
}

export function registerHistoryPresentationCases(
  reportSource: string,
  historySource: string,
): void {
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
}
