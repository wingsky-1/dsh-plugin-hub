/**
 * dsh-provider-usage — integration：报告路由域组合根四维度 + 释放验收（#768 计划表 rev2 D11 验收）。
 *
 * 白盒直连 src（经 server/report-routes 门面活装配 + 实现直引同一性）；落盘一律进
 * mkdtemp 隔离目录（产物零污染；路径禁令：本文件无家目录调用，走 dshHome 接缝检查由
 * gate:homedir 门禁覆盖）。离线：桩队列/配置服务/ctx 全内存，不起端口、不触 DSH_HOME、
 * 不读真实凭据。
 * 四维度 + 一验收：
 * - D11一 经 server/report-routes 域门面装配：六 handler + create + 三白名单只经
 *   server/report-routes/interface.ts，不走旧 domain2/routes 入口；apply/apply.ts
 *   的路由消费与 apply/index.ts 的 status 转发收口新门面；旧 domain2 面不再转发
 *   报告符号；门面禁整文件 re-export；创建面不进包导出面。
 * - D11二 配置服务窄面消费 + 任务队列 + 执行器：context 两字段为 deps.ts 窄口
 *   （ReportRoutesConfigPort = get/update，ReportRoutesQueuePort = submit/get）；
 *   只暴露窄口方法的桩跑通全部 handler（多用一能力即 TypeError 先红）；真实例
 *   （ReportConfigService/ReportTaskQueue）可赋值窄口（tsc 编译面）；deps.ts
 *   纯类型面运行时零出口；执行器工厂不直引（实现内无 makeDueReportExecutor/
 *   DueExecutorDeps）；装配面转发消除、锚点已删除（#768 D13 删 apply/interface.ts
 *   空门面：dir-imports 基线（apply 模块归属消失）+ 本文件 D11二存在性断言已同步更新）。
 * - D11三 围栏与正路：六端点非回环 + 错方法仍 403（顺序反了即 405 泄漏）；
 *   回环 + 错方法 405 且文案逐字节锁定；回环 + 正方法放行（config/reports 200，
 *   generate 202，status 未知任务 404）。
 * - D11四 释放顺序锁定 + 复位标记 + 路由单点 + 客户端契约：释放顺序锁定
 *  （routes 首释 + stats → trend → scheduler，改序即红；仅首位与装配逆序，
 *  非严格全逆序——见 D11四注记）；同进程重装配先复位标记
 *  （releaseUpgrade 缺失或晚于 install 即红）；reportScheduler 释放成对；
 *   创建面路径即 ROUTES 单点（实现内无硬编码 /api/ 字面量）；客户端六键回指同源
 *   （host-seams R2 收敛后字面量只留 client/shared/contract.ts 一份，缺键即分叉）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LlmResolvedModelInfo, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
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
import type { ReportRoutesContext } from "../../../src/server/report-routes/interface.ts";
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
import * as reportRoutesDepsNs from "../../../src/server/report-routes/deps.ts";
import type {
  ReportRoutesConfigPort,
  ReportRoutesQueuePort,
} from "../../../src/server/report-routes/deps.ts";
import { ReportConfigService } from "../../../src/server/config/interface.ts";
import {
  DEFAULT_PROMPTS,
  normalizeReportConfig,
  readReportConfig,
} from "../../../src/server/config/interface.ts";
import {
  readReportIndex,
  reportHtmlFile,
  reportMetaFile,
} from "../../../src/server/execute/interface.ts";
import {
  ReportTaskQueue,
  createReportStateCoordinator,
  createRetryLedger,
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  readLastRun,
  updateLastRun,
} from "../../../src/server/schedule/interface.ts";
import type { ReportTask } from "../../../src/server/schedule/interface.ts";
import { ROUTES } from "../../../src/apply/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const readText = (p: string): string => readFileSync(p, "utf8");
const applySrc = readText(join(srcDir, "apply", "apply.ts"));
const applyFaceSrc = readText(join(srcDir, "apply", "index.ts"));
// #768 D13：空锚点 src/domain2/routes/interface.ts 已删（ui 四块 D12 起归 server/ui-routes），本文件不再读旧面。
const reportFaceSrc = readText(join(srcDir, "server", "report-routes", "interface.ts"));
const reportDepsSrc = readText(join(srcDir, "server", "report-routes", "deps.ts"));
const reportsSrc = readText(join(srcDir, "server", "report-routes", "reports.ts"));
// host-seams R2 收敛后客户端字面量只留 client/shared/contract.ts 一份（core/report 改经具名表 import）。
const clientContractSrc = readText(join(srcDir, "client", "shared", "contract.ts"));
const topologySrc = readText(join(repoRoot, "scripts", "data", "mutation-topology.json"));
const strykerRoutesSrc = readText(
  join(repoRoot, "stryker.conf.d", "dsh-provider-usage-routes.json"),
);

/** 旧门面判据：旧 domain2 门面入口、旧深相对路径或已删装配面残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain2/routes/interface", "../../server/", "../../apply/interface"]);
}

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

// ---------------------------------------------------------------- fake 请求/响应
//
// 与 data-routes 组合根同形：loopback = 127.0.0.1 socket + 回环 host；
// readJsonBodyOutcome 经 for await 读 body，故带 async-iterator 桩。
function fakeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080" },
    method: "GET",
    url: "/",
    [Symbol.asyncIterator]: async function* (this: unknown) {
      const body = (overrides as { body?: unknown }).body;
      if (typeof body === "string" && body !== "") {
        yield Buffer.from(body);
      }
    },
    ...overrides,
  };
  return req as unknown as IncomingMessage;
}

/** 非回环桩（smoke 实证：该 socket 即 403）。 */
function nonLoopbackReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  return fakeReq({
    socket: { remoteAddress: "10.0.0.2" },
    headers: { host: "evil.example" },
    ...overrides,
  });
}

