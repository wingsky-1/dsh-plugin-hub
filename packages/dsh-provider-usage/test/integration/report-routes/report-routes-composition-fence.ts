/**
 * report-routes 组合根：D11三 越围栏 403 先于 405 + D11四 释放顺序/路由单点/客户端契约 + detector 探针。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { describe, expect, it } from "vitest";
import { hasExportStar } from "../../helpers.ts";
import {
  handleReportConfig,
  handleReportModels,
  handleReports,
  handleReportDetail,
  handleReportGenerate,
  handleReportStatus,
  createReportRoutes,
  isReportKeyValid,
  isReportPeriodValid,
  isTaskIdValid,
} from "../../../src/server/report-routes/interface.ts";
import { ROUTES } from "../../../src/apply/index.ts";
import {
  callStatus,
  fakeReq,
  isolatedDir,
  nonLoopbackReq,
  stubReportCtx,
  type AnyHandler,
} from "./report-routes-composition-fixtures.ts";
import { containsAny } from "../../helpers.ts";

/** 旧门面判据：旧 domain2 门面入口、旧深相对路径或已删装配面残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain2/routes/interface", "../../server/", "../../apply/interface"]);
}

/** D11三/四/探针 仍须原入口读出的 src 文本（判据 = 释放顺序、客户端回指、隔离目录探针）。 */
export interface ReportRoutesFenceSources {
  applySrc: string;
  reportsSrc: string;
  clientContractSrc: string;
}

export function registerReportRoutesFenceCases(src: ReportRoutesFenceSources): void {
  registerReportRoutesFenceTableCase();
  registerReportRoutesLifecycleCases(src);
  registerReportRoutesDetectorProbes();
}

function registerReportRoutesFenceTableCase(): void {
  describe("D11三 越围栏必须红（403 先于 405）", () => {
    const fenceTable: { name: string; handler: AnyHandler; wrongMethod: string }[] = [
      { name: "reportConfig", handler: handleReportConfig as AnyHandler, wrongMethod: "DELETE" },
      { name: "reportModels", handler: handleReportModels as AnyHandler, wrongMethod: "POST" },
      { name: "reports", handler: handleReports as AnyHandler, wrongMethod: "POST" },
      { name: "reportDetail", handler: handleReportDetail as AnyHandler, wrongMethod: "POST" },
      { name: "reportGenerate", handler: handleReportGenerate as AnyHandler, wrongMethod: "GET" },
      { name: "reportStatus", handler: handleReportStatus as AnyHandler, wrongMethod: "POST" },
    ];

    it.each(fenceTable.map((c) => c.name))(
      "%s 非回环 + 错方法仍 403（顺序反了即 405 泄漏）",
      async (name) => {
        const found = fenceTable.find((c) => c.name === name);
        if (found === undefined) throw new Error("fence 缺行：" + name);
        const root = isolatedDir("dou-reportroutesD11-");
        const { ctx } = stubReportCtx(root);
        const { code } = await callStatus(
          found.handler,
          nonLoopbackReq({ method: found.wrongMethod }),
          ctx,
        );
        expect(code).toBe(403);
      },
    );

    it.each(fenceTable.map((c) => ({ name: c.name, method: c.wrongMethod })))(
      "$name 回环 + 错 $method → 405 且文案逐字节锁定（文案漂移即红）",
      async ({ name, method }) => {
        const found = fenceTable.find((c) => c.name === name);
        if (found === undefined) throw new Error("fence 缺行：" + name);
        const root = isolatedDir("dou-reportroutesD11-");
        const { ctx } = stubReportCtx(root);
        const { code, body } = await callStatus(found.handler, fakeReq({ method }), ctx);
        expect(code).toBe(405);
        expect((body as { error?: string }).error).toBe("method not allowed: " + method);
      },
    );
  });
}

