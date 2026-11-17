/**
 * dsh-notifier events 域 listen 块 —— 装配面：订阅宿主事件、转交翻译、把请求递给下游。
 *
 * 这一层是**装配面**（只伪 `events/deps.ts` 声明的端口），因此这里能测到别处测不到的两件事：
 *  1. 订阅与退订成对——少订阅一个口就是整整一类通知消失，漏退订一个口就是卸载后事件仍在灌；
 *  2. 完成判定的**时序**：`running` 起记、`idle` 结算，证据来自推送还是快照，取决于两刻之间
 *     会话日志长成了什么样。假 agent 的 `snapshotEvents()` 返回**可变数组**，就是为了摆出这个时序。
 *
 * 时间纪律：耗时按 running→idle 的墙钟差算，故用 `vi.setSystemTime` 钉住两刻（只换 `Date`，不碰
 * 事件循环）；`afterEach` 必须还原，否则同文件后续用例看到伪造的「现在」。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentDisposedPayload,
  AgentErrorPayload,
  AgentRegistryPort,
  AgentStatusPayload,
  AgentTurnStoppingPayload,
  EventsDeps,
  HostEventPort,
  NotifyRequest,
} from "../../../src/server/events/deps.ts";
import { installEvents, releaseEvents } from "../../../src/server/events/interface.ts";
import { makeAgentRegistry, makeLogger } from "../../helpers.ts";

afterEach(() => {
  releaseEvents();
  vi.useRealTimers();
});

/** 宿主事件口能收到的负载里，本块只关心这几个字段。 */
const EVENT_NAMES = [
  "approval",
  "question",
  "session",
  "status",
  "disposed",
  "turnStopping",
  "error",
] as const;

type EventName = (typeof EVENT_NAMES)[number];

/** 任意函数：订阅口收下的 handler 形状各不相同，统一按「调用即触发」存。 */
type AnyHandler = (...args: never[]) => void;

/** 假宿主事件面：订阅进表、退订出表，`emit` 只送达**仍在表里**的 handler。 */
interface HostEvents {
  readonly port: HostEventPort;
  readonly subscribed: string[];
  readonly unsubscribed: string[];
  approval(request: ApprovalRequest): void;
  question(request: AskUserQuestionRequest): void;
  session(sessionId: string, event: SessionEvent): void;
  status(payload: AgentStatusPayload): void;
  disposed(payload: AgentDisposedPayload): void;
  turnStopping(payload: AgentTurnStoppingPayload): void;
  error(payload: AgentErrorPayload): void;
}

/**
 * 退订必须真的停止投递：只记「退订被调过」而不摘 handler，会掩盖「摘了订阅却仍产出」这一类
 * 回归——那正是插件卸载后通知还在弹的成因。
 */
function makeHostEvents(): HostEvents {
  const handlers = new Map<EventName, AnyHandler[]>();
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];

  const take =
    <H extends AnyHandler>(name: EventName) =>
    (handler: H): (() => void) => {
      subscribed.push(name);
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        unsubscribed.push(name);
        const current = handlers.get(name) ?? [];
        const index = current.indexOf(handler);
        if (index !== -1) current.splice(index, 1);
      };
    };

  const emit = (name: EventName, ...args: unknown[]): void => {
    for (const handler of [...(handlers.get(name) ?? [])]) {
      (handler as (...rest: unknown[]) => void)(...args);
    }
  };

  const port: HostEventPort = {
    onApprovalRequest: take("approval"),
    onUserQuestion: take("question"),
    onSessionEvent: take("session"),
    onAgentStatus: take("status"),
    onAgentDisposed: take("disposed"),
    onAgentTurnStopping: take("turnStopping"),
    onAgentError: take("error"),
  };

  return {
    port,
    subscribed,
    unsubscribed,
    approval: (request) => emit("approval", request),
    question: (request) => emit("question", request),
    session: (sessionId, event) => emit("session", sessionId, event),
    status: (payload) => emit("status", payload),
    disposed: (payload) => emit("disposed", payload),
    turnStopping: (payload) => emit("turnStopping", payload),
    error: (payload) => emit("error", payload),
  };
}

