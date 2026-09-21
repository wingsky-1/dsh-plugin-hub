/**
 * dsh-provider-usage — integration：管线域组合根三维度（#768 计划表 rev2 D6 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/pipeline 门面活装配）；落盘一律进
 * mkdtempSync 隔离目录（产物零污染）。三维度：
 * - D6一 经 server/pipeline 域门面装配：取数渲染管道一族只经
 *   server/pipeline/interface.ts，不走旧 domain1/pipeline 入口；apply/apply.ts、
 *   apply/index.ts、server/ui-routes/context.ts（#768 D12 起，前为
 *   domain2/routes/ui.ts）的管线消费收口新门面；门面禁整文件
 *   re-export；包导出面（apply/index.ts 转发名）收窄后集合（B波续批）。
 * - D6二 取数渲染管道 + 净化缺失必须红：入参组装 → safe 执行 → 净化 → 归一化；
 *   hostile 胶囊/面板 HTML 经 fresh/stale/panel 三路输出必被净化（先转义后清洗
 *   双层，清洗 fail-closed 由 sanitize.ts 自证，本域只保证「不缺席」——
 *   删掉 sanitizeHtml 调用即红，见同文件末条反证锚）。
 * - D6三 deps 注入面窄面：PipelineSanitize/PipelineDiagnose 命名接缝与块内联
 *   双生子（StatsServiceOptions 保留内联函数类型，不 import type 本面）；
 *   deps.ts 纯类型面运行时零出口。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import {
  StatsServiceCtor,
  runV2Pipeline,
  runV2PanelPipeline,
  panelCacheKey,
  normalizeRangeDay,
  isPanelCacheStale,
  PANEL_CACHE_TTL_MS,
  safeFetchData,
  safeFormat,
  fetchWithTimeout,
} from "../../../src/server/pipeline/interface.ts";
import type {
  StatsService,
  StatsServiceOptions,
  V2PipelineResult,
} from "../../../src/server/pipeline/interface.ts";
import { StatsService as ImplService } from "../../../src/server/pipeline/stats-service.ts";
import {
  runV2Pipeline as ImplRunV2,
  runV2PanelPipeline as ImplRunV2Panel,
  panelCacheKey as ImplPanelKey,
  normalizeRangeDay as ImplNormDay,
  isPanelCacheStale as ImplStale,
  PANEL_CACHE_TTL_MS as ImplTtl,
} from "../../../src/server/pipeline/v2.ts";
import {
  safeFetchData as ImplSafeFetch,
  safeFormat as ImplSafeFormat,
  fetchWithTimeout as ImplFetchTimeout,
} from "../../../src/server/pipeline/guards.ts";
import * as pipelineDepsNs from "../../../src/server/pipeline/deps.ts";
import type { PipelineDiagnose, PipelineSanitize } from "../../../src/server/pipeline/deps.ts";
import { makeAdapterRegistry } from "../../../src/server/registry/interface.ts";
import { HistoryStore } from "../../../src/server/history/interface.ts";
import { normalizeConfig } from "../../../src/shared/interface.ts";
import type { UsageStatsAdapter } from "../../../src/shared/interface.ts";
import type { Context } from "@deepseek-ai/cordis";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const uiRoutesSrc = readFileSync(join(srcDir, "server", "ui-routes", "context.ts"), "utf8");
const pipelineFaceSrc = readFileSync(join(srcDir, "server", "pipeline", "interface.ts"), "utf8");
const pipelineDepsSrc = readFileSync(join(srcDir, "server", "pipeline", "deps.ts"), "utf8");
const statsServiceSrc = readFileSync(
  join(srcDir, "server", "pipeline", "stats-service.ts"),
  "utf8",
);
const registrySrc = readFileSync(join(srcDir, "server", "registry", "registry.ts"), "utf8");
const unitStatsTestSrc = readFileSync(
  join(srcDir, "..", "test", "unit", "pipeline", "unit-stats-service.test.ts"),
  "utf8",
);
const topologySrc = readFileSync(
  join(repoRoot, "scripts", "data", "mutation-topology.json"),
  "utf8",
);

/** 旧门面判据：任一旧 domain1/pipeline 引用残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain1/pipeline"]);
}

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。 */
const sanitizeSeam: PipelineSanitize = (s) => s;
const diagnoseSeam: PipelineDiagnose = () => undefined;

/** hostile 适配器：fetchData 正常、format 系吐恶意 HTML（净化探针）。 */
function hostileAdapter(): UsageStatsAdapter {
  return {
    version: 2,
    name: "hostile",
    providers: ["pv"],
    fetchData: async () => ({ v: 1 }),
    formatCapsule: () => "<script>alert(1)</script><b>ok</b>",
    formatPanel: () => '<img src="x" onerror="alert(1)"><b>panel</b>',
  } as UsageStatsAdapter;
}

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

