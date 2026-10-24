/**
 * dsh-mcp-manager — e2e smoke 共享夹具（#1174 shape 拆分产物）。
 *
 * 只承载**跨文件复用**的 fixture：原 e2e/smoke.test.ts 内的假 ctx / 假 res / 工具捕获面 /
 * 临时 store / css 归一化等。它们与 test/helpers.ts 的同名件**形状不同**（例如本文件的 fakeRes
 * 无 destroyed / writableEnded 回读，helpers 的有；fakeCtx 的 effect 记录 label），故不并入
 * helpers——helpers 由中央单一登记人维护，本模块只服务 e2e smoke 拆分会出的各文件。
 *
 * 归属：support（mutation-topology 的 supportFiles 语义），**不入任何测试层、不计 --min、
 * 不进变异面**。hook 一律由消费文件自行注册（catalogTempDirs 的回收由各文件的 afterAll 将
 * 该文件自己的账本传给 releaseCatalogTempDirs()），本模块顶层不注册 hook。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, LoggerService } from "@deepseek-ai/cordis";
import type {
  PreToolDecision,
  ToolDefinition,
  ToolExecution,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { McpStore } from "../../src/server/store/interface.ts";

// 组合根端口手装是**消费文件**的职责（lib bundle 与 src 域门面并存会换模块实例身份，
// 见各 e2e 文件头注释）；本 support 模块顶层不注册任何 hook。

/** catalogTempDirs 的回收面（消费文件传入自己的账本，回收与积累始终落在同一数组）。 */
export function releaseCatalogTempDirs(catalogTempDirs: string[]) {
  for (const dir of catalogTempDirs) rmSync(dir, { recursive: true, force: true });
  catalogTempDirs.length = 0;
}

/** 假路由：fakeCtx.webServer 收到的注册项，只表达测试回读的面（path/handler）。 */
export interface FakeRoute {
  path: string;
  handler: (req: FakeReq, res: FakeRes) => unknown;
}

/** 假 HTTP 请求的可观测面（与 IncomingMessage 取交集，保证 handler 调用位合法）。 */
export interface FakeReqShape {
  method: string;
  url: string;
  socket: { remoteAddress: string };
  headers: Record<string, string>;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
}
export type FakeReq = FakeReqShape & IncomingMessage;

/** 假 HTTP 响应的可观测面（与 ServerResponse 取交集，保证 handler 调用位合法）。 */
export interface FakeResState {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface FakeResShape {
  state: FakeResState;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
}
export type FakeRes = FakeResShape & ServerResponse;

/** 假 section：apply 实际传入静态文本（见 src/index.ts），测试读 name/order/text。 */
export interface FakeSection {
  name: string;
  order: number;
  text: string;
}

export type FakeListener = (...args: unknown[]) => unknown;

/**
 * 假 ctx 的可回读状态 + 宿主注入面。返回 FakeCtx & Context：回读走 FakeCtx，
 * 传 apply 时走 Context（假体与真实 Context 的结构差由一处 seam cast 桥接，
 * 成例：test/helpers.ts fakeManagerCtx）。
 */
export interface FakeCtx {
  routes: FakeRoute[];
  sections: FakeSection[];
  effects: (string | undefined)[];
  registeredTools: ToolDefinition[];
  listeners: Map<string, FakeListener[]>;
  tools: { register: (definition: ToolDefinition) => () => void };
  webServer: { register: (route: FakeRoute) => () => void };
  systemPrompt: { section: (section: FakeSection) => () => void };
  on: (event: string, handler: FakeListener) => () => void;
  logger: LoggerService;
  effect: (fn: () => unknown, label?: string) => () => void;
}

/** 假 logger：被测体只读 warn/info/error，其余 LoggerService 面按 seam cast。 */
export function fakeLogger(): LoggerService {
  return { warn: () => {}, info: () => {}, error: () => {} } as unknown as LoggerService;
}

export function fakeCtx(overrides: Record<string, unknown> = {}): FakeCtx & Context {
  const state = {
    routes: [] as FakeRoute[],
    sections: [] as FakeSection[],
    effects: [] as (string | undefined)[],
    registeredTools: [] as ToolDefinition[],
    listeners: new Map<string, FakeListener[]>(),
  };
  const ctx = {
    ...state,
    tools: {
      register: (definition: ToolDefinition) => {
        state.registeredTools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register: (route: FakeRoute) => {
        state.routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section: FakeSection) => {
        state.sections.push(section);
        return () => {};
      },
    },
    on: (event: string, handler: FakeListener) => {
      const handlers = state.listeners.get(event) ?? [];
      handlers.push(handler);
      state.listeners.set(event, handlers);
      return () => {};
    },
    logger: fakeLogger(),
    effect: (fn: () => unknown, label?: string) => {
      state.effects.push(label);
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    ...overrides,
  };
  return ctx as unknown as FakeCtx & Context;
}

/** 伪造 node:http res（可回读 state；传 handler 处按 ServerResponse 面兼容）。 */
export function fakeRes(): FakeRes {
  const state: FakeResState = { status: 0, headers: {}, body: "" };
  const res: FakeResShape = {
    state,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      Object.assign(state.headers, headers);
    },
    end(body: string) {
      state.body = body;
    },
  };
  return res as unknown as FakeRes;
}

/**
 * 中间层装配夹具 ctx：只实现 tools.register（捕获注册的工具定义供断言）。
 * 其余宿主面按测试 seam cast 到 Context（成例：test/helpers.ts fakeManagerCtx）。
 */
export function captureCtx(registered: ToolDefinition[]): Context {
  return {
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def);
        return () => {};
      },
    },
  } as unknown as Context;
}

