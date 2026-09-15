/**
 * dsh-mcp-manager — 组合根层的真实 cordis Context 集成测试（§8.1 的「组合根」行）。
 *
 * 测什么：组合根机制的**三条纪律**——宿主上下文只到组合根（域拿到的是一份收窄后的能力面）、装配成对
 * 且释放逆序、每个域复位自己的装配标记。驱动它的是本文件里的**夹具域**：真实各域尚未经这条机制接线，
 * 探针要证的是机制本身，不是某个域的业务。
 *
 * 为什么机制物理不在包入口：入口的**任何新导出**都会让 export-surface-snapshot 判红（B1.4 的硬判据是
 * 入口导出面零 diff），而写在入口又不导出的函数测试不可达。入口尚未接线——截至 #767 B2b，组合根仍走模块求值期的静态 installXxx、并在 apply 内直接
 * installUpgrade/releaseUpgrade，对这三个函数零调用；处置（接线或收窄/删除）归 B3，见 v5 附录 H。
 *
 * 为什么用真 Context 而不是假 ctx：ctx.effect 的卸载时机、ctx.on 的作用域与摘除、ctx.provide 的可见性
 * 都是宿主行为，夹具替代会把「装配顺序 / 释放逆序」测成对夹具的断言。宿主服务（webServer / tools /
 * systemPrompt）是假的，但事件总线、effect 与 lifecycle 全是真的。落盘面不参与本文件。
 */
import { Context } from "@deepseek-ai/cordis";
import type { Events, Fiber } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { afterAll, describe, expect, it } from "vitest";

import type { McpManagerService } from "../../src/index.ts";
import {
  assemble,
  bindHost,
  OFFICIAL_MCP_CLIENT_SPECIFIER,
  safeDisposeAll,
} from "../../src/server/shared/interface.ts";
import type { DomainSpec, HostFaces } from "../../src/server/shared/interface.ts";
import { fakeLoaderPort, pollUntil, tempDshHome } from "../helpers.ts";

// ---------------------------------------------------------------- 编译期锁
// 入口的声明合并必须让消费方按包名取到服务类型面：声明合并搬出入口、或键改成别的字面量，这条先红。
// 本文件不带 @ts-nocheck，故 service-contract-wiring 的 tsc 面真的会编译它（与那两包同口径）。
type Assert<T extends true> = T;
type EntryFace = Context["mcpManager"];
type EntryDeclaresService = Assert<
  EntryFace extends McpManagerService ? (McpManagerService extends EntryFace ? true : false) : false
>;

/**
 * 入口模块面：DSH_HOME 必须先于被测模块求值——本包若干单例的落盘路径在构造时定下，装反了就会写进真实
 * 的宿主 home（正在跑的 dsh web 那一份）。探针自己不动磁盘，但入口的静态图里有落盘面。
 */
const home = tempDshHome();
const entry = await import("../../src/index.ts");

afterAll(() => {
  home.dispose();
});

// ---------------------------------------------------------------- 夹具域

/** 夹具域的外加观测面：装配标记必须能被测试读到（它是「域复位自己」的唯一凭据）。 */
interface FixtureDomain extends DomainSpec<HostFaces> {
  readonly log: readonly string[];
  installed(): boolean;
}

/** 夹具域的故障注入点：装配中抛 / 释放中抛（真实的域两种都会发生）。 */
interface FixtureFaults {
  failInstall?: boolean;
  failRelease?: boolean;
}

/**
 * 造一个夹具域：只保留机制要管的三件事——装配标记、装配期从能力面取一样能力、装配与释放各记一行。
 *
 * 标记与抛错是**域自己的**责任（组合根不持有域的安装状态）：重复装配当场抛、释放时复位，两者都在这里，
 * 与参照包 upgradeRunner 的形态一致。
 */
