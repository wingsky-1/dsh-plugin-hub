/**
 * dsh-mcp-manager — unit：visibility 域（#767 笔 1b 交付物 A：模型可见面隐藏）。
 *
 * 覆盖：A1 注册表优先（#922：在册形状良好的 mcp__* 全进名单，不再要求 id 属于单元；A1b 另锁
 * 四原子工具 ws_mcp_* 豁免与畸形名排除）、名单未变不重挂（防自激循环的两道闸）、后注册收敛且旧限制
 * 先 dispose、空名单不调用 restrict、disposed/域 disposer 的清理、事件面缺失的降级、装载时的初始
 * 全量 reconcile；B1–B6 锁定 #922：双向错位、逐名 skip+warn、抖动收敛、tools/change 风暴封顶、
 * 非未知错误重抛语义（无假记忆+可重试）。
 *
 * 直连域门面（`src/server/visibility/interface.ts`）——**不 import src/index.ts**（单元层
 * 导入面越界是已登记存量，新增即判红）。
 */
import { describe, expect, it } from "vitest";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import { startAgentVisibility } from "../../src/server/visibility/interface.ts";
import type { VisibilityEventsPort } from "../../src/server/visibility/interface.ts";
import type { AgentFace } from "../../src/server/shared/interface.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";

/** 假 agent：restrict 记一笔，返回的摘除器也记一笔（带句柄号，供顺序断言）。 */
function fakeAgent(id: string, log: string[], onChange?: () => (() => void)[]): AgentFace {
  let seq = 0;
  return {
    id,
    tools: {
      restrict(filter: ToolRestriction) {
        seq += 1;
        const handle = `${id}#${seq}`;
        log.push(`restrict:${id}[${[...(filter.deny ?? [])].join("|")}]`);
        // 宿主 restrict 会**同步**发 tools/change：夹具照做，才测得到重入闸。
        if (onChange) for (const hook of onChange()) hook();
        return () => log.push(`dispose:${handle}`);
      },
    },
  };
}

/** 可抛错的假 agent：shouldThrow 按单次 deny 名（含批量 join 形）决定是否抛，抛错不记 seq。 */
function flakyAgent(
  id: string,
  log: string[],
  shouldThrow: (joined: string) => Error | undefined,
): AgentFace {
  let seq = 0;
  return {
    id,
    tools: {
      restrict(filter: ToolRestriction) {
        const joined = [...(filter.deny ?? [])].join("|");
        const error = shouldThrow(joined);
        if (error !== undefined) throw error;
        seq += 1;
        const handle = `${id}#${seq}`;
        log.push(`restrict:${id}[${joined}]`);
        return () => log.push(`dispose:${handle}`);
      },
    },
  };
}

/** 假事件面：三个监听各自可注入、摘除器可观测；`liveAgents` 由调用方给。 */
function makeEvents(liveAgents: () => readonly AgentFace[] = () => []) {
  const handlers: {
    created: ((agent: AgentFace) => void)[];
    disposed: ((agent: { id: string }) => void)[];
    changed: (() => void)[];
  } = { created: [], disposed: [], changed: [] };
  const unhooked: string[] = [];
  const port: VisibilityEventsPort = {
    onAgentCreated: (handler) => {
      handlers.created.push(handler);
      return () => {
        unhooked.push("created");
      };
    },
    onAgentDisposed: (handler) => {
      handlers.disposed.push(handler);
      return () => {
        unhooked.push("disposed");
      };
    },
    onToolsChange: (handler) => {
      handlers.changed.push(handler);
      return () => {
        unhooked.push("changed");
      };
    },
    liveAgents,
  };
  return {
    handlers,
    unhooked,
    port,
  };
}

/**
 * 单元表夹具：本域只读 `unit.connections[*].id`（注册名 `mcp__<id>__` 的前缀来源，见
 * `visibility/impl/mask/index.ts` 的装配循环）——其余 ProjectUnit/ConnectionEntry 字段（ServerConfig、
 * 六态、句柄等）与本域无关，全量构造会把 visibility 测试耦合到无关形状上，故按本仓既有惯例
 * （unit-lifecycle 的 `as unknown as LoaderPort`）做收窄断言，而不用 any。
 */
function unitsWith(...ids: string[]): ReadonlyMap<string, ProjectUnit> {
  return new Map([
    ["/proj", { connections: new Map(ids.map((id) => [`srv-${id}`, { id }])) }],
  ]) as unknown as ReadonlyMap<string, ProjectUnit>;
}

