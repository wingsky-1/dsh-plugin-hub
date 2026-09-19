/**
 * dsh-mcp-manager — unit：McpManager 方法面 / normalize 家族 / apply 配置分支。
 *
 * 覆盖：
 * - normalizeServer：名称/传输/command/url 校验、timeout clamp、description trim、
 *   args/env/headers 映射、enabled/reconnect 默认
 * - normalizeUiConfig 三形态兼容与非法回退、buildConfigUiPatch、panelAnchor /
 *   panelTop 定位函数
 * - findProjectRoot：.git / .dsh(排除全局家) / .mcp.json 标记、向上遍历、无标记回落
 * - #770 B2：symlink 双拼写经 normalizedProjectRoot 收敛同一项目根（store/单元不分裂）、不存在路径回退不抛
 * - McpManager：uiConfig/updateUiConfig、目录缓存读写、onStatus、项目 store 缓存、
 *   catalogServersFor、setSession 幂等与切换、refreshFromDisk、reconcileServers
 *   各分支、start/stop/connect/disconnect/reconnect、summary/summarize、dispose
 * - #903 M4/M5-A：fire-and-forget 拒绝记 warn、projectStoreFor 缓存命中同样 settle
 * - apply：enabled:false / announceToAgent:false / announceCatalog:false 分支、
 *   settings 注入 uiUpdate、effect disposer
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoGrowth,
  fakeLoaderPort,
  fakeLogsPort,
  fakeToolsService,
  pollUntil,
} from "../helpers.ts";
import type { FakeLoaderScript, FakeToolEntry } from "../helpers.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";
import type { LoaderPort, LogsPort } from "../../src/server/shared/interface.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { ToolsRegistryPort } from "../../src/server/servers/lifecycle/deps.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { ConnectionEntry } from "../../src/server/connection/runtime/interface.ts";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { McpManagerService } from "../../src/shared/interface.ts";
import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import { OFFICIAL_MCP_CLIENT_SPECIFIER } from "../../src/server/shared/interface.ts";
import {
  installLifecycle,
  mountLedger,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";

// S6-B2：McpManager 构造/apply/路由装配是装配依赖，留包根；其余纯符号改道域门面。
const { apply, McpManager, McpMiddleware, makeHealthRoute } = await import("../../src/index.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const {
  normalizeServer,
  normalizeUiConfig,
  buildConfigUiPatch,
  panelTopForAnchor,
  SERVER_NAME_PATTERN,
  DEFAULT_UI_CONFIG,
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
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function trackManager(manager: McpManagerType) {
  trackedManagers.push(manager);
  return manager;
}

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

// ------------------------------------------------------------ 池装载夹具（#767 S1-4d）
// 换引擎后中间层不再自建 transport/client：远端条目一律经 lifecycle 域装载官方实例。本文件
// 的池用例必须走这条真链路（假 loader 不 spawn 子进程，全离线），故在工厂里装一次六键端口。
// id 表按 (scope, name) 稳定分配——「跨 root 同名各自成条」正靠它（与 unit-lifecycle-mount 同形）。

/** 假 id 表：按 (scope, name) 稳定返回并自增（mirror unit-lifecycle-mount.test.ts 的同名夹具）。 */
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

describe("normalizeServer", () => {
  const fullInput = () => ({
    name: "  web  ",
    transport: "streamable-http",
    url: "http://localhost:9/mcp ",
    headers: { A: 1 },
    toolCallTimeoutMs: 2500.9,
    description: "  custom desc  ",
    reconnect: { maxAttempts: 3 },
  });
  const full = () => normalizeServer(fullInput());
  const stdio = () =>
    normalizeServer({
      name: "s",
      transport: "stdio",
      command: " npx ",
      args: [1, "x"],
      cwd: "/w",
      env: { K: null },
    });
  const bare = () => normalizeServer({ name: "b", transport: "stdio", command: "x" });

  it("SERVER_NAME_PATTERN 是锚定正则", () => {
    expect(SERVER_NAME_PATTERN.source).toMatch(/\^/);
  });

  it("name trim", () => {
    expect(full().name).toBe("web");
  });

  it("transport 透传", () => {
    expect(full().transport).toBe("streamable-http");
  });

  it("url 不 trim（原样保留）", () => {
    expect(full().url).toBe("http://localhost:9/mcp ");
  });

  it("headers 值 String 化", () => {
    expect(full().headers).toEqual({ A: "1" });
  });

  it("正数 timeout floor", () => {
    expect(full().toolCallTimeoutMs).toBe(2500);
  });

  it("description trim", () => {
    expect(full().description).toBe("custom desc");
  });

  it("reconnect 透传", () => {
    expect(full().reconnect).toEqual({ maxAttempts: 3 });
  });

  it("enabled 默认 true", () => {
    expect(full().enabled).toBe(true);
  });

  it("stdio command 不 trim（保留空白）", () => {
    expect(stdio().command).toBe(" npx ");
  });

  it("stdio args String 化", () => {
    expect(stdio().args).toEqual(["1", "x"]);
  });

  it("stdio cwd 透传", () => {
    expect(stdio().cwd).toBe("/w");
  });

  it("stdio env 值 String 化", () => {
    expect(stdio().env).toEqual({ K: "null" });
  });

  it("缺省 toolCallTimeoutMs 为数字", () => {
    expect(typeof bare().toolCallTimeoutMs).toBe("number");
  });

  it("缺省 toolCallTimeoutMs 为正", () => {
    // normalizeServer 恒补齐默认超时（被测契约），此处断言存在。
    expect(bare().toolCallTimeoutMs! > 0).toBeTruthy();
  });

  it("缺省 reconnect 为空对象", () => {
    expect(bare().reconnect).toEqual({});
  });

  it("缺省 description 为 undefined", () => {
    expect(bare().description).toBeUndefined();
  });

  it("缺省 args 为 undefined", () => {
    expect(bare().args).toBeUndefined();
  });

  it("非对象入参抛 must be an object", () => {
    expect(() => normalizeServer("str")).toThrow(/must be an object/);
  });

  it("null 入参抛 must be an object", () => {
    expect(() => normalizeServer(null)).toThrow(/must be an object/);
  });

  it("缺 name 抛 server name must match", () => {
    expect(() => normalizeServer({ transport: "stdio" })).toThrow(/server name must match/);
  });

  it("非法 name 抛 server name must match", () => {
    expect(() => normalizeServer({ name: "bad name!" })).toThrow(/server name must match/);
  });

  it("缺 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n" })).toThrow(/transport must be/);
  });

  it("非法 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n", transport: "rpc" })).toThrow(/transport must be/);
  });

  it("stdio 缺 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio" })).toThrow(/requires a command/);
  });

  it("stdio 空白 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio", command: "   " })).toThrow(
      /requires a command/,
    );
  });

  it("http 缺 url 抛 requires a url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http" })).toThrow(
      /requires a url/,
    );
  });

  it("http 非法 url 抛 invalid url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http", url: "::::" })).toThrow(
      /invalid url/,
    );
  });

  // timeout 非法回退默认（0/负数/NaN）。
  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为正数", (bad) => {
    const s = normalizeServer({
      name: "t",
      transport: "stdio",
      command: "x",
      toolCallTimeoutMs: bad,
    });
    expect(s.toolCallTimeoutMs! > 0).toBe(true);
  });

  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为有限数", (bad) => {
    const s = normalizeServer({
      name: "t",
      transport: "stdio",
      command: "x",
      toolCallTimeoutMs: bad,
    });
    expect(Number.isFinite(s.toolCallTimeoutMs)).toBe(true);
  });
});

describe("normalizeUiConfig / buildConfigUiPatch / panel 定位", () => {
  it("新嵌套形态归一", () => {
    expect(
      normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 1.6, y: -3, blankY: 0 } } }),
    ).toEqual({
      position: "bottom-right",
      offsetX: 2,
      offsetY: 0,
      blankY: 0,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("旧扁平 offset 形态归一", () => {
    expect(normalizeUiConfig({ position: "top-right", offset: { x: 7, y: 8, blankY: 9 } })).toEqual(
      {
        position: "top-right",
        offsetX: 7,
        offsetY: 8,
        blankY: 9,
        zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
      },
    );
  });

  it("客户端扁平 offsetX 形态优先于 offset.*", () => {
    expect(
      normalizeUiConfig({
        offsetX: 11,
        offsetY: 12,
        blankY: 13,
        offset: { x: 1, y: 2, blankY: 3 },
      }),
    ).toEqual({
      position: "top-right",
      offsetX: 11,
      offsetY: 12,
      blankY: 13,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  // #128 四角锚点透传 + zIndexBase clamp 边界（非法回退默认 / 越界压边界）。
  it.each(["top-left", "bottom-left"])("四角 %s 透传", (position) => {
    expect(normalizeUiConfig({ position }).position).toBe(position);
  });

  it("合法层级基准透传", () => {
    expect(normalizeUiConfig({ zIndexBase: 5000 }).zIndexBase).toBe(5000);
  });

  it("低于下界压到 1", () => {
    expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase).toBe(Z_INDEX_BASE_MIN);
  });

  it("超上界压到 9000", () => {
    expect(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase).toBe(Z_INDEX_BASE_MAX);
  });

  it("非数字回退默认", () => {
    expect(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("子浮层派生扩展点 base+30（B5）", () => {
    expect(panelZIndexFor(10)).toBe(40);
  });

  it("undefined 回退默认", () => {
    expect(normalizeUiConfig(undefined)).toEqual({
      position: DEFAULT_UI_CONFIG.position,
      offsetX: DEFAULT_UI_CONFIG.offset.x,
      offsetY: DEFAULT_UI_CONFIG.offset.y,
      blankY: DEFAULT_UI_CONFIG.offset.blankY,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("字符串输入回退默认", () => {
    expect(normalizeUiConfig("junk")).toEqual({
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    });
  });

  it("非法 position + 非有限 offset 回退默认", () => {
    expect(normalizeUiConfig({ position: "left", offsetX: Number.NaN, offsetY: Infinity })).toEqual(
      {
        position: "top-right",
        offsetX: 8,
        offsetY: 8,
        blankY: 40,
        zIndexBase: 10,
      },
    );
  });

  it("ui 非对象按顶层处理", () => {
    expect(normalizeUiConfig({ ui: 5 }).offsetX).toBe(8);
  });

  it("buildConfigUiPatch 组装嵌套 patch", () => {
    expect(
      buildConfigUiPatch({
        position: "bottom-right",
        offsetX: 4,
        offsetY: 5,
        blankY: 6,
        zIndexBase: 20,
      }),
    ).toEqual({
      position: "bottom-right",
      offset: { x: 4, y: 5, blankY: 6 },
      zIndexBase: 20,
    });
  });

  it("panelAnchorForPosition bottom-right", () => {
    expect(panelAnchorForPosition("bottom-right")).toBe("bottom");
  });

  it("#128 左下也是底部锚点", () => {
    expect(panelAnchorForPosition("bottom-left")).toBe("bottom");
  });

  it("panelAnchorForPosition top-right", () => {
    expect(panelAnchorForPosition("top-right")).toBe("top");
  });

  it("#128 左上是顶部锚点", () => {
    expect(panelAnchorForPosition("top-left")).toBe("top");
  });

  it("panelAnchorForPosition undefined 回落 top", () => {
    expect(panelAnchorForPosition(undefined)).toBe("top");
  });

  // #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）。
  it("320 宽归 narrow", () => {
    expect(breakpointForWidth(320)).toBe("narrow");
  });

  it("480 边界归 narrow", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX)).toBe("narrow");
  });

  it("481 翻转 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1)).toBe("tablet");
  });

  it("834 边界归 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX)).toBe("tablet");
  });

  it("835 翻转 wide", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1)).toBe("wide");
  });

  it("异常宽度按宽档兜底", () => {
    expect(breakpointForWidth(Number.NaN)).toBe("wide");
  });

  it("负坐标钳回视口原点", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667)).toEqual({ x: 0, y: 0 });
  });

  it("右/下溢出钳回视口内", () => {
    expect(clampPointToViewport(400, 700, 100, 80, 375, 667)).toEqual({ x: 275, y: 587 });
  });

  it("safeInset>0 时按安全区内缩", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10)).toEqual({ x: 10, y: 10 });
  });

  it("bottom 锚点向上弹", () => {
    expect(panelTopForAnchor("bottom", 100, 120, 50, 10)).toBe(40);
  });

  it("bottom 溢出 clamp 到 6", () => {
    expect(panelTopForAnchor("bottom", 20, 30, 50, 10)).toBe(6);
  });

  it("top 锚点向下弹", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 10)).toBe(130);
  });

  it("top 锚点无安全区偏移", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 0)).toBe(120);
  });
});

describe("findProjectRoot", () => {
  /** 沙箱顶棚：dir/.git 必先命中，防止向上逸出到真实仓库/真实家目录。 */
  async function withSandbox(body: (dir: string, fakeHome: string) => unknown) {
    return inRootSandbox(async (dir: string) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      const fakeHome = join(dir, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      return body(dir, fakeHome);
    });
  }

  it(".git 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const gitProj = join(dir, "git-proj");
      mkdirSync(join(gitProj, ".git"), { recursive: true });
      expect(await findProjectRoot(gitProj)).toBe(gitProj);
    });
  });

  it(".mcp.json 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const mcpProj = join(dir, "mcp-proj");
      mkdirSync(mcpProj, { recursive: true });
      writeFileSync(join(mcpProj, ".mcp.json"), "{}");
      expect(await findProjectRoot(mcpProj)).toBe(mcpProj);
    });
  });

  it(".dsh 非 home 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const dshProj = join(dir, "dsh-proj");
      mkdirSync(join(dshProj, ".dsh"), { recursive: true });
      expect(await findProjectRoot(dshProj)).toBe(dshProj);
    });
  });

  it("全局家不算项目标记", async () => {
    // 全局家排除：模拟 ~ 下含 .dsh（= DSH_HOME），其子目录向上命中家级 .dsh 应跳过，
    // 继续向上命中顶棚 dir/.git（若误判家级 .dsh 为项目标记则返回 fake-user-home）。
    await withSandbox(async (dir: string) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      const inHome = join(fakeUserHome, "sub");
      mkdirSync(inHome, { recursive: true });
      expect(await findProjectRoot(inHome)).toBe(dir);
    });
  });

  it("家目录自身不算项目标记", async () => {
    // cwd 恰为家目录本身：家级 .dsh 不算自身标记 → 越过它命中顶棚。
    await withSandbox(async (dir: string) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      expect(await findProjectRoot(fakeDshHome)).toBe(dir);
    });
  });

  it("无标记普通目录向上命中顶棚", async () => {
    await withSandbox(async (dir: string) => {
      const plain = join(dir, "plain");
      mkdirSync(plain, { recursive: true });
      expect(await findProjectRoot(plain)).toBe(dir);
    });
  });

  it("16 级窗口内无标记 → 回落 cwd", async () => {
    // 回落 cwd：输入嵌套 16 级，向上窗口（16 层）不出沙箱、够不到任何标记 → 原样返回。
    await withSandbox(async (dir: string) => {
      let deep = dir;
      for (let i = 0; i < 16; i += 1) deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
      expect(await findProjectRoot(deep)).toBe(deep);
    });
  });

  it("undefined cwd → process.cwd() 兜底", async () => {
    await withSandbox(async () => {
      const fallback = await findProjectRoot(undefined);
      expect(typeof fallback).toBe("string");
    });
  });
});

