/**
 * dsh-mcp-manager middleware unit：pool 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountLedger } from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { FakeToolsScript } from "../helpers.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecutionToken } from "@deepseek-ai/dsh-tools";
import type { DisabledToolsMap } from "../../src/server/store/interface.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { ServerConfig } from "../../src/server/config/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const { createRedactor } = await import("../../src/server/pipeline/interface.ts");
const { parseDisabledTools } = await import("../../src/server/store/interface.ts");

const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const remoteEntry = middlewareShape.remoteEntry.bind(middlewareShape);
const identity = middlewareShape.identity.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const ownTempDir = middlewareShape.ownTempDir.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

function registerPoolForwardingCases() {
  it("forwarding：执行中登记外层 token，结算后注销", async () => {
    const observed: unknown[][] = [];
    // 执行面在派发时才跑，此刻 fixture 已绑定：借它读同一实例的登记表（不必用 let 承接）。
    const fixture = poolFixture({
      execute: async () => {
        observed.push([...fixture.mw.forwarding]);
        return { isError: false, content: [], value: { content: [] } };
      },
    });
    const mw = fixture.mw;
    const token = Symbol("outer-call");
    await mw.callTool(
      fullServerName(ROOT, "py"),
      "echo",
      {},
      undefined,
      identity({ parent: token }),
    );
    // 登记必须在派发**之前**（guard 读的同一份集合），否则自家转发的子调用会被判成模型直呼。
    expect(observed).toEqual([[token]]);
    expect(mw.forwarding.size).toBe(0);
  });

  it("forwarding：execute 抛错时同样注销（异常路径不留永久放行位）", async () => {
    const fixture = poolFixture({
      execute: async () => {
        throw new Error("宿主执行面炸了");
      },
    });
    const mw = fixture.mw;
    const token = Symbol("outer-call");
    await expect(
      mw.callTool(fullServerName(ROOT, "py"), "echo", {}, undefined, identity({ parent: token })),
    ).rejects.toThrow(/调用失败/);
    expect(mw.forwarding.size).toBe(0);
  });

  it("拆除走账本：releaseConnection 摘账并让句柄 dispose 被发起", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    await mw.ensureConnected(ROOT, "ctx");
    // 真装载保证条目存在（ensureConnected 刚写入），此处断言存在。
    const entry = unit.connections.get("ctx")!;
    expect(mountLedger.get(entry.id!)).toBeDefined();
    expect(mw.releaseConnection(ROOT, "ctx")).toBe(true);
    // 摘账同步生效 + 句柄 dispose 已发起（只发起不等结算：拆除是同步语义）。
    expect(mountLedger.get(entry.id!)).toBeUndefined();
    expect(unit.connections.has("ctx")).toBe(false);
    // 真装载的句柄恒存在，此处断言存在。
    expect(entry.handle!.disposed).toBe(true);
    await expect(mountLedger.flushDisposals()).resolves.toBeUndefined();
    // 幂等：不在册的条目再拆返回 false（调用方据此决定要不要广播状态）。
    expect(mw.releaseConnection(ROOT, "ctx")).toBe(false);
  });

  it("evictIfNeeded 淘汰旧单元时逐条走账本拆除", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(
      new Map([
        [ROOT, servers],
        ["/root-old", servers],
      ]),
    );
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const oldUnit = makeUnit({ root: "/root-old" });
    oldUnit.lastTouchedAt = 1;
    mw.units.set("/root-old", oldUnit);
    await mw.ensureConnected("/root-old", "ctx");
    const entry = oldUnit.connections.get("ctx")!;
    expect(mountLedger.get(entry.id!)).toBeDefined();
    for (let index = 0; index < 17; index += 1) {
      const unit = makeUnit({ root: `/root-${index}` });
      unit.lastTouchedAt = 1000 + index;
      mw.units.set(`/root-${index}`, unit);
    }
    mw.evictIfNeeded(16);
    expect(mw.units.has("/root-old")).toBe(false);
    expect(mountLedger.get(entry.id!)).toBeUndefined();
    // 真装载的句柄恒存在，此处断言存在。
    expect(entry.handle!.disposed).toBe(true);
    await mountLedger.flushDisposals();
  });
}

function registerPoolStatusCases() {
  it("statusOf 读时刷新：曾连上 + 前缀消失 → reconnecting", async () => {
    const { mw, unit, tools } = poolFixture();
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("connected");
    // 官方在退避 / 预算耗尽时注销工具：前缀消失是「已掉线」唯一可判的时点，且必须现算——
    // 直读 entry.status 会永远停在装载窗口结算那一刻的 connected。
    tools.entries = [{ name: "mcp__other-id__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("reconnecting");
    expect(unit.connections.get("py")!.status).toBe("reconnecting");
  });

  it("statusOf 读时刷新：reconnect.enabled=false 时前缀消失 → failed（不再有后台重连）", async () => {
    const noReconnect = { ...PY, reconnect: { enabled: false } };
    const { host, tools } = makeHost(new Map([[ROOT, [noReconnect]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(noReconnect, "id-py"));
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(mw.statusOf(ROOT, "py")).toBe("connected");
    tools.entries = [];
    expect(mw.statusOf(ROOT, "py")).toBe("failed");
  });

  it("statusOf：虚拟连接恒 connected（配置 / 用户禁用才 disabled）", async () => {
    // 虚拟单元（toolDefinitions）没有官方实例、从不 mount：它不进六态投影，就地收敛。
    // 三处读点的另外两处（manager.summarize / /health）分别由 unit-manager2 与
    // unit-routes-sse 的用例钉住，同一份 statusOf 语义。
    const virtualServer: ServerConfig = {
      name: "cg",
      transport: "stdio",
      command: "codegraph",
      enabled: true,
      toolDefinitions: [],
    };
    const { host, tools } = makeHost(new Map([[ROOT, [virtualServer]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("cg", remoteEntry(virtualServer, undefined));
    // 注册面空无一物也必须 connected——虚拟连接的「已连上」不来自官方注册面。
    expect(tools.entries).toEqual([]);
    expect(mw.statusOf(ROOT, "cg")).toBe("connected");
    unit.userDisabled.add("cg");
    expect(mw.statusOf(ROOT, "cg")).toBe("disabled");
    unit.userDisabled.delete("cg");
    unit.connections.get("cg")!.server.enabled = false;
    expect(mw.statusOf(ROOT, "cg")).toBe("disabled");
  });
}

function registerPoolCatalogDiscoveryCases() {
  it("discover：按 mcp__<id>__ 前缀从注册面投影目录（剥前缀 + description/parameters 映射）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-disc-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    tools.entries = [
      {
        name: "mcp__id-py__alpha",
        description: "甲",
        parameters: { type: "object", properties: { a: {} } },
      },
      { name: "mcp__id-py__beta", description: "乙", parameters: { type: "object" } },
      { name: "mcp__other-id__gamma", description: "他 id", parameters: {} },
      { name: "no_prefix", description: "无前缀", parameters: {} },
    ];
    // 连接层在投影前一定会先建单元（projectUnitFor → ensureRootLoaded 让 root 在册）；
    // 这里按同一顺序复现，否则投影写口对未在册的 root 无表可写。
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    // discover 自 #767 S1-3b 起是 catalog 域的投影口：这里按连接层的实参形状调用
    // （schemas 取宿主注册面、cachePath 取宿主算好的目录缓存路径）。
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      cachePath: () => catalogHost.catalogCachePath(ROOT),
      redact: (error: unknown) => String(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    // 投影刚写入该条目，此处断言存在。
    const catalog = catalogDirectory.entryFor(ROOT, "py")!;
    // 只收本 id 前缀的两条，名字已剥前缀；他 id 与无前缀条目不得混入。
    expect([...catalog.tools.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(catalog.tools.get("alpha")).toEqual({
      description: "甲",
      inputSchema: { type: "object", properties: { a: {} } },
    });
    expect(catalog.tools.get("beta")!.description).toBe("乙");
    expect(catalog.unavailable).toBeUndefined();
  });
}

function registerPoolCatalogInvalidationCases() {
  // #1014 B7：显式失效压过 TTL 短路。TTL 是 24h 的兜底上限，不是刷新策略——
  // 此前 tools/change / 重连 / 手工刷新都没有落点，模型会一直看着已删除的 schema。
  it("显式失效压过 TTL：未登记失效时 TTL 短路不重投影，登记后立刻重投影", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-dirty-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    const project = async () => {
      await catalogDirectory.projectRegisteredTools({
        root: ROOT,
        serverName: "py",
        id: "id-py",
        schemas: tools.schemas(),
        cachePath: () => catalogHost.catalogCachePath(ROOT),
        redact: (error: unknown) => String(error),
        isRuntimeServer: () => false,
        warn: () => {},
      });
    };
    tools.entries = [
      { name: "mcp__id-py__alpha", description: "甲", parameters: {} },
      { name: "mcp__id-py__beta", description: "乙", parameters: {} },
    ];
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    await project();
    expect([...catalogDirectory.entryFor(ROOT, "py")!.tools.keys()].sort()).toEqual([
      "alpha",
      "beta",
    ]);
    // 远端删掉 beta：未登记失效 → TTL 短路，目录**不动**（这正是旧行为，也说明判据有效）。
    tools.entries = [{ name: "mcp__id-py__alpha", description: "甲", parameters: {} }];
    await project();
    expect([...catalogDirectory.entryFor(ROOT, "py")!.tools.keys()].sort()).toEqual([
      "alpha",
      "beta",
    ]);
    // 登记失效后同一份注册面立刻重投影，beta 消失。
    catalogDirectory.markDirty(ROOT, "py");
    expect(catalogDirectory.isDirty(ROOT, "py")).toBe(true);
    await project();
    expect([...catalogDirectory.entryFor(ROOT, "py")!.tools.keys()].sort()).toEqual(["alpha"]);
    // 投影成功即消费标记：再投影回到 TTL 短路。
    expect(catalogDirectory.isDirty(ROOT, "py")).toBe(false);
  });

  it("投影失败保留失效标记（不让一次失败把该服务器冻结 24h）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-dirty2-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    tools.entries = [{ name: "mcp__id-py__alpha", description: "甲", parameters: {} }];
    await catalogDirectory.ensureRootLoaded(ROOT, join(dir, "root.json"));
    catalogDirectory.markDirty(ROOT, "py");
    // cachePath 求值抛错 → 落盘链失败 → catch 收口成 unavailable；标记必须还在。
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      cachePath: () => {
        throw new Error("path boom");
      },
      redact: (error: unknown) => String(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(catalogDirectory.entryFor(ROOT, "py")!.unavailable).toBeDefined();
    expect(catalogDirectory.isDirty(ROOT, "py"), "失败后仍应重试").toBe(true);
  });
}

function registerPoolDirtyDropCases() {
  it("dropRoot 清该 root 的失效标记，不动别的 root", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-dirty3-")));
    // 本条只验 catalog 域的账本生命周期，不碰连接层：makeHost 仍要调（它装池侧端口并复位）。
    makeHost(new Map([[ROOT, [PY]]]));
    // 用**私有 root**而不是共享的 ROOT：本条会 dropRoot，而 catalogDirectory 是跨用例的
    // 单例——拿 ROOT 做 destructive 用例会拆掉后续用例仍在读的目录。
    const own = "/1014-drop-root";
    const other = "/1014-other-root";
    await catalogDirectory.ensureRootLoaded(own, join(dir, "a.json"));
    await catalogDirectory.ensureRootLoaded(other, join(dir, "b.json"));
    catalogDirectory.markDirty(own, "py");
    catalogDirectory.markDirty(other, "py");
    catalogDirectory.dropRoot(own);
    expect(catalogDirectory.isDirty(own, "py")).toBe(false);
    expect(catalogDirectory.isDirty(other, "py")).toBe(true);
  });

  it("dropServer 只清真被删掉那台的失效标记", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-dropserver-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      isRuntimeServer: () => false,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    // 条目只能由投影产生（ensureRootLoaded 建的是空表），故先投两台。
    for (const serverName of ["py", "other"]) {
      const id = "id-" + serverName;
      tools.entries = [{ name: `mcp__${id}__alpha`, description: "甲", parameters: {} }];
      await catalogDirectory.projectRegisteredTools({
        root: ROOT,
        serverName,
        id,
        schemas: tools.schemas(),
        cachePath: () => catalogHost.catalogCachePath(ROOT),
        redact: (error: unknown) => String(error),
        isRuntimeServer: () => false,
        warn: () => {},
      });
    }
    catalogDirectory.markDirty(ROOT, "py");
    catalogDirectory.markDirty(ROOT, "other");
    expect(catalogDirectory.dropServer(ROOT, "py"), "在册条目应删掉").toBe(true);
    expect(catalogDirectory.isDirty(ROOT, "py"), "被删掉那台的标记应清").toBe(false);
    expect(catalogDirectory.isDirty(ROOT, "other"), "另一台不受影响").toBe(true);
    // 不在册的名字 / 不在册的 root：早返回 false，且不得顺带清任何标记。
    expect(catalogDirectory.dropServer(ROOT, "not-there")).toBe(false);
    expect(catalogDirectory.dropServer("/no-such-root", "py")).toBe(false);
    expect(catalogDirectory.isDirty(ROOT, "other"), "未命中时不得动别人的标记").toBe(true);
  });
}

function registerPoolRefreshCases() {
  it("tools/change 后按 server diff 重投影：远端删掉的工具从目录消失（#1014 B7b）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-change-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      // projectConnectedCatalog 经 host 读这一面（runtime 条目不落盘），缺了会让整次投影
      // 走 unavailable 降级并把工具表清空——症状是「目录空了」，不是「夹具没造全」。
      isRuntimeServer: () => false,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    tools.entries = [
      { name: "mcp__id-py__alpha", description: "甲", parameters: {} },
      { name: "mcp__id-py__beta", description: "乙", parameters: {} },
    ];
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      cachePath: () => catalogHost.catalogCachePath(ROOT),
      redact: (error: unknown) => String(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect([...catalogDirectory.entryFor(ROOT, "py")!.tools.keys()].sort()).toEqual([
      "alpha",
      "beta",
    ]);
    // 远端删掉 beta 后触发 tools/change 的等价调用。
    tools.entries = [{ name: "mcp__id-py__alpha", description: "甲", parameters: {} }];
    await mw.reprojectCatalogs();
    expect([...catalogDirectory.entryFor(ROOT, "py")!.tools.keys()].sort()).toEqual(["alpha"]);
    // 注册面没变时不重投影。
    //
    // 这里断的是**条目对象引用**而不是 discoveredAt：重投影走 servers.set 换掉整个条目，
    // 引用变了即重投影过；引用不变即短路。discoveredAt 是 Date.now() 的毫秒分辨率——同一毫秒
    // 内改与不改数值相等，拿它当判据等于恒绿（复核实测：把短路改成恒 true 仍全绿）。
    const before = catalogDirectory.entryFor(ROOT, "py")!;
    await mw.reprojectCatalogs();
    expect(catalogDirectory.entryFor(ROOT, "py"), "注册面没变不应重投影").toBe(before);
  });

  // #1014 复核 P0-1：list_changed 最常见的形态是**只改描述/参数 schema**、工具名集合不动。
  // 只比裸名集合会让目录继续发旧描述，模型照旧参数调用——而这正是 issue §2 的目标面。
  it("tools/change 后只改 description 也重投影（不止增删）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-desc-")));
    const { host, tools } = makeHost(new Map([[ROOT, [PY]]]));
    const catalogHost = {
      ...host,
      isRuntimeServer: () => false,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(PY, "id-py"));
    tools.entries = [{ name: "mcp__id-py__alpha", description: "旧描述", parameters: {} }];
    await catalogDirectory.ensureRootLoaded(ROOT, catalogHost.catalogCachePath(ROOT));
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      cachePath: () => catalogHost.catalogCachePath(ROOT),
      redact: (error: unknown) => String(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(catalogDirectory.entryFor(ROOT, "py")!.tools.get("alpha")!.description).toBe("旧描述");
    // 工具名集合不变，只改描述。
    tools.entries = [{ name: "mcp__id-py__alpha", description: "新描述", parameters: {} }];
    await mw.reprojectCatalogs();
    expect(catalogDirectory.entryFor(ROOT, "py")!.tools.get("alpha")!.description).toBe("新描述");
  });

  it("discover：目录落盘失败 → unavailable 降级（discoveredAt 归零）", async () => {
    // 触发点说明：注册面读不到（schemas 抛错）**不会**走到这个降级——registeredSchemas 按设计
    // 吞掉读取异常并当空处理（读不到注册表不许阻塞投影）。真正能触发 catch 的是落盘链：
    // 调用点给出的 cachePath（host.catalogCachePath(root)）求值在 catalog 域的 try 之外。
    // 凭据取自「在册服务器」的 env：脱敏源就是它，所以这里必须真带一个凭据值。
    const withSecret = { ...PY, env: { MCP_TOKEN: "sekrit" } };
    const { host, tools } = makeHost(new Map([[ROOT, [withSecret]]]));
    const brokenHost = {
      ...host,
      catalogCachePath: () => {
        throw new Error("目录缓存路径不可用 token=sekrit");
      },
    };
    // 部分宿主（catalogCachePath 故意抛错的坏路径面）：按接缝收窄。
    const mw = trackMw(new McpMiddleware(brokenHost as unknown as MiddlewareHost));
    const unit = makeUnit();
    mw.units.set(ROOT, unit);
    unit.connections.set("py", remoteEntry(withSecret, "id-py"));
    tools.entries = [{ name: "mcp__id-py__alpha", description: "甲", parameters: {} }];
    // 同上一例：先让 root 在册，投影失败才会落在已有条目上翻成 unavailable。
    await catalogDirectory.ensureRootLoaded(
      ROOT,
      join(ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-seed-"))), "none.json"),
    );
    await catalogDirectory.projectRegisteredTools({
      root: ROOT,
      serverName: "py",
      id: "id-py",
      schemas: tools.schemas(),
      // 路径求值本身要抛：缓存路径 thunk 在 persistRoot 内才求值，等价复现连接层
      // host.catalogCachePath 在投影 try 之外求值的失败面。
      // 路径 thunk 本就不取参（调用即抛），此处按其签名调用。
      cachePath: () => brokenHost.catalogCachePath(),
      // 脱敏器形状与连接层一致：全部在册服务器作为凭据词根来源。
      redact: (error: unknown) => createRedactor([withSecret])(error),
      isRuntimeServer: () => false,
      warn: () => {},
    });
    // 投影失败落在已有条目上（上一段 ensureRootLoaded 已建条目），此处断言存在。
    const catalog = catalogDirectory.entryFor(ROOT, "py")!;
    expect(catalog.discoveredAt).toBe(0);
    // last-good 保留（#1014 §2「失败保留 last-good」）：落盘失败是本地问题，与远端工具清单
    // 无关。此前这里断言 tools 为空——一次落盘失败就把这台服务器在模型视野里变成
    // 「没有工具」，而目录读口已经带 unavailable 段足以表达「这份快照不新鲜」。
    // 断言锁的是「远端明明报了 alpha，失败后仍在」：把它改回清空即红。
    expect([...catalog.tools.keys()]).toEqual(["alpha"]);
    // 真脱敏器的替换词是 [REDACTED]（fake pipeline 里的 *** 是另一套夹具，别混）。
    expect(catalog.unavailable).toBe("目录缓存路径不可用 token=[REDACTED]");
  });
}
const PY: ServerConfig = { name: "py", transport: "stdio", command: "python", enabled: true };
function poolFixture(toolsScript: FakeToolsScript = {}) {
  const { host, tools } = makeHost(new Map([[ROOT, [PY]]]), toolsScript);
  const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
  const unit = makeUnit();
  mw.units.set(ROOT, unit);
  unit.connections.set("py", remoteEntry(PY, "id-py"));
  return { mw, unit, tools, host };
}
describe("#767 S1-4d：池的转发登记、拆除走账本与读时刷新", () => {
  /** 一个远端条目 + 假宿主执行面的池：执行面按 script 给结果（缺省空成功）。 */

  registerPoolForwardingCases();
  registerPoolStatusCases();
  registerPoolCatalogDiscoveryCases();
  registerPoolCatalogInvalidationCases();
  registerPoolDirtyDropCases();
  registerPoolRefreshCases();
});

