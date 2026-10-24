/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdtempSync, rmSync } from "node:fs";

import { join } from "node:path";

import { afterAll, afterEach, beforeAll } from "vitest";

import {
  fakeLoaderPort,
  fakeLogsPort,
  fakeToolsService,
  installCompositionPorts,
  markerFreeTempParent,
  releaseCompositionPorts,
} from "../helpers.ts";

import type { FakeLoaderScript, FakeToolEntry } from "../helpers.ts";

import type { Context } from "@deepseek-ai/cordis";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import type { LoaderPort, LogsPort } from "../../src/server/shared/interface.ts";

import type { ServerConfig } from "../../src/server/config/interface.ts";

import type { ToolsRegistryPort } from "../../src/server/servers/lifecycle/deps.ts";

import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";

import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";

import { OFFICIAL_MCP_CLIENT_SPECIFIER } from "../../src/server/shared/interface.ts";

import {
  installLifecycle,
  mountLedger,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——管理器、中间层与健康路由改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装。驱动 apply() 的那两组用例
// （ctx.mcpManager 服务面、apply 配置分支）已整段迁至 test/integration/apply-lifecycle.test.ts。
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");

const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");

const { makeHealthRoute } = await import("../../src/server/api/interface.ts");

const { McpStore } = await import("../../src/server/store/interface.ts");

const {
  normalizeServer,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  SERVER_NAME_PATTERN,
  DEFAULT_UI_CONFIG,
  Config,
} = await import("../../src/server/config/interface.ts");

const {
  panelAnchorForPosition,
  Z_INDEX_BASE_MIN,
  Z_INDEX_BASE_MAX,
  panelZIndexFor,
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  clampPointToViewport,
  MIDDLEWARE_GLOBAL_ROOT,
} = await import("../../src/shared/interface.ts");

const { findProjectRoot, normalizedProjectRoot } =
  await import("../../src/server/workspace/interface.ts");

const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

const { ROUTES } = await import("../../src/server/api/interface.ts");

// 临时目录 / manager / timer 收口：用例结束后统一清理，防产物与句柄泄漏。
let tempDirs: string[] = [];

let trackedManagers: McpManagerType[] = [];

let trackedTimers: Array<ReturnType<typeof setTimeout>> = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(markerFreeTempParent(), prefix));
  tempDirs.push(dir);
  return dir;
}

function trackManager(manager: McpManagerType) {
  trackedManagers.push(manager);
  return manager;
}

// ------------------------------------------------------------ 池装载夹具（#767 S1-4d）
// 换引擎后中间层不再自建 transport/client：远端条目一律经 lifecycle 域装载官方实例。本文件
// 的池用例必须走这条真链路（假 loader 不 spawn 子进程，全离线），故在工厂里装一次六键端口。
// id 表按 (scope, name) 稳定分配——「跨 root 同名各自成条」正靠它（与 unit-lifecycle-mount 同形）。

/** 假 id 表：按 (scope, name) 稳定返回并自增（mirror lifecycle-mount.test.ts 的同名夹具）。 */
function fakeIdTable() {
  const byKey = new Map<string, string>();
  let seq = 0;
  return {
    idFor(scope: string, name: string) {
      const key = scope + "\u0000" + name;
      let id = byKey.get(key);
      if (id === undefined) {
        seq += 1;
        id = "id-" + seq;
        byKey.set(key, id);
      }
      return id;
    },
  };
}

/** 被测的官方插件模块面：apply 由官方引擎调，本域只把它当不透明模块转交。 */
const OFFICIAL_MODULE = { name: "test:official", apply: () => {} };

/** 装载 ready 时序由用例改这里的 ready（fakeLoaderPort 在每次 mount 时现读）。 */
let loaderScript: FakeLoaderScript;

let poolLoader: ReturnType<typeof fakeLoaderPort> | undefined;

let poolToolsView: () => FakeToolEntry[] = () => [];

let lifecycleInstalled = false;

/** 装配池装载链路（幂等：一个用例里建多个 manager 只装一次，afterEach 统一释放）。 */
function installPoolLifecycle() {
  if (lifecycleInstalled) return;
  loaderScript = {
    modules: { [OFFICIAL_MCP_CLIENT_SPECIFIER]: OFFICIAL_MODULE },
    ready: "immediate",
  };
  poolLoader = fakeLoaderPort(loaderScript);
  // 结构形状假件（只实现装载链触达的面）：按本文件既有接缝收窄为端口面。
  installLifecycle({
    loader: poolLoader as unknown as LoaderPort,
    pipeline: { withTimeout },
    workspace: fakeIdTable(),
    config: { expandServerEnv },
    tools: {
      // 委托到「当前 manager 的工具服务」：装载窗口的 hasTools 必须与用例看见的注册面同一份。
      schemas: () => poolToolsView(),
    } as unknown as ToolsRegistryPort,
    logs: fakeLogsPort() as unknown as LogsPort,
  });
  lifecycleInstalled = true;
}

/**
 * summary 诊断投影面（Record 形态）：测试读取 servers/counts/cwd，不断言完整类型。
 * 键集事实源是 api 健康/摘要写出口（R6 逐字断言另有其处），此处只给读面。
 */
