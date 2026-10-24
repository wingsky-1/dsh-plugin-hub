/**
 * dsh-mcp-manager — integration：apply 组合根装配面（守卫计数、装载域接线、升级链、源码序、getTools）。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」列为
 * 集成层的许可导入面，本文件的被测对象**就是 `apply()` 本身**——它在 src/index.ts 内就地定义
 * （包自己的架构计划「各落点域端口化之后才谈把它再拆出去」把它压在组合根里），全仓无第二出口，
 * 故单元层不存在合法导入面。断言与其夹具自原 apply-lifecycle.test.ts 逐字迁来，未改判据。
 *
 * 覆盖：
 * - D8：mcp__ 直呼命中禁用表 → deny（guard 已挂载 + 命中毒表）
 * - #1014 B4：pre-execute 守卫单一注册点（按事件名计数）
 * - 组合根接线：mountServer 经宿主 loader 装载、id 进账本、六态投影、跨 root 同名各自成条、卸载复位
 * - apply 的升级链失败穿透（旧用户状态不可读 → fail-closed）
 * - 装配顺序（源码序锁定）：升级链 await 跑完才装读存储的域
 * - #767 笔 1a：ctx.mcpManager.getTools 行为判据（注册名 / 未知 server / 断开后）
 * - 前端 POST /config 不会覆盖抹除已有的 debug 配置
 *
 * settings 注入与降级、配置分支、pre-step/disposer 三个自然职责段已拆至
 * apply-settings-shape.test.ts / apply-config-shape.test.ts / apply-listeners-shape.test.ts
 * （#1174 shape 拆分，fullName 与断言逐字保留）。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { fakeManagerCtx, pollUntil } from "../helpers.ts";
import type { FakeToolEntry } from "../helpers.ts";
import { baseCtx, makeTempDir, releaseTempDirs } from "./remaining-apply-support.ts";

// apply 与 resolveDebugConfig 都是组合根内就地定义、单元层无合法导入面的符号——本层经包入口取
// 它们（§8 矩阵：包产物入口是集成层的许可导入面）。
const { apply, resolveDebugConfig } = await import("../../src/index.ts");
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
import type { McpManagerService } from "../../src/shared/interface.ts";
const { McpStore, saveDisabledTools } = await import("../../src/server/store/interface.ts");
const { mountLedger, mountServer, releaseLifecycle } =
  await import("../../src/server/servers/lifecycle/interface.ts");

afterEach(() => {
  releaseTempDirs();
});

describe("D8：mcp__ 直呼命中禁用表 → deny", () => {
  async function applyOffModeWithDisabledTool() {
    const dir = makeTempDir("dsh-mcp-manager-d8-");
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    const guards = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        guards.set(evt, handler);
        return () => {};
      },
    });
    // 预置工具级禁用表（manager.userStatePath = DSH_HOME/dsh-mcp-user-state.json）。
    const disabled = new Map([["@global", new Map([["svc", new Set(["use_t"])]])]]);
    await saveDisabledTools(join(dir, "dsh-mcp-user-state.json"), disabled);
    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    const restore = () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    };
    return { guards, restore };
  }

  it("D8：pre-execute guard 已挂载", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      const guard = guards.get("tools/pre-execute");
      expect(typeof guard === "function").toBeTruthy();
    } finally {
      restore();
    }
  });

  it("D8：mcp__ 直呼命中禁用表 → deny", async () => {
    const { guards, restore } = await applyOffModeWithDisabledTool();
    try {
      // guard 已挂载由上一用例保证（同一装配器），此处非空。
      const guard = guards.get("tools/pre-execute")!;
      const decision = (await guard(
        { name: "mcp__svc__use_t", agent: { session: { header: {} } } },
        async () => ({ kind: "allow" }),
      )) as { kind: unknown };
      expect(decision.kind).toBe("deny");
    } finally {
      restore();
    }
  });
});

describe("#1014 B4：pre-execute 守卫单一注册点", () => {
  async function countPreExecuteSubscriptions() {
    const dir = makeTempDir("dsh-mcp-manager-b4-");
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    const seen: string[] = [];
    const ctx = baseCtx({
      on: (evt: string) => {
        seen.push(evt);
        return () => {};
      },
    });
    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    const restore = () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    };
    return { seen, restore };
  }

  it("apply 后 tools/pre-execute 恰好注册一次", async () => {
    const { seen, restore } = await countPreExecuteSubscriptions();
    try {
      const count = seen.filter((evt) => evt === "tools/pre-execute").length;
      // 恒等于 1，故「事件名拼错 → 计数 0」「多注册点 → 计数 2」两种漂移都会红；
      // 不需要另配对照判据（复核时曾加过一条 seen.length > 0，它守不住上面任何一种）。
      expect(count, "pre-execute 守卫必须单点注册（多注册点会让 mcp__ 裁决出现分歧）").toBe(1);
    } finally {
      restore();
    }
  });
});

describe("组合根接线：装载生命周期域（#767 S1-4c）", () => {
  afterEach(() => {
    releaseLifecycle();
  });

  /**
   * 假宿主上只多给两样：loader 服务（官方 loader 是宿主服务，bindHost 经 ctx.get 现取）与
   * plugin（挂载入口）。工具注册面按当次装载的 serverName 造一个前缀命中项——官方不暴露状态
   * API，注册面是六态投影唯一能观测「已连上」的输入面（设计 §3.1 输入面 B）。
   */
  function wiringCtx() {
    const mounts: Array<{ mod: unknown; config: { serverName: string } }> = [];
    const disposers: Array<() => unknown> = [];
    const ctx = baseCtx({
      get: (name: string) =>
        name === "loader"
          ? { import: async () => ({ name: "mcp-client", apply: () => {} }) }
          : undefined,
      plugin: (mod: unknown, config: { serverName: string }) => {
        mounts.push({ mod, config });
        return { await: async () => {}, dispose: async () => {} };
      },
      tools: {
        register: () => () => {},
        schemas: () =>
          mounts.length === 0
            ? []
            : [{ name: `mcp__${mounts[mounts.length - 1].config.serverName}__echo` }],
      },
      effect: (fn: () => () => void) => {
        const inner = fn();
        disposers.push(inner);
        return () => {
          void inner();
        };
      },
    });
    return { ctx, mounts, disposers };
  }

  const server = { name: "svc", transport: "stdio" as const, command: "echo", enabled: true };

  it("apply 之后域已装配：mountServer 经宿主 loader 装载，id 进账本、状态投影到 connected", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, mounts } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });

    const states: string[] = [];
    const result = await mountServer({
      root: "/tmp/proj",
      server,
      onState: (state: string) => states.push(state),
    });

    expect(result.outcome).toMatchObject({ kind: "settled", state: "connected" });
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{1,32}$/u);
    expect(mountLedger.get(result.id)?.key).toBe(result.id);
    // 交给官方的 serverName 是 id 表分配的注册名，不是用户写的 bare 名。
    expect(mounts.map((m) => m.config.serverName)).toEqual([result.id]);
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("跨 root 同名各自成条：两个 root 都拿到独立注册名（不再是后到跳过）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, mounts } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });

    const a = await mountServer({ root: "/tmp/proj-a", server, onState: () => {} });
    const b = await mountServer({ root: "/tmp/proj-b", server, onState: () => {} });

    expect(a.id).not.toBe(b.id);
    expect(mountLedger.size).toBe(2);
    expect(mounts.map((m) => m.config.serverName)).toEqual([a.id, b.id]);
  });

  it("卸载后域被复位：mountServer 报未装配（组合根漏装即抛，不静默空装）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-wire-");
    const { ctx, disposers } = wiringCtx();
    await apply(ctx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") });
    for (const dispose of disposers) await dispose();

    await expect(mountServer({ root: "/tmp/proj", server, onState: () => {} })).rejects.toThrow(
      /servers\/lifecycle 域未装配/,
    );
  });
});