function makeDomain(name: string, log: string[], faults: FixtureFaults = {}): FixtureDomain {
  let installed = false;
  return {
    name,
    log,
    installed: () => installed,
    install(host) {
      if (installed) throw new Error("fixture:" + name + " 只能装配一次");
      // 真的从能力面取一样东西：证明组合根递进来的是能力，而不是又一个宽上下文。
      host.logger.warn("install:" + name);
      if (faults.failInstall === true) throw new Error("install 失败：" + name);
      installed = true;
      log.push("install:" + name);
    },
    release() {
      installed = false;
      log.push("release:" + name);
      if (faults.failRelease === true) throw new Error("release 失败：" + name);
    },
  };
}

// ---------------------------------------------------------------- 宿主夹具

/** 宿主注册表里预置的一条工具 schema：schemas 转发探针拿它比对象身份，不另造投影。 */
const SEED_TOOL_SCHEMA = { name: "mcp__itest__seed", description: "", parameters: {} };

/** 组合根够得着的三样宿主服务：只实现被调用的那一面，并记下调用现场。 */
function makeHostServices() {
  const routes: string[] = [];
  const tools: string[] = [];
  const sections: string[] = [];
  const provided: string[] = [];
  const removals: string[] = [];
  const toolSchemas: Array<typeof SEED_TOOL_SCHEMA> = [SEED_TOOL_SCHEMA];
  let schemaCalls = 0;
  return {
    routes,
    tools,
    sections,
    provided,
    removals,
    toolSchemas,
    get schemaCalls() {
      return schemaCalls;
    },
    webServer: {
      register(route: WebRoute) {
        routes.push(route.path);
        return () => {
          removals.push(route.path);
        };
      },
    } as unknown as Context["webServer"],
    toolRuntime: {
      register(definition: ToolDefinition) {
        tools.push(definition.name);
        return () => {};
      },
      schemas() {
        schemaCalls += 1;
        return toolSchemas;
      },
    } as unknown as Context["tools"],
    systemPrompt: {
      section(section: { name: string }) {
        sections.push(section.name);
        return () => {};
      },
    } as unknown as Context["systemPrompt"],
    expose: {
      provide(name: string) {
        provided.push(name);
        return () => {};
      },
    },
  };
}

interface Mounted {
  readonly root: Context;
  readonly fiber: Fiber;
  readonly host: ReturnType<typeof makeHostServices>;
  /** 宿主日志出口收到的 warn 文案（夹具域真的从能力面的 logger 出了一声）。 */
  readonly warns: readonly string[];
}

/**
 * 按真实挂载顺序装配：先 provide 宿主服务，再 ctx.plugin(组合根)。
 *
 * 组合根体本应是 bindHost → assemble →
 * ctx.effect(() => () => safeDisposeAll(disposers)) 这三行；入口尚未接线（见上）。
 * 本文件的每个用例都从这一条链出发，测的是这条链本身。
 */
async function mount(domains: readonly DomainSpec<HostFaces>[]): Promise<Mounted> {
  const host = makeHostServices();
  const root = new Context();
  // 日志出口要在装配之前挂上：夹具域的 warn 发生在装配期。
  const warns: string[] = [];
  root.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      if (message.type === "warn") warns.push(String(message.args[0]));
    },
  });
  root.provide("webServer", host.webServer);
  root.provide("tools", host.toolRuntime);
  root.provide("systemPrompt", host.systemPrompt);
  const fiber = await root.plugin({
    name: "itest:composition-root",
    // 依赖未就绪就不装配：这三样是 bindHost 直接读的宿主服务。
    inject: ["webServer", "tools", "systemPrompt"],
    apply: async (ctx: Context) => {
      const faces = bindHost(ctx);
      const disposers = await assemble(faces, domains);
      ctx.effect(() => () => {
        safeDisposeAll(disposers);
      });
    },
  });
  await fiber.await();
  return { root, fiber, host, warns };
}

// ---------------------------------------------------------------- 能力面