function makeLogger(): { warns: string[]; warn: (message: string) => void } {
  const warns: string[] = [];
  return {
    warns,
    warn: (message: string) => {
      warns.push(message);
    },
  };
}

describe("visibility 域：mcp__* 的模型可见面隐藏", () => {
  it("A1 agent/created：deny 含注册面全部形状良好的 mcp__ 名（#922 注册表优先，不再要求 id 属于单元）", () => {
    const log: string[] = [];
    const agent = fakeAgent("a1", log);
    const events = makeEvents();
    const names = ["mcp__id-a__echo", "mcp__id-b__ping", "mcp__other__x", "ws_mcp_call", "mcp__"];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    // id-b / other 的 id 不在单元表里：#922 前会被漏摘（泄漏窗口），现在同样进名单（单元命中走批量，
    // 其余逐名）；ws_mcp_call 不是 mcp__ 前缀、mcp__ 无分隔符：形状不良，永不进名单。
    expect(log).toEqual([
      "restrict:a1[mcp__id-a__echo]",
      "restrict:a1[mcp__id-b__ping]",
      "restrict:a1[mcp__other__x]",
    ]);
    expect(logger.warns).toEqual([]);
    dispose();
  });

  it("A1b 四原子工具（ws_mcp_*）一律不在 deny 名单（DOC-A §1 模型可见面）", () => {
    const log: string[] = [];
    const agent = fakeAgent("a1", log);
    const events = makeEvents();
    const names = [
      "ws_mcp_list",
      "ws_mcp_detail",
      "ws_mcp_search",
      "ws_mcp_call",
      "mcp__id-a__echo",
    ];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    // 四原子工具是模型唯一入口：只摘 mcp__*，ws_mcp_* 一个都不许进 deny。
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]"]);
    expect(logger.warns).toEqual([]);
    dispose();
  });

  it("A2a 重入闸：restrict 同步发 tools/change 时不产生第二次 restrict", () => {
    const log: string[] = [];
    const events = makeEvents();
    const agent = fakeAgent("a1", log, () => events.handlers.changed);
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__echo"],
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]"]);
    dispose();
  });

  it("A2b 记忆闸：名单未变的后续 tools/change 不再动限制面", () => {
    const log: string[] = [];
    const events = makeEvents();
    const agent = fakeAgent("a1", log);
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__echo"],
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    events.handlers.changed[0]();
    events.handlers.changed[0]();
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]"]);
    dispose();
  });

  it("A3 后注册的 mcp__* 经 tools/change 进名单，且旧限制先被 dispose", () => {
    const log: string[] = [];
    const events = makeEvents();
    const agent = fakeAgent("a1", log);
    const names = ["mcp__id-a__echo"];
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    // 第一次 reconcile 之后才注册的新工具（restriction 是调用时刻快照，不在旧快照里）。
    names.push("mcp__id-a__late");
    events.handlers.changed[0]();
    expect(log).toEqual([
      "restrict:a1[mcp__id-a__echo]",
      "dispose:a1#1",
      "restrict:a1[mcp__id-a__echo|mcp__id-a__late]",
    ]);
    dispose();
  });

  it("A4 名单为空：不调用 restrict，但旧的限制仍被 dispose", () => {
    const log: string[] = [];
    const events = makeEvents();
    const agent = fakeAgent("a1", log);
    const names = ["mcp__id-a__echo"];
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    names.length = 0;
    events.handlers.changed[0]();
    // 空 filter 会被宿主当场拒：本轮只撤旧的，不新调用 restrict。
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]", "dispose:a1#1"]);
    dispose();
  });

  it("A5 agent/disposed 撤该 agent 的限制；域 disposer 撤全部并摘三个监听", () => {
    const log: string[] = [];
    const events = makeEvents();
    const a1 = fakeAgent("a1", log);
    const a2 = fakeAgent("a2", log);
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__echo"],
      logger: makeLogger(),
    });
    events.handlers.created[0](a1);
    events.handlers.created[0](a2);
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]", "restrict:a2[mcp__id-a__echo]"]);
    events.handlers.disposed[0]({ id: "a1" });
    expect(log).toEqual([
      "restrict:a1[mcp__id-a__echo]",
      "restrict:a2[mcp__id-a__echo]",
      "dispose:a1#1",
    ]);
    dispose();
    expect(log).toEqual([
      "restrict:a1[mcp__id-a__echo]",
      "restrict:a2[mcp__id-a__echo]",
      "dispose:a1#1",
      "dispose:a2#1",
    ]);
    expect(events.unhooked.sort()).toEqual(["changed", "created", "disposed"]);
  });

  it("A6 降级：事件面缺失 → 不抛、不调用 restrict、只 warn 一次", () => {
    const logger = makeLogger();
    let dispose = () => {};
    expect(() => {
      dispose = startAgentVisibility({
        events: {},
        units: unitsWith("id-a"),
        registeredNames: () => ["mcp__id-a__echo"],
        logger,
      });
    }).not.toThrow();
    expect(logger.warns.length).toBe(1);
    expect(() => dispose()).not.toThrow();
  });

  it("A6c 注册面读口抛错（假 ctx 的 tools 只有 register）→ 降级 no-op、不抛、只 warn 一次", () => {
    const log: string[] = [];
    const events = makeEvents();
    const logger = makeLogger();
    let dispose = () => {};
    expect(() => {
      dispose = startAgentVisibility({
        events: events.port,
        units: unitsWith("id-a"),
        registeredNames: () => {
          throw new TypeError("ctx.tools.schemas is not a function");
        },
        logger,
      });
    }).not.toThrow();
    expect(log).toEqual([]);
    expect(logger.warns.length).toBe(1);
    // 后续 tools/change 仍降级（不抛、不重复喊）。
    events.handlers.changed[0]();
    expect(log).toEqual([]);
    expect(logger.warns.length).toBe(1);
    // agent/created 也走同一条仲裁：注册面读不到就不挂限制（绝不拿空名单去 restrict）。
    events.handlers.created[0](fakeAgent("a1", log));
    expect(log).toEqual([]);
    expect(() => dispose()).not.toThrow();
  });

  it("A6b 服务缺失：liveAgents 缺席/空表 → 无 agent 可挂，不调用 restrict、不告警", () => {
    const log: string[] = [];
    const events = makeEvents(() => []);
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__echo"],
      logger,
    });
    expect(log).toEqual([]);
    expect(logger.warns).toEqual([]);
    events.handlers.created[0](fakeAgent("a1", log));
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]"]);
    dispose();
  });

  it("A7 初始 reconcile：装载时对已经 live 的每个 agent 逐个上限制", () => {
    const log: string[] = [];
    const live = [fakeAgent("live-1", log), fakeAgent("live-2", log)];
    // 活表每次现读都返回**新对象**（同 id），域必须按 id 规范化对象身份，否则记忆恒 miss。
    const events = makeEvents(() => live.map((agent) => ({ ...agent })));
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__echo"],
      logger: makeLogger(),
    });
    expect(log).toEqual(["restrict:live-1[mcp__id-a__echo]", "restrict:live-2[mcp__id-a__echo]"]);
    // 名单未变的 tools/change 不得因为「新对象」再挂一次（身份规范化的判据）。
    events.handlers.changed[0]();
    expect(log.length).toBe(2);
    dispose();
    expect(log.length).toBe(4);
  });

  it("B1 错位其一（registry 有 / units 无）：照摘不误（#922 泄漏正例）", () => {
    const log: string[] = [];
    const agent = fakeAgent("a1", log);
    const events = makeEvents();
    const names = ["mcp__idx__a", "mcp__idx__b", "ws_mcp_call", "mcp__"];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    // 单元表空：旧交集口径下一个都摘不掉（泄漏）；新口径逐名挂，畸形与四原子仍排除。
    expect(log).toEqual(["restrict:a1[mcp__idx__a]", "restrict:a1[mcp__idx__b]"]);
    expect(logger.warns).toEqual([]);
    dispose();
    expect(log).toEqual([
      "restrict:a1[mcp__idx__a]",
      "restrict:a1[mcp__idx__b]",
      "dispose:a1#2",
      "dispose:a1#1",
    ]);
  });

  it("B2 错位其二（units 有 / registry 无）：走 A4 路径，不调用 restrict", () => {
    const log: string[] = [];
    const agent = fakeAgent("a1", log);
    const events = makeEvents();
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["ws_mcp_call", "bash"],
      logger,
    });
    events.handlers.created[0](agent);
    expect(log).toEqual([]);
    expect(logger.warns).toEqual([]);
    dispose();
    expect(log).toEqual([]);
  });

  it("B3 逐名 skip+warn：挂载时已销的未知名字只跳过，不阻断整单", () => {
    const log: string[] = [];
    const events = makeEvents();
    // 宿主未知名字报错原文案（实现侧 isUnknownNameError 耦合点，由本用例锁定）。
    const unknownHostError =
      'tools.restrict() names unknown global tool "mcp__id-x__ghost"; ' +
      "known global tools: mcp__id-a__ok";
    const agent = flakyAgent("a1", log, (joined) =>
      joined.includes("mcp__id-x__ghost") ? new Error(unknownHostError) : undefined,
    );
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__ok", "mcp__id-x__ghost"],
      logger,
    });
    events.handlers.created[0](agent);
    // ok 走批量直挂；ghost 逐名挂时未知→跳过+warn；整单不抛。
    expect(log).toEqual(["restrict:a1[mcp__id-a__ok]"]);
    expect(logger.warns.length).toBe(1);
    expect(logger.warns[0]).toContain("mcp__id-x__ghost");
    // 名单不变的重同步直接收敛，不重试、不追加 warn（无风暴）。
    events.handlers.changed[0]();
    expect(log).toEqual(["restrict:a1[mcp__id-a__ok]"]);
    expect(logger.warns.length).toBe(1);
    dispose();
  });

  it("B4 抖动收敛：逐轮新增工具精确追补，无变更的重同步冻结", () => {
    const log: string[] = [];
    const events = makeEvents();
    const agent = fakeAgent("a1", log);
    const names: string[] = [];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    expect(log).toEqual([]);
    names.push("mcp__idx__t1");
    events.handlers.changed[0]();
    names.push("mcp__idx__t2");
    events.handlers.changed[0]();
    names.push("mcp__idx__t3");
    events.handlers.changed[0]();
    events.handlers.changed[0]();
    events.handlers.changed[0]();
    expect(log).toEqual([
      "restrict:a1[mcp__idx__t1]",
      "dispose:a1#1",
      "restrict:a1[mcp__idx__t1]",
      "restrict:a1[mcp__idx__t2]",
      "dispose:a1#3",
      "dispose:a1#2",
      "restrict:a1[mcp__idx__t1]",
      "restrict:a1[mcp__idx__t2]",
      "restrict:a1[mcp__idx__t3]",
    ]);
    expect(logger.warns).toEqual([]);
    dispose();
  });

  it("B5 风暴封顶：多 agent 全量 reconcile 的 restrict 数恒等于 agent 数×名单数", () => {
    const log: string[] = [];
    const live: AgentFace[] = [];
    const events = makeEvents(() => live);
    const e1 = fakeAgent("e1", log, () => events.handlers.changed);
    const p1 = fakeAgent("p1", log);
    const p2 = fakeAgent("p2", log);
    live.push(e1, p1, p2);
    const names = ["mcp__idx__w1", "mcp__idx__w2", "mcp__idx__w3", "mcp__idx__w4"];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => names,
      logger,
    });
    // e1 每次挂载都同步发 tools/change：重入闸必须吞掉，总数仍是 3×4 = 12。
    expect(log.filter((line) => line.startsWith("restrict")).length).toBe(12);
    expect(log.length).toBe(12);
    for (let i = 0; i < 5; i += 1) events.handlers.changed[0]();
    expect(log.filter((line) => line.startsWith("restrict")).length).toBe(12);
    expect(log.length).toBe(12);
    expect(logger.warns).toEqual([]);
    dispose();
  });

  it("B6 非未知错误：整单回滚+无假记忆+warn，下轮可重试", () => {
    const log: string[] = [];
    const events = makeEvents();
    let broken = true;
    const agent = flakyAgent("a1", log, (joined) =>
      broken && joined.includes("mcp__id-a__bad")
        ? new Error("boom: agent scope disposed")
        : undefined,
    );
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => ["mcp__id-a__ok", "mcp__id-a__bad"],
      logger,
    });
    events.handlers.created[0](agent);
    // 批量 [bad|ok] 撞上非未知错误：零生效、无记忆、reconcile 按 agent 兜 warn。
    expect(log).toEqual([]);
    expect(logger.warns.length).toBe(1);
    expect(logger.warns[0]).toContain("boom");
    broken = false;
    events.handlers.changed[0]();
    expect(log).toEqual(["restrict:a1[mcp__id-a__bad|mcp__id-a__ok]"]);
    dispose();
  });
});
