/**
 * schedule 组合根：D2一 域门面装配 + D2二 根内无业务判断（源码文本扫描面）。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 装配面禁直连标记：判据 = 任一实现路径进入组合根 import 即红。 */
export const FORBIDDEN_FACES = [
  "domain2/schedule",
  "domain2/common/last-run",
  "server/schedule/due",
  "server/schedule/scheduler",
  "server/schedule/tasks",
  "server/schedule/store",
  "server/schedule/deps",
  "schedule/config",
  "report-config-service",
];

/** 根内禁入业务判断标记：判据 = 任一标记进入 apply.ts 即红（#768 D13 起 interface.ts 锚点已删）。 */
export const BUSINESS_MARKERS = [
  { marker: "candidateWindow(", why: "候选窗口纯函数归调度域，组合根只提交到期回调" },
  { marker: "pendingReports(", why: "到期集合计算归调度器 tick，根内不得重算" },
  { marker: "presetLastRunForNewlyEnabled(", why: "扣期预置纯函数归路由写侧，根内不得直调" },
  { marker: "previousClosedWindow(", why: "手动窗口锚定归路由写侧，根内不得直调" },
  { marker: "deriveLastRun(", why: "index 推导归调度域（迁移与校准两路同源）" },
  { marker: "alignLastRun(", why: "温和校准同上" },
  { marker: "isClosedWindowRecord(", why: "闭环判定同上" },
  { marker: "readLastRun(", why: "lastRun 读面归调度域门面，根内不得直读" },
  { marker: "writeLastRun(", why: "lastRun 写面同上" },
  { marker: "updateLastRun(", why: "per-root 链唯一入口，根内不得绕过" },
  { marker: "ensureLastRunMigrated(", why: "启动校准归调度器内部，根内不得直调" },
  { marker: "LAST_RUN_SCHEMA", why: "schema 唯一定义在调度域，根内不得复述" },
  { marker: "lastRunChainByRoot", why: "per-root 链状态封在调度域 store 内" },
];

/**
 * 装配面源码文本扫描面：所有 src 文本由原入口按原时点读出后传入，本模块只做判据。
 * 传入面即原文件模块级的读取点集合（改读取点须同步原入口，两处不得漂移）。
 */
export interface ScheduleFacadeSources {
  applySrcFlat: string;
  applySrc: string;
  executorSrc: string;
  runnerSrc: string;
  reportsSrc: string;
  morphSrc: string;
  storageLayoutSrc: string;
  srcDir: string;
}

export function registerScheduleFacadeCases(src: ScheduleFacadeSources): void {
  const {
    applySrcFlat,
    applySrc,
    executorSrc,
    runnerSrc,
    reportsSrc,
    morphSrc,
    storageLayoutSrc,
    srcDir,
  } = src;
  describe("D2一 经 server/schedule 域门面装配", () => {
    it("调度器经同一门面进入（分头 import 即红）", () => {
      expect(
        applySrcFlat.includes(
          'import { ReportScheduler, createReportStateCoordinator, createRetryLedger } from "../server/schedule/interface.ts";',
        ),
      ).toBe(true);
    });

    it("队列经同一门面进入", () => {
      expect(
        applySrc.includes('import { ReportTaskQueue } from "../server/schedule/interface.ts";'),
      ).toBe(true);
    });

    for (const face of FORBIDDEN_FACES) {
      it("组合根不直连 " + face, () => {
        expect(applySrc.includes(face)).toBe(false);
      });
    }

    it("执行器的推进经注入（B1 值边清零，不走旧 common 入口）", () => {
      expect(executorSrc.includes('"../schedule/interface.ts"')).toBe(true);
      expect(executorSrc.includes("advanceLastRun")).toBe(true);
      expect(executorSrc.includes("import { updateLastRun }")).toBe(false);
      expect(executorSrc.includes("domain2/schedule")).toBe(false);
      expect(executorSrc.includes("common/interface")).toBe(false);
    });

    it("读侧 DueReport 类型经调度门面（index 解析归本域同级文件）", () => {
      expect(runnerSrc.includes('"../schedule/interface.ts"')).toBe(true);
      expect(runnerSrc.includes('"./report-index.ts"')).toBe(true);
      expect(runnerSrc.includes("common/interface")).toBe(false);
    });

    it("路由写侧经注入（B1 值边清零，同级短径，不走旧深径）", () => {
      expect(reportsSrc.includes('"../schedule/interface.ts"')).toBe(true);
      expect(reportsSrc.includes("context.presetLastRunForNewlyEnabled")).toBe(true);
      expect(reportsSrc.includes("import { presetLastRunForNewlyEnabled")).toBe(false);
      expect(reportsSrc.includes("../../server/schedule")).toBe(false);
      expect(reportsSrc.includes("domain2/schedule")).toBe(false);
      expect(reportsSrc.includes("../common/interface")).toBe(false);
    });

    it("迁移步纯函数经共享门面（#768 A波4 下沉 shared，不调业务实例）", () => {
      expect(morphSrc.includes('"../shared/interface.ts"')).toBe(true);
      expect(morphSrc.includes('"../schedule/interface.ts"')).toBe(false);
      expect(morphSrc.includes("domain2/schedule")).toBe(false);
      const morphImports = morphSrc
        .split(String.fromCharCode(10))
        .filter((l) => l.startsWith("import"));
      expect(morphImports.some((l) => l.includes("readLastRun"))).toBe(false);
      expect(morphImports.some((l) => l.includes("updateLastRun"))).toBe(false);
      expect(morphImports.some((l) => l.includes("ensureLastRunMigrated"))).toBe(false);
    });

    it("存储布局的空落盘 schema 与共享域同源（#768 A波4 单一定义）", () => {
      expect(storageLayoutSrc.includes('"../shared/interface.ts"')).toBe(true);
      expect(storageLayoutSrc.includes("LAST_RUN_SCHEMA")).toBe(true);
    });

    it("common 目录已消除（旧门面残留即回退）", () => {
      expect(existsSync(join(srcDir, "domain2", "common", "interface.ts"))).toBe(false);
      expect(existsSync(join(srcDir, "domain2", "common", "errsurf.ts"))).toBe(false);
      expect(existsSync(join(srcDir, "domain2", "common"))).toBe(false);
    });
  });

  describe("D2二 根内无业务判断（必须红）", () => {
    for (const entry of BUSINESS_MARKERS) {
      it("apply.ts 无 " + entry.marker + "（" + entry.why + "）", () => {
        expect(applySrc.includes(entry.marker)).toBe(false);
      });
    }
  });
}