describe("组合根：宿主上下文只到组合根", () => {
  it("bindHost 交付能力而不是上下文：逐项转发到宿主，收窄后的面里没有 ctx 本身", async () => {
    const { root, fiber, host, warns } = await mount([makeDomain("store", [])]);
    const faces = bindHost(fiber.ctx);

    // logger 是活的宿主出口：夹具域在装配期出的那一声必须落到宿主的 exporter 上。
    expect(warns).toEqual(["install:store"]);
    // 收窄是**减法**：能力面里没有上下文本体，也没有未收窄的宿主服务。
    expect("ctx" in faces).toBe(false);
    expect("webServer" in faces).toBe(false);
    expect("on" in faces).toBe(false);
    // loader 是新增的第 7 样能力；它取 loader 服务走的 `get` 与装载走的 `plugin` 都不得顺带出门。
    expect("loader" in faces).toBe(true);
    expect("get" in faces).toBe(false);
    expect("plugin" in faces).toBe(false);
    expect("effect" in faces).toBe(false);

    faces.register.register({ path: "/itest/route", kind: "exact" } as unknown as WebRoute);
    expect(host.routes).toEqual(["/itest/route"]);
    faces.tools.register({ name: "itest_tool" } as unknown as ToolDefinition);
    expect(host.tools).toEqual(["itest_tool"]);
    faces.prompt.section({ name: "itest:section" } as never);
    expect(host.sections).toEqual(["itest:section"]);
    // expose 直接挂宿主上下文（不经夹具）：能取回来才算挂上了。
    const service = { apiVersion: 2 };
    faces.expose.provide("itest.service", service);
    expect(root.get("itest.service", false)).toBe(service);
  });

  it("tools.schemas 真转发到宿主注册表，且扩 Pick 之后能力面仍是减法", async () => {
    const { fiber, host } = await mount([]);
    const faces = bindHost(fiber.ctx);

    // 返回宿主那一份对象本身（不复制成快照）：六态投影要在服务器掉线后立刻看到注册面变化，
    // 复制出的快照会让已断开的服务器永远显示 connected。
    expect(faces.tools.schemas()).toBe(host.toolSchemas);
    expect(host.schemaCalls).toBe(1);
    host.toolSchemas.push({ name: "mcp__late__pong", description: "", parameters: {} });
    expect(faces.tools.schemas().map((schema) => schema.name)).toEqual([
      "mcp__itest__seed",
      "mcp__late__pong",
    ]);
    // 扩 Pick 不等于把 ctx.tools 整份放出门：注册表上其余能力都不在面里。
    for (const wider of ["execute", "restrict", "get", "guard", "register"]) {
      expect(wider in faces.tools).toBe(wider === "register");
    }
    expect("ctx" in faces).toBe(false);
    expect("get" in faces).toBe(false);
    expect("plugin" in faces).toBe(false);
  });

  it("events.onPreStep 订阅落在宿主事件总线上，摘除后不再收到", async () => {
    const { root, fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);
    const seen: string[] = [];
    const off = faces.events.onPreStep((payload, next) => {
      seen.push(payload.agent.id);
      return next();
    });

    type PreStepNext = Parameters<Events["agent/pre-step"]>[1];
    const next: PreStepNext = () => Promise.resolve(undefined as never);
    const payload = {
      agent: { id: "itest-agent" } as Agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    };
    // 作用域派发：从组合根所在的 fiber 发，作用域才与本插件的订阅匹配。
    fiber.ctx.emit("agent/pre-step", payload, next);
    expect(seen).toEqual(["itest-agent"]);
    expect(root.get("mcpManager", false)).toBeUndefined();

    off();
    fiber.ctx.emit("agent/pre-step", payload, next);
    expect(seen).toEqual(["itest-agent"]);
  });

  it("logs.capture 收到宿主 logger 的记录，摘除之后不再收到", async () => {
    const { fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);
    const seen: string[] = [];
    const off = faces.logs.capture((record) => {
      seen.push(record.type + ":" + record.level + ":" + String(record.args[0]));
    });

    // 默认档位的宿主就得能收到 warn：这条面自带门槛（levels.default=2），不要求用户把日志级别
    // 配够——否则「首连失败可见」会变成一条有前提的承诺。cordis 的投递闸只放阈值内的档位
    // （LoggerLevel 数值越大越啰嗦），故这里同时钉住 debug 不进面（诊断不要官方内部噪音）。
    fiber.ctx.logger.warn("itest:log-one");
    expect(seen).toEqual(["warn:2:itest:log-one"]);

    fiber.ctx.logger.debug("itest:log-debug");
    expect(seen).toEqual(["warn:2:itest:log-one"]);

    off();
    fiber.ctx.logger.warn("itest:log-two");
    expect(seen).toEqual(["warn:2:itest:log-one"]);
  });
});