// #770 B2：symlink 双拼写收敛到同一项目根 ----
describe("#770 B2：symlink 双拼写收敛到同一项目根", () => {
  /** 双拼写夹具：real-proj（.git 真实标记）+ link-proj（目录 symlink）。
   *  落盘全在 mkdtemp 内，afterEach 经 rmSync 收口，不留产物。 */
  async function symlinkFixture(
    body: (args: {
      base: string;
      realProj: string;
      linkProj: string;
      realCwd: string;
      linkCwd: string;
    }) => unknown,
  ) {
    const prevHome = process.env.DSH_HOME;
    const base = makeTempDir("dsh-mcp-symlink-");
    try {
      const fakeHome = join(base, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      const realProj = join(base, "real-proj");
      mkdirSync(join(realProj, ".git"), { recursive: true });
      mkdirSync(join(realProj, "sub"), { recursive: true });
      const linkProj = join(base, "link-proj");
      symlinkSync(realProj, linkProj, "dir");
      return await body({
        base,
        realProj,
        linkProj,
        realCwd: join(realProj, "sub"),
        linkCwd: join(linkProj, "sub"),
      });
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  }

  it("symlink 拼写仍发现同一项目", async () => {
    await symlinkFixture(async ({ realProj, linkCwd }) => {
      // 两侧 realpath 对比：发现透过 symlink 不丢标记，只拼写不同。
      expect(realpathSync(await findProjectRoot(linkCwd))).toBe(realpathSync(realProj));
    });
  });

  it("双拼写 normalizedProjectRoot 相等且为 real 路径", async () => {
    await symlinkFixture(async ({ realProj, realCwd, linkCwd }) => {
      const fromReal = await normalizedProjectRoot(realCwd);
      const fromLink = await normalizedProjectRoot(linkCwd);
      expect(fromLink).toBe(fromReal);
      expect(fromLink).toBe(realpathSync(realProj));
    });
  });

  it("双拼写 projectStoreFor 同一实例", async () => {
    await symlinkFixture(async ({ realCwd, linkCwd }) => {
      const { manager } = managerFixture("dsh-mcp-symlink-store-");
      const rootA = await normalizedProjectRoot(realCwd);
      const rootB = await normalizedProjectRoot(linkCwd);
      const first = await manager.projectStoreFor(rootA);
      const second = await manager.projectStoreFor(rootB);
      // 反证：realpath 换回 resolve 则两侧键不同，toBe 红。
      expect(second).toBe(first);
    });
  });

  it("双拼写 projectUnitFor 只建一个单元", async () => {
    await symlinkFixture(async ({ realCwd, linkCwd }) => {
      installPoolLifecycle();
      const tools = fakeToolsService({});
      poolToolsView = () => tools.schemas();
      const host = {
        ctx: { tools },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        projectServersFor: async () => [],
        globalServers: () => [],
        normalizedProjectRoot: async (cwd: string | undefined) =>
          typeof cwd === "string" && cwd !== "" ? cwd : undefined,
        saveUserState: async () => {},
        emitStatus: () => {},
        catalogCachePath: (root: string) => join(root, ".dsh-mcp-symlink-test.json"),
      };
      const rootA = await normalizedProjectRoot(realCwd);
      const rootB = await normalizedProjectRoot(linkCwd);
      const mw = new McpMiddleware(host as unknown as MiddlewareHost);
      try {
        const unitA = await mw.projectUnitFor(rootA);
        const unitB = await mw.projectUnitFor(rootB);
        // 反证：realpath 换回 resolve 则建出两个单元，size 红。
        expect(unitB).toBe(unitA);
        expect(mw.units.size).toBe(1);
      } finally {
        if (rootA !== undefined) catalogDirectory.dropRoot(rootA);
        try {
          await mw.dispose();
        } catch {
          // 收口失败不掩盖用例结论
        }
      }
    });
  });

  it("不存在 cwd 回退不抛", async () => {
    const prevHome = process.env.DSH_HOME;
    const base = makeTempDir("dsh-mcp-symlink-missing-");
    try {
      const fakeHome = join(base, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      // 16 级窗口内无标记：findProjectRoot 回落不存在路径，realpath 抛错由 catch 接住。
      let missing = base;
      for (let i = 0; i < 16; i += 1) missing = join(missing, `d${i}`);
      // 反证：catch 删掉则此处抛 ENOENT 红。
      await expect(normalizedProjectRoot(missing)).resolves.toBe(resolve(missing));
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});

// #767 S1-5b 笔 2（B4 对账）：装载路径的两条缺口服役 ----
// 缺口一（R4）：catalogCache 的写入此前只有「夹具直接 seed」与「方法级直调 recordCatalogTools」
// 两类用例，缺「挂载结算自动写入」这半边（生产侧在 manager.ts 的 mountEntry 结算分支）。
// 缺口二（R6）：/health 的顶层 payload 键集全仓零处断言，且既有 health 夹具是手工塞 map。
// 两条都走真链路：真 McpManager + 真 lifecycle + 假 loader（不 spawn 子进程，全离线）。
describe("#767 S1-5b：装载路径的 catalogCache 与 /health 口径", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2ld-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** health 路由的最小请求面：只给 isLoopbackRequest + guardLoopbackMethod 要的字段。 */
  // 最小请求面（只给路由实际读取的字段）：按接缝收窄。
  function healthReq(): IncomingMessage {
    return {
      method: "GET",
      url: ROUTES.health,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3080" },
    } as unknown as IncomingMessage;
  }

  function healthRes(): ServerResponse & { state: { status: number; body: string } } {
    const state: { status: number; body: string } = { status: 0, body: "" };
    return {
      state,
      writeHead(status: number) {
        state.status = status;
      },
      end(body: string) {
        state.body = body;
      },
    } as unknown as ServerResponse & { state: { status: number; body: string } };
  }

  /** 装一台全局服务器：经 lifecycle 真装载挂载，id 由假 id 表分配（单池：落 @global 单元）。 */
  async function mountedGlobalFixture() {
    const entry = { name: "mcp__id-1__echo", description: "回显给定的文本" };
    // 注册面必须在装载前就含该工具：挂载结算那一刻读的是注册面，事后补不进账本。
    const { manager } = makeManager(homeDir, [entry]);
    await manager.initMiddleware();
    await manager.registerServer({ ...quietServer("gn"), enabled: true });
    await pollUntil("全局服务器装载结算且注册面命中", () =>
      manager.registeredToolsFor("gn").some((tool) => tool.name === entry.name),
    );
    return { manager, entry };
  }

  it("R4：挂载结算自动把工具描述摘要写进 catalogCache", async () => {
    const { manager, entry } = await mountedGlobalFixture();
    // 判据先证明工具确实来自装载（不是夹具塞的），再看缓存。单池（#767 笔 1a）：
    // 工具面从池条目（单元 id + 注册面）取——旧直连账本 manager.supervisors 已退役。
    expect(manager.registeredToolsFor("gn").map((tool) => tool.name)).toEqual([entry.name]);
    expect(manager.catalogCache.get("gn")?.summary).toContain("回显给定的文本");
  });

  it("R6：/health 在 1 台挂载全局服务器下计数正确且顶层键集逐字相等", async () => {
    const { manager } = await mountedGlobalFixture();
    const res = healthRes();
    makeHealthRoute(manager).handler(healthReq(), res);
    expect(res.state.status, "health 200").toBe(200);
    const payload = JSON.parse(res.state.body);
    // 单池（#767 笔 1a）：三计数与 middleware 子对象都按池单元表聚合（该服务器在 @global 单元）。
    expect(payload.servers, "1 台服务器").toBe(1);
    expect(payload.connected, "已连接 1 台").toBe(1);
    expect(payload.tools, "工具计数").toBe(1);
    // 顶层键集逐字相等：键集事实源在 api/routes.ts 的 health 写出口。少键（诊断面丢字段）或多键
    // （把内部状态泄漏给诊断接口）都红，toMatchObject 这类子集断言抓不到这两类。
    expect(Object.keys(payload)).toEqual([
      "ok",
      "plugin",
      "servers",
      "connected",
      "tools",
      "catalogCacheEntries",
      "middleware",
    ]);
  });
});

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

// uiConfig / updateUiConfig / 目录缓存 ----
describe("uiConfig / updateUiConfig / 目录缓存", () => {
  it("uiConfig 默认值", () => {
    const { manager } = managerFixture();
    expect(manager.uiConfig()).toEqual({
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    });
  });

  it("写不可用抛错（not writable）", async () => {
    const { manager } = managerFixture();
    await expect(manager.updateUiConfig({})).rejects.toThrow(/not writable/);
  });

  function writableFixture() {
    const fixture = managerFixture();
    let captured: unknown;
    fixture.manager.uiUpdate = async (patch) => {
      captured = patch;
      // ui 形态由调用方保证（本用例传入完整 ui 面），此处按测试前置收窄。
      const ui = patch.ui as {
        position: unknown;
        offset: { x: unknown; y: unknown; blankY: unknown };
        zIndexBase: unknown;
      };
      // 模拟 settings 落盘后 setSource 更新（apply 内 installSettingsNamespace 行为）。
      fixture.manager.uiConfigSource = () => ({
        position: ui.position,
        offsetX: ui.offset.x,
        offsetY: ui.offset.y,
        blankY: ui.offset.blankY,
        zIndexBase: ui.zIndexBase,
      });
    };
    return { ...fixture, captured: () => captured };
  }

  it("patch 归一化传递", async () => {
    const { manager, captured } = writableFixture();
    await manager.updateUiConfig({
      position: "bottom-right",
      offsetX: 3.4,
      offsetY: -1,
      blankY: 100,
    });
    expect(captured()).toEqual({
      ui: { position: "bottom-right", offset: { x: 3, y: 0, blankY: 100 }, zIndexBase: 10 },
    });
  });

  it("updateUiConfig 返回最新配置", async () => {
    const { manager } = writableFixture();
    const written = await manager.updateUiConfig({
      position: "bottom-right",
      offsetX: 3.4,
      offsetY: -1,
      blankY: 100,
    });
    expect(written).toEqual({
      position: "bottom-right",
      offsetX: 3,
      offsetY: 0,
      blankY: 100,
      zIndexBase: 10,
    });
  });

  it("loadCatalogCache：缺失文件静默", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "no-such-cache.json");
    await manager.loadCatalogCache();
    expect(manager.catalogCache.size).toBe(0);
  });

  it("仅字符串 summary 入缓存", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    writeFileSync(
      manager.catalogCachePath,
      JSON.stringify({ version: 1, entries: { a: { summary: "sa" }, b: { summary: 5 }, c: {} } }),
    );
    await manager.loadCatalogCache();
    expect([...manager.catalogCache.entries()]).toEqual([["a", { summary: "sa" }]]);
  });

  it("损坏文件忽略", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    writeFileSync(manager.catalogCachePath, "{broken");
    manager.catalogCache.clear();
    await manager.loadCatalogCache();
    expect(manager.catalogCache.size).toBe(0);
  });

  it("recordCatalogTools 更新摘要", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-a" }]]));
    // recordCatalogTools 刚写入该键，此处断言存在。
    expect(manager.catalogCache.get("srv")!.summary).toBe("desc-a");
  });

  it("摘要变化落盘", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    expect(existsSync(manager.catalogCachePath)).toBeTruthy();
  });

  function statSafe(p: string) {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  }

  it("相同摘要不再落盘", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    const before = statSafe(manager.catalogCachePath);
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    expect(statSafe(manager.catalogCachePath)).toBe(before);
  });

  it("全空白摘要短路不覆盖", async () => {
    const { manager, dir } = managerFixture();
    manager.catalogCachePath = join(dir, "cache.json");
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "desc-b" }]]));
    await manager.recordCatalogTools("srv", new Map([["t1", { description: "   " }]]));
    expect(manager.catalogCache.get("srv")!.summary).toBe("desc-b");
  });

  it("写入失败触发 logger.warn", async () => {
    const { manager, dir, log } = managerFixture();
    // 写入失败 warn（路径是目录制造 rename 失败）。
    mkdirSync(join(dir, "dir-as-file"), { recursive: true });
    manager.catalogCachePath = join(dir, "dir-as-file");
    const warnBefore = log.warn.length;
    await manager.recordCatalogTools("other", new Map([["x", { description: "y" }]]));
    expect(log.warn.length > warnBefore).toBeTruthy();
  });
});

// onStatus 订阅注销 ----
describe("onStatus 订阅注销", () => {
  it("注销后不再回调", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2b-");
    let count = 0;
    const off = manager.onStatus(() => {
      count += 1;
    });
    manager.emitStatus();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播 handler 落定（事件驱动）。
    await pollUntil("onStatus 广播落定", () => count === 1);
    off();
    // 注销后再广播：哨兵确认广播仍发生（事件驱动），原监听不再被调用。
    let sentinel = 0;
    const offSentinel = manager.onStatus(() => {
      sentinel += 1;
    });
    manager.emitStatus();
    await pollUntil("注销后广播仍发出", () => sentinel === 1);
    offSentinel();
    expect(count).toBe(1);
  });
});

// reconcileServers：增删/scope 切换/禁用/busy 重入 ----
describe("reconcileServers", () => {
  /** 触达一台全局服务器并等它进 @global 单元（单池后唯一账本是单元表）。 */
  async function withGlobalServer(name: string, extra: Record<string, unknown> = {}) {
    const fixture = managerFixture("dsh-mcp-mgr2c-");
    await fixture.manager.initMiddleware();
    fixture.store.upsert(normalizeServer(quietServer(name, extra)));
    fixture.manager.reconcileServers();
    await pollUntil(
      `${name} 进 @global 单元`,
      () => fixture.manager.middleware!.units.get("@global")?.connections.has(name) ?? false,
    );
    return fixture;
  }

  it("首次同步把新服务器触达进池（@global 单元）", async () => {
    const { manager } = await withGlobalServer("g-one");
    expect(manager.middleware!.units.get("@global")!.connections.has("g-one")).toBe(true);
  });

  it("池内只有一条（单元表条目数）", async () => {
    const { manager } = await withGlobalServer("g-one");
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
  });

  it("池内条目带自己的 server 配置（单元 = 唯一事实源）", async () => {
    const { manager } = await withGlobalServer("g-one");
    // 刚触达的条目恒存在，此处断言存在。
    expect(manager.middleware!.units.get("@global")!.connections.get("g-one")!.server.name).toBe(
      "g-one",
    );
  });

  it("集合无变化不报变更", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    expect(manager.reconcileServers()).toBe(false);
  });

  it("busy 重入直接拒绝", () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("g-one")));
    manager.reconcileServers();
    manager.reconcileBusy = true;
    expect(manager.reconcileServers()).toBe(false);
  });

  async function withTwoServers() {
    const fixture = managerFixture("dsh-mcp-mgr2c-");
    await fixture.manager.initMiddleware();
    fixture.store.upsert(normalizeServer(quietServer("g-one")));
    fixture.manager.reconcileServers();
    fixture.store.upsert(normalizeServer(quietServer("g-off")));
    fixture.manager.reconcileServers();
    await pollUntil(
      "两台都进 @global 单元",
      () => fixture.manager.middleware!.units.get("@global")?.connections.size === 2,
    );
    return fixture;
  }

  it("g-off 进池后条目存在", async () => {
    const { manager } = await withTwoServers();
    expect(manager.middleware!.units.get("@global")!.connections.has("g-off")).toBeTruthy();
  });

  it("禁用已运行服务器报变更（释放一条池连接）", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    expect(manager.reconcileServers()).toBe(true);
  });

  it("禁用后池内条目移除（同单元其余不动）", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    expect(manager.middleware!.units.get("@global")!.connections.has("g-off")).toBe(false);
    expect(manager.middleware!.units.get("@global")!.connections.has("g-one")).toBe(true);
  });

  it("未运行的禁用项无变更", async () => {
    const { manager, store } = await withTwoServers();
    store.upsert(normalizeServer(quietServer("g-off", { enabled: false })));
    manager.reconcileServers();
    store.upsert(normalizeServer(quietServer("g-off2", { enabled: false })));
    expect(manager.reconcileServers()).toBe(false);
  });

  it("配置移除后池内条目同步移除", async () => {
    const { manager, store } = await withTwoServers();
    store.remove("g-one");
    store.remove("g-off");
    manager.reconcileServers();
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(0);
  });

  /** 全局 + 当前项目级各一台同名服务器（同名跨 root 是本笔的键形状判据）。 */
  async function withScopeDuplicate() {
    const { dir, manager, store, log } = managerFixture("dsh-mcp-mgr2c-");
    store.upsert(normalizeServer(quietServer("both")));
    manager.projectStore = new McpStore(join(dir, "proj.json"));
    // 上一行刚赋值，此处断言存在。
    manager.projectStore!.data.servers.push(
      normalizeServer({ ...quietServer("both"), command: "other" }),
    );
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    await manager.initMiddleware();
    manager.reconcileServers();
    await pollUntil("两个 root 各有一条 both", () => {
      return (
        manager.middleware!.units.get("@global")?.connections.has("both") === true &&
        manager.middleware!.units.get(dir)?.connections.has("both") === true
      );
    });
    return { manager, store, dir, log };
  }

  it("同名跨 root 各成一条（不再被全局顶掉）", async () => {
    const { manager, dir } = await withScopeDuplicate();
    expect(manager.middleware!.units.get("@global")!.connections.has("both")).toBe(true);
    expect(manager.middleware!.units.get(dir)!.connections.has("both")).toBe(true);
  });

  it("同名跨 root 各拿独立注册名（id 不同）", async () => {
    const { manager, dir } = await withScopeDuplicate();
    const globalEntry = manager.middleware!.units.get("@global")!.connections.get("both")!;
    const projectEntry = manager.middleware!.units.get(dir)!.connections.get("both")!;
    expect(globalEntry.id).not.toBe(projectEntry.id);
  });

  it("同名跨 root：禁用项目级只拆项目那条（(root, 裸名) 键）", async () => {
    const { manager, store, dir } = await withScopeDuplicate();
    // 项目 store 里那条改成 disabled → 只有项目单元的条目该被释放。
    store.upsert(normalizeServer(quietServer("both")));
    // 项目 store 由 withScopeDuplicate 装配，此处断言存在。
    manager.projectStore!.data.servers = [
      normalizeServer({ ...quietServer("both"), command: "other", enabled: false }),
    ];
    manager.reconcileServers();
    expect(manager.middleware!.units.get(dir)!.connections.has("both")).toBe(false);
    expect(manager.middleware!.units.get("@global")!.connections.has("both")).toBe(true);
  });
});

