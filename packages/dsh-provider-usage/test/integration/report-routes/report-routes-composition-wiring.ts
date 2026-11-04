/**
 * report-routes 组合根：D11一 经 server/report-routes 域门面装配（源码文本与门面收口面）。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containsAny, hasExportStar } from "../../helpers.ts";
import {
  handleReportConfig,
  handleReportModels,
  handleReports,
  handleReportDetail,
  handleReportGenerate,
  handleReportStatus,
  createReportRoutes,
  isReportPeriodValid,
  isReportKeyValid,
  isTaskIdValid,
} from "../../../src/server/report-routes/interface.ts";
import {
  handleReportConfig as ImplHandleReportConfig,
  handleReportModels as ImplHandleReportModels,
  handleReports as ImplHandleReports,
  handleReportDetail as ImplHandleReportDetail,
  handleReportGenerate as ImplHandleReportGenerate,
  handleReportStatus as ImplHandleReportStatus,
  createReportRoutes as ImplCreateReportRoutes,
  isReportPeriodValid as ImplIsPeriod,
  isReportKeyValid as ImplIsKey,
  isTaskIdValid as ImplIsTaskId,
} from "../../../src/server/report-routes/reports.ts";

/** 旧门面判据：旧 domain2 门面入口、旧深相对路径或已删装配面残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain2/routes/interface", "../../server/", "../../apply/interface"]);
}

/** D11一 仍须原入口读出的 src 文本（判据 = 门面收口与变异面登记）。 */
export interface ReportRoutesWiringSources {
  applySrc: string;
  applyFaceSrc: string;
  reportFaceSrc: string;
  reportDepsSrc: string;
  reportsSrc: string;
  topologySrc: string;
  strykerRoutesSrc: string;
  srcDir: string;
}

export function registerReportRoutesWiringCases(src: ReportRoutesWiringSources): void {
  const {
    applySrc,
    applyFaceSrc,
    reportFaceSrc,
    reportDepsSrc,
    reportsSrc,
    topologySrc,
    strykerRoutesSrc,
    srcDir,
  } = src;
  describe("D11一 经 server/report-routes 域门面装配", () => {
    it("组合根与包入口收窄后集合：入口已无路由转发白盒直连（残留即红）", () => {
      // B波收窄后集合：handleReportStatus已退役（白盒直连域门面，见unit-report）；组合根实现仍经新门面。
      expect(usesOldFace(reportFaceSrc)).toBe(false);
      expect(usesOldFace(reportDepsSrc)).toBe(false);
      expect(usesOldFace(reportsSrc)).toBe(false);
      expect(applySrc.includes("server/report-routes/interface")).toBe(true);
    });

    it("实现块改址：同级短径复用双门面 + 调度注入（B1 值边清零，旧深路径残留必须红）", () => {
      expect(reportsSrc.includes("../config/interface")).toBe(true);
      expect(reportsSrc.includes("../execute/interface")).toBe(true);
      expect(reportsSrc.includes("../schedule/interface")).toBe(true);
      expect(reportsSrc.includes("context.presetLastRunForNewlyEnabled")).toBe(true);
      expect(reportsSrc.includes("import { presetLastRunForNewlyEnabled")).toBe(false);
      expect(reportsSrc.includes("import { readLastRun")).toBe(false);
      expect(reportsSrc.includes("../../shared/interface")).toBe(true);
    });

    it("B2 配置与执行读面经上下文注入（值边清零，直引残留必须红）", () => {
      expect(reportsSrc.includes("context.normalizeReportConfig")).toBe(true);
      expect(reportsSrc.includes("context.readReportConfig")).toBe(true);
      expect(reportsSrc.includes("reportCfgService.promptDefaults")).toBe(true);
      expect(reportsSrc.includes("context.readReportIndex")).toBe(true);
      expect(reportsSrc.includes("context.reportHtmlFile")).toBe(true);
      expect(reportsSrc.includes("context.reportMetaFile")).toBe(true);
      expect(reportsSrc.includes("DEFAULT_PROMPTS")).toBe(false);
      expect(reportsSrc.includes("import { readReportIndex")).toBe(false);
      expect(applySrc.includes("normalizeReportConfig,")).toBe(true);
      expect(applySrc.includes("readReportIndex,")).toBe(true);
    });

    it("旧 domain2 面已删除（残留即装配分叉回退）", () => {
      expect(existsSync(join(srcDir, "domain2", "routes", "interface.ts"))).toBe(false);
      expect(existsSync(join(srcDir, "domain2", "routes"))).toBe(false);
      expect(existsSync(join(srcDir, "domain2"))).toBe(false);
    });

    it("门面收口：interface 与实现同一引用（包装即红）", () => {
      expect(handleReportConfig).toBe(ImplHandleReportConfig);
      expect(handleReportModels).toBe(ImplHandleReportModels);
      expect(handleReports).toBe(ImplHandleReports);
      expect(handleReportDetail).toBe(ImplHandleReportDetail);
      expect(handleReportGenerate).toBe(ImplHandleReportGenerate);
      expect(handleReportStatus).toBe(ImplHandleReportStatus);
      expect(createReportRoutes).toBe(ImplCreateReportRoutes);
      expect(isReportPeriodValid).toBe(ImplIsPeriod);
      expect(isReportKeyValid).toBe(ImplIsKey);
      expect(isTaskIdValid).toBe(ImplIsTaskId);
    });

    it("门面禁整文件 re-export（加星导出即红）", () => {
      for (const src of [reportFaceSrc, reportDepsSrc]) {
        const codeLines = src
          .split(String.fromCharCode(10))
          .filter((l) => !l.trim().startsWith("*"));
        expect(hasExportStar(codeLines)).toBe(false);
      }
    });

    it("门面值出口恰为 10 项（多一项即公共面膨胀）", async () => {
      const faceNs = await import("../../../src/server/report-routes/interface.ts");
      expect(Object.keys(faceNs).sort()).toEqual(
        [
          "handleReportConfig",
          "handleReportModels",
          "handleReports",
          "handleReportDetail",
          "handleReportGenerate",
          "handleReportStatus",
          "createReportRoutes",
          "isReportPeriodValid",
          "isReportKeyValid",
          "isTaskIdValid",
        ].sort(),
      );
    });

    it("包导出面零扩张：路由创建面不进 apply/index.ts（误转即红）", () => {
      expect(applyFaceSrc.includes("createReportRoutes")).toBe(false);
    });

    it("变异面登记随域改址（旧路径残留即红）", () => {
      expect(topologySrc.includes("src/domain2/routes/reports.ts")).toBe(false);
      expect(topologySrc.includes("src/server/report-routes/reports.ts")).toBe(true);
      expect(strykerRoutesSrc.includes("src/domain2/routes/reports.ts")).toBe(false);
      expect(strykerRoutesSrc.includes("src/server/report-routes/reports.ts")).toBe(true);
    });
  });
}
