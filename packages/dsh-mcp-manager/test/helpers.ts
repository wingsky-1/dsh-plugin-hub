/**
 * dsh-mcp-manager — 测试共享辅助（smoke + 各 unit 双份共用）。
 *
 * 防 flake 纪律（DEVELOPMENT.md §5 / issue #315）：一律用事件驱动 await /
 * pollUntil 轮询替代「固定 sleep 等响应/等后台」的时序假设。本文件是单一事实源：
 * 任何测试文件需要「等 handler 响应」或「等后台异步落定」时，从这里取原语，
 * 禁止在测试里自行写固定 sleep。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 建一个隔离的 DSH_HOME（临时目录 + `DSH_HOME` 打桩），返回 `{ dir, dispose }`。
 *
 * 为什么必须打桩：落盘面（含迁移用例）会真的建目录、搬文件、改名，**绝不碰真实 `~/.dsh`**
 * （#218 产物零污染）。`dshHome()` 每次调用都读环境变量，故桩随 dispose 还原即可。
 */
export function tempDshHome() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    dispose() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 最小假宿主上下文：McpManager 构造器只读 `ctx.logger`（见
 * `server/connection/orchestrator/manager.ts` 构造器），其余 Context 面用例不用——按本仓既有
 * 接缝（`as unknown as`）收窄，不断言无关形状。需要组合根装配（installOrchestrator 等）时仍须
 * 先求值包根入口，本夹具不替代装配。
 */
export function fakeManagerCtx(): Context {
  return { logger: { warn: () => {}, info: () => {}, error: () => {} } } as unknown as Context;
}

/** 收集 warn 的假 logger：upgrade 域的诊断出口只用到 `warn`。 */
export function makeLogger(): { warns: string[]; warn: (message: string) => void } {
  const warns: string[] = [];
  return {
    warns,
    warn(message: string) {
      warns.push(message);
    },
  };
}

/** 伪造 node:http res：捕获 writeHead / end，供断言状态码与响应体。 */
export interface FakeResponseState {
  status: number;
  headers: Record<string, string>;
  body: string;
  destroyed: boolean;
  writableEnded: boolean;
  onClose?: () => void;
}

/** callHandler 的响应桩面：node 响应 + 可读的 state（测试断言状态码与响应体）。 */
export type FakeHandlerResponse = ServerResponse & { state: FakeResponseState };

export function fakeRes(): FakeHandlerResponse {
  const state: FakeResponseState = {
    status: 200,
    headers: {},
    body: "",
    destroyed: false,
    writableEnded: false,
  };
  return {
    state,
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      Object.assign(state.headers, headers ?? {});
    },
    write(chunk: { toString(): string }) {
      state.body += chunk.toString();
    },
    end(chunk?: { toString(): string }) {
      if (chunk !== undefined) state.body += chunk.toString();
      state.writableEnded = true;
    },
    setHeader() {},
    on(event: string, cb: () => void) {
      if (event === "close") state.onClose = cb;
    },
    destroy() {
      state.destroyed = true;
    },
  } as unknown as FakeHandlerResponse;
}

/**
 * 统一调用路由 handler 并拿响应。
 *
 * 防 flake 关键形态：async handler 时 await（writeJson 在 resolve 前同步触发
 * end 回调，故 await 返回后 res 已完整写入）；同步 handler 时立即返回。
 * 返回 { status, payload }：payload 为 JSON 解析后的响应体，非 JSON 时回退原文。
 * 禁止在调用方「调用 handler 后 sleep 再读外联变量」——一律用本封装或直接 await。
 *
 * @param {{ handler: Function }} route 路由对象（makeRoutes 产物）。
 * @param {object} req 请求桩（fakeReq 形态）。
 * @param {object} [res] 响应桩，缺省用 fakeRes()。
 */
/**
 * 统一调用路由 handler 并拿响应（req/res 皆为 node:http 面：被测路由的 handler 类型即
 * `WebRoute["handler"]`，桩在调用方按 `as unknown as` 收窄——见各测试文件的 fakeReq/fakeRes）。
 */