// start / stop / startAll 边界 ----
describe("start / stop / startAll 边界", () => {
  it("start 未知名 no-op（无中间层实例就不建任何连接）", () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    manager.start("ghost");
    expect(manager.middleware, "未装配实例 → 无池").toBe(undefined);
  });

  it("无活动项目 root 时 project scope no-op", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    manager.start("any", "project");
    expect(manager.middleware!.units.size, "无项目 root → 不建单元").toBe(0);
  });

  it("startAll 把 svc 触达进池（@global 单元）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBe(true);
  });

  it("已有连接不重建（重复 start 不换代际）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    const existing = manager.middleware!.units.get("@global")!.connections.get("svc");
    manager.start("svc");
    expect(manager.middleware!.units.get("@global")!.connections.get("svc")).toBe(existing);
  });

  it("无中间层实例时 start 打 warn 且不建连接", () => {
    const { manager, store, log } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.start("svc");
    expect(manager.middleware, "不建连接池").toBe(undefined);
    expect(
      log.warn.some((m) => /中间层未就绪/.test(m)),
      "warn 可归因",
    ).toBeTruthy();
  });

  function withScopeDuplicate() {
    const { dir, manager, store, log } = managerFixture("dsh-mcp-mgr2d-");
    store.upsert(normalizeServer(quietServer("svc")));
    manager.projectStore = new McpStore(join(dir, "p-d.json"));
    manager.projectStore.upsert(normalizeServer(quietServer("svc")));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    return { manager, dir, log };
  }

  it("同名跨 root：全局与项目级各进各的单元（不再拒绝启动）", async () => {
    const { manager, dir } = withScopeDuplicate();
    await manager.initMiddleware();
    manager.start("svc", "global");
    manager.start("svc", "project");
    await pollUntil("两个单元各有一条 svc", () => {
      return (
        manager.middleware!.units.get("@global")?.connections.has("svc") === true &&
        manager.middleware!.units.get(dir)?.connections.has("svc") === true
      );
    });
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBe(true);
    expect(manager.middleware!.units.get(dir)!.connections.has("svc")).toBe(true);
  });

  it("同名跨 root：不再打 already registered in scope", async () => {
    const { manager, log } = withScopeDuplicate();
    await manager.initMiddleware();
    manager.start("svc", "global");
    manager.start("svc", "project");
    expect(log.warn.some((m) => /already registered in scope/.test(m))).toBe(false);
  });

  it("startAll 跳过后再启动 svc", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("svc")).toBeTruthy();
  });

  it("禁用不启动", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2d-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("svc")));
    manager.startAll();
    store.upsert(normalizeServer(quietServer("off", { enabled: false })));
    manager.startAll();
    await pollUntil(
      "svc 进 @global 单元",
      () => manager.middleware!.units.get("@global")?.connections.has("svc") ?? false,
    );
    expect(manager.middleware!.units.get("@global")!.connections.has("off")).toBe(false);
  });
});

// connect / disconnect / reconnect（manager 面） ----
describe("connect / disconnect / reconnect（manager 面）", () => {
  it("connect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.connect("ghost")).rejects.toThrow(/not found/);
  });

  it("connect 建立池内条目（@global 单元）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    expect(manager.middleware!.units.get("@global")!.connections.has("c-one")).toBeTruthy();
  });

  it("已连接重复 connect 不增数量（force 受控重建后仍是一条）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    // 已连接跳过：注册面带该 id 前缀 = 「已连上」（官方零状态 API，前缀是唯一正向证据）。
    // 刚 connect 的条目恒存在，此处断言存在。
    const connected = manager.middleware!.units.get("@global")!.connections.get("c-one")!;
    connected.id = "id-c-one";
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: "mcp__id-c-one__t" },
    ];
    await manager.connect("c-one");
    // 单池后 connect 恒走 force 受控重建（#412：半开卡 connected 也要能恢复），
    // 故条目**换代际**但仍只有一条——重复 connect 不会长出第二条。
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
    expect(manager.middleware!.units.get("@global")!.connections.has("c-one")).toBe(true);
  });

  it("disconnect 未知 no-op / 已知移除", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    await manager.disconnect("ghost");
    await manager.disconnect("c-one");
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(0);
  });

  it("disconnect 落 userDisabled（浮窗断开语义）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-one")));
    await manager.connect("c-one");
    await manager.disconnect("c-one");
    expect(manager.middleware!.units.get("@global")!.userDisabled.has("c-one")).toBe(true);
  });

  it("reconnect 未知抛 not found", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2e-");
    await expect(manager.reconnect("ghost")).rejects.toThrow(/not found/);
  });

  it("同名跨 root：connect(project) 不再抛 registered in scope", async () => {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2e-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("c-two")));
    manager.projectStore = new McpStore(join(dir, "p.json"));
    // 上一行刚赋值，此处断言存在。
    manager.projectStore!.data.servers.push(normalizeServer(quietServer("c-two")));
    manager.projectStores.set(dir, manager.projectStore);
    manager.projectRoot = dir;
    manager.start("c-two", "global");
    // 单池：单元键是 (root, 裸名)，同名跨 scope 各成一条——不再有跨 scope 拒绝。
    await manager.connect("c-two", "project");
    expect(manager.middleware!.units.get(dir)!.connections.has("c-two")).toBe(true);
  });
});

// #382 F2/F3/F4/F5：runtime 回退重连 + all 模式池接管 + 防双进程探测重试 ----
describe("#382 F2：runtime 回退重连", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("runtime 条目 reconnect 复活（F2 回退 runtimeRegistry）", async () => {
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    // F2：runtime 注入条目（不落 store）——reconnect 不再抛 not found，
    // 断开后按 runtimeRegistry 配置经 @global 单元复活（单池后唯一连接路径）。
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    await manager.reconnect("rt");
    expect(manager.middleware!.units.get("@global")!.connections.has("rt")).toBeTruthy();
  });

  it("F2 否定：project scope 不回退 runtime → not found", async () => {
    const { manager } = makeManager(homeDir);
    manager.runtimeRegistry.set("rt", normalizeServer(quietServer("rt")));
    // F2 否定：project scope 不回退 runtime（挂错 scope 会被下次 reconcile
    // 无声停掉）——runtime 条目按 project 查询照旧抛 not found。
    manager.projectStore = new McpStore(join(homeDir, "p.json"));
    await manager.projectStore.load();
    await expect(manager.connect("rt", "project")).rejects.toThrow(/not found/);
  });
});

describe("#382 F3/F4：all 模式池接管", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  async function allModeStarted() {
    const { manager, store, log } = makeManager(homeDir);
    // 单池（#767 笔 1a）：start 全局一律触达 @global 单元惰性连接，不注册 mcp__ 直呼工具。
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("g2")));
    manager.start("g2", "global");
    return { manager, store, log };
  }

  it("全局 start 后不存在第二本账（直连账本字段已整体退役）", async () => {
    const { manager } = await allModeStarted();
    expect("supervisors" in manager, "supervisors 字段已删").toBe(false);
  });

  it("不注册 mcp__ 前缀工具", async () => {
    const { log } = await allModeStarted();
    expect(log.registered.filter((name) => String(name).startsWith("mcp__g2__")).length).toBe(0);
  });

  it("@global 单元连接条目建立", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    expect(manager.middleware!.units.get("@global")?.connections.has("g2")).toBe(true);
  });

  it("connect 走池：条目仍在 @global 单元且只有一条（无第二本账）", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    // F4：connect 全局走池（userDisabled 解除 + ensureConnected 受控重建）。
    manager.middleware!.units.get("@global")!.userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.middleware!.units.get("@global")!.connections.has("g2")).toBe(true);
    expect(manager.middleware!.units.get("@global")!.connections.size).toBe(1);
  });

  it("userDisabled 已解除", async () => {
    const { manager } = await allModeStarted();
    await pollUntil(
      "@global 单元连接条目建立",
      () => manager.middleware!.units.get("@global")?.connections.has("g2") === true,
    );
    manager.middleware!.units.get("@global")!.userDisabled.add("g2");
    await manager.connect("g2");
    expect(manager.middleware!.units.get("@global")!.userDisabled.has("g2")).toBe(false);
  });
});

// #382 F5「防双进程探测重试」整段删除：换引擎后「同名服务器只能有一个实例」由官方 serverName 在
// 应用根上的活体预留承担（同 id 二次挂载当场抛，实测 §2.9-16），我方不再需要探测 + 一次性重试，
// probeRetried / reconnectTimer / scheduleProbeRetry 已随实现删除——这三例的断言对象不存在了。
// 其中第三例顺带守的「ensureConnected 对 userDisabled 短路」判据仍然成立（实现里的早返回），
// 故就地按新链路重建：驱动换成池的真 ensureConnected，观测点换成「条目没建、官方实例没挂」。
describe("#382 F5 删除后的等价判据：userDisabled 短路不装载", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2g-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("userDisabled 命中 → 不建连接条目、不挂官方实例（短路在装载之前）", async () => {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("g3")));
    // initMiddleware 刚建池、projectUnitFor 刚建单元（同一用例流），此处断言存在。
    const mw = manager.middleware!;
    mw.disabledByRoot.set("@global", new Set(["g3"]));
    const unit = (await mw.projectUnitFor("@global"))!;
    await mw.ensureConnected("@global", "g3");
    expect(unit.userDisabled.has("g3")).toBe(true);
    expect(unit.connections.has("g3")).toBe(false);
    expect(poolLoader!.calls.filter((call) => call[0] === "mount")).toHaveLength(0);
  });
});

// #412 复报：resumeReconnect 配置全集重建（单元缺失 / entry 缺失场景） ----
describe("#412 resumeReconnect 配置全集重建", () => {
  function resumeFixture() {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2r-");
    const projRoot = join(dir, "proj");
    mkdirSync(projRoot, { recursive: true });
    const projStore = new McpStore(join(projRoot, ".dsh", "mcp.json"));
    // 内存态配置（不落盘）：p1 启用、p2 禁用、p3 启用。
    projStore.data = {
      version: 1,
      servers: [
        normalizeServer(quietServer("p1")),
        normalizeServer(quietServer("p2", { enabled: false })),
        normalizeServer(quietServer("p3")),
      ],
    };
    manager.projectStores.set(projRoot, projStore);
    manager.projectRoot = projRoot;

    // stub 中间层：units 为空（模拟宿主重启后单元/entry 全清），记录调用面。
    const calls: Array<[string, ...unknown[]]> = [];
    const fakeMw = {
      units: new Map(),
      projectUnitFor: async (root: string) => {
        const unit = {
          root,
          connections: new Map(),
          catalog: new Map(),
          userDisabled: new Set(),
          lastTouchedAt: Date.now(),
          inFlight: new Map(),
        };
        fakeMw.units.set(root, unit);
        calls.push(["projectUnitFor", root]);
        return unit;
      },
      ensureConnected: async (root: string, name: string, opts: unknown) => {
        calls.push(["ensureConnected", root, name, opts]);
      },
      // 部分中间层桩（只实现 resume 触达的 units/projectUnitFor/ensureConnected）：按接缝收窄。
    };
    manager.middleware = fakeMw as unknown as McpManagerType["middleware"];
    return { manager, projRoot, calls, fakeMw };
  }

  it("单元缺失时先 projectUnitFor 确保单元创建", async () => {
    // 单元缺失：resumeReconnect 应先 projectUnitFor 创建单元，再按配置全集 force 重建。
    const { manager, projRoot, calls } = resumeFixture();
    await manager.resumeReconnect();
    expect(calls.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot)).toBeTruthy();
  });

  it("目标=配置全集 enabled（排除 disabled 的 p2、不依赖已有 entry）", async () => {
    const { manager, calls } = resumeFixture();
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon.map((c) => c[2]).sort()).toEqual(["p1", "p3"]);
  });

  it("全部 force 受控重建（#412）", async () => {
    const { manager, calls } = resumeFixture();
    await manager.resumeReconnect();
    const recon = calls.filter((c) => c[0] === "ensureConnected");
    // opts 为调用方透传的未知形状：只读 force 面。
    expect(
      recon.every((c) => (c[3] as { force?: unknown } | undefined)?.force === true),
    ).toBeTruthy();
  });

  it("userDisabled 过滤（p3 已禁用不复活）", async () => {
    // 单元已存在但 entry 缺失：仍按配置全集重建（不重复 projectUnitFor）。
    const { manager, projRoot, calls, fakeMw } = resumeFixture();
    await manager.resumeReconnect();
    calls.length = 0;
    fakeMw.units.get(projRoot).userDisabled.add("p3");
    await manager.resumeReconnect();
    const recon2 = calls.filter((c) => c[0] === "ensureConnected");
    expect(recon2.map((c) => c[2])).toEqual(["p1"]);
  });

  it("单元已存在不再重复创建", async () => {
    const { manager, projRoot, calls, fakeMw } = resumeFixture();
    await manager.resumeReconnect();
    calls.length = 0;
    fakeMw.units.get(projRoot).userDisabled.add("p3");
    await manager.resumeReconnect();
    expect(!calls.some((c) => c[0] === "projectUnitFor")).toBeTruthy();
  });
});