/** 会话日志条目：判定只读 `type` 与 `data`。 */
function titleEvent(title: string): SessionEvent {
  return { type: "session/title", data: { title } } as unknown as SessionEvent;
}

function turnEndEvent(turn: number, kind = "completed"): SessionEvent {
  return { type: "turn/end", data: { turn, reason: { kind } } } as unknown as SessionEvent;
}

/** 一个假会话：日志**可变**，因为完成判定读的是「running 那一刻」与「idle 那一刻」两份快照。 */
interface FakeSession {
  readonly id: string;
  readonly agent: Agent;
  readonly log: SessionEvent[];
  endTurn(turn: number, kind?: string): void;
}

function makeSession(
  id: string,
  options: { title?: string; header?: Record<string, unknown> } = {},
): FakeSession {
  const log: SessionEvent[] = [];
  if (options.title !== undefined) log.push(titleEvent(options.title));
  const agent = {
    id,
    session: { header: options.header ?? {}, snapshotEvents: () => log },
  } as unknown as Agent;
  return {
    id,
    agent,
    log,
    endTurn: (turn, kind) => {
      log.push(turnEndEvent(turn, kind));
    },
  };
}

/** 装配一次 events 域，交出观测面。 */
function assemble(options: { agents?: AgentRegistryPort } = {}) {
  const events = makeHostEvents();
  const logger = makeLogger();
  const submitted: NotifyRequest[] = [];
  const deps: EventsDeps = {
    events: events.port,
    agents: options.agents ?? makeAgentRegistry(),
    logger,
    pipeline: {
      submit: (request) => {
        submitted.push(request);
      },
    },
  };
  installEvents(deps);
  return { events, logger, submitted };
}

/** 本域只读得懂 `status`；两个迁移包一层，免得每处都写一遍载荷。 */
function setStatus(events: HostEvents, session: FakeSession, status: "idle" | "running"): void {
  events.status({ agent: session.agent, status });
}

/** 钉住「现在」：只换 `Date`，不动定时器。 */
function at(hour: number, minute: number, second = 0): void {
  vi.setSystemTime(new Date(2026, 0, 15, hour, minute, second));
}

describe("装配与卸载", () => {
  it("装配订阅全部 7 个宿主事件口（少订阅一个就是整整一类通知消失）", () => {
    const { events } = assemble();
    expect([...events.subscribed].sort()).toEqual([...EVENT_NAMES].sort());
    expect(events.unsubscribed).toEqual([]);
  });

  it("release 逐个调用退订句柄，退订之后宿主事件不再进管线（否则卸载等于没生效）", () => {
    const { events, submitted } = assemble();
    events.approval({ toolName: "bash" } as unknown as ApprovalRequest);
    expect(submitted).toHaveLength(1);

    releaseEvents();
    expect([...events.unsubscribed].sort()).toEqual([...EVENT_NAMES].sort());

    events.approval({ toolName: "bash" } as unknown as ApprovalRequest);
    expect(submitted).toHaveLength(1);
  });

  it("重复装配当场抛错，而 release 之后装配能把订阅面装回来（卸载链可能走到不止一次）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
    releaseEvents();
    releaseEvents();
    // 只断言「没抛」不够：install 在 release 之后静默空转（插件热重载后彻底哑掉）同样不抛。
    const { events } = assemble();
    expect([...events.subscribed].sort()).toEqual([...EVENT_NAMES].sort());
  });
});

