/**
 * dsh-mcp-manager — unit：visibility 域（#767 笔 1b 交付物 A：模型可见面隐藏）。
 *
 * 覆盖七条判据：名单只取本方单元的 mcp__*（含反例；A1b 另锁四原子工具 ws_mcp_* 豁免）、名单未变不重挂
 * （防自激循环的两道闸）、后注册收敛且旧限制先 dispose、空名单不调用 restrict、disposed/域 disposer
 * 的清理、事件面缺失的降级、装载时的初始全量 reconcile。
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
  it("A1 agent/created：deny 只含「前缀 mcp__ 且 id 属于本方连接池单元」的名字", () => {
    const log: string[] = [];
    const agent = fakeAgent("a1", log);
    const events = makeEvents();
    const names = ["mcp__id-a__echo", "mcp__id-b__ping", "mcp__other__x", "ws_mcp_call"];
    const logger = makeLogger();
    const dispose = startAgentVisibility({
      events: events.port,
      units: unitsWith("id-a"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    // id-b 不在本方单元表里、mcp__other__x 的 id 段不属于任何单元、ws_mcp_call 不是 mcp__ 前缀。
    expect(log).toEqual(["restrict:a1[mcp__id-a__echo]"]);
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
});
