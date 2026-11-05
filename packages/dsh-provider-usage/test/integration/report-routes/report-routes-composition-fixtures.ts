/**
 * report-routes 组合根共享夹具：fake 请求/响应、窄面桩、隔离目录与 afterEach 收口。
 *
 * 由原入口 composition-root.test.ts 的模块级夹具原样下沉；模块级 afterEach（cache 生命周期）
 * 随夹具一起落在这里——注册处只 import，不再各自声明 hook（避免两处收口时序漂移）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LlmResolvedModelInfo, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { afterEach } from "vitest";
import { cleanupIsolatedDirs, makeIsolatedDir } from "../../helpers.ts";
import type { ReportRoutesContext } from "../../../src/server/report-routes/interface.ts";
import type {
  ReportRoutesConfigPort,
  ReportRoutesQueuePort,
} from "../../../src/server/report-routes/deps.ts";
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
  presetLastRunForNewlyEnabled,
  previousClosedWindow,
  readLastRun,
  updateLastRun,
} from "../../../src/server/schedule/interface.ts";
import type { ReportTask } from "../../../src/server/schedule/interface.ts";

// ---------------------------------------------------------------- fake 请求/响应
//
// 与 data-routes 组合根同形：loopback = 127.0.0.1 socket + 回环 host；
// readJsonBodyOutcome 经 for await 读 body，故带 async-iterator 桩。
export function fakeReq(overrides: Record<string, unknown> = {}): IncomingMessage {
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
export function nonLoopbackReq(overrides: Record<string, unknown> = {}): IncomingMessage {
  return fakeReq({
    socket: { remoteAddress: "10.0.0.2" },
    headers: { host: "evil.example" },
    ...overrides,
  });
}

export function makeRes(): ServerResponse & { _code(): number | undefined; _body(): string } {
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
export const DONE_TASK_ID = "11111111-1111-4111-8111-111111111111";
export const FAILED_TASK_ID = "22222222-2222-4222-8222-222222222222";
export const UNKNOWN_TASK_ID = "33333333-3333-4333-8333-333333333333";

export function stubConfigPort(): ReportRoutesConfigPort & { _current(): unknown } {
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

export function stubQueuePort(): ReportRoutesQueuePort {
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

export type RouteModelStub = { id: string; name?: string };
export type RouteLlmSeen = {
  resolveCalls: Array<{ provider: string; model: string; signal?: AbortSignal }>;
};

export function stubReportCtx(
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

export const routeEffortId = (value: string): ReasoningEffortId => value as ReasoningEffortId;
export const routeCapability: LlmResolvedModelInfo = {
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

export type AnyHandler = (req: IncomingMessage, res: ServerResponse, ctx: object) => unknown;

export async function callStatus(
  handler: AnyHandler,
  req: IncomingMessage,
  ctx: ReportRoutesContext,
): Promise<{ code: number | undefined; body: unknown }> {
  const res = makeRes();
  await handler(req, res, ctx);
  return { code: res._code(), body: res._body() === "" ? undefined : JSON.parse(res._body()) };
}

const tmpDirs: string[] = [];
export function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});