describe("转发：只有构成通知的事件才进管线", () => {
  it("审批请求 → ask 请求进管线，并带上会话标题", () => {
    const { events, submitted } = assemble();
    const session = makeSession("a-ask", { title: "修复登录" });
    events.approval({
      toolName: "bash",
      reason: "要跑测试",
      agent: session.agent,
    } as unknown as ApprovalRequest);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("ask");
    expect(submitted[0]!.body).toContain("修复登录");
  });

  it("用户在提问 → question 请求进管线", () => {
    const { events, submitted } = assemble();
    const session = makeSession("a-q", { title: "写文档" });
    events.question({
      questions: [{ id: "q1", question: "要哪个格式？" }],
      agent: session.agent,
    } as unknown as AskUserQuestionRequest);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("question");
    expect(submitted[0]!.body).toContain("要哪个格式？");
  });

  it("agent 出错 → error 请求进管线，且两次独立失败各报一条（把失败去重就等于静默第二次出错）", () => {
    const { events, submitted } = assemble();
    const session = makeSession("a-err", { title: "部署" });
    events.error({ agent: session.agent, turn: 2, step: 3, error: "连接超时" });
    events.error({ agent: session.agent, turn: 2, step: 3, error: "连接超时" });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]!.kind).toBe("error");
    expect(submitted[0]!.body).toContain("连接超时");
  });

  it("agent 消亡与会话内事件都不产出通知（清账与记账本身不是通知）", () => {
    const { events, submitted } = assemble();
    const session = makeSession("a-quiet");
    events.disposed({ agent: session.agent });
    events.session(session.id, turnEndEvent(1));
    expect(submitted).toEqual([]);
  });
});

describe("完成判定：running 起记、idle 结算", () => {
  it("running → idle 且本轮 completed 落盘 → done，耗时取两刻墙钟差", () => {
    const { events, submitted } = assemble();
    const session = makeSession("c-done", { title: "跑测试" });

    at(12, 0, 0);
    setStatus(events, session, "running");
    session.endTurn(1);
    at(12, 0, 2);
    setStatus(events, session, "idle");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("done");
    expect(submitted[0]!.body).toBe("任务「跑测试」已完成\n耗时：2 秒");
  });

  it("running 本身不产出（起记不是完成，否则每轮开始都会弹一条「完成」）", () => {
    const { events, submitted } = assemble();
    setStatus(events, makeSession("c-running"), "running");
    expect(submitted).toEqual([]);
  });

  it("没有先 running 的 idle 不产出，也不留诊断（没跑过的 agent 不能造出一条假的完成）", () => {
    const { events, logger, submitted } = assemble();
    const session = makeSession("c-idle-only");
    session.endTurn(1);
    setStatus(events, session, "idle");
    expect(submitted).toEqual([]);
    expect(logger.warns).toEqual([]);
  });

  it("本轮是 aborted（用户中断）时不产出，并在日志里说清为什么（否则「为什么没发 done」无从查）", () => {
    const { events, logger, submitted } = assemble();
    const session = makeSession("c-abort");
    setStatus(events, session, "running");
    session.endTurn(1, "aborted");
    setStatus(events, session, "idle");
    expect(submitted).toEqual([]);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("agent=c-abort");
    expect(logger.warns[0]).toContain("kind=aborted");
  });

  it("没有任何 turn/end 证据时不产出（保守静默优于误报一条完成）", () => {
    const { events, logger, submitted } = assemble();
    const session = makeSession("c-no-evidence");
    setStatus(events, session, "running");
    setStatus(events, session, "idle");
    expect(submitted).toEqual([]);
    expect(logger.warns[0]).toContain("kind=none");
  });

  it("推送来的 turn/end 优先于快照：日志里还没有本轮结束时也能判定完成", () => {
    const { events, submitted } = assemble();
    const session = makeSession("c-push", { title: "推送判定" });

    events.session(session.id, turnEndEvent(5));
    setStatus(events, session, "running");
    setStatus(events, session, "idle");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("done");
  });

  it("同一份证据的第二次 idle 不重复通知（running 而不产生新轮次是常态）", () => {
    const { events, logger, submitted } = assemble();
    const session = makeSession("c-dedupe", { title: "去重" });

    events.session(session.id, turnEndEvent(5));
    setStatus(events, session, "running");
    setStatus(events, session, "idle");
    expect(submitted).toHaveLength(1);

    setStatus(events, session, "running");
    setStatus(events, session, "idle");
    expect(submitted).toHaveLength(1);
    expect(logger.warns[0]).toContain("记忆turn=5");
  });

  it("进入 running 时日志里已存在的 turn/end 是上一轮的（快照冻结）：不当作本轮完成", () => {
    const { events, logger, submitted } = assemble();
    const session = makeSession("c-frozen", { title: "旧证据" });
    session.endTurn(3);

    setStatus(events, session, "running");
    setStatus(events, session, "idle");

    expect(submitted).toEqual([]);
    expect(logger.warns[0]).toContain("证据源=快照冻结");
  });
});