describe("#767 S1-4d：guard 判发起者", () => {
  function guardFixture(disabledMap: DisabledToolsMap) {
    const guards = new Map();
    const ctx = {
      tools: { register: () => () => {} },
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        guards.set(evt, handler);
        return () => {};
      },
    };
    const host = {
      ctx,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => [],
      globalServers: () => [],
      normalizedProjectRoot: async (cwd: string | undefined) =>
        cwd === "/proj" ? "/proj" : undefined,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: middlewareShape.catalogCachePath,
      isGlobalServer: () => false,
    };
    const resolveRoot = async (agent: unknown) =>
      (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd ===
      "/proj"
        ? "/proj"
        : undefined;
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    // 部分宿主（只实现路由触达的 tools/on 面）：按接缝收窄，装配语义不变。
    registerMiddlewareTools(ctx as unknown as Context, mw, resolveRoot, {
      disabledTools: disabledMap,
    });
    return { guards, mw };
  }

  it("exec.parent 在 forwarding 集合内 → 放行（不再做工具级裁决）", async () => {
    const { guards, mw } = guardFixture(parseDisabledTools({ "@global": { my: ["t"] } }));
    // 转发身份是测试自造的 plain symbol（域内仅作 Set 身份键、不读 brand 面）。
    const token = Symbol("forwarded") as unknown as ToolExecutionToken;
    mw.forwarding.add(token);
    const decision = await guards.get("tools/pre-execute")(
      { name: "mcp__my__t", parent: token, agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    // 同一名字在计划外（下面那条用例）会被禁用表拒绝：能否放行完全取决于发起者身份。
    expect(decision.kind).toBe("allow");
  });

  it("同名但 parent 不在集合内 → 仍被工具级禁用拒绝", async () => {
    const { guards } = guardFixture(parseDisabledTools({ "@global": { my: ["t"] } }));
    const decision = await guards.get("tools/pre-execute")(
      {
        name: "mcp__my__t",
        parent: Symbol("not-registered"),
        agent: { session: { header: { cwd: "/proj" } } },
      },
      async () => ({ kind: "allow" }),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toMatch(/已被用户在「MCP」浮窗禁用/);
  });

  // #1014 B5 / 不变量 I-E：mw.forwarding 是 mcp__ 直呼**唯一**的放行位。
  // 上一条只证明「集合外被拒」，没证明「集合内必须是飞行中的 token」——若放行改按
  // (root, server) 这类**可重放**键判定，前者仍绿。此条把 token 的时效性钉住。
  it("转发结算后（token 已摘除）同一 token 重放直呼 → 拒", async () => {
    const { guards, mw } = guardFixture(parseDisabledTools({}));
    const token = Symbol("forwarded") as unknown as ToolExecutionToken;
    mw.forwarding.add(token);
    const guard = guards.get("tools/pre-execute");
    const inFlight = await guard(
      { name: "mcp__my__t", parent: token, agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    expect(inFlight.kind).toBe("allow");
    // dispatch 的 finally 摘除 token 后，同一个 token 不应再有放行权。
    mw.forwarding.delete(token);
    const replayed = await guard(
      { name: "mcp__my__t", parent: token, agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    expect(replayed.kind).toBe("deny");
    expect(replayed.reason).toContain("ws_mcp_call");
  });

  // 文案纪律：deny 是模型唯一能看到的自我纠正依据，冗长会挤占上下文并诱发重试。
  it("兜底拒的文案短且指路 ws_mcp_call", async () => {
    const { guards } = guardFixture(parseDisabledTools({}));
    const decision = await guards.get("tools/pre-execute")(
      { name: "mcp__my__t", agent: { session: { header: { cwd: "/proj" } } } },
      async () => ({ kind: "allow" }),
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toContain("ws_mcp_call");
    // 长度断**字符数**而不是句数：按「。」断句对不含中文句号的文案恒返回长度 1 的数组，
    // 判据等于真空（复核实测：文案追加 4 句仍全绿）。字符数与语言无关，膨胀即红。
    expect(decision.reason.length, "兜底拒文案过长会挤占上下文并诱发重试").toBeLessThanOrEqual(160);
    // README 已承诺「写明不要重试本次调用」，此前代码与测试都没有任何判据钉它。
    expect(decision.reason).toContain("不要重试");
  });
});