// ---------------------------------------------------------------- 装配

describe("组合根：装配顺序与成对", () => {
  it("按装配表的顺序逐域 install，装配完即处于在装状态", async () => {
    const log: string[] = [];
    const domains = ["store", "stats", "catalog"].map((name) => makeDomain(name, log));
    const { fiber } = await mount(domains);

    expect(log).toEqual(["install:store", "install:stats", "install:catalog"]);
    // 装配完即为「在装状态」：标记在域自己的 install 末尾置位。
    expect(domains.map((domain) => domain.installed())).toEqual([true, true, true]);
    expect(fiber.ctx.fiber).toBe(fiber);
  });

  it("装配表里同名域出现两次当场抛，且不吞错（装配链中止）", async () => {
    const log: string[] = [];
    const duplicate = makeDomain("store", log);
    const root = new Context();
    const host = makeHostServices();
    root.provide("webServer", host.webServer);
    root.provide("tools", host.toolRuntime);
    root.provide("systemPrompt", host.systemPrompt);
    const faces = bindHost(root);

    await expect(assemble(faces, [duplicate, duplicate])).rejects.toThrow(/出现了两次/u);
    // 中止发生在第二格：第一格已经装上了（装配表写错不该静默只装一份）。
    expect(log).toEqual(["install:store"]);
    expect(duplicate.installed()).toBe(true);
  });
});

// ---------------------------------------------------------------- 释放

describe("组合根：释放逆序与标记复位", () => {
  it("卸载时严格逆序释放，且每个域自己的标记被复位", async () => {
    const log: string[] = [];
    const domains = ["store", "stats", "catalog"].map((name) => makeDomain(name, log));
    const { fiber } = await mount(domains);
    await fiber.dispose();

    expect(log).toEqual([
      "install:store",
      "install:stats",
      "install:catalog",
      "release:catalog",
      "release:stats",
      "release:store",
    ]);
    // 复位是「可再次装配」的前提：标记不复位，下一次装配就是静默复用上一次的状态。
    expect(domains.map((domain) => domain.installed())).toEqual([false, false, false]);
  });

  it("释放后同一批夹具域可以再装配一次（标记复位才谈得上复用）", async () => {
    const log: string[] = [];
    const domains = ["store", "stats"].map((name) => makeDomain(name, log));
    const first = await mount(domains);
    await first.fiber.dispose();
    const second = await mount(domains);
    expect(log).toEqual([
      "install:store",
      "install:stats",
      "release:stats",
      "release:store",
      "install:store",
      "install:stats",
    ]);
    await second.fiber.dispose();
  });

  it("单个域释放失败不阻断其余：三个域都走完释放链", async () => {
    const log: string[] = [];
    const domains = [
      makeDomain("store", log),
      makeDomain("stats", log, { failRelease: true }),
      makeDomain("catalog", log),
    ];
    const { fiber } = await mount(domains);
    await fiber.dispose();

    expect(log).toEqual([
      "install:store",
      "install:stats",
      "install:catalog",
      "release:catalog",
      "release:stats",
      "release:store",
    ]);
    expect(domains.map((domain) => domain.installed())).toEqual([false, false, false]);
  });

  it("重复装配当场抛：已在装状态的域被再装一次，装配链不吞错", async () => {
    const log: string[] = [];
    const domain = makeDomain("store", log);
    const first = await mount([domain]);
    expect(domain.installed()).toBe(true);

    const host = makeHostServices();
    const root = new Context();
    root.provide("webServer", host.webServer);
    root.provide("tools", host.toolRuntime);
    root.provide("systemPrompt", host.systemPrompt);
    await expect(assemble(bindHost(root), [domain])).rejects.toThrow(/只能装配一次/u);

    await first.fiber.dispose();
    expect(domain.installed()).toBe(false);
  });
});