function makeService() {
  const dir = isolatedDir("dou-pipeD6-");
  const config = normalizeConfig({ apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  const registry = makeAdapterRegistry();
  registry.register(hostileAdapter(), "builtin");
  const history = new HistoryStore({ root: dir });
  const options: StatsServiceOptions = {
    // 测试替身：无宿主 Context，以空对象经 unknown 中转断言（v2.ts 内 as unknown as FetchContext 同形）
    ctx: {} as unknown as Context,
    config,
    historyRoot: dir,
    registry,
    history,
    sanitizeDiagnostic: sanitizeSeam,
    recordAdapterStateDiagnostic: diagnoseSeam,
  };
  const service: StatsService = new StatsServiceCtor(options);
  return { service, dir };
}

describe("D6一 经 server/pipeline 域门面装配", () => {
  it("组合根只经新门面取管线（旧入口残留必须红）", () => {
    expect(usesOldFace(applySrc)).toBe(false);
    expect(usesOldFace(applyFaceSrc)).toBe(false);
    expect(usesOldFace(uiRoutesSrc)).toBe(false);
    expect(usesOldFace(unitStatsTestSrc)).toBe(false);
    expect(applySrc.includes("server/pipeline/interface")).toBe(true);
    expect(applyFaceSrc.includes("server/pipeline/interface")).toBe(true);
    expect(uiRoutesSrc.includes("../pipeline/interface")).toBe(true);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(StatsServiceCtor).toBe(ImplService);
    expect(runV2Pipeline).toBe(ImplRunV2);
    expect(runV2PanelPipeline).toBe(ImplRunV2Panel);
    expect(panelCacheKey).toBe(ImplPanelKey);
    expect(normalizeRangeDay).toBe(ImplNormDay);
    expect(isPanelCacheStale).toBe(ImplStale);
    expect(PANEL_CACHE_TTL_MS).toBe(ImplTtl);
    expect(safeFetchData).toBe(ImplSafeFetch);
    expect(safeFormat).toBe(ImplSafeFormat);
    expect(fetchWithTimeout).toBe(ImplFetchTimeout);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [pipelineFaceSrc, pipelineDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 10 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/pipeline/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "StatsServiceCtor",
        "runV2Pipeline",
        "runV2PanelPipeline",
        "panelCacheKey",
        "normalizeRangeDay",
        "isPanelCacheStale",
        "PANEL_CACHE_TTL_MS",
        "safeFetchData",
        "safeFormat",
        "fetchWithTimeout",
      ].sort(),
    );
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    for (const p of ["src/domain1/pipeline/v2.ts", "src/domain1/pipeline/stats-service.ts"]) {
      expect(topologySrc.includes(p)).toBe(false);
    }
    for (const p of ["src/server/pipeline/v2.ts", "src/server/pipeline/stats-service.ts"]) {
      expect(topologySrc.includes(p)).toBe(true);
    }
  });

  it("B2 注册能力经实例调用（值边清零，直引残留必须红）", () => {
    expect(statsServiceSrc.includes("this.registry.resolveProviderConfig")).toBe(true);
    expect(statsServiceSrc.includes("this.registry.readAdapterStateResult")).toBe(true);
    expect(statsServiceSrc.includes("this.registry.writeAdapterState")).toBe(true);
    expect(statsServiceSrc.includes("this.registry.readUserAdapters")).toBe(true);
    expect(statsServiceSrc.includes("this.registry.userAdaptersFile")).toBe(true);
    expect(statsServiceSrc.includes("import { resolveProviderConfig")).toBe(false);
    expect(statsServiceSrc.includes("import {\n  readAdapterStateResult,")).toBe(false);
    expect(registrySrc.includes("resolveProviderConfigBound")).toBe(true);
  });
});

describe("D6二 取数渲染管道 + 净化缺失必须红", () => {
  it("fresh 路：恶意胶囊 HTML 被净化（删净化调用即红）", async () => {
    const result: V2PipelineResult = await runV2Pipeline({
      adapter: hostileAdapter(),
      provider: "pv",
      config: {},
      staticPath: "",
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("fresh");
    expect(result.capsuleHtml).toContain("<b>ok</b>");
    expect(result.capsuleHtml).not.toContain("<script");
  });

  it("stale 路：取数失败仍产出净化胶囊（删净化调用即红）", async () => {
    const failing = hostileAdapter();
    failing.fetchData = async () => {
      throw new Error("boom-fetch");
    };
    const result: V2PipelineResult = await runV2Pipeline({
      adapter: failing,
      provider: "pv",
      config: {},
      staticPath: "",
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.error).toBe("boom-fetch");
    expect(result.capsuleHtml).toContain("<b>ok</b>");
    expect(result.capsuleHtml).not.toContain("<script");
  });

  it("panel 路：恶意面板 HTML 被净化（删净化调用即红）", async () => {
    const dir = isolatedDir("dou-pipeD6-panel-");
    const history = new HistoryStore({ root: dir });
    const ts = Date.now();
    await history.append("pv", "hostile", { time: ts, data: { v: 1 } });
    const out = await runV2PanelPipeline({
      adapter: hostileAdapter(),
      provider: "pv",
      history,
      range: { start: ts - 1000, end: ts + 1000 },
    });
    expect(out.error).toBe(undefined);
    expect(out.panelHtml).toContain("<b>panel</b>");
    expect(out.panelHtml).not.toContain("onerror");
  });

  it("组装端到端：StatsService.getStats 经同一管道净化（管道分叉即红）", async () => {
    const { service } = makeService();
    const result = await service.getStats("pv");
    expect(result.ok).toBe(true);
    expect(result.capsuleHtml).toContain("<b>ok</b>");
    expect(result.capsuleHtml).not.toContain("<script");
  });
});

describe("D6三 deps 注入面窄面", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(pipelineDepsNs)).toEqual([]);
  });

  it("命名接缝装配 StatsService（改名断链即红）", () => {
    const { service } = makeService();
    expect(service.cacheSize()).toBe(0);
    expect(typeof service.getStats).toBe("function");
    expect(typeof service.getPanelResult).toBe("function");
    expect(typeof service.purgeAllCaches).toBe("function");
  });
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain1/pipeline/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../server/pipeline/interface.ts")).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./v2.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./v2.ts"])).toBe(false);
  });
});
