/** Manager 方法面的自然职责测试与专属fixture。 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import { mountLedger } from "../../src/server/servers/lifecycle/interface.ts";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  makeManager,
  makeTempDir,
  poolLoader,
  setupManagerTestLifecycle,
  summaryView,
} from "./manager-shape-support.ts";

import {
  registered,
  registerRuntimeInjectionHooks,
} from "./manager-shape-runtime-injection-fixture.ts";
setupManagerTestLifecycle();
describe("#413 all 模式 runtime 注入归一中台", () => {
  registerRuntimeInjectionHooks();

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