/** 在已断言注册名的前提下按名取工具定义：缺失即抛（测试失败），顺带收窄 undefined。 */
export function mustTool(registered: ToolDefinition[], name: string): ToolDefinition {
  const def = registered.find((d) => d.name === name);
  if (def === undefined) throw new Error(`中间层工具未注册: ${name}`);
  return def;
}

/** search 执行结果的可断言面（与产品 executeSearch 返回同形，只取测试回读的键）。 */
export interface SmokeSearchHit {
  server: string;
  tool?: string;
}
export interface SmokeSearchResult {
  results: SmokeSearchHit[];
  unavailable: unknown[];
  truncated: boolean;
}

/** list 执行结果的可断言面（与产品 executeList 返回同形，只取测试回读的键）。 */
export interface SmokeListServer {
  server: string;
  tools: { name: string }[];
}
export interface SmokeListResult {
  servers: SmokeListServer[];
  totalServers: number;
  totalTools: number;
  message: string;
  workspace: string;
}

/** detail 执行结果的可断言面（与产品 findToolDetail 返回同形，只取测试回读的键）。 */
export interface SmokeDetailResult {
  server: string;
  tool: string;
}

/** execute 的 exec 入参桩：被测体只读 agent（工作空间反解），其余面按测试 seam cast。 */
export function execWithAgent(agent: unknown): ToolRunContext {
  return { agent } as unknown as ToolRunContext;
}

/** tools/pre-execute guard 形态（与产品 middleware-register.ts 注册签名同形）。 */
export type SmokeGuard = (
  exec: Pick<ToolExecution, "name" | "arguments" | "agent" | "parent">,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision>;

/** 沿宿主约定的 session.header.cwd 形状逐层收窄；任一层不是对象即中止。 */
export function nestedProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** resolveRoot 桩从 agent 取 cwd：宿主约定的 session.header.cwd 形状，此处收窄读取。 */
export function agentCwd(agent: unknown): string | undefined {
  const cwd = nestedProp(nestedProp(nestedProp(agent, "session"), "header"), "cwd");
  return typeof cwd === "string" ? cwd : undefined;
}

/** 测试路由桩：/proj 会话回项目根，/no-project 回 @global（单池后组合根同款回落）。 */
export function testResolveRoot(agent: unknown, globalRoot?: string): Promise<string | undefined> {
  const cwd = agentCwd(agent);
  if (cwd === "/proj") return Promise.resolve("/proj");
  if (globalRoot !== undefined && cwd === "/no-project") return Promise.resolve(globalRoot);
  return Promise.resolve(undefined);
}

/** 在临时目录建一个空 store，返回 { store, path, cleanup }。 */
export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-"));
  const path = join(dir, "dsh-mcp.json");
  return {
    store: new McpStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * style.css 的排版归 Prettier（该文件在格式化面内），而下面多处判据是按「无空格」的紧凑
 * 形态写的。这里把声明两侧的空白归一化，让判据只认声明内容、不认排版形态。
 */
export function styleCssCompact() {
  return readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8").replace(
    /\s*([{}:;,])\s*/g,
    "$1",
  );
}