function summaryView(manager: McpManagerType): {
  servers: Array<{
    name: string;
    status?: unknown;
    scope?: unknown;
    tools?: Array<{ tool: string }>;
  }>;
  counts: { connected: number; disabled: number };
  cwd: unknown;
} {
  return manager.summary() as unknown as {
    servers: Array<{
      name: string;
      status?: unknown;
      scope?: unknown;
      tools?: Array<{ tool: string }>;
    }>;
    counts: { connected: number; disabled: number };
    cwd: unknown;
  };
}

/**
 * summarize 单条投影面（Record 形态）：测试读取 status/tools/error/scope，不断言完整类型。
 * 单条恒含 status（投影必落状态，无状态即 stopped 兜底）；tools 恒为数组。
 */
function summarizeOf(
  manager: McpManagerType,
  server: ServerConfig,
  scope: string,
): {
  status: unknown;
  tools: string[];
  error: unknown;
  scope: unknown;
  disabledTools?: string[];
} {
  return manager.summarize(server, scope) as unknown as {
    status: unknown;
    tools: string[];
    error: unknown;
    scope: unknown;
    disabledTools?: string[];
  };
}

/** 在独立沙箱目录内执行（DSH_HOME 原值恢复，目录删除）。 */
async function inRootSandbox(body: (dir: string) => unknown) {
  const prevHome = process.env.DSH_HOME;
  const dir = makeTempDir("dsh-mcp-root-");
  try {
    return await body(dir);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

// manager 工厂 ----

function makeManager(dir: string, poolTools: FakeToolEntry[] = []) {
  const log: {
    registered: unknown[];
    disposed: unknown[];
    info: string[];
    warn: string[];
    error: string[];
    catalog: unknown[];
  } = { registered: [], disposed: [], info: [], warn: [], error: [], catalog: [] };
  const store = new McpStore(join(dir, "global.json"));
  store.data = { version: 1, servers: [] };
  // 最小假宿主上下文（构造器只读 ctx.logger；日志面保留可断言的收集）：按既有接缝收窄。
  const manager = new McpManager(
    {
      logger: {
        info: (m: string) => log.info.push(m),
        warn: (m: string) => log.warn.push(m),
        error: (m: string) => log.error.push(m),
      },
    } as unknown as Context,
    store,
  );
  // 工具服务面（register + schemas）与生命周期域共用同一份：池的六态投影读注册面前缀，
  // 装载窗口的 hasTools 也必须读同一份，否则「已连上」的两处判据会分裂。
  const tools = fakeToolsService({ schemas: poolTools });
  // 同一份工具服务挂回顾问：池投影与装载窗口读同一注册面（判据分裂防线），类型面按接缝收窄。
  manager.ctx.tools = tools as unknown as Context["tools"];
  log.registered = tools.registered;
  log.disposed = tools.disposed;
  poolToolsView = () => tools.schemas();
  installPoolLifecycle();
  return { manager: trackManager(manager), store, log };
}

const quietServer = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: "stdio",
  command: "dsh-noop-cmd",
  reconnect: { enabled: false },
  ...extra,
});

function managerFixture(prefix = "dsh-mcp-mgr2a-") {
  const dir = makeTempDir(prefix);
  return { dir, ...makeManager(dir) };
}
export function setPoolToolsView(view: () => FakeToolEntry[]) {
  poolToolsView = view;
}
export {
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  buildConfigUiPatch,
  clampPointToViewport,
  Config,
  DEFAULT_UI_CONFIG,
  fakeIdTable,
  findProjectRoot,
  inRootSandbox,
  installPoolLifecycle,
  lifecycleInstalled,
  loaderScript,
  makeHealthRoute,
  makeManager,
  makeTempDir,
  managerFixture,
  McpManager,
  McpMiddleware,
  McpStore,
  MIDDLEWARE_GLOBAL_ROOT,
  normalizedProjectRoot,
  normalizeServer,
  normalizeUiConfig,
  OFFICIAL_MODULE,
  panelAnchorForPosition,
  panelTopForAnchor,
  panelZIndexFor,
  poolLoader,
  poolToolsView,
  quietServer,
  registerMiddlewareTools,
  ROUTES,
  SERVER_NAME_PATTERN,
  summarizeOf,
  summaryView,
  tempDirs,
  trackedManagers,
  trackedTimers,
  trackManager,
  Z_INDEX_BASE_MAX,
  Z_INDEX_BASE_MIN,
};
export function setupManagerTestLifecycle() {
  beforeAll(() => {
    installCompositionPorts();
  });

  afterAll(() => {
    releaseCompositionPorts();
  });

  afterEach(async () => {
    for (const manager of trackedManagers) {
      // 连接收口全走账本（releaseServer → 句柄 dispose）：manager.dispose() 逐单元拆除即可，
      // 旧栈那套 transport.close() / clearTimeout(reconnectTimer) 的直操作随字段删除一并消失。
      try {
        await manager.dispose();
      } catch {
        // 收口失败不掩盖用例结论
      }
    }
    trackedManagers = [];
    for (const timer of trackedTimers) clearTimeout(timer);
    trackedTimers = [];
    if (lifecycleInstalled) {
      releaseLifecycle();
      // deferred 时序下装载窗口仍挂起：不放闸，窗口内那个 10s 超时定时器会拖住 worker。
      poolLoader?.settleReady();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await mountLedger.flushDisposals();
      lifecycleInstalled = false;
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });
}