// ---------------------------------------------------------------- 装载口

/**
 * LoaderPort 的装配判据：解析真的经宿主 loader 服务、装载真的落到 `ctx.plugin`。
 *
 * 假模块的 `apply` 收的是**真** ctx（`ctx.plugin` 由真 cordis 执行），故断言落在真实的 effect
 * 注册与回收上；官方包本身不在仓库内可解析（设计 §6.4），故模块一律用结构形状造。
 */
describe("组合根：LoaderPort 的解析与装载", () => {
  it('load 经 ctx.get("loader") 调到宿主服务的 import，并把解析结果原样交付', async () => {
    const { root, fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);
    const official = { name: "itest:official", apply: () => {} };
    const loader = fakeLoaderPort({ modules: { [OFFICIAL_MCP_CLIENT_SPECIFIER]: official } });
    root.provide("loader", loader);

    await expect(faces.loader.load(OFFICIAL_MCP_CLIENT_SPECIFIER)).resolves.toBe(official);
    expect(loader.calls).toEqual([["import", OFFICIAL_MCP_CLIENT_SPECIFIER]]);
  });

  it("宿主未提供 loader 服务时 load 抛错，判词点名 loader（fail closed 而不是回落 undefined）", async () => {
    const { fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);

    await expect(faces.loader.load(OFFICIAL_MCP_CLIENT_SPECIFIER)).rejects.toThrow(
      /宿主未提供 loader 服务/,
    );
  });

  it("mount 把模块挂成 ctx.plugin 的实例：apply 真被调用，ready 在其 resolve 之后 settle", async () => {
    const { fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);
    const order: string[] = [];
    let releaseApply = () => {};
    const handle = faces.loader.mount(
      {
        name: "itest:official",
        apply: async () => {
          order.push("apply:start");
          await new Promise<void>((resolve) => {
            releaseApply = () => {
              resolve();
            };
          });
          order.push("apply:end");
        },
      },
      { serverName: "itest" },
    );
    // ready 的结算时点靠**登记次序**断言，不靠等毫秒：早于 apply 收尾结算的实现在这里先红。
    void handle.ready.then(() => {
      order.push("ready");
    });

    await pollUntil("apply 开始", () => order.includes("apply:start"));
    expect(order).toEqual(["apply:start"]);

    releaseApply();
    await handle.ready;
    expect(order).toEqual(["apply:start", "apply:end", "ready"]);
    await handle.dispose();
  });

  it("dispose() 置位 disposed；漏释放的实例由宿主 fiber 卸载时的兜底链回收", async () => {
    const { fiber } = await mount([]);
    const faces = bindHost(fiber.ctx);
    const released: string[] = [];
    const module = (name: string, tag: string) => ({
      name,
      apply: (ctx: unknown) => {
        (ctx as Context).effect(() => () => {
          released.push(tag);
        });
      },
    });

    const first = faces.loader.mount(module("itest:first", "first"), { serverName: "first" });
    await first.ready;
    expect(first.disposed).toBe(false);
    await first.dispose();
    expect(first.disposed).toBe(true);
    expect(released).toEqual(["first"]);

    // 这一笔刻意不走确定性链：只有 bindHost 里挂的兜底 effect 能回收它。
    const second = faces.loader.mount(module("itest:second", "second"), { serverName: "second" });
    await second.ready;
    await fiber.dispose();
    expect(second.disposed).toBe(true);
    await pollUntil("兜底链回收 second", () => released.includes("second"));
    expect(released).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------- 入口面

describe("包入口：插件契约与声明合并同处一处", () => {
  it("入口可加载，插件契约（name / inject / apply）在声明合并迁入之后仍然齐备", () => {
    // 上面那条编译期锁的运行时锚：布尔本身没有内容，它的价值是让锁被裁剪时这里先红。
    const declaresService: EntryDeclaresService = true;
    expect(declaresService).toBe(true);
    expect(entry.name).toBe("mcp-manager");
    expect(entry.inject).toEqual(["tools", "webServer", "systemPrompt"]);
    expect(typeof entry.apply).toBe("function");
  });
});