function makeRes(): ServerResponse & { _code(): number | undefined; _body(): string } {
  const chunks: string[] = [];
  let code: number | undefined;
  const res = {
    writeHead(c: number): void {
      code = c;
    },
    end(chunk: unknown): void {
      chunks.push(String(chunk));
    },
    _code(): number | undefined {
      return code;
    },
    _body(): string {
      return chunks.join("");
    },
  };
  return res as unknown as ServerResponse & { _code(): number | undefined; _body(): string };
}

// ---------------------------------------------------------------- 窄面桩
//
// 只暴露窄口方法（config：get/update；queue：submit/get）——handler 多用一能力
// 即 TypeError 先红。端口注解由 tsc 编译面校验与 deps.ts 同名（改名断链即红）。
const DONE_TASK_ID = "11111111-1111-4111-8111-111111111111";
const FAILED_TASK_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_TASK_ID = "33333333-3333-4333-8333-333333333333";

function stubConfigPort(): ReportRoutesConfigPort & { _current(): unknown } {
  let current = normalizeReportConfig({});
  const port: ReportRoutesConfigPort = {
    get: () => current,
    update: async (next) => {
      current = next;
    },
    promptDefaults: DEFAULT_PROMPTS,
  };
  return Object.assign(port, { _current: () => current });
}

function stubQueuePort(): ReportRoutesQueuePort {
  return {
    submit: () => ({ taskId: DONE_TASK_ID, existing: false }),
    get: (taskId: string): ReportTask | undefined => {
      if (taskId === DONE_TASK_ID) {
        return {
          id: DONE_TASK_ID,
          period: "daily",
          key: "2026-09-18",
          startDay: "2026-09-18",
          endDay: "2026-09-18",
          force: true,
          status: "done",
          createdAt: 1,
          updatedAt: 2,
        };
      }
      if (taskId === FAILED_TASK_ID) {
        return {
          id: FAILED_TASK_ID,
          period: "daily",
          key: "2026-09-18",
          startDay: "2026-09-18",
          endDay: "2026-09-18",
          force: true,
          status: "failed",
          createdAt: 1,
          updatedAt: 2,
          error: "boom",
        };
      }
      return undefined;
    },
  };
}