// #616：reconcile/refreshFromDisk 不得拆毁中间层项目单元 ----
describe("#616 reconcile / start(项目级) / refreshFromDisk 不拆毁中间层项目单元", () => {
  function regression616() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2x-");
    const projRoot = join(dir, "proj");
    mkdirSync(projRoot, { recursive: true });
    const projStore = new McpStore(join(projRoot, ".dsh", "mcp.json"));
    projStore.data = {
      version: 1,
      servers: [normalizeServer(quietServer("p1")), normalizeServer(quietServer("p2"))],
    };
    manager.projectStores.set(projRoot, projStore);
    manager.projectRoot = projRoot;
    manager.projectStore = projStore;

    // stub 中间层：项目单元已建且 p1/p2 均已 connected（模拟稳定运行态），
    // teardownUnit 必须零调用（回归红线：reconcile 有任何拆毁即判红）。
    const teardownRoots: string[] = [];
    // 调用记录：元组与裸标记混记（"reconcile" 裸串），读侧按位置收窄。
    // 调用记录：元组与裸标记（"reconcile"）混记，读侧按位置收窄。
    const calls614: Array<unknown[] | string> = [];
    const mkUnit = (root: string) => ({
      root,
      connections: new Map([
        ["p1", { server: projStore.find("p1"), status: "connected" }],
        ["p2", { server: projStore.find("p2"), status: "connected" }],
      ]),
      catalog: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    const fakeMw = {
      units: new Map([[projRoot, mkUnit(projRoot)]]),
      projectUnitFor: async (root: string) => {
        calls614.push(["projectUnitFor", root]);
        return (
          fakeMw.units.get(root) ??
          (() => {
            const unit = mkUnit(root);
            fakeMw.units.set(root, unit);
            return unit;
          })()
        );
      },
      ensureConnected: async (root: string, name: string, opts: unknown) => {
        calls614.push(["ensureConnected", root, name, opts]);
        const unit = fakeMw.units.get(root);
        if (unit !== undefined && !unit.connections.has(name)) {
          unit.connections.set(name, { server: projStore.find(name), status: "connected" });
        }
        return opts;
      },
      teardownUnit: (root: string) => teardownRoots.push(root),
      // 部分中间层桩（teardown 回归面）：按接缝收窄。
    };
    manager.middleware = fakeMw as unknown as McpManagerType["middleware"];
    return { manager, store, projRoot, projStore, fakeMw, teardownRoots, calls614 };
  }

  /** 全局配置加一台 g1：reconcile 会因 supervisor 集合变化走 start("g1")。 */
  async function afterReconcile() {
    const fixture = regression616();
    // 关键断言：项目单元 connections 保持、teardownUnit 零调用（修复前此处把
    // 项目单元整个拆毁且无人重建）。
    fixture.store.upsert(normalizeServer(quietServer("g1")));
    fixture.manager.reconcileServers();
    await pollUntil(
      "all 模式全局 g1 经池接管连接",
      () => fixture.fakeMw.units.get("@global")?.connections.has("g1") === true,
    );
    return fixture;
  }

  it("reconcile 零拆毁（#616 回归红线）", async () => {
    const { teardownRoots } = await afterReconcile();
    expect(teardownRoots.length).toBe(0);
  });

  it("项目级 p1 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot)!.connections.get("p1")?.status).toBe("connected");
  });

  it("项目级 p2 连接保持", async () => {
    const { fakeMw, projRoot } = await afterReconcile();
    expect(fakeMw.units.get(projRoot)!.connections.get("p2")?.status).toBe("connected");
  });

  it("配置无变化 refreshFromDisk 早退、不 reconcile", async () => {
    const { manager, calls614 } = await afterReconcile();
    // refreshFromDisk 早退：配置无变化时不再 reconcile（消除 user-state 写盘
    // 误触发 reconcile 的放大器；reconcileBusy 置位可探测是否被调用）。
    calls614.length = 0;
    manager.reconcileServers = () => {
      calls614.push("reconcile");
      return false;
    };
    await manager.refreshFromDisk();
    expect(calls614.length).toBe(0);
  });

  it("start(项目级) 幂等触达零拆毁", async () => {
    // start(项目级) 幂等触达：不拆单元、对该服务器 ensureConnected（无 force）。
    const { manager, projRoot, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () =>
      calls614.some((c) => c[0] === "ensureConnected" && c[1] === projRoot && c[2] === "p1"),
    );
    expect(teardownRoots.length).toBe(0);
  });

  it("幂等触达不带 force（connected 短路语义）", async () => {
    const { manager, calls614 } = await afterReconcile();
    calls614.length = 0;
    manager.start("p1", "project");
    await pollUntil("start(项目级) 幂等触达完成", () =>
      calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p1"),
    );
    // opts 为透传未知形状：只读 force 面。
    expect(
      calls614.every(
        (c) => c[0] !== "ensureConnected" || (c[3] as { force?: unknown })?.force !== true,
      ),
    ).toBeTruthy();
  });

  it("配置漂移 force 重建仍零拆毁（单台重建不殃及单元）", async () => {
    // start(项目级) 配置漂移：entry.server 与 store 当前配置不一致 → force 单台
    // 重建（保留手工编辑 mcp.json 热生效语义，评审 P1-2 补测）。
    const { manager, projStore, calls614, teardownRoots } = await afterReconcile();
    calls614.length = 0;
    projStore.data.servers[0] = normalizeServer(quietServer("p1", { command: "dsh-noop-cmd-v2" }));
    manager.start("p1", "project");
    await pollUntil("配置漂移 force 重建完成", () =>
      calls614.some(
        (c) =>
          c[0] === "ensureConnected" &&
          c[2] === "p1" &&
          (c[3] as { force?: unknown })?.force === true,
      ),
    );
    expect(teardownRoots.length).toBe(0);
  });

  it("userDisabled 命中不连接", async () => {
    // start(项目级) userDisabled 命中：不触发 ensureConnected（浮窗断开语义）。
    const { manager, projRoot, calls614, fakeMw } = await afterReconcile();
    calls614.length = 0;
    fakeMw.units.get(projRoot)!.userDisabled.add("p2");
    manager.start("p2", "project");
    await pollUntil("projectUnitFor 触达完成", () =>
      calls614.some((c) => c[0] === "projectUnitFor" && c[1] === projRoot),
    );
    // 反向验证：userDisabled 命中后稳定不连接（观察窗口内持续断言，替代固定 sleep）
    await assertNoGrowth(
      "userDisabled命中不连接",
      () => calls614.filter((c) => c[0] === "ensureConnected" && c[2] === "p2").length,
      0,
    );
    expect(!calls614.some((c) => c[0] === "ensureConnected" && c[2] === "p2")).toBeTruthy();
  });
});

// #413：all 模式 runtime 注入（toolDefinitions）归一中台 ----
describe("#413 all 模式 runtime 注入归一中台", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2w-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  function wrappedTool() {
    return {
      name: "cg_node",
      description: "查符号",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      output: {
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
      },
      // String() 与模板内插转义逐字一致，此处不断言、只为类型收窄。
      execute: async (args: unknown) => ({
        text: `node(${String((args as { symbol: unknown }).symbol)})`,
      }),
    };
  }

  async function registered({ unregister = false } = {}) {
    const { manager, store, log } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // 经 registerServer 注入（带 toolDefinitions）→ start 触达 @global 单元虚拟连接，
    // 不注册 mcp__ 直呼工具（单池后没有第二本账）。
    await manager.registerServer({
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      args: ["serve", "--mcp"],
      toolDefinitions: [wrappedTool()],
    });
    await pollUntil(
      "@global 单元虚拟连接建立",
      () => mw.units.get("@global")?.connections.has("cg") === true,
    );
    if (unregister) await manager.unregisterServer("cg");
    return { manager, store, log, mw };
  }

  it("runtime 条目已注册", async () => {
    const { manager } = await registered();
    expect(manager.runtimeRegistry.has("cg")).toBeTruthy();
  });

  it("runtime 条目归 @global 单元（#413 归一，无第二本账）", async () => {
    const { manager, mw } = await registered();
    expect(mw.units.get("@global")!.connections.has("cg")).toBe(true);
    expect("supervisors" in manager, "supervisors 字段已删").toBe(false);
  });

  it("不注册 mcp__ 前缀工具", async () => {
    const { log } = await registered();
    expect(log.registered.filter((name) => String(name).startsWith("mcp__cg__")).length).toBe(0);
  });

  it("虚拟连接 connected", async () => {
    const { mw } = await registered();
    // 真装载保证条目存在，此处断言存在。
    expect(mw.units.get("@global")!.connections.get("cg")!.status).toBe("connected");
  });

  it("虚拟连接不挂官方实例（无账本键 / 无句柄 / loader 未 mount）", async () => {
    const { mw } = await registered();
    // 真装载保证条目存在，此处断言存在。
    const entry = mw.units.get("@global")!.connections.get("cg")!;
    // 旧断言读 entry.client 恒 undefined 会退化成恒真（字段已删）；判据换到新链路上：
    // 虚拟单元不派官方实例的证据是「没有账本键、没有句柄、loader 一次都没 mount」。
    expect(entry.id).toBeUndefined();
    expect(entry.handle).toBeUndefined();
    expect(poolLoader!.calls.filter((call) => call[0] === "mount")).toHaveLength(0);
    expect(mountLedger.size).toBe(0);
  });

  it("虚拟连接：statusOf 恒 connected，配置/用户禁用时 disabled", async () => {
    const { manager, mw } = await registered();
    const entry = () => mw.units.get("@global")!.connections.get("cg")!;
    // 虚拟单元没有注册面工具，六态投影对它会判 stopped——故它就地收敛（#413 既有契约）。
    expect(mw.statusOf("@global", "cg")).toBe("connected");
    mw.units.get("@global")!.userDisabled.add("cg");
    expect(mw.statusOf("@global", "cg")).toBe("disabled");
    mw.units.get("@global")!.userDisabled.delete("cg");
    entry()!.server.enabled = false;
    expect(mw.statusOf("@global", "cg")).toBe("disabled");
    expect(manager.runtimeRegistry.has("cg")).toBe(true);
  });

  it("目录投影封装工具", async () => {
    await registered();
    expect(catalogDirectory.entryFor("@global", "cg")?.tools.has("cg_node")).toBeTruthy();
  });

  it("summary 投影 connected（@global 单元）", async () => {
    // 查询面：summary 从 @global 单元投影（connected + tools），不落 supervisor。
    const { manager } = await registered();
    // summary 是 Record 面（诊断投影）：此处只读 servers 条目三键，不断言其类型。
    const summaryServer = (
      summaryView(manager).servers as Array<{
        name: string;
        status?: unknown;
        tools?: Array<{ tool: string }>;
      }>
    ).find((s) => s.name === "cg");
    expect(summaryServer?.status).toBe("connected");
  });

  it("summary 工具列表来自目录投影", async () => {
    const { manager } = await registered();
    // summary 是 Record 面（诊断投影）：此处只读 servers 条目三键，不断言其类型。
    const summaryServer = (
      summaryView(manager).servers as Array<{
        name: string;
        status?: unknown;
        tools?: Array<{ tool: string }>;
      }>
    ).find((s) => s.name === "cg");
    // cg 条目恒在清单内（上一用例同夹具已验 status），此处断言存在。
    expect([...summaryServer!.tools!].sort()).toEqual(["cg_node"]);
  });

  it("runtime 条目已注销", async () => {
    // unregisterServer 清理 @global 单元虚拟连接与目录（防 unregister 后幽灵残留）。
    const { manager } = await registered({ unregister: true });
    expect(manager.runtimeRegistry.has("cg")).toBe(false);
  });

  it("虚拟连接已拆", async () => {
    const { mw } = await registered({ unregister: true });
    expect(mw.units.get("@global")?.connections.has("cg")).toBe(false);
  });

  it("目录条目已清（防幽灵）", async () => {
    await registered({ unregister: true });
    expect(catalogDirectory.entryFor("@global", "cg")).toBeUndefined();
  });
});

// #413：all 模式 runtime（toolDefinitions）注销后 project 模式保留 supervisor ----
describe("#413 封装定义条目（runtime 注入）的归属", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2w2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  async function projectRegistered() {
    const { manager } = makeManager(homeDir);
    const wrapped = {
      name: "cg_node",
      description: "查符号",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      output: {
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
      },
      // String() 与模板内插转义逐字一致，此处不断言、只为类型收窄。
      execute: async (args: unknown) => ({
        text: `node(${String((args as { symbol: unknown }).symbol)})`,
      }),
    };
    await manager.initMiddleware();
    await manager.registerServer({
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      args: ["serve", "--mcp"],
      toolDefinitions: [wrapped],
    });
    return { manager };
  }

  it("封装定义条目恒归中间层（(c)'：与模式无关）", async () => {
    // 单池后没有模式键：封装定义的归属与模式无关（它没有 mcp__ 宿主注册可回退，触达面只能是
    // ws_mcp_call）。不存在第二本账，连接落在中间层的虚拟连接上。
    const { manager } = await projectRegistered();
    expect("supervisors" in manager, "直连账本字段已删").toBe(false);
    await pollUntil(
      "@global 单元虚拟连接建立",
      () => manager.middleware!.units.get("@global")?.connections.has("cg") === true,
    );
  });

  it("注销后 registry 清除", async () => {
    const { manager } = await projectRegistered();
    await manager.unregisterServer("cg");
    expect(manager.runtimeRegistry.has("cg")).toBe(false);
  });

  it("注销后虚拟连接移除", async () => {
    // 拆除走池路径：虚拟连接随 unregister 一并拆掉。
    const { manager } = await projectRegistered();
    await manager.unregisterServer("cg");
    expect(manager.middleware!.units.get("@global")?.connections.has("cg")).toBe(false);
  });
});