describe("子代理归属：main 与 subagent 的 kind 分流", () => {
  it("origin=subagent 的会话报 subagent-done", () => {
    const { events, submitted } = assemble();
    const session = makeSession("s-origin", { title: "子任务", header: { origin: "subagent" } });
    setStatus(events, session, "running");
    session.endTurn(1);
    setStatus(events, session, "idle");
    expect(submitted[0]!.kind).toBe("subagent-done");
    expect(submitted[0]!.body).toContain("子任务「子任务」已完成");
  });

  it("父 agent 在册且确由它创建时报 subagent-done（运行时归属是 header 之外的第二个信号）", () => {
    const parent = makeSession("p-owner");
    const child = makeSession("s-owned", { header: { parentSession: "p-owner" } });
    const { events, submitted } = assemble({
      agents: makeAgentRegistry({ live: [parent.agent], owned: [["s-owned", "p-owner"]] }),
    });
    setStatus(events, child, "running");
    child.endTurn(1);
    setStatus(events, child, "idle");
    expect(submitted[0]!.kind).toBe("subagent-done");
  });

  it("父 agent 已消亡（查不到）时判主任务：宁可多报一条 done，也不静默用户自己的任务", () => {
    const { events, submitted } = assemble();
    const child = makeSession("s-orphan", { header: { parentSession: "p-gone" } });
    setStatus(events, child, "running");
    child.endTurn(1);
    setStatus(events, child, "idle");
    expect(submitted[0]!.kind).toBe("done");
  });
});

describe("turn 停止边界：同一 turn 只发一次", () => {
  it("同一 agent 的同一 turn 第二次到达不再产出，下一个 turn 照常产出", () => {
    const { events, submitted } = assemble();
    const session = makeSession("t-dedupe", { title: "任务A" });
    const payload = { agent: session.agent, turn: 3 } as AgentTurnStoppingPayload;

    events.turnStopping(payload);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.kind).toBe("turn-end");
    expect(submitted[0]!.body).toBe("任务「任务A」第 3 轮工作已完成");

    events.turnStopping(payload);
    expect(submitted).toHaveLength(1);

    events.turnStopping({ agent: session.agent, turn: 4 } as AgentTurnStoppingPayload);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.body).toContain("第 4 轮");
  });

  it("turn 不是有限数时不写出「第 NaN 轮」，且同一 agent 的这类轮次只发一次", () => {
    const { events, submitted } = assemble();
    const session = makeSession("t-nan", { title: "脏轮次" });
    const payload = { agent: session.agent, turn: Number.NaN } as AgentTurnStoppingPayload;

    events.turnStopping(payload);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.body).toBe("任务「脏轮次」工作已完成");

    events.turnStopping(payload);
    expect(submitted).toHaveLength(1);
  });
});

describe("agent 消亡：只清账", () => {
  it("消亡清掉去重记账：同一个 agent id 的同一轮次在其消亡后可再次通知（会话 id 复用不该被旧账吞掉）", () => {
    const { events, submitted } = assemble();
    const session = makeSession("d-reuse", { title: "任务" });
    const payload = { agent: session.agent, turn: 3 } as AgentTurnStoppingPayload;

    events.turnStopping(payload);
    events.turnStopping(payload);
    expect(submitted).toHaveLength(1);

    events.disposed({ agent: session.agent });
    events.turnStopping(payload);
    expect(submitted).toHaveLength(2);
  });
});