type RouteModelStub = { id: string; name?: string };
type RouteLlmSeen = {
  resolveCalls: Array<{ provider: string; model: string; signal?: AbortSignal }>;
};

function stubReportCtx(
  historyRoot: string,
  opts: {
    throwingDirs?: boolean;
    models?: RouteModelStub[];
    modelsError?: string;
    capability?: LlmResolvedModelInfo;
    capabilityError?: string;
    capabilityNever?: boolean;
  } = {},
): {
  ctx: ReportRoutesContext;
  cfg: ReportRoutesConfigPort & { _current(): unknown };
  llmSeen: RouteLlmSeen;
} {
  const cfg = stubConfigPort();
  const llmSeen: RouteLlmSeen = { resolveCalls: [] };
  const llm = {
    listProviders: () => [{ id: "stub-p" }],
    listModels: async () => {
      if (opts.modelsError !== undefined) throw new Error(opts.modelsError);
      return opts.models ?? [{ id: "m1" }];
    },
    resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) => {
      llmSeen.resolveCalls.push({ provider, model, signal });
      if (opts.capabilityNever === true) {
        return new Promise<LlmResolvedModelInfo>(() => {});
      }
      if (opts.capabilityError !== undefined) throw new Error(opts.capabilityError);
      if (opts.capability === undefined) throw new Error("capability fixture missing");
      return opts.capability;
    },
  };
  const ctx: ReportRoutesContext = {
    ctx: { llm } as unknown as ReportRoutesContext["ctx"],
    historyRoot,
    reportQueue: stubQueuePort(),
    reportCfgService: cfg,
    presetLastRunForNewlyEnabled,
    previousClosedWindow,
    readLastRun,
    updateLastRun,
    normalizeReportConfig,
    readReportConfig,
    readReportIndex,
    reportHtmlFile,
    reportMetaFile,
    listDirs: opts.throwingDirs
      ? () => {
          throw new Error("dirs-down");
        }
      : () => [{ dir: "d", calls: 1, total: null }],
  };
  return { ctx, cfg, llmSeen };
}

const routeEffortId = (value: string): ReasoningEffortId => value as ReasoningEffortId;
const routeCapability: LlmResolvedModelInfo = {
  provider: "stub-p",
  id: "m2",
  name: "M2 capability",
  reasoning: {
    efforts: [
      { id: routeEffortId("vendor::deep"), name: "Deep", description: "深度思考" },
      { id: routeEffortId("vendor::balanced"), name: "Balanced" },
    ],
    defaultEffort: routeEffortId("vendor::balanced"),
  },
};

type AnyHandler = (req: IncomingMessage, res: ServerResponse, ctx: object) => unknown;

async function callStatus(
  handler: AnyHandler,
  req: IncomingMessage,
  ctx: ReportRoutesContext,
): Promise<{ code: number | undefined; body: unknown }> {
  const res = makeRes();
  await handler(req, res, ctx);
  return { code: res._code(), body: res._body() === "" ? undefined : JSON.parse(res._body()) };
}

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
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
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