// #767 S1-5b 裁决 (c)'：封装定义条目（toolDefinitions）恒交中间层虚拟连接，与模式无关 ----
// 目标态没有 off/project 模式键、也没有 mcp__ 直呼面：调用方定义 + 调用方 execute 保留，
// 触达面从「直呼」收敛为 ws_mcp_call。故这里对 project / off 两档参数化，判据打在外面对：
// 虚拟连接与目录可见、ws_mcp_call 转发执行调用方 execute、零官方装载、注销即移除。
describe("#767 S1-5b：封装定义条目恒交中间层（(c)'）", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2wr-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 调用方封装定义：execute 是调用方 JS（记录每次调用，供断言「执行的是它」）。 */
  function wrappedTool(calls: unknown[]) {
    return {
      name: "cg_node",
      description: "查符号",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      output: {
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
      },
      execute: async (args: unknown) => {
        calls.push(args);
        return { text: `node(${String((args as { symbol: unknown }).symbol)})` };
      },
    };
  }

  /** 每种模式一套夹具：注册封装条目 + 挂中间层工具（ws_mcp_call 是它唯一的触达面）。 */
  /**
   * 封装定义条目夹具。单池（#767 笔 1a）后模式轴不存在了，剩下的两档都走虚拟连接：
   * - "runtime"：registerServer 运行时注入（不落 store）；
   * - "store"：持久化在 store 里（落盘条目 + start 触达）。
   */
  async function wrappedFixture(source: string) {
    const { manager, store, log } = makeManager(homeDir);
    const mw = await manager.initMiddleware();
    const calls: unknown[] = [];
    const definition = wrappedTool(calls);
    if (source === "store") {
      const config = normalizeServer(quietServer("cg"));
      // 封装定义是中间层自持形状（与官方 ToolDefinition 面不完全一致）：此处不断言其类型。
      config.toolDefinitions = [definition] as unknown as ToolDefinition[];
      store.upsert(config);
      manager.start("cg", "global");
    } else {
      await manager.registerServer({
        name: "cg",
        transport: "stdio",
        command: "codegraph",
        args: ["serve", "--mcp"],
        toolDefinitions: [definition],
      });
    }
    const disposeTools = registerMiddlewareTools(manager.ctx, mw, async () => homeDir, {
      disabledTools: manager.disabledTools,
      stats: manager.stats,
      resolveServerId: (id) => manager.serverNameForId(id),
    });
    await pollUntil("虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg") === true);
    return { manager, store, mw, log, calls, definition, disposeTools };
  }

  const mountCalls = () => poolLoader!.calls.filter((call) => call[0] === "mount").length;

  for (const source of ["runtime", "store"]) {
    it(`[${source}] 虚拟连接建立且目录可见 @global/cg`, async () => {
      const { mw } = await wrappedFixture(source);
      expect(mw.units.get("@global")?.connections.get("cg")?.status).toBe("connected");
      expect(catalogDirectory.entryFor("@global", "cg")?.tools.has("cg_node")).toBe(true);
    });

    it(`[${source}] ws_mcp_call 转发执行的是调用方 execute`, async () => {
      const { log, calls } = await wrappedFixture(source);
      // 注册的是实现传入的真定义（ws_mcp_call 恒在内），此处按形状收窄。
      const wsCall = log.registered.find(
        (def) => (def as { name?: string }).name === "ws_mcp_call",
      ) as ToolDefinition | undefined;
      const result = await wsCall!.execute(
        { server: "@global/cg", tool: "cg_node", arguments: { symbol: "X" } },
        { signal: undefined, agent: undefined, callId: "call-1" } as unknown as ToolRunContext,
      );
      expect(calls).toEqual([{ symbol: "X" }]);
      expect(JSON.stringify(result)).toContain("node(X)");
    });

    it(`[${source}] 未发生官方装载（假 loader 零 mount）`, async () => {
      await wrappedFixture(source);
      expect(mountCalls()).toBe(0);
    });

    it(`[${source}] 注销后虚拟条目与目录条目一并移除`, async () => {
      const { manager, mw } = await wrappedFixture(source);
      // 两档的注销入口不同：runtime 注入走 unregisterServer，store 落盘条目走 remove。
      if (source === "store") await manager.remove("cg");
      else await manager.unregisterServer("cg");
      expect(mw.units.get("@global")?.connections.has("cg")).toBe(false);
      expect(catalogDirectory.entryFor("@global", "cg")).toBeUndefined();
      expect(manager.runtimeRegistry.has("cg")).toBe(false);
    });
  }

  // ---- M2 洞（本笔反转）：建单元的惰性连接范围不再按所有权收窄 ----
  // 单池（#767 笔 1a）后本层是唯一连接路径，单元内**全部** enabled 服务器都归本层。
  // 判据打在外面：池的 connections + 假 loader 的 mount 计数（不断言私有字段）。
  /** 夹具：一个正常 transport 全局服务器 + 一个封装条目（后者触发 @global 单元创建）。 */
  async function eagerFilterFixture() {
    const { manager, store } = makeManager(homeDir);
    const mw = await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("gn")));
    await manager.registerServer({
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      toolDefinitions: [wrappedTool([])],
    });
    await pollUntil("@global 单元建立", () => mw.units.get("@global") !== undefined);
    return { manager, mw };
  }

  it("建 @global 单元把同 root 的正常全局服务器一并拉进池（不再按所有权收窄）", async () => {
    const { mw } = await eagerFilterFixture();
    await pollUntil(
      "正常全局服务器同时进池",
      () => mw.units.get("@global")?.connections.has("gn") === true,
    );
    expect(mw.units.get("@global")?.connections.has("cg")).toBe(true);
    expect(mw.units.get("@global")?.connections.has("gn")).toBe(true);
    expect(mountCalls() > 0).toBe(true);
  });

  it("重复 start 不重复装载（同 root 两台各只一条条目）", async () => {
    const { manager, mw } = await eagerFilterFixture();
    await pollUntil(
      "正常全局服务器进池",
      () => mw.units.get("@global")?.connections.has("gn") === true,
    );
    const mountsBefore = mountCalls();
    manager.start("gn", "global");
    manager.start("cg", "global");
    expect(mw.units.get("@global")!.connections.size).toBe(2);
    expect(mountCalls()).toBe(mountsBefore);
  });

  // ---- M3 洞：guard 的 id 反解（注册名中段 → (root, 裸名)）必须有判据 ----
  // 这条链今天零覆盖，而它正是裁定 AG② 要修的工具级禁用直呼路径。
  /**
   * 夹具：正常 transport 全局服务器（进 @global 单元，注册名 `mcp__<id>__<tool>`）
   * + 中间层工具与其 pre-execute guard（连 resolveServerId 一起按组合根的接线递入）。
   */
  async function directIdGuardFixture() {
    const { manager } = makeManager(homeDir);
    // guard 回调捕获器：存取两用（ctx.on 侧存入、判据侧按 guard 形状调用），值面保持未知、调用点收窄。
    const handlers = new Map<string, unknown>();
    // 假 ctx 补 on：registerMiddlewareTools 只在 ctx.on 可用时才挂 pre-execute guard。
    manager.ctx.on = (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    };
    const mw = await manager.initMiddleware();
    // 禁用面用仓库既有事实源（manager.disabledTools → 经 options 同步进 mw）。
    manager.disabledTools.set(MIDDLEWARE_GLOBAL_ROOT, new Map([["g1", new Set(["echo"])]]));
    registerMiddlewareTools(manager.ctx, mw, async () => homeDir, {
      disabledTools: manager.disabledTools,
      stats: manager.stats,
      resolveServerId: (id) => manager.serverNameForId(id),
    });
    await manager.registerServer({
      name: "g1",
      transport: "stdio",
      command: "dsh-noop-cmd",
      reconnect: { enabled: false },
    });
    await pollUntil(
      "池内条目拿到 id",
      () => manager.middleware!.units.get("@global")?.connections.get("g1")?.id !== undefined,
    );
    // 轮询已等到 id 写回，条目与 guard 恒存在，此处断言存在。
    const entry = manager.middleware!.units.get("@global")!.connections.get("g1")!;
    // 注册名就是 id 前缀形态（直呼路径看得见的那两个名字）。
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: `mcp__${entry.id}__echo` },
      { name: `mcp__${entry.id}__other` },
    ];
    return {
      entry,
      guard: handlers.get("tools/pre-execute")! as (
        exec: unknown,
        next: () => unknown,
      ) => Promise<{ kind: unknown; reason?: unknown }>,
    };
  }

  it("直呼 mcp__<id>__<禁用工具> 命中禁用面（guard 反解回 @global/g1）", async () => {
    const { entry, guard } = await directIdGuardFixture();
    // guard 回调返回裁决对象（kind/reason 面）：此处按测试读取面收窄。
    const decision = (await guard(
      { name: `mcp__${entry.id}__echo`, agent: { session: { header: {} } } },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown; reason?: unknown };
    // 反解不到 (root, 裸名) 就会把 id 当服务器名查表 → 恒 miss → 这条会红。
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toContain("@@global/g1/echo");
  });

  it("直呼 mcp__<id>__<未禁用工具> 放行（不是一律拒）", async () => {
    const { entry, guard } = await directIdGuardFixture();
    let nexted = false;
    const decision = (await guard(
      { name: `mcp__${entry.id}__other`, agent: { session: { header: {} } } },
      async () => {
        nexted = true;
        return { kind: "allow" };
      },
    )) as { kind: unknown; reason?: unknown };
    expect(nexted).toBe(true);
    expect(decision.kind).toBe("allow");
  });

  it("无 transport 的封装条目（直传配置）同样只经虚拟连接，不派官方实例", async () => {
    // normalizeServer 要求 transport，故这条走 start 的直传配置路径：判定的是「封装定义条目
    // 不走官方装载」本身，与配置里有没有 transport 无关。
    const { manager, mw } = await wrappedFixture("runtime");
    const calls: unknown[] = [];
    const bare = { name: "cg2", enabled: true, toolDefinitions: [wrappedTool(calls)] };
    // 无 transport 是本用例的测试输入（直传配置路径），按意图收窄。
    manager.runtimeRegistry.set("cg2", bare as unknown as ServerConfig);
    manager.start("cg2", "global");
    await pollUntil("虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg2") === true);
    expect("supervisors" in manager, "supervisors 字段已删").toBe(false);
    expect(mountCalls()).toBe(0);
  });
});

// #392 遗留①②③：remove/update 清目录幽灵条目 + disconnect 显式 scope 定位 ----
describe("#392 遗留①：remove 清内存目录幽灵条目", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 已 start 并手工塞入目录条目（模拟 discover 残留）。 */
  async function ghostStarted({ remove = false } = {}) {
    const { manager, store, log } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // #392 遗留①：remove 后目录（unit.catalog）残留幽灵条目清除——此前 dropMiddleware
    // Connection 只拆 connections 不清 catalog，TTL 内 ws_mcp_list 仍显示已删服务器。
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil(
      "@global 单元连接条目建立",
      () => mw.units.get("@global")?.connections.has("ghost") === true,
    );
    // 手动塞目录条目模拟「已 discover」残留（真实 remove 前目录必然存在）。目录内存态
    // 归 catalog 域，故经域写口登记。
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "ghost",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    if (remove) await manager.remove("ghost");
    return { manager, store, log, mw };
  }

  it("目录条目存在（模拟 discover 残留）", async () => {
    await ghostStarted();
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeDefined();
  });

  it("remove 后连接被拆", async () => {
    const { mw } = await ghostStarted({ remove: true });
    expect(mw.units.get("@global")!.connections.has("ghost")).toBe(false);
  });

  it("remove 后目录条目被清（#392 幽灵条目消除）", async () => {
    await ghostStarted({ remove: true });
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeUndefined();
  });

  it("remove 落盘", async () => {
    const { store } = await ghostStarted({ remove: true });
    expect(store.find("ghost")).toBeUndefined();
  });
});

describe("#392 遗留①（M1 复核）：remove 清磁盘 last-good 缓存", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 先 persistRoot 写盘（含 ghost），remove 后等待异步清盘完成。 */
  async function persistedGhost({ remove = false } = {}) {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    store.upsert(normalizeServer(quietServer("ghost")));
    manager.start("ghost", "global");
    await pollUntil(
      "@global 单元连接条目建立",
      () => mw.units.get("@global")?.connections.has("ghost") === true,
    );
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "ghost",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    await catalogDirectory.persistRoot("@global", {
      cachePath: () => mw.host.catalogCachePath("@global"),
      isRuntimeServer: (name) => manager.isRuntimeServer(name),
      warn: () => {},
    });
    const cacheFile = mw.host.catalogCachePath("@global");
    if (remove) {
      await manager.remove("ghost");
      // dropMiddlewareConnection 内 removeCatalogEntry 为 fire-and-forget，轮询磁盘收敛。
      await pollUntil("磁盘目录缓存已清除 ghost", () => {
        try {
          return !readFileSync(cacheFile, "utf8").includes("ghost");
        } catch {
          return true; // 缓存文件整体被删（目录已空）也算清除
        }
      });
    }
    return { mw, cacheFile };
  }

  it("磁盘目录缓存写入 ghost 条目", async () => {
    const { cacheFile } = await persistedGhost();
    expect(readFileSync(cacheFile, "utf8").includes("ghost")).toBeTruthy();
  });

  it("remove 后内存目录亦清", async () => {
    await persistedGhost({ remove: true });
    expect(catalogDirectory.entryFor("@global", "ghost")).toBeUndefined();
  });
});

describe("#392 遗留③：disconnect 显式 scope 定位", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2m-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const projectConnect = async () => {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // #392 遗留③：disconnect 显式 scope=project 定位项目单元，不误写 @global 单元。
    // 构造：全局 store 与项目 store 同名 "dup"（项目级由中间层项目单元接管）。
    store.upsert(normalizeServer(quietServer("dup")));
    // @global 单元须先存在（原脚本由更早的全局 start 触达建立），否则「不误写
    // @global」断言无对象可查。
    await mw.projectUnitFor("@global");
    const proj = join(homeDir, "proj");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "dup", transport: "stdio", command: "dcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    await manager.connect("dup", "project");
    // connect 刚建项目单元，此处断言存在。
    const projUnit = mw.units.get(proj)!;
    return { manager, mw, proj, projUnit };
  };

  it("项目单元已创建", async () => {
    const { projUnit } = await projectConnect();
    expect(projUnit).toBeTruthy();
  });

  it("scope=project 断开写项目单元", async () => {
    // 项目级 disconnect：显式 scope=project → 写项目单元 userDisabled（此前无 scope
    // 时 all 模式全局同名会把项目级 disconnect 错定位 @global）。
    const { manager, projUnit } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBeTruthy();
  });

  it("不误写 @global 单元（#392 同名跨 scope 修正）", async () => {
    const { manager, mw } = await projectConnect();
    await manager.disconnect("dup", "project");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBe(false);
  });

  it("reconnect(scope=project) 不误写 @global 单元（S1）", async () => {
    // #392 遗留③（S1 复核）：reconnect 透传 scope——项目级 reconnect 不再误写 @global。
    // 此前 reconnect 内部 disconnect(name) 不带 scope，all 模式 + 全局同名时项目级
    // reconnect 会把全局同名服务器误写进 @global userDisabled 并持久化。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBe(false);
  });

  it("reconnect 后项目单元 userDisabled 已解除", async () => {
    const { manager, projUnit } = await projectConnect();
    await manager.connect("dup", "project");
    await manager.reconnect("dup", "project");
    expect(projUnit.userDisabled.has("dup")).toBe(false);
  });

  it("scope=global 断开写 @global 单元", async () => {
    // 全局 disconnect 显式 scope=global → 写 @global 单元。
    const { manager, mw } = await projectConnect();
    await manager.connect("dup", "global");
    await manager.disconnect("dup", "global");
    expect(mw.units.get("@global")!.userDisabled.has("dup")).toBeTruthy();
  });
});

// 拆除时在途建连的 in-flight 残留（跨平台确定性回归：Windows 必现） ----
// 「attempt 在途」改由假 loader 的 deferred ready 撑：装载窗口按在窗口内不自行结算，
// 不再 spawn 真子进程（离线纪律）。此前 remove/disconnect 强拆 entry 后不同步废弃
// inFlight 去重标记，同名后续 ensureConnected（含 force 的显式「连接」）被残留标记
// 吞掉，且旧 attempt 收敛命中 disposed 守卫无人补连——修复前本块必红。
describe("拆除时在途建连的 in-flight 残留", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2n-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /** 挂起型服务器：命令永不执行（假 loader 不 spawn），挂起完全由装载窗口的 ready 时序撑。 */
  const hangServer = (name: string) => quietServer(name);

  async function allModeFixture() {
    const { manager, store } = makeManager(homeDir);
    await manager.initMiddleware();
    // 装载窗口按在 deferred：attempt 一直 pending，直到本用例收口时放闸。
    loaderScript.ready = "deferred";
    // 池由 initMiddleware 刚建，此处断言存在。
    return { manager, store, mw: manager.middleware! };
  }

  it("remove 后重加立即重建连接条目（in-flight 残留已废弃）", async () => {
    const { manager, store, mw } = await allModeFixture();
    // remove 路径：connecting 中强拆 + 重加，连接条目须立即重建。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.remove("hang");
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "remove 后重加立即重建连接条目（in-flight 残留已废弃）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
  });

  it("disconnect 写 userDisabled", async () => {
    const { manager, store, mw } = await allModeFixture();
    // disconnect 路径：connecting 中断开 + 显式「连接」，force 建连不被去重吞掉。
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.disconnect("hang", "global");
    expect(mw.units.get("@global")!.userDisabled.has("hang")).toBeTruthy();
  });

  it("disconnect 后显式连接立即重建条目", { timeout: 30_000 }, async () => {
    const { manager, store, mw } = await allModeFixture();
    store.upsert(normalizeServer(hangServer("hang")));
    manager.start("hang", "global");
    await pollUntil(
      "hang 连接条目建立（connecting）",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    await manager.disconnect("hang", "global");
    await manager.connect("hang", "global");
    await pollUntil(
      "disconnect 后显式连接立即重建条目",
      () => mw.units.get("@global")?.connections.has("hang") === true,
    );
    expect(mw.units.get("@global")?.connections.has("hang")).toBe(true);
  });
});

// add / update（scope project 抛错路径在 unit-manager 已覆盖，此处补全局） ----
describe("add / update / remove（全局）", () => {
  it("add 返回名", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    const added = await manager.add(normalizeServer(quietServer("new")));
    expect(added.name).toBe("new");
  });

  it("重复 add 抛 already exists", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await expect(manager.add(normalizeServer(quietServer("new")))).rejects.toThrow(
      /already exists/,
    );
  });

  it("update 返回新 command", async () => {
    const { manager } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    const updated = await manager.update("new", { command: "cmd2" });
    expect(updated.command).toBe("cmd2");
  });

  it("更新落盘", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await manager.update("new", { command: "cmd2" });
    expect(store.find("new")!.command).toBe("cmd2");
  });

  it("remove 后 store 无该条目", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2f-");
    await manager.add(normalizeServer(quietServer("new")));
    await manager.remove("new");
    expect(store.find("new")).toBeUndefined();
  });
});

// #767 S1-3b：组合根侧接线判据——目录投影与载入都走 catalog 域 ----
describe("#767 S1-3b：manager 接线（建单元时才载入、内存不被磁盘盖回）", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2s13b-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  it("projectUnitFor 建单元时载入读到的磁盘目录", async () => {
    // 反证：把 projectUnitFor 里的 catalog.ensureRootLoaded 调用删掉 → 本条红（目录恒空）。
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    const root = "@global";
    const file = manager.catalogCachePathFor(root);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root,
        entries: {
          diskSrv: {
            discoveredAt: 1,
            tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
          },
        },
      }),
      "utf8",
    );
    // 建单元之前目录里没有这个 root。
    expect(catalogDirectory.serversFor(root)).toBeUndefined();
    await manager.middleware!.projectUnitFor(root);
    expect(catalogDirectory.entryFor(root, "diskSrv")?.tools.has("disk_tool")).toBe(true);
    expect(catalogDirectory.entryFor(root, "diskSrv")?.discoveredAt).toBe(1);
    await catalogDirectory.ensureRootLoaded(root, file);
    // 二次载入不再读盘：内存那份仍在。
    expect(catalogDirectory.entryFor(root, "diskSrv")?.discoveredAt).toBe(1);
  });

  it("root 已在册时，磁盘那份不得盖回内存投影", async () => {
    // 反证：删掉 ensureRootLoaded 的 `if (this.byRoot.has(root)) return;` 短路 → 本条红
    // （内存条目会被磁盘内容整体替换成 diskSrv）。
    const { manager } = makeManager(homeDir);
    await manager.initMiddleware();
    const root = "@global";
    const file = manager.catalogCachePathFor(root);
    catalogDirectory.dropRoot(root);
    catalogDirectory.projectWrappedTools({
      root,
      serverName: "memSrv",
      definitions: [{ name: "mem_tool", description: "内存那份", parameters: {} }],
    });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root,
        entries: {
          diskSrv: {
            discoveredAt: 1,
            tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
          },
        },
      }),
      "utf8",
    );
    // 单元已被本用例先建过（root 在册）→ 建单元不再载入、也不覆盖。
    await manager.middleware!.projectUnitFor(root);
    expect(catalogDirectory.entryFor(root, "memSrv")?.tools.has("mem_tool")).toBe(true);
    expect(catalogDirectory.entryFor(root, "diskSrv")).toBeUndefined();
  });
});