function registerReportRoutesLifecycleCases(src: ReportRoutesFenceSources): void {
  const { applySrc, reportsSrc, clientContractSrc } = src;
  describe("D11四 释放顺序锁定 + 复位标记 + 路由单点 + 客户端契约", () => {
    // 注记（选改述不改实现）：实测装配序 stats → trend → scheduler，释放序
    // routes → stats → trend → scheduler——仅 routes 首释与装配逆序（装配最末注册
    // 路由，先释防拆卸期新请求进入）；stats → trend → scheduler 与装配同序。
    // 排成严格全逆序需改装配实现（scheduler tick 执行器依赖 trend/stats，在途语义
    // 待估），属 D13 组合根收尾范围；D11 为零行为变更改址，只锁定现状顺序。
    it("释放顺序锁定（改序即红）", () => {
      const disposeRoutes = applySrc.indexOf("void disposeRoutes();");
      const disposeStats = applySrc.indexOf("statsService.dispose();");
      const disposeTrend = applySrc.indexOf("await trend.dispose();");
      const disposeScheduler = applySrc.indexOf("reportScheduler.dispose();");
      for (const i of [disposeRoutes, disposeStats, disposeTrend, disposeScheduler]) {
        expect(i).toBeGreaterThan(-1);
      }
      expect(disposeRoutes).toBeLessThan(disposeStats);
      expect(disposeStats).toBeLessThan(disposeTrend);
      expect(disposeTrend).toBeLessThan(disposeScheduler);
    });

    it("复位标记先于装配（缺失或晚装即红）", () => {
      const release = applySrc.indexOf("releaseUpgrade();");
      const install = applySrc.indexOf("await installUpgrade({");
      expect(release).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(-1);
      expect(release).toBeLessThan(install);
    });

    it("报告调度释放成对（装配 start 无对应 dispose 即红）", () => {
      expect(applySrc.includes("ReportScheduler.start({")).toBe(true);
      expect(applySrc.includes("reportScheduler.dispose()")).toBe(true);
    });

    it("创建面路径即 ROUTES 单点（自定字面量即红）", () => {
      const root = isolatedDir("dou-reportroutesD11-");
      const { ctx } = stubReportCtx(root);
      const routes = createReportRoutes(
        {
          reportConfig: ROUTES.reportConfig,
          reportModels: ROUTES.reportModels,
          reports: ROUTES.reports,
          reportDetail: ROUTES.reportDetail,
          reportGenerate: ROUTES.reportGenerate,
          reportGenerateStatus: ROUTES.reportGenerateStatus,
        },
        ctx,
      );
      expect(routes.map((r) => r.path).sort()).toEqual(
        [
          ROUTES.reportConfig,
          ROUTES.reportModels,
          ROUTES.reports,
          ROUTES.reportDetail,
          ROUTES.reportGenerate,
          ROUTES.reportGenerateStatus,
        ].sort(),
      );
      expect(reportsSrc.includes("/api/")).toBe(false);
    });

    it.each([
      "/api/dsh-provider-usage/report-config",
      "/api/dsh-provider-usage/report-models",
      "/api/dsh-provider-usage/reports",
      "/api/dsh-provider-usage/reports/detail",
      "/api/dsh-provider-usage/reports/generate",
      "/api/dsh-provider-usage/reports/generate/status",
    ])("客户端回指 %s（缺键即宿主与客户端分叉）", (literal) => {
      expect(clientContractSrc.includes(literal)).toBe(true);
    });
  });
}

function registerReportRoutesDetectorProbes(): void {
  describe("探针：detector 失明则本段先红", () => {
    it("旧门面 detector 对脏输入有效", () => {
      expect(usesOldFace("import { x } from ../domain2/routes/interface.ts")).toBe(true);
      expect(usesOldFace("import { x } from ../../server/config/interface.ts")).toBe(true);
      expect(usesOldFace("import { x } from ../../apply/interface.ts")).toBe(true);
      expect(usesOldFace("import { x } from ../server/report-routes/interface.ts")).toBe(false);
      expect(usesOldFace("import { x } from ../config/interface.ts")).toBe(false);
    });

    it("export * detector 对脏输入有效", () => {
      expect(hasExportStar(["export * from ./reports.ts"])).toBe(true);
      expect(hasExportStar(["export { a } from ./reports.ts"])).toBe(false);
    });

    it("白名单 detector 对脏输入有效", () => {
      expect(isReportPeriodValid("bogus")).toBe(false);
      expect(isReportKeyValid("daily", "not-a-date")).toBe(false);
      expect(isTaskIdValid("not-a-uuid")).toBe(false);
    });

    it("隔离目录可用（mkdtemp 探针）", () => {
      const dir = isolatedDir("dou-reportroutesD11-");
      expect(typeof dir).toBe("string");
    });
  });
}