export async function callHandler(
  route: { handler: (req: IncomingMessage, res: FakeHandlerResponse) => unknown },
  req: IncomingMessage,
  res: FakeHandlerResponse = fakeRes(),
): Promise<{ status: number; payload: unknown }> {
  const ret: unknown = route.handler(req, res);
  if (
    typeof ret === "object" &&
    ret !== null &&
    typeof (ret as { then: unknown }).then === "function"
  )
    await ret;
  let payload: unknown;
  try {
    payload = JSON.parse(res.state.body || "null");
  } catch {
    payload = res.state.body;
  }
  return { status: res.state.status, payload };
}

/**
 * 轮询等待条件成立（防 flake：轮询替代固定 sleep）。超时抛错。
 * 谓词每 tick 重估；tick 是轮询 tick（语义分类：轮询 tick），非「等够毫秒」。
 */
export async function pollUntil(
  label: string,
  cond: () => boolean,
  { timeoutMs = 5000, tickMs = 10 }: { timeoutMs?: number; tickMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

/**
 * 观察窗口内持续轮询断言测量值保持 baseline（反向验证：确认某后台行为停止，
 * 如 close/disposer 后不再写心跳帧）。窗口内每 tick 都断言，任何时刻偏离立即失败，
 * 比「单次固定 sleep 后一次性断言」更能即时暴露竞态。窗口时长是物理必需
 * （无法不经过时间就证明『未来无新帧』），tick 属轮询 tick。
 */
export async function assertNoGrowth(
  label: string,
  measure: () => unknown,
  baseline: unknown,
  { windowMs = 120, tickMs = 10 }: { windowMs?: number; tickMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    assert.equal(measure(), baseline, label);
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

/**
 * 假 loader：宿主服务面（`import`）与 LoaderPort 面（`load` / `mount`）合一。
 *
 * 为什么两副面孔合一：`bindHost` 的 `LoaderPort.load` 只经 `ctx.get("loader")` 拿到的**宿主服务**
 * （`import`）解析包名，而 LoaderPort 自己（`load` / `mount`）是域侧要消费的注入面；同一份夹具
 * 同时扮演两侧，探针才能在一条链上端到端验「端口 → 宿主服务」的转发。
 *
 * 为什么不引真 loader：官方 loader 与官方 MCP 客户端都不在 catalog、仓库内不可解析，任何 import
 * （含 import type）在 CI 上都会直接失败；夹具只按自持声明的结构形状造。
 *
 * ready 的三种时序由 `script.ready` 注入（默认 immediate）：immediate 立即 settle、deferred 由测试
 * 显式 `settleReady()` 放闸、never 永不 settle（测超时封装与晚到结算守卫）。禁止用固定 sleep 等
 * 结算（本文件头部的防 flake 纪律）。
 *
 * @param {object} [script]
 * @param {Record<string, unknown>} [script.modules] 包名 → 模块（load/import 按表解析，未登记即抛）
 * @param {"immediate"|"deferred"|"never"} [script.ready] 句柄 ready 的结算时序
 * @param {boolean} [script.disposeThrows] dispose 是否抛错（置位在先，抛错在后）
 */
export interface FakeLoaderScript {
  modules?: Record<string, unknown>;
  ready?: "immediate" | "deferred" | "never";
  disposeThrows?: boolean;
}

export interface FakeMountState {
  disposed: boolean;
  disposeCalls: number;
}

export interface FakeMountRecord {
  module: unknown;
  config: unknown;
  state: FakeMountState;
  ready: Promise<unknown>;
}

export function fakeLoaderPort(script: FakeLoaderScript = {}) {
  const modules = script.modules ?? {};
  const calls: unknown[][] = [];
  const handles: FakeMountRecord[] = [];
  const pendingReady: ((value: unknown) => void)[] = [];
  const makeReady = () => {
    if (script.ready === "never") return new Promise(() => {});
    if (script.ready === "deferred") {
      return new Promise((resolve) => {
        pendingReady.push(resolve);
      });
    }
    return Promise.resolve();
  };
  const loader = {
    calls,
    handles,
    /** deferred 时序的放闸口：一次性结算所有已 mount 句柄的 ready。 */
    settleReady() {
      for (const resolve of pendingReady.splice(0)) resolve(undefined);
    },
    import(specifier: string) {
      calls.push(["import", specifier]);
      if (!(specifier in modules)) {
        throw new Error("fakeLoaderPort: 未登记的包名 " + specifier);
      }
      return modules[specifier];
    },
    async load(specifier: string) {
      calls.push(["load", specifier]);
      return await loader.import(specifier);
    },
    mount(module: unknown, config: unknown) {
      calls.push(["mount", module, config]);
      const state = { disposed: false, disposeCalls: 0 };
      const record = { module, config, state, ready: makeReady() };
      handles.push(record);
      return {
        get disposed() {
          return state.disposed;
        },
        ready: record.ready,
        async dispose() {
          state.disposed = true;
          state.disposeCalls += 1;
          calls.push(["dispose", record]);
          if (script.disposeThrows === true) throw new Error("fakeLoaderPort: dispose 失败");
        },
      };
    },
  };
  return loader;
}

/**
 * 假工具服务（宿主 `ctx.tools` 面）：注册面查询 + 执行面，中间层池与 dispatch 的夹具共用。
 *
 * 为什么 `schemas` 返回的是**活数组**而不是快照：换引擎后官方不暴露任何状态 API，「已连上」只能
 * 从注册面的 `mcp__<id>__` 前缀读出来，六态投影的可判时点就是「前缀出现 / 消失」——夹具必须让
 * 用例能在两次读之间改写它，否则「曾连上、前缀消失」这条判据根本构造不出来。
 *
 * 为什么 `execute` 的缺省结果带 `value`：官方执行器返回的 `value` 是远端原始 CallToolResult，
 * 中间层投影吃的就是它（结果形状实测：`{isError, content, value}`）。
 *
 * @param {object} [script]
 * @param {Array} [script.schemas] 初始注册面条目（`{name, description?, parameters?}`）
 * @param {Function} [script.execute] 执行面实现，收官方 ToolExecutionInput；缺省返回空成功结果
 */
export interface FakeToolEntry {
  name: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface FakeToolsScript {
  schemas?: FakeToolEntry[];
  execute?: (input: unknown) => unknown | Promise<unknown>;
}

export function fakeToolsService(script: FakeToolsScript = {}) {
  let schemas: FakeToolEntry[] = script.schemas ?? [];
  const registered: unknown[] = [];
  const disposed: unknown[] = [];
  const executed: unknown[] = [];
  return {
    registered,
    disposed,
    executed,
    get entries() {
      return schemas;
    },
    set entries(next) {
      schemas = next;
    },
    register(def: FakeToolEntry) {
      registered.push(def);
      return () => disposed.push(def?.name);
    },
    schemas() {
      return schemas;
    },
    async execute(input: unknown) {
      executed.push(input);
      if (script.execute) return await script.execute(input);
      return { isError: false, content: [], value: { content: [] } };
    },
  };
}

/**
 * 假宿主日志面（`LogsPort`）：把「挂导出器 → 投记录 → 摘除」这条链做成可观测的夹具。
 *
 * 为什么 `emit` 先复制一份订阅者列表：摘除器允许在投递过程中被调用（`collectOfficialLogs.stop()`
 * 就发生在装载窗口的 `finally` 里），原地遍历会因数组被改而漏投后面的订阅者——夹具的投递语义
 * 必须与宿主一致，否则「只收归属本实例的」这类断言会因夹具的缺陷而失真。
 *
 * `captured` 是在册导出器数：装载链的判据之一就是窗口结束后它必须归零。
 */
export function fakeLogsPort() {
  const handlers: ((record: unknown) => void)[] = [];
  const records: unknown[] = [];
  return {
    handlers,
    records,
    capture(handler: (record: unknown) => void) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    emit(record: unknown) {
      records.push(record);
      for (const handler of [...handlers]) handler(record);
    },
    get captured() {
      return handlers.length;
    },
  };
}