// setSession / catalogServersFor / projectStoreFor / refreshFromDisk ----
describe("setSession", () => {
  function sessionFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    // 项目目录：<dir>/proj/.git。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    return { dir, manager, store, proj };
  }

  it("空 → 空 幂等短路", async () => {
    const { manager } = sessionFixture();
    await manager.setSession(undefined);
    expect(manager.projectRoot).toBeUndefined();
  });

  it("切换到项目 root", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    expect(manager.projectRoot).toBe(proj);
  });

  it("projectStore 是 McpStore 实例", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    expect(manager.projectStore instanceof McpStore).toBeTruthy();
  });

  it("项目级服务器随会话启动（进当前项目单元）", async () => {
    const { manager, proj } = sessionFixture();
    await manager.initMiddleware();
    await manager.setSession(proj);
    await pollUntil(
      "项目级服务器进项目单元",
      () => manager.middleware!.units.get(proj)?.connections.has("psrv") === true,
    );
    expect(manager.middleware!.units.get(proj)!.connections.has("psrv")).toBeTruthy();
  });

  it("同项目幂等不重载", async () => {
    const { manager, proj } = sessionFixture();
    await manager.setSession(proj);
    const sameStore = manager.projectStore;
    await manager.setSession(proj);
    expect(manager.projectStore).toBe(sameStore);
  });

  async function switchedAway() {
    const fixture = sessionFixture();
    await fixture.manager.initMiddleware();
    await fixture.manager.setSession(fixture.proj);
    const sameStore = fixture.manager.projectStore;
    // 切走：项目 supervisor 全部断开（无标记目录回落为项目根 = cwd 自身，
    // 加载出空 projectStore 属预期行为）。
    const elsewhere = join(fixture.dir, "elsewhere");
    await fixture.manager.setSession(elsewhere);
    return { ...fixture, sameStore, elsewhere };
  }

  it("切走后项目级连接常驻（单池不再随会话断开）", async () => {
    const { manager, proj } = await switchedAway();
    // 单池（#767 笔 1a）：连接按 root 常驻，切会话只切 currentRoot，不拆项目单元。
    await pollUntil(
      "项目单元仍在池",
      () => manager.middleware!.units.get(proj)?.connections.has("psrv") === true,
    );
    expect(manager.middleware!.units.get(proj)!.connections.has("psrv")).toBe(true);
  });

  it("切走后 projectRoot 更新", async () => {
    const { manager, elsewhere } = await switchedAway();
    expect(manager.projectRoot).toBe(elsewhere);
  });

  it("不再持有旧项目 store", async () => {
    const { manager, sameStore } = await switchedAway();
    expect(manager.projectStore !== sameStore).toBeTruthy();
  });

  it("切走后 catalogServersFor 无 psrv", async () => {
    const { manager, elsewhere } = await switchedAway();
    expect((await manager.catalogServersFor(elsewhere)).has("psrv")).toBe(false);
  });
});

describe("catalogServersFor", () => {
  async function catalogFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    // catalogServersFor：全局 + 项目聚合，禁用过滤，同名项目级被顶掉。
    // 上一行刚赋值，此处断言存在。
    manager.projectStore!.data.servers.push(
      normalizeServer({ ...quietServer("psrv2", { enabled: false }) }),
    );
    return { dir, manager, store, proj };
  }

  it("含全局", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("glob")).toBeTruthy();
  });

  it("含项目级", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("psrv")).toBeTruthy();
  });

  it("禁用服务器不进目录", async () => {
    const { manager, proj } = await catalogFixture();
    expect((await manager.catalogServersFor(proj)).has("psrv2")).toBe(false);
  });

  it("项目级 scope 标注", async () => {
    const { manager, proj } = await catalogFixture();
    // 聚合恒含项目级条目（上一用例同夹具已验 has），此处断言存在。
    expect((await manager.catalogServersFor(proj)).get("psrv")!.scope).toBe("project");
  });

  it("空 cwd 只出全局", async () => {
    // 空 cwd 只出全局。
    const { manager } = await catalogFixture();
    const onlyGlobal = await manager.catalogServersFor("");
    expect([...onlyGlobal.keys()]).toEqual(["glob"]);
  });
});

describe("projectStoreFor", () => {
  async function cachedFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "psrv", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    return { manager, proj };
  }

  it("工作区缓存复用", async () => {
    // projectStoreFor 缓存命中复用。
    const { manager, proj } = await cachedFixture();
    const cached = await manager.projectStoreFor(proj);
    expect(cached).toBe(manager.projectStore);
  });

  it("空串 undefined", async () => {
    const { manager } = await cachedFixture();
    expect(await manager.projectStoreFor("")).toBeUndefined();
  });

  it("undefined undefined", async () => {
    const { manager } = await cachedFixture();
    expect(await manager.projectStoreFor(undefined)).toBeUndefined();
  });
});

describe("refreshFromDisk", () => {
  async function refreshFixture() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2g-");
    store.upsert(normalizeServer(quietServer("glob")));
    // 先建立 supervisor，使后续 reconcile 有"集合变化"可报（原脚本经 setSession
    // 启动过项目级/全局 supervisor，此处显式补上等价前置）。
    manager.reconcileServers();
    // 建立 0 基线（文件缺失 → 内存 servers 清空）。
    await store.load();
    let broadcasts = 0;
    manager.onStatus(() => {
      broadcasts += 1;
    });
    return { dir, manager, store, broadcasts: () => broadcasts };
  }

  it("重读生效", async () => {
    const { dir, manager, store, broadcasts } = await refreshFixture();
    const future = Date.now() / 1000 + 10;
    writeFileSync(
      join(dir, "global.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }],
      }),
    );
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    // emitStatus 是 coalesce 异步（setTimeout 0）：轮询等广播落定且无未决 coalesce
    //（statusTimer 清空 = 广播 handler 已全部执行），再取基线（事件驱动）。
    await pollUntil(
      "配置变化广播落定",
      () =>
        broadcasts() >= 1 &&
        (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    expect(store.data.servers.some((s) => s.name === "fresh")).toBeTruthy();
  });

  it("无变化不广播", async () => {
    const { dir, manager, broadcasts } = await refreshFixture();
    const future = Date.now() / 1000 + 10;
    writeFileSync(
      join(dir, "global.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "fresh", transport: "stdio", command: "x", enabled: false }],
      }),
    );
    utimesSync(join(dir, "global.json"), future, future);
    await manager.refreshFromDisk();
    await pollUntil(
      "配置变化广播落定",
      () =>
        broadcasts() >= 1 &&
        (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    // 无变化时不广播：先取基线（上一广播已完全落定），再 refreshFromDisk
    //（无变化 → 不 emitStatus），轮询确认无未决广播后断言计数不变。
    const before = broadcasts();
    await manager.refreshFromDisk();
    await pollUntil(
      "无变化后无未决广播",
      () => (manager as unknown as { statusTimer: unknown }).statusTimer === undefined,
    );
    expect(broadcasts()).toBe(before);
  });
});

// setSession 零连接副作用（#228：POST /session 永不挂起回归） ----
describe("setSession 零连接副作用（#228）", () => {
  async function slowProjectSession() {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2s-");
    // 项目目录含一个「连接会卡住」的服务器（stdio 命令不存在 → connect 会失败/等待，
    // 若 setSession await 连接则此测试超时）。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "slow", transport: "stdio", command: "definitely-not-exist-cmd", enabled: true },
        ],
      }),
    );
    // 中间层 project 模式：setSession 只切 currentRoot，不 await 连接。
    const started = Date.now();
    await manager.setSession(proj);
    return { manager, proj, elapsed: Date.now() - started };
  }

  it("setSession 零连接副作用", async () => {
    const { elapsed } = await slowProjectSession();
    expect(elapsed < 2000).toBeTruthy();
  });

  it("projectRoot 切到项目", async () => {
    const { manager, proj } = await slowProjectSession();
    expect(manager.projectRoot).toBe(proj);
  });

  it("中间层未初始化（apply 时才建）→ 不崩", async () => {
    const { manager } = await slowProjectSession();
    expect(manager.middleware).toBeUndefined();
  });
});

// 中间层模式 connect/disconnect 分支（#228：userDisabled 持久化） ----
describe("中间层模式 connect/disconnect 分支（#228）", () => {
  async function middlewareConnected() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2t-");
    store.upsert(normalizeServer(quietServer("g1")));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "p1", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    await manager.setSession(proj);
    // 初始化中间层（模拟 apply）。
    await manager.initMiddleware();
    // 项目级 connect → 中间层连接池（userDisabled 解除 + ensureConnected）。
    await manager.connect("p1", "project");
    // 池由 initMiddleware 刚建，此处断言存在。
    return { manager, store, proj, mw: manager.middleware! };
  }

  it("中间层已初始化", async () => {
    const { manager } = await middlewareConnected();
    expect(manager.middleware !== undefined).toBeTruthy();
  });

  it("中间层单元已创建", async () => {
    const { mw, proj } = await middlewareConnected();
    expect(mw.units.has(proj)).toBeTruthy();
  });

  it("connect 解除 userDisabled", async () => {
    const { mw, proj } = await middlewareConnected();
    expect(mw.units.get(proj)!.userDisabled.has("p1")).toBe(false);
  });

  it("断开后 userDisabled", async () => {
    // 项目级 disconnect → userDisabled 持久化。
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj)!.userDisabled.has("p1")).toBe(true);
  });

  it("连接拆毁", async () => {
    const { manager, mw, proj } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(mw.units.get(proj)!.connections.has("p1")).toBe(false);
  });

  it("持久化文件存在（不崩）", async () => {
    const { manager } = await middlewareConnected();
    await manager.disconnect("p1");
    expect(existsSync(manager.userStatePath)).toBe(true);
  });

  it("全局 disconnect 也走池（写 @global 单元 userDisabled）", async () => {
    const { manager } = await middlewareConnected();
    // 单池（#767 笔 1a）：全局服务器同样在 @global 单元，断开按（store ∩ 非 runtime）定位到它。
    // 刚 connect 的 @global 单元恒存在，此处断言存在。
    const globalUnit = (await manager.middleware!.projectUnitFor("@global"))!;
    await manager.disconnect("g1");
    expect(globalUnit.userDisabled.has("g1")).toBe(true);
  });
});

// summary / summarize / dispose ----
describe("summary", () => {
  function summaryFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    return { manager, store };
  }

  it("servers 列表长度 2", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).servers.length).toBe(2);
  });

  it("counts.connected 为 0", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).counts.connected).toBe(0);
  });

  it("counts.disabled 为 1", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).counts.disabled).toBe(1);
  });

  it("cwd 为 undefined", () => {
    const { manager } = summaryFixture();
    expect(summaryView(manager).cwd).toBeUndefined();
  });
});

describe("summarize", () => {
  function summarizeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    store.upsert(normalizeServer(quietServer("s-on")));
    store.upsert(normalizeServer(quietServer("s-off", { enabled: false })));
    // 单池（#767 笔 1a）：summarize 只从连接池单元投影（旧直连账本分支已退役）。
    // 这里挂最小池替身：statusOf 给态（真投影语义由中间层自己的用例钉住），目录读口给工具面。
    // 只实现 summarize 触达的 units/statusOf/toolCountOf：按接缝收窄。
    manager.middleware = {
      units: new Map([
        [
          "@global",
          {
            root: "@global",
            connections: new Map([
              [
                "s-on",
                {
                  server: store.find("s-on"),
                  id: "id-on",
                  handle: { disposed: false },
                  status: "failed",
                  error: new Error("boom"),
                  connectedAt: Date.now(),
                  readySettled: false,
                  everConnected: false,
                  disposed: false,
                },
              ],
            ]),
            userDisabled: new Set(),
            lastTouchedAt: Date.now(),
            inFlight: new Map(),
          },
        ],
      ]),
      statusOf: () => "failed",
      toolCountOf: () => 1,
    } as unknown as McpManagerType["middleware"];
    catalogDirectory.projectWrappedTools({
      root: "@global",
      serverName: "s-on",
      definitions: [{ name: "t", description: "d", parameters: {} }],
    });
    return { manager, store };
  }

  it("entryOn.status 为 failed", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").status).toBe("failed");
  });

  it("entryOn.error 为字符串文案", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").error).toBe("boom");
  });

  it("entryOn.tools 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").tools).toEqual(["t"]);
  });

  it("entryOn.scope 透传", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-on")!, "global").scope).toBe("global");
  });

  it("entryOff.status 为 disabled", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").status).toBe("disabled");
  });

  it("entryOff.tools 为空", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").tools).toEqual([]);
  });

  it("entryOff.error 为 undefined", () => {
    const { manager, store } = summarizeFixture();
    expect(summarizeOf(manager, store.find("s-off")!, "global").error).toBeUndefined();
  });

  it("不在池里且启用 → stopped", () => {
    const { manager, store } = summarizeFixture();
    manager.middleware!.units.get("@global")!.connections.delete("s-on");
    expect(summarizeOf(manager, store.find("s-on")!, "global").status).toBe("stopped");
  });
});

describe("dispose", () => {
  async function disposeFixture() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2h-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s-on")));
    manager.startAll();
    return { manager };
  }

  it("dispose 释放全部池条目（官方句柄被 dispose）", async () => {
    // 工具注销自换引擎起归官方实例自己的 dispose（本地只留「逐条摘账 + 发起释放」）：
    // 句柄被释放即旧栈「逐个调用 toolDisposers」的同一判据面（撤销工具注册是 dispose 的效果）。
    const { manager } = await disposeFixture();
    await pollUntil("装载已发起", () => poolLoader!.handles.length > 0);
    const record = poolLoader!.handles[poolLoader!.handles.length - 1];
    expect(record.state.disposed).toBe(false);
    await manager.dispose();
    expect(record.state.disposed).toBe(true);
  });

  it("dispose 后池被整体拆空", async () => {
    const { manager } = await disposeFixture();
    await pollUntil("装载已发起", () => poolLoader!.handles.length > 0);
    await manager.dispose();
    expect(manager.middleware, "中间层实例已释放").toBe(undefined);
  });
});