describe("D11二 配置服务窄面消费 + 任务队列 + 执行器", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(reportRoutesDepsNs)).toEqual([]);
  });

  it("真实例可赋值窄口（Pick 收窄断裂即红，tsc 编译面）", () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const svc = new ReportConfigService({ root, initial: normalizeReportConfig({}) });
    const queue = new ReportTaskQueue({ executor: async () => ({}) });
    const cfgPort: ReportRoutesConfigPort = svc;
    const queuePort: ReportRoutesQueuePort = queue;
    expect(typeof cfgPort.get).toBe("function");
    expect(typeof queuePort.submit).toBe("function");
  });

  it("窄面桩跑通配置读写（内存权威 + 串行写，确权即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx, cfg } = stubReportCtx(root);
    const got = await callStatus(handleReportConfig as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    expect((got.body as { ok?: boolean }).ok).toBe(true);
    expect((got.body as { dirs?: unknown }).dirs).toEqual([{ dir: "d" }]);
    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({}) }),
      ctx,
    );
    expect(posted.code).toBe(200);
    expect((cfg._current() as { daily: { time: string } }).daily.time).toBe("08:00");
  });

  it.each([
    { label: "非 string", value: 7 },
    { label: "空串", value: "" },
  ])("POST reasoningEffort 为$label时显式 400 且不改配置", async ({ value }) => {
    const root = isolatedDir("dou-reportroutes-reasoning-effort-");
    const { ctx, cfg } = stubReportCtx(root);
    const before = cfg._current();

    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ reasoningEffort: value }) }),
      ctx,
    );

    expect(posted.code).toBe(400);
    expect((posted.body as { error?: string }).error).toBe("invalid-reasoning-effort");
    expect(cfg._current()).toBe(before);
  });

  it("首次启用翻转落盘lastRun（changed接线，断线即红）", async () => {
    // #768 B1b：changed=true→updateLastRun 接线覆盖（翻转 daily 关闭→启用，lastRun 落盘非空）。
    const root = isolatedDir("dou-reportroutesD11-flip-");
    const { ctx } = stubReportCtx(root);
    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({
        method: "POST",
        body: JSON.stringify({ daily: { enabled: true, time: "08:00" } }),
      }),
      ctx,
    );
    expect(posted.code).toBe(200);
    const lastRun = await readLastRun(root);
    expect(typeof lastRun.daily).toBe("string");
    expect((lastRun.daily as string).length).toBeGreaterThan(0);
  });

  it("目录候选异常不连坐配置本身（降级空数组，误拦即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root, { throwingDirs: true });
    const got = await callStatus(handleReportConfig as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    expect((got.body as { dirs?: unknown }).dirs).toEqual([]);
  });

  it("窄面桩跑通模型发现（未知 provider 与超时外形态，误判即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const known = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p" }),
      ctx,
    );
    expect(known.code).toBe(200);
    expect((known.body as { ok?: boolean }).ok).toBe(true);
    expect((known.body as { models?: Array<{ id: string }> }).models).toEqual([{ id: "m1" }]);
    const unknown = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=ghost" }),
      ctx,
    );
    expect((unknown.body as { reason?: string }).reason).toBe("unknown-provider");
  });

  describe("report-models：exact model capability wire", () => {
    it("无 model 参数保持 models[] 且不调用 resolver", async () => {
      const root = isolatedDir("dou-reportroutes-model-capability-");
      const { ctx, llmSeen } = stubReportCtx(root);

      const response = await callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p" }),
        ctx,
      );

      expect(response.code).toBe(200);
      expect(response.body).toEqual({ ok: true, models: [{ id: "m1" }] });
      expect(llmSeen.resolveCalls).toEqual([]);
    });

    it("多模型目录只查 exact model 一次并透传 efforts 顺序、name、description、default", async () => {
      const root = isolatedDir("dou-reportroutes-model-capability-");
      const { ctx, llmSeen } = stubReportCtx(root, {
        models: [
          { id: "m1", name: "Catalog M1" },
          { id: "m2", name: "Catalog M2" },
          { id: "m3", name: "Catalog M3" },
        ],
        capability: routeCapability,
      });

      const response = await callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p&model=m2" }),
        ctx,
      );

      expect(response.code).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        models: [
          { id: "m1", name: "Catalog M1" },
          { id: "m2", name: "Catalog M2" },
          { id: "m3", name: "Catalog M3" },
        ],
        selectedModel: {
          id: "m2",
          name: "M2 capability",
          reasoning: {
            efforts: [
              { id: "vendor::deep", name: "Deep", description: "深度思考" },
              { id: "vendor::balanced", name: "Balanced" },
            ],
            defaultEffort: "vendor::balanced",
          },
        },
      });
      expect(llmSeen.resolveCalls).toEqual([
        { provider: "stub-p", model: "m2", signal: expect.any(AbortSignal) },
      ]);
    });

    it("exact model 不在列表时返回 unknown-model 且不调用 resolver", async () => {
      const root = isolatedDir("dou-reportroutes-model-capability-");
      const { ctx, llmSeen } = stubReportCtx(root);

      const response = await callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p&model=missing" }),
        ctx,
      );

      expect(response.code).toBe(200);
      expect(response.body).toEqual({ ok: false, reason: "unknown-model" });
      expect(llmSeen.resolveCalls).toEqual([]);
    });

    it("命中模型但 capability resolver 失败时保留 models[] 并标记 capabilityError", async () => {
      const root = isolatedDir("dou-reportroutes-model-capability-");
      const { ctx, llmSeen } = stubReportCtx(root, {
        models: [{ id: "m1", name: "Catalog M1" }],
        capabilityError: "capability unavailable",
      });

      const response = await callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p&model=m1" }),
        ctx,
      );

      expect(response.code).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        models: [{ id: "m1", name: "Catalog M1" }],
        selectedModel: { id: "m1", capabilityError: true },
      });
      expect(llmSeen.resolveCalls).toEqual([
        { provider: "stub-p", model: "m1", signal: expect.any(AbortSignal) },
      ]);
    });

    it("never-settling resolver 超时返回 capabilityError 并尽力 abort 底层", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const root = isolatedDir("dou-reportroutes-model-capability-timeout-");
        const { ctx, llmSeen } = stubReportCtx(root, {
          models: [{ id: "m1" }, { id: "m2" }],
          capabilityNever: true,
        });
        const pending = callStatus(
          handleReportModels as AnyHandler,
          fakeReq({ method: "GET", url: "/?provider=stub-p&model=m2" }),
          ctx,
        );

        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;

        expect(response.code).toBe(200);
        expect(response.body).toEqual({
          ok: true,
          models: [{ id: "m1" }, { id: "m2" }],
          selectedModel: { id: "m2", capabilityError: true },
        });
        expect(llmSeen.resolveCalls).toHaveLength(1);
        expect(llmSeen.resolveCalls[0]!.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("模型列表异常只返回稳定 code，不泄露 resolver 原始文案", async () => {
      const root = isolatedDir("dou-reportroutes-model-discover-safe-error-");
      const raw = "key=sk-private path=/private/report.json";
      const { ctx } = stubReportCtx(root, { modelsError: raw });

      const response = await callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p" }),
        ctx,
      );

      expect(response.code).toBe(200);
      expect(response.body).toEqual({ ok: false, reason: "discover-failed" });
      expect(JSON.stringify(response.body)).not.toContain(raw);
    });
  });

  it("窄面桩跑通历史索引与详情围栏（空索引 200，键非法 400，缺件 404）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const list = await callStatus(handleReports as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(list.code).toBe(200);
    expect((list.body as { reports?: unknown[] }).reports).toEqual([]);
    const badPeriod = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=bogus&key=x" }),
      ctx,
    );
    expect(badPeriod.code).toBe(400);
    const badKey = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=daily&key=not-a-date" }),
      ctx,
    );
    expect((badKey.body as { error?: string }).error).toBe("invalid-key");
    const missing = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=daily&key=2026-09-18" }),
      ctx,
    );
    expect(missing.code).toBe(404);
  });

  it("窄面桩跑通手动生成与状态轮询（非法 400，入队 202，done/failed/未知分支）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const bad = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "bogus" }) }),
      ctx,
    );
    expect(bad.code).toBe(400);
    const queued = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      ctx,
    );
    expect(queued.code).toBe(202);
    expect((queued.body as { taskId?: string }).taskId).toBe(DONE_TASK_ID);
    const done = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + DONE_TASK_ID }),
      ctx,
    );
    expect(done.code).toBe(200);
    expect((done.body as { status?: string }).status).toBe("done");
    const failed = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + FAILED_TASK_ID }),
      ctx,
    );
    expect((failed.body as { error?: string }).error).toBe("boom");
    const unknown = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + UNKNOWN_TASK_ID }),
      ctx,
    );
    expect(unknown.code).toBe(404);
    const illegal = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=not-a-uuid" }),
      ctx,
    );
    expect(illegal.code).toBe(404);
  });

  it("非 force 遇 waiting/terminal ledger 时明确 deferred/terminal 且不入队", async () => {
    const root = isolatedDir("dou-reportroutes-retry-state-");
    const { ctx } = stubReportCtx(root);
    const ledger = createRetryLedger(root, {
      createCycleId: (() => {
        let n = 0;
        return () => `route-cycle-${(n += 1)}`;
      })(),
    });
    const state = createReportStateCoordinator({ root, ledger });
    const due = previousClosedWindow("daily", ctx.reportCfgService.get(), Date.now());
    const claim = await state.beginAttempt({
      ...due,
      route: { provider: "stub-p", model: "m1" },
    });
    if (claim === null) throw new Error("expected claim");
    await state.recordFailure(claim, { code: "transient", kind: "transient" });
    const waiting = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }),
      { ...ctx, retryState: state },
    );
    expect(waiting.code).toBe(409);
    expect((waiting.body as { status?: string }).status).toBe("deferred");
    await state.beginForce({
      ...due,
      route: { provider: "stub-p", model: "m1" },
    });
    const terminalEntry = await state.get(due.period, due.key);
    if (terminalEntry === undefined) throw new Error("expected terminal ledger");
    const terminalClaim = await state.beginAttempt({
      ...due,
      cycleId: terminalEntry.cycleId,
      route: terminalEntry.route,
    });
    if (terminalClaim === null) throw new Error("expected terminal claim");
    await state.recordFailure(terminalClaim, { code: "permanent", kind: "permanent" });
    const terminal = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }),
      { ...ctx, retryState: state },
    );
    expect(terminal.code).toBe(409);
    expect((terminal.body as { status?: string }).status).toBe("terminal");
  });

  it.each(["waiting", "in-flight"] as const)(
    "旧 cycle index 遇到 force %s 时 non-force 仅复用，不清新 ledger/lastRun",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.UTC(2026, 8, 24, 12, 0, 0);
      vi.setSystemTime(now);
      const root = isolatedDir(`dou-reportroutes-old-index-${phase}-`);
      const { ctx } = stubReportCtx(root);
      const due = previousClosedWindow("daily", ctx.reportCfgService.get(), now);
      const ledger = createRetryLedger(root, {
        createCycleId: (() => {
          let sequence = 0;
          return () => `route-cycle-${(sequence += 1)}`;
        })(),
      });
      const state = createReportStateCoordinator({ root, ledger, now: () => now });
      const oldClaim = await state.beginAttempt(
        {
          ...due,
          route: { provider: "stub-p", model: "m1" },
        },
        now - 1,
      );
      if (oldClaim === null) throw new Error("expected old claim");
      const oldMeta = {
        period: due.period,
        key: due.key,
        startDay: due.startDay,
        endDay: due.endDay,
        provider: "stub-p",
        model: "m1",
        generatedAt: now - 1,
        durationMs: 1,
        ok: true,
        cycleId: oldClaim.cycleId,
      };
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(join(root, "reports", "index.jsonl"), `${JSON.stringify(oldMeta)}\n`);
      const forced = await state.beginForce(
        {
          ...due,
          route: { provider: "stub-p", model: "m1" },
        },
        now,
      );
      if (phase === "in-flight") {
        const claim = await state.beginAttempt(
          {
            ...due,
            cycleId: forced.cycleId,
            route: forced.route,
          },
          now,
        );
        if (claim === null) throw new Error("expected in-flight force claim");
      }
      const beforeLastRun = { daily: "2000-01-01" };
      await updateLastRun(root, () => beforeLastRun);

      try {
        const response = await callStatus(
          handleReportGenerate as AnyHandler,
          fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: false }) }),
          { ...ctx, retryState: state },
        );

        expect(response.code).toBe(200);
        expect(response.body).toMatchObject({ ok: true, reused: true, meta: oldMeta });
        expect(await state.get(due.period, due.key)).toMatchObject({
          cycleId: forced.cycleId,
          phase,
          terminal: false,
        });
        expect(await readLastRun(root)).toEqual(beforeLastRun);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("force 走 submitForce；status 透出稳定 retry 状态", async () => {
    const root = isolatedDir("dou-reportroutes-force-");
    const { ctx } = stubReportCtx(root);
    const taskId = "44444444-4444-4444-8444-444444444444";
    let submitted = 0;
    const queue: ReportRoutesQueuePort & {
      submitForce?: (input: {
        period: "daily";
        key: string;
        startDay: string;
        endDay: string;
        force: true;
      }) => Promise<{ taskId: string; existing: boolean }>;
    } = {
      submit: () => ({ taskId: DONE_TASK_ID, existing: false }),
      submitForce: async () => {
        submitted += 1;
        return { taskId, existing: false };
      },
      get: (id: string) =>
        id === taskId
          ? {
              id,
              period: "daily",
              key: "2026-09-18",
              startDay: "2026-09-18",
              endDay: "2026-09-18",
              force: true,
              status: "failed",
              createdAt: 1,
              updatedAt: 2,
              error: "storage",
            }
          : undefined,
    };
    const retryState = {
      get: async () => ({
        period: "daily" as const,
        key: "2026-09-18",
        startDay: "2026-09-18",
        endDay: "2026-09-18",
        route: { provider: "stub-p", model: "m1" },
        attempts: 2,
        maxAttempts: 5 as const,
        nextRetryAt: 1234,
        terminal: false,
        reason: null,
        cycleId: "c1",
        phase: "waiting" as const,
        attemptObservations: [],
        usage: {
          inputTokens: 11,
          outputTokens: null,
          reasoningTokens: 3,
          totalTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          durationMs: 42,
        },
      }),
    } as unknown as ReportRoutesContext["retryState"];
    const withState = { ...ctx, reportQueue: queue, retryState };
    const response = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      withState,
    );
    expect(response.code).toBe(202);
    expect(submitted).toBe(1);
    const status = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: `/?taskId=${taskId}` }),
      withState,
    );
    expect(status.code).toBe(200);
    expect((status.body as { error?: string; retry?: unknown }).error).toBe("storage");
    expect(
      (status.body as { retry?: { attempts?: number; usage?: unknown } }).retry?.attempts,
    ).toBe(2);
    expect((status.body as { retry?: { usage?: unknown } }).retry?.usage).toEqual({
      inputTokens: 11,
      outputTokens: null,
      reasoningTokens: 3,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      durationMs: 42,
    });
  });

  it("force prepare/提交失败返回稳定 code，不泄露原始错误", async () => {
    const root = isolatedDir("dou-reportroutes-force-error-");
    const { ctx } = stubReportCtx(root);
    const queue: ReportRoutesQueuePort & {
      submitForce?: () => Promise<{ taskId: string; existing: boolean }>;
    } = {
      submit: () => ({ taskId: DONE_TASK_ID, existing: false }),
      submitForce: async () => {
        throw new Error("secret path=/private/report.json key=sk-live");
      },
      get: () => undefined,
    };
    const response = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      { ...ctx, reportQueue: queue },
    );
    expect(response.code).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("secret path");
    expect(JSON.stringify(response.body)).not.toContain("sk-live");
  });

  it("执行器工厂不直引（实现内无执行器符号，越界即红）", () => {
    expect(reportsSrc.includes("makeDueReportExecutor")).toBe(false);
    expect(reportsSrc.includes("DueExecutorDeps")).toBe(false);
    expect(reportsSrc.includes("ReportTaskQueueOptions")).toBe(false);
  });

  it("装配面锚点已删除（复活即类型倒灌回退）", () => {
    expect(existsSync(join(srcDir, "apply", "interface.ts"))).toBe(false);
    expect(applySrc.includes("apply/interface")).toBe(false);
    expect(reportsSrc.includes("apply/interface")).toBe(false);
  });

  it("家目录禁令：三文件无 homedir/HOME/untildify 直调（直调即红）", () => {
    for (const src of [reportsSrc, reportFaceSrc, reportDepsSrc]) {
      expect(src.includes("homedir(")).toBe(false);
      expect(src.includes("process.env.HOME")).toBe(false);
      expect(src.includes("untildify")).toBe(false);
    }
  });
});

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