describe("apply 的升级链失败穿透", () => {
  it("旧用户状态不可读 → apply 抛错", async () => {
    const homeDir = makeTempDir("dsh-mcp-apply-fail-");
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = homeDir;
    try {
      // 旧用户状态落点（LEGACY_LAYOUT.userState）做成目录：读源即抛 EISDIR
      //（确定性失败，不依赖权限位）；config 项被显式 storePath 接管整项跳过，不影响本判据。
      mkdirSync(join(homeDir, "dsh-mcp-user-state.json"));
      await expect(
        apply(baseCtx() as unknown as Context, {
          enabled: false,
          storePath: join(homeDir, "mcp.json"),
        }),
      ).rejects.toThrow(/不可读/);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});

/**
 * 装配顺序（源码序锁定）：升级链必须 await 跑完，才轮到任何读存储的域。
 *
 * 为什么只能钉源码顺序：运行期能观测到的只有「apply 的 promise resolve 时链已跑完」（本文件上方
 * 那条 fail-closed 用例就是它的运行期面），而**装配体内**的先后没有观测量——把 installUpgrade 挪到
 * `store.load()` 之后，各域读着被搬走一半的磁盘跑起来，假 ctx 装配照样成功。组合根里唯一可判的形态
 * 就是源码文本的先后（同先例：dsh-provider-usage report-routes/composition-root.test.ts 的装配序锁定）。
 */

describe("装配顺序：升级链 await 跑完才装读存储的域", () => {
  const applySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.ts"),
    "utf8",
  );

  it("升级域是 await 装配方（漏掉 await 即红）", () => {
    expect(applySrc.indexOf("await installUpgrade({")).toBeGreaterThan(-1);
  });

  it("先复位 upgrade 装配标记再装配（release 晚于 install 即红）", () => {
    const release = applySrc.indexOf("releaseUpgrade();");
    const install = applySrc.indexOf("await installUpgrade({");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(install);
  });

  it("升级链早于存储装载（迁移必须早于任何读存储的域）", () => {
    const install = applySrc.indexOf("await installUpgrade({");
    const load = applySrc.indexOf("await store.load();");
    expect(install).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(install).toBeLessThan(load);
  });
});

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

describe("前端 POST /config 不会覆盖抹除已有的 debug 配置", () => {
  async function updateUiOnly() {
    // 原文件里的 tempDir() 是那个文件的 mkdtempSync 助手，这里改用本层同形态的 makeTempDir
    // （同一 mkdtempSync 隔离目录、同一 afterEach 回收；前缀沿用原命名便于认产物）。
    const dir = makeTempDir("mcp-stats-test-");
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager(fakeManagerCtx(), store);

    let persistedSettings = {
      ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 },
      debug: { callStats: true, statsFile: "/tmp/custom.json" },
    };

    manager.uiConfigSource = () => persistedSettings;
    manager.uiUpdate = async (patch) => {
      // 模拟 settings.update 行为：合并 patch，不抹除不在 patch 中的字段
      persistedSettings = { ...persistedSettings, ...patch };
      return persistedSettings;
    };

    // 前端更新 UI（只提交扁平 UI 参数）
    await manager.updateUiConfig({ position: "bottom-left", offsetX: 10, offsetY: 20 });
    return {
      persisted: () => persistedSettings,
      debugCfg: () => resolveDebugConfig(undefined, persistedSettings),
    };
  }

  it("更新 UI 后 debug.callStats 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.callStats).toBe(true);
  });

  it("更新 UI 后 debug.statsFile 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.statsFile).toBe("/tmp/custom.json");
  });

  it("debug 解析依然生效（callStats）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().callStats).toBe(true);
  });

  it("debug 解析依然生效（statsFile）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().statsFile).toBe("/tmp/custom.json");
  });
});