// 中间层模式 summary 投影（#228 回归：连接池状态投影到浮窗/summary） ----
describe("中间层模式 summary 投影（#228）", () => {
  // 池条目的态不再由测试手改 entry.status：summarize 经 statusOf 读时刷新（裁定 U），输入面是
  // 「配置 + 账本句柄 + 注册面前缀」。夹具因此按新 ConnectionEntry 造，并让注册面携带该 id 前缀
  // ——换引擎后「已连上」只有这一条正向证据（官方不暴露状态 API）。
  const POOL_ID = "id-p1";
  // 部分连接条目桩（被测读面：id/status/server；everConnected/disposed 为本文件判据自备的探测字段，
  // 域形状外）：调用方只读域内面，收窄不断言。
  const connectedEntry = (name = "p1", id = POOL_ID): ConnectionEntry =>
    ({
      server: { name, transport: "stdio", command: "pcmd", enabled: true },
      id,
      handle: { disposed: false },
      status: "connected",
      error: undefined,
      connectedAt: Date.now(),
      readySettled: true,
      everConnected: true,
      disposed: false,
    }) as unknown as ConnectionEntry;

  async function projectionBase() {
    const { dir, manager, store } = managerFixture("dsh-mcp-mgr2mw-");
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      join(proj, ".dsh", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: [{ name: "p1", transport: "stdio", command: "pcmd", enabled: true }],
      }),
    );
    // 先切中间层模式再 setSession（off 语义的 setSession 会 reconcile 启动
    // 项目级真 supervisor 并异步重连，污染后续兜底投影断言）。
    await manager.setSession(proj);
    await manager.initMiddleware();
    // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
    const mw = manager.middleware!;
    // 预置 userDisabled（initMiddleware 会以磁盘加载结果覆盖 disabledByRoot，
    // 故必须在其后设置）：单元创建即合并，惰性 ensureConnected 直接短路——
    // 连接条目完全由本测试手工注入，杜绝 spawn 真进程与后台重连污染。
    mw.disabledByRoot.set(proj, new Set(["p1"]));
    // projectUnitFor 刚建单元，此处断言存在。
    const unit = (await mw.projectUnitFor(proj))!;
    // 这条禁用只为短路惰性建连；条目改由本测试手工注入，要按真实运行态投影，故立即撤回。
    unit.userDisabled.delete("p1");
    // 注册面携带该 id 前缀 = 「已连上」；不带它 statusOf 会如实投影成 failed / reconnecting。
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: `mcp__${POOL_ID}__t1` },
    ];
    // 注入连接池条目 + 目录缓存（模拟已握手成功，不派官方实例）。
    unit.connections.set("p1", connectedEntry());
    catalogDirectory.projectWrappedTools({
      root: proj,
      serverName: "p1",
      definitions: [
        { name: "t1", description: "d1", parameters: {} },
        { name: "t2", description: "", parameters: {} },
      ],
    });
    // 手工注入的条目恒存在，此处断言存在。
    return { dir, manager, store, proj, mw, unit, entry: unit.connections.get("p1")! };
  }

  it("项目级 server 在 summary 中", async () => {
    // 回归盲区主断言（#228 维护者实测补充验收）：中间层 connected →
    // summary 显示 connected、tools 从 catalog 缓存填充出**非空列表**且与
    // 目录一致（此前 summarize 只读 supervisors，项目级恒 stopped / 空数组，
    // 而 ws_mcp_search 实测目录有货）。
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1 !== undefined).toBeTruthy();
  });

  it("p1.scope 为 project", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1.scope).toBe("project");
  });

  it("p1.status 为 connected", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(p1.status).toBe("connected");
  });

  it("summary.tools 非空（catalog 有货不得返回空数组）", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    expect(Array.isArray(p1.tools) && p1.tools.length > 0).toBeTruthy();
  });

  it("summary.tools 与 catalog 目录一致", async () => {
    const { manager } = await projectionBase();
    // p1 恒在清单内（前序用例同夹具已验存在），此处断言存在。
    const p1 = summaryView(manager).servers.find((s) => s.name === "p1")!;
    // tools 恒为数组（投影构造保证），此处断言存在。
    expect([...p1.tools!].sort()).toEqual(["t1", "t2"]);
  });

  it("sum.counts.connected 为 1", async () => {
    const { manager } = await projectionBase();
    expect(summaryView(manager).counts.connected).toBe(1);
  });

  // 状态不再靠手改 entry.status 伪造：投影输入换成「注册面前缀 + readySettled + everConnected」。
  it("failed 态：error 详情投影（浮窗红字展示来源）", async () => {
    const { manager, entry } = await projectionBase();
    // 首连就没成功（注册面无该前缀、everConnected 为假）→ failed，error 透出官方判词。
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [];
    entry.everConnected = false;
    entry.error = new Error("官方装载失败：连接超时");
    const failed = summarizeOf(manager, manager.projectStore!.find("p1")!, "project");
    expect(failed.status).toBe("failed");
  });

  it("failed 态：error 文案投影", async () => {
    const { manager, entry } = await projectionBase();
    // ctx.tools 是工厂挂载的同一份假注册面（makeManager 注释）：此处取其 entries 写口。
    (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [];
    entry.everConnected = false;
    entry.error = new Error("官方装载失败：连接超时");
    const failed = summarizeOf(manager, manager.projectStore!.find("p1")!, "project");
    expect(failed.error).toBe("官方装载失败：连接超时");
  });

  it("connecting 态投影", async () => {
    const { manager, entry } = await projectionBase();
    // 装载等待窗口未结算（readySettled 为假）→ connecting 纯属我方动作面。
    entry.readySettled = false;
    entry.error = undefined;
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connecting",
    );
  });

  async function unavailableBase() {
    const fixture = await projectionBase();
    // connected（投影输入面不变：readySettled / everConnected / 注册面前缀都在）+ 目录发现失败
    // （unavailable）→ 0 工具且透出原因到 error。
    catalogDirectory.markUnavailable(fixture.proj, "p1", "discovery timed out");
    return fixture;
  }

  it("unavailable → status connected", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connected",
    );
  });

  it("unavailable → tools 为空", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools).toEqual([]);
  });

  it("unavailable reason 透出到 error", async () => {
    const { manager } = await unavailableBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").error).toBe(
      "discovery timed out",
    );
  });

  async function stoppedBase() {
    const fixture = await projectionBase();
    // userDisabled（手动断开，无连接条目）→ 落回兜底：无 supervisor → stopped。
    // （不做 userDisabled 短路：见 summarize 注释——all 模式 supervisor 复活场景
    // 若短路会把实际已连接反向投影成 stopped。）
    fixture.unit.connections.delete("p1");
    fixture.unit.userDisabled.add("p1");
    return fixture;
  }

  it("userDisabled 无连接条目 → stopped", async () => {
    const { manager } = await stoppedBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "stopped",
    );
  });

  it("userDisabled → tools 为空", async () => {
    const { manager } = await stoppedBase();
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools).toEqual([]);
  });

  it("userDisabled → error undefined", async () => {
    const { manager } = await stoppedBase();
    expect(
      summarizeOf(manager, manager.projectStore!.find("p1")!, "project").error,
    ).toBeUndefined();
  });

  async function globalScopeBase() {
    const fixture = await projectionBase();
    // 单池（#767 笔 1a）：全局服务器同样从 @global 单元投影（没有「project 模式走直连」这条分支）。
    fixture.store.upsert(normalizeServer(quietServer("g1")));
    (fixture.manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: `mcp__${POOL_ID}__t1` },
      { name: "mcp__id-g1__gt" },
    ];
    catalogDirectory.projectWrappedTools({
      root: MIDDLEWARE_GLOBAL_ROOT,
      serverName: "g1",
      definitions: [{ name: "gt", description: "", parameters: {} }],
    });
    fixture.mw.units.set(MIDDLEWARE_GLOBAL_ROOT, {
      root: MIDDLEWARE_GLOBAL_ROOT,
      connections: new Map([["g1", connectedEntry("g1", "id-g1")]]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    return fixture;
  }

  it("全局 scope 经 @global 单元投影（status connected）", async () => {
    const { manager, store } = await globalScopeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("connected");
  });

  it("全局 scope tools 来自 @global 目录投影", async () => {
    const { manager, store } = await globalScopeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual(["gt"]);
  });

  async function allModeBase() {
    const fixture = await projectionBase();
    // 项目单元（p1）与 @global 单元（g1）并存：单池后两者各按 scope 投影，互不串台。
    fixture.store.upsert(normalizeServer(quietServer("g1")));
    (fixture.manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
      { name: `mcp__${POOL_ID}__t1` },
      { name: "mcp__id-g1__gt" },
    ];
    catalogDirectory.projectWrappedTools({
      root: MIDDLEWARE_GLOBAL_ROOT,
      serverName: "g1",
      definitions: [{ name: "gt", description: "", parameters: {} }],
    });
    fixture.mw.units.set(MIDDLEWARE_GLOBAL_ROOT, {
      root: MIDDLEWARE_GLOBAL_ROOT,
      connections: new Map([["g1", connectedEntry("g1", "id-g1")]]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    });
    return fixture;
  }

  it("项目单元与 @global 单元并存时各按 scope 投影", async () => {
    const { manager, store } = await allModeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("connected");
    expect(summarizeOf(manager, manager.projectStore!.find("p1")!, "project").status).toBe(
      "connected",
    );
  });

  it("同 scope 各自 tools（全局取 @global 目录，项目取项目目录）", async () => {
    const { manager, store } = await allModeBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual(["gt"]);
    expect(
      [...summarizeOf(manager, manager.projectStore!.find("p1")!, "project").tools].sort(),
    ).toEqual(["t1", "t2"]);
  });

  async function disabledProjectionBase() {
    const fixture = await allModeBase();
    // 断开语义（#382 F4）：池内条目被拆 + userDisabled → summarize 落兜底 stopped。
    // 单池后不存在「直连账本残留」这条会误显示连接态的分支。
    // 刚建的 @global 单元恒存在，此处断言存在。
    const globalUnit = fixture.mw.units.get(MIDDLEWARE_GLOBAL_ROOT)!;
    globalUnit.connections.delete("g1");
    globalUnit.userDisabled.add("g1");
    return fixture;
  }

  it("userDisabled 短路（#382：池接管后断开即 stopped）", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });

  it("userDisabled 短路 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual([]);
  });

  it("#413：runtime 注入条目同样只经池投影（@global 单元，断开即 stopped）", async () => {
    // #413：runtime 注入条目与 store 全局同口径（同一本池账），不因注入来源而豁免。
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1")!);
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });

  it("#413 runtime 投影 → tools 为空", async () => {
    const { manager, store } = await disabledProjectionBase();
    manager.runtimeRegistry.set("g1", store.find("g1")!);
    expect(summarizeOf(manager, store.find("g1")!, "global").tools).toEqual([]);
  });

  it("条目不在池里 → 兜底 stopped（不谎报 connected）", async () => {
    const { manager, store } = await disabledProjectionBase();
    // 既拆条目又清 userDisabled：兜底分支的唯一输入就是「不在池里」。
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)!.userDisabled.delete("g1");
    expect(summarizeOf(manager, store.find("g1")!, "global").status).toBe("stopped");
  });
});

// B5：受控重建释放旧代际 ----
// 旧直连账本的「start 替换分支（directConfig 换引用）」随账本退役；单池后同一条不变式落在
// connect 的 force 受控重建上（connectInternal：先 await disposeServer(旧 id) 再挂新实例）。
describe("B5 红测：受控重建释放旧代际", () => {
  const poolEntry = (manager: McpManagerType) =>
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)?.connections.get("s5");

  async function rebuiltEntry() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5a-");
    await manager.initMiddleware();
    const srv = normalizeServer(quietServer("s5"));
    store.upsert(srv);
    // 第一代走真装载链（假 loader，离线）：账本句柄就是旧代际的可观测面。
    manager.start("s5", "global");
    await pollUntil("第一代装载完成", () => poolEntry(manager)?.id !== undefined);
    // 轮询已等到条目建立，此处断言存在；旧句柄恒存在（真装载链产物）。
    const oldEntry = poolEntry(manager)!;
    const oldHandle = oldEntry.handle!;
    // 受控重建：connect 走 connectInternal 的 force 分支（先 disposeServer 旧 id 再挂新实例）。
    await manager.connect("s5", "global");
    return { manager, oldEntry, oldHandle };
  }

  it("B5：受控重建释放旧代际（旧句柄被 dispose）", async () => {
    const { oldHandle } = await rebuiltEntry();
    await pollUntil("旧代际已释放", () => oldHandle.disposed === true);
    expect(oldHandle.disposed).toBe(true);
  });

  it("新代际已替换", async () => {
    const { manager, oldEntry } = await rebuiltEntry();
    await pollUntil("新代际已装载", () => {
      const entry = poolEntry(manager);
      return entry !== undefined && entry !== oldEntry && entry.id !== undefined;
    });
    expect(poolEntry(manager) === oldEntry).toBe(false);
  });

  it("旧条目 disposed 置位", async () => {
    const { oldEntry } = await rebuiltEntry();
    expect(oldEntry.disposed).toBe(true);
  });
});

// B5（续）：重复触达不重复装载 ----
describe("B5 红测（续）：重复触达不重复装载", () => {
  const poolEntry = (manager: McpManagerType) =>
    manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)?.connections.get("s5");

  async function startedEntry() {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5b-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s5")));
    manager.start("s5", "global");
    await pollUntil("第一代装载完成", () => poolEntry(manager)?.id !== undefined);
    return { manager };
  }

  it("B5：重复 start 不重建（同 (root, 裸名) 一条条目）", async () => {
    const { manager } = await startedEntry();
    const entry = poolEntry(manager);
    manager.start("s5", "global");
    expect(poolEntry(manager)).toBe(entry);
  });

  it("B5：重复 connect 受控重建后仍只有一条条目", async () => {
    const { manager } = await startedEntry();
    const oldEntry = poolEntry(manager);
    await manager.connect("s5", "global");
    expect(poolEntry(manager) === oldEntry).toBe(false);
    expect(manager.middleware!.units.get(MIDDLEWARE_GLOBAL_ROOT)!.connections.size).toBe(1);
  });
});

// B5（续）：顺序不变式——旧代际先释放、新代际后挂载 ----
// 换引擎后「工具注册/注销」归官方实例自己的 apply/dispose，本层能判的同一不变式落在账本键上：
// 同 id 的新代际必须在旧代际结算**之后**才挂载（否则官方 serverName 活体预留当场抛，裁定 V）。
describe("B5 红测（续）：顺序不变式（旧代际先释放）", () => {
  it("B5：顺序不变式——旧代际释放先于新代际挂载（受控重建路径）", async () => {
    const { manager, store } = managerFixture("dsh-mcp-mgr2b5c-");
    await manager.initMiddleware();
    store.upsert(normalizeServer(quietServer("s5")));
    // [调用, 序号] 元组表：序号恒为 number，调用恒有 [0] 动作名。
    const mountsAt = (): Array<[unknown, number]> =>
      poolLoader!.calls
        .map((call, index): [unknown, number] => [call, index])
        .filter(([call]) => (call as unknown[])[0] === "mount");
    manager.start("s5", "global");
    await pollUntil("旧代际已挂载", () => mountsAt().length >= 1);
    const firstMount = mountsAt()[0][1];
    // 受控重建（用户显式 connect）：强制换代际。
    await manager.connect("s5", "global");
    await pollUntil("新代际已挂载", () => mountsAt().length >= 2);
    const disposeAt = poolLoader!.calls.findIndex((call) => call[0] === "dispose");
    const secondMount = mountsAt()[1][1];
    expect(firstMount >= 0 && disposeAt > firstMount && secondMount > disposeAt).toBeTruthy();
  });
});

// B19 红测：summarize 禁用查询合并判定（@global ∪ projectRoot） ----
describe("B19 红测：summarize 合并禁用集", () => {
  it("B19：项目级条目合并 @global 与 projectRoot 禁用集（只取其一 → 红测）", async () => {
    const { dir, manager } = managerFixture("dsh-mcp-mgr2b19-");
    const srv = normalizeServer(quietServer("g1"));
    const proj = join(dir, "proj");
    manager.projectRoot = proj;
    manager.projectStore = new McpStore(join(proj, "mcp.json"));
    manager.projectStore!.data.servers = [srv];
    manager.projectStores.set(proj, manager.projectStore!);
    const mw = await manager.initMiddleware();
    manager.disabledTools.set(MIDDLEWARE_GLOBAL_ROOT, new Map([["g1", new Set(["toolA"])]]));
    manager.disabledTools.set(proj, new Map([["g1", new Set(["toolB"])]]));
    // 目录（裸名工具面）与池条目：项目级条目的禁用查询必须**合并**项目 root 与 @global 两个集合。
    catalogDirectory.projectWrappedTools({
      root: proj,
      serverName: "g1",
      definitions: [
        { name: "toolA", description: "", parameters: {} },
        { name: "toolB", description: "", parameters: {} },
      ],
    });
    mw.units.set(proj, {
      root: proj,
      connections: new Map([
        [
          "g1",
          {
            server: srv,
            id: "id-g1",
            handle: { disposed: false },
            status: "connected",
            error: undefined,
            connectedAt: Date.now(),
            readySettled: true,
            everConnected: true,
            disposed: false,
          },
        ],
      ]),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
      // 部分单元桩（status 字面量与探测字段超出域形状）：调用方只读域内面，收窄不断言。
    } as unknown as ProjectUnit);
    const s = summarizeOf(manager, srv, "project");
    expect([...(s.disabledTools ?? [])].sort()).toEqual(["toolA", "toolB"]);
  });
});

// #767 笔 1a（M5 = A）：ctx.mcpManager.getTools 的行为判据 ----
// 今天全仓零行为断言（只有 service-contract 的编译期类型断言 test/integration/service-contract.test.ts:127
// 与形参锁 :202）。本笔换了数据源（supervisor.toolMeta → 连接池单元表），必须把
// 「返回注册名」与「未连接 / 未知 server 返回 []」钉成行为判据。
describe("#767 笔 1a：ctx.mcpManager.getTools 行为判据", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2gt-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  /**
   * 最小 apply 宿主：`provide` 捕获核心化服务；loader / plugin / tools.schemas 支撑一条
   * 真装载链（官方 client 的 syncTools 在本夹具里由 OFFICIAL_MODULE.apply 代替）。
   */
  async function appliedService() {
    const provided = new Map<string, unknown>();
    const schemas: FakeToolEntry[] = [];
    const officialModule = {
      name: "test:official",
      // 真实引擎里这一步由官方 client 的 syncTools 做：把 `mcp__<serverName>__<tool>`
      // 写进宿主注册表。六态投影的 hasTools 与 getTools 的注册面因此同源。
      apply: (_pluginCtx: unknown, config: { serverName: string }) => {
        schemas.push({
          name: `mcp__${config.serverName}__echo`,
          description: "回显给定的文本",
        });
      },
    };
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {}, exporter: () => () => {} },
      tools: { register: () => () => {}, schemas: () => schemas },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn: () => unknown) => fn(),
      provide: (serviceName: string, service: unknown) => {
        provided.set(serviceName, service);
      },
      get: (serviceName: string) =>
        serviceName === "loader" ? { import: async () => officialModule } : undefined,
      plugin: (
        module: { apply?: (ctx: unknown, config: { serverName: string }) => unknown },
        config: { serverName: string },
      ) => {
        if (typeof module?.apply === "function") module.apply(ctx, config);
        return { await: async () => undefined, dispose: async () => {} };
      },
    };
    const store = new McpStore(join(homeDir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    await store.save();
    // 残缺宿主（只实现装配触达面）：按接缝收窄，装配语义不变。
    await apply(ctx as unknown as Context, {
      storePath: store.path,
      announceToAgent: false,
      announceCatalog: false,
    });
    // 提供方挂载的真服务（行为面由本组用例钉住），此处取其类型面。
    return { svc: provided.get("mcpManager") as McpManagerService, schemas };
  }

  /** 起一台全局服务器并等它在池里拿到 id（单池：进 @global 单元）。 */
  async function connectedService(svc: McpManagerService) {
    await svc.registerServer({
      name: "g1",
      transport: "stdio",
      command: "dsh-noop-cmd",
      reconnect: { enabled: false },
      enabled: true,
    });
    await pollUntil("池内条目拿到 id 且注册面命中", () => svc.getTools("g1").length > 0);
  }

  it("① 中间层接管的服务器返回非空且逐字是注册名（mcp__<id>__<tool>）", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    const tools = svc.getTools("g1");
    // 旧数据源（直连账本 toolMeta）只由已退役的那条路径填充 → 这里会恒返回 []。
    expect(tools.length, "非空（数据源换到池了）").toBeGreaterThan(0);
    // 逐字是注册名：`mcp__<id>__<tool>`，id 是装配期分配的不透明短 id（不是裸名、不是裸名加前缀）。
    expect(tools.map((tool) => tool.name)).toEqual([
      expect.stringMatching(/^mcp__[A-Za-z0-9_-]+__echo$/),
    ]);
    expect(tools[0].description).toBe("回显给定的文本");
  });

  it("① 否定：返回的不是裸名（改成裸名即红）", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    const names = svc.getTools("g1").map((tool) => tool.name);
    expect(names, "裸名口径（summary().tools / 目录读口）不在这里返回").not.toContain("echo");
    for (const name of names) expect(name.startsWith("mcp__")).toBe(true);
  });

  it("② 未知 server 返回 []", async () => {
    const { svc } = await appliedService();
    expect(svc.getTools("ghost")).toEqual([]);
  });

  it("② 未连接（断开后）返回 []", async () => {
    const { svc } = await appliedService();
    await connectedService(svc);
    await svc.disconnect("g1");
    expect(svc.getTools("g1"), "断开后条目已拆 → 不再返回工具").toEqual([]);
  });
});

// apply：配置分支 ----
describe("apply：配置分支", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-apply2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  // enabled:false：无路由、无 section、无 pre-step。
  // （cordis effect(fn, label) 语义：立即执行工厂取回 disposer。）
  function makeCtx() {
    const state: {
      preSteps: Array<(...args: unknown[]) => void>;
      sections: string[];
      routes: string[];
      disposers: Array<() => void>;
      injected: unknown[];
    } = { preSteps: [], sections: [], routes: [], disposers: [], injected: [] };
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route: { path: string }) => {
          state.routes.push(route.path);
          return () => {
            const i = state.routes.indexOf(route.path);
            if (i >= 0) state.routes.splice(i, 1);
          };
        },
      },
      systemPrompt: {
        section: (opts: { name: string }) => {
          state.sections.push(opts.name);
          return () => {
            const i = state.sections.indexOf(opts.name);
            if (i >= 0) state.sections.splice(i, 1);
          };
        },
      },
      inject: (keys: unknown, _cb: (services: unknown) => void) => {
        state.injected.push(keys);
        return () => {};
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === "agent/pre-step") state.preSteps.push(handler);
        return () => {};
      },
      effect: (fn: () => () => void) => {
        const disposer = fn();
        state.disposers.push(disposer);
        return disposer;
      },
    };
    return { ctx, state };
  }

  async function applied(options: Record<string, unknown> | undefined) {
    const { ctx, state } = makeCtx();
    // 残缺宿主（只实现装配触达面）：按接缝收窄，装配语义不变。
    await apply(ctx as unknown as Context, options);
    return { ctx, state };
  }

  it("禁用不注册路由", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.routes.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注入提示词", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注册 pre-step", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用仅注册 dispose effect", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.disposers.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // announceToAgent:false：有路由无 section；announceCatalog:false：无 pre-step。
  const disabledAnnounce = () =>
    applied({
      announceToAgent: false,
      announceCatalog: false,
      storePath: join(homeDir, "st.json"),
    });

  it("启用时注册全部路由", async () => {
    const { state } = await disabledAnnounce();
    expect(state.routes.length >= 9).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭宣告不注入提示词", async () => {
    const { state } = await disabledAnnounce();
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭目录不注册 pre-step", async () => {
    const { state } = await disabledAnnounce();
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // 默认开启：section + pre-step + settings 注入。
  const defaultOn = () => applied({ storePath: join(homeDir, "st2.json") });

  it("默认注入提示词 section", async () => {
    const { state } = await defaultOn();
    expect(state.sections.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("默认注册目录 pre-step", async () => {
    const { state } = await defaultOn();
    expect(state.preSteps.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("尝试注入 settings", async () => {
    const { state } = await defaultOn();
    expect(state.injected.some((k) => Array.isArray(k) && k.includes("settings"))).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("settings 注入回调通路（cb 收到 settings 服务即挂载成功）", async () => {
    const { ctx } = await defaultOn();
    // settings 注入回调挂 uiUpdate 的通路验证（cb 收到 settings 服务即挂载成功）。
    const settingsCalls: Array<[unknown, unknown]> = [];
    const settingsCtx = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: async (ns: unknown, patch: unknown) => settingsCalls.push([ns, patch]),
            },
          });
        }
        return () => {};
      },
    };
    // 残缺宿主（只实现 settings 注入面）：按接缝收窄。
    await apply(settingsCtx as unknown as Context, { enabled: false });
    expect(typeof settingsCalls).toBe("object");
  });

  // effect disposer：卸载时注销路由与提示词。
  function unloadFixture() {
    return applied({ storePath: join(homeDir, "st3.json") });
  }

  it("默认注册多个 effect disposer", async () => {
    const { state } = await unloadFixture();
    expect(state.disposers.length >= 2).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("卸载注销全部路由", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.routes.length).toBe(0);
  });

  it("卸载注销提示词", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.sections.length).toBe(0);
  });
});

// #569：catalogViewFor 合成注入端目录视图（B 起步 + 中间层覆盖 + 磁盘兜底） ----
describe("#569 catalogViewFor 合成注入端目录视图", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-catview-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });

  const catalogFileFor = (root: string) =>
    join(
      homeDir,
      "@wingsky-1",
      "dsh-mcp-manager",
      "catalog",
      `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`,
    );
  /** 单元夹具 + 目录登记：目录内存态归 catalog 域（#767 S1-3b），单元只留连接/禁用面。 */
  const unitFor = (
    root: string,
    catalogEntries: Record<
      string,
      {
        tools: Map<string, { description?: string; inputSchema?: unknown }>;
        unavailable?: string;
        discoveredAt: number;
      }
    >,
  ) => {
    catalogDirectory.dropRoot(root);
    for (const [serverName, entry] of Object.entries(catalogEntries)) {
      catalogDirectory.projectWrappedTools({
        root,
        serverName,
        definitions: [...entry.tools].map(([name, tool]) => ({
          name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      });
      if (entry.unavailable !== undefined) {
        catalogDirectory.markUnavailable(root, serverName, entry.unavailable);
        continue;
      }
      // 夹具要的是显式时间戳（1 = 很久以前），投影写口恒写 now，故就地校正。
      // 刚投影的条目恒存在，此处断言存在。
      catalogDirectory.serversFor(root)!.get(serverName)!.discoveredAt = entry.discoveredAt;
    }
    return {
      root,
      connections: new Map(),
      userDisabled: new Set(),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    };
  };
  // 目录视图输入面（只读 server.name/scope）：条目按读取面收窄，容器按被测签名收窄。
  const serversWith = (entries: Record<string, { server: { name: string }; scope: string }>) =>
    new Map(Object.entries(entries)) as unknown as Map<
      string,
      { server: ServerConfig; scope: string }
    >;

  async function catalogViewFixture() {
    // 项目 root 夹具用真实目录 + .git 标记：findProjectRoot 从该目录起步必然原样
    // 返回（跨平台确定，POSIX 字符串 "/proj" 在 Windows resolve 后形态不一致）。
    const projDir = join(homeDir, "proj");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const { manager } = makeManager(homeDir);
    const mw = { units: new Map() };
    // B 缓存基底：supervisor 路径旧摘要（应被中间层覆盖 / 保留兜底）。
    manager.catalogCache.set("g1", { summary: "B-global-g1" });
    manager.catalogCache.set("g2", { summary: "B-global-g2" });
    manager.catalogCache.set("p1", { summary: "B-project-p1" });
    manager.catalogCache.set("p2", { summary: "B-project-p2" });
    // 只有 units 面的池替身（目录视图不读池内条目）：按接缝收窄。
    manager.middleware = mw as unknown as McpManagerType["middleware"];
    // 目录内存态是域内单例（跨用例留存），每个场景从这里重新开始。
    catalogDirectory.dropRoot("@global");
    catalogDirectory.dropRoot(projDir);
    return { manager, mw, projDir };
  }

  /** 场景 1：无中间层单元 → 纯 B 视图（磁盘/摘要兜底；单池 #767 后与模式无关）。 */
  async function noUnitView() {
    const { manager, projDir } = await catalogViewFixture();
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("无单元时全局走 B", async () => {
    const { view } = await noUnitView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("无单元时项目走 B", async () => {
    const { view } = await noUnitView();
    expect(view.get("p1")?.summary).toBe("B-project-p1");
  });

  /** 场景 2：@global 单元含 g1（内存目录）→ 覆盖 B；p1 项目单元覆盖。 */
  async function unitView() {
    const { manager, mw, projDir } = await catalogViewFixture();
    mw.units.set(
      "@global",
      unitFor("@global", {
        g1: {
          discoveredAt: 1,
          tools: new Map([["g_search", { description: "Global search the web for facts." }]]),
        },
      }),
    );
    mw.units.set(
      projDir,
      unitFor(projDir, {
        p1: {
          discoveredAt: 1,
          tools: new Map([["p_read", { description: "Project read files." }]]),
        },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      g2: { server: { name: "g2" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("有单元时全局覆盖为中间层目录摘要", async () => {
    const { view } = await unitView();
    expect(view.get("g1")?.summary).toBe("Global search the web for facts.");
  });

  it("中间层无 g2 → 保留 B", async () => {
    const { view } = await unitView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });

  it("project scope 覆盖为项目单元摘要", async () => {
    const { view } = await unitView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  /** 场景 3：project scope → 项目单元；global scope 无 @global 单元 → B；
   *  场景 4：中间层有 unavailable → 视为无 → 磁盘兜底/保留 B。 */
  async function projectView() {
    const { manager, mw, projDir } = await catalogViewFixture();
    mw.units.clear();
    mw.units.set(
      projDir,
      unitFor(projDir, {
        p1: {
          discoveredAt: 1,
          tools: new Map([["p_read", { description: "Project read files." }]]),
        },
        p2: { discoveredAt: 1, tools: new Map(), unavailable: "discovery failed" },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      p1: { server: { name: "p1" }, scope: "project" },
      p2: { server: { name: "p2" }, scope: "project" },
    });
    return { view: await manager.catalogViewFor(projDir, servers) };
  }

  it("项目级有单元 → 走中间层目录", async () => {
    const { view } = await projectView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  it("全局无 @global 单元 → B", async () => {
    const { view } = await projectView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("unavailable 目录视为无 → 保留 B", async () => {
    const { view } = await projectView();
    expect(view.get("p2")?.summary).toBe("B-project-p2");
  });

  /** 场景 5：磁盘 last-good 兜底（单元缺失但 A 文件有该服务器）。 */
  async function diskView() {
    const { manager, mw } = await catalogViewFixture();
    mw.units.clear(); // 单元全部缺失
    const diskRoot = "@global";
    const file = catalogFileFor(diskRoot);
    mkdirSync(join(homeDir, "@wingsky-1", "dsh-mcp-manager", "catalog"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        root: diskRoot,
        entries: {
          g1: {
            discoveredAt: 1,
            tools: [{ name: "g_search", description: "Disk cached global search." }],
          },
        },
      }),
    );
    const servers = serversWith({
      g1: { server: { name: "g1" }, scope: "global" },
      g2: { server: { name: "g2" }, scope: "global" },
    });
    return { view: await manager.catalogViewFor(undefined, servers) };
  }

  it("单元缺失 → 磁盘 last-good 兜底", async () => {
    const { view } = await diskView();
    expect(view.get("g1")?.summary).toBe("Disk cached global search.");
  });

  it("磁盘无该服务器 → 保留 B", async () => {
    const { view } = await diskView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });
});

// #903 M4/M5-A：fire-and-forget 拒绝处理 + 缓存命中 settle ----
describe("#903 M4/M5-A：浮空拒绝记 warn、缓存命中同样 settle", () => {
  function regressionFixture() {
    const { dir, manager, log } = managerFixture("dsh-mcp-m4-");
    // 项目目录：<dir>/proj/.git（findProjectRoot 的真实标记，与 setSession 用例同形）。
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    return { dir, manager, log, proj };
  }

  it("M4-a：setSession 触达单元失败 → warn 落日志、调用方不抛", async () => {
    const { manager, log, proj } = regressionFixture();
    manager.middleware = {
      projectUnitFor: async () => {
        throw new Error("boom-touch");
      },
    } as unknown as McpManagerType["middleware"];
    // 反证：把 setSession 的拒绝处理删掉 → 无 warn，pollUntil 超时红。
    await manager.setSession(proj);
    await pollUntil("touch 失败 warn", () =>
      log.warn.some((message) => message.includes("setSession touch unit")),
    );
    expect(
      log.warn.some(
        (message) => message.includes("setSession touch unit") && message.includes("failed"),
      ),
    ).toBe(true);
  });

  it("M4-b：touchGlobalUnit 内层连接失败 → 外层 catch 记 warn", async () => {
    const { manager, log } = regressionFixture();
    const unit = { root: MIDDLEWARE_GLOBAL_ROOT, userDisabled: new Set<string>() };
    manager.middleware = {
      projectUnitFor: async () => unit,
      ensureConnected: async () => {
        throw new Error("boom-conn");
      },
    } as unknown as McpManagerType["middleware"];
    // 反证：把 .then 回调里的 await 改回内层 void → 外层 catch 接不到，warn 缺席红。
    (manager as unknown as { touchGlobalUnit: (name: string) => void }).touchGlobalUnit("g1");
    await pollUntil("touchGlobalUnit 失败 warn", () =>
      log.warn.some((message) => message.includes("touchGlobalUnit(g1) failed")),
    );
    expect(log.warn.some((message) => message.includes("touchGlobalUnit(g1) failed"))).toBe(true);
  });

  it("M5-A：缓存命中后旧扁平重现 → 再次 projectStoreFor 同样归位", async () => {
    const { manager, proj } = regressionFixture();
    const legacy = join(proj, ".dsh", "mcp.json");
    mkdirSync(join(proj, ".dsh"), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        servers: [{ name: "p-old", transport: "stdio", command: "pcmd" }],
      }),
    );
    const first = await manager.projectStoreFor(proj);
    expect(first!.data.servers.map((server) => server.name)).toContain("p-old");
    // 降级写：旧扁平重现（切旧分支/降级写回）。
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        servers: [{ name: "p-downgraded", transport: "stdio", command: "pcmd" }],
      }),
    );
    // 反证：命中分支去掉 settle 包装 → 旧文件永不归位，existsSync(legacy) 恒真红。
    const second = await manager.projectStoreFor(proj);
    expect(second).toBe(first);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.migrated.bak.2`)).toBe(true);
    // 目标不被历史覆盖：命中分支的 settle 只归档，读到仍是归位前的内容。
    expect(second!.data.servers.map((server) => server.name)).toContain("p-old");
  });
});
