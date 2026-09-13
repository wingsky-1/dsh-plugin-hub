/**
 * dsh-notifier events 域 session 块 —— 从宿主对象上读证据：会话标题、turn/end、子代理归属。
 *
 * 为什么值得单独一测：这三个读取都跨宿主边界读**不受信**的对象（payload 里的 Agent 与会话日志来自
 * 别的模块、别的版本，字段随时可能缺、可能是脏值），而读错一处的症状全是「通知看起来发了但内容不对」：
 * 任务名缺失、子代理完成被报成主任务完成、脏 turn 号把后续真实完成永久吞掉。因此本文件不装配任何
 * 东西，直接喂假 Agent——被读的每一处分支都要能单独说清。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { makeAgentRegistry } from "../../helpers.ts";
import {
  isSubagentOf,
  lastTurnEndOf,
  sessionTitleOf,
  turnEndEvidenceOf,
} from "../../../src/server/events/impl/session/index.ts";

/**
 * 会话日志条目：判定只读 `type` 与 `data`，其余字段（seq / time）与判定无关，故不造。
 * 断言用 `as unknown as` 收口在这里：真实 SessionEvent 带 seq/time/必需性标记，抄一份等于把
 * 官方的信封形状抄成第二份事实源，而本块读的从来只有这么几个字段。
 */
function titleEvent(title: string): SessionEvent {
  return { type: "session/title", data: { title } } as unknown as SessionEvent;
}

function turnEndEvent(turn: unknown, reason: unknown = { kind: "completed" }): SessionEvent {
  return { type: "turn/end", data: { turn, reason } } as unknown as SessionEvent;
}

function unknownEvent(): SessionEvent {
  return { type: "user/message", data: {} } as unknown as SessionEvent;
}

/** 假 agent：只暴露被读的两处（`session.header` 与 `session.snapshotEvents()`）。 */
function makeAgent(
  id: string,
  options: {
    events?: SessionEvent[];
    header?: Record<string, unknown>;
    snapshotThrows?: boolean;
  } = {},
): Agent {
  const events = options.events ?? [];
  return {
    id,
    session: {
      header: options.header ?? {},
      snapshotEvents: () => {
        if (options.snapshotThrows === true) throw new Error("日志读不出来");
        return events;
      },
    },
  } as unknown as Agent;
}

describe("sessionTitleOf：任务名取自日志里最后一条标题", () => {
  it("后写的标题胜出（改名后通知里还显示旧名，用户会以为改名没生效）", () => {
    const agent = makeAgent("s-title", { events: [titleEvent("旧名"), titleEvent("新名")] });
    expect(sessionTitleOf(agent)).toEqual({ found: true, title: "新名" });
  });

  it("trim 后超过 40 字符即截断（系统通知的标题行很短，长标题会挤掉真正要看的内容）", () => {
    const agent = makeAgent("s-long", { events: [titleEvent(`  ${"x".repeat(60)}  `)] });
    expect(sessionTitleOf(agent)).toEqual({ found: true, title: "x".repeat(40) });
  });

  it("空白标题当作没有标题（否则通知里会出现一行「任务「」」）", () => {
    const agent = makeAgent("s-blank", { events: [titleEvent("   ")] });
    expect(sessionTitleOf(agent)).toEqual({ found: false });
  });

  it("日志读不出来时返回「没有标题」而不是抛出（通知主流程不该被一次日志读取失败带走）", () => {
    const agent = makeAgent("s-broken", { snapshotThrows: true });
    expect(sessionTitleOf(agent)).toEqual({ found: false });
  });
});

describe("turnEndEvidenceOf：turn/end 的证据收窄", () => {
  it("正常一条 turn/end 读出轮次与成因", () => {
    expect(turnEndEvidenceOf(turnEndEvent(3, { kind: "completed" }))).toEqual({
      found: true,
      evidence: { turn: 3, kind: "completed" },
    });
  });

  it("非 turn/end 一律不算证据（会话日志里绝大多数追加都不是结束）", () => {
    expect(turnEndEvidenceOf(unknownEvent())).toEqual({ found: false });
  });

  it("turn 不是有限数就丢弃（NaN 一旦进了记账，后续真实完成因 x > NaN 恒假被永久吞掉）", () => {
    for (const turn of [Number.NaN, Number.POSITIVE_INFINITY, "3", undefined, null]) {
      expect(turnEndEvidenceOf(turnEndEvent(turn)), `turn=${String(turn)}`).toEqual({
        found: false,
      });
    }
  });

  it("reason 不是对象就丢弃（脏载荷不能变成一条 kind 为 undefined 的证据）", () => {
    expect(turnEndEvidenceOf(turnEndEvent(3, null))).toEqual({ found: false });
    expect(turnEndEvidenceOf(turnEndEvent(3, "completed"))).toEqual({ found: false });
  });

  it("reason.kind 不是字符串时按空值处理，而不是让 undefined 漏进判定", () => {
    expect(turnEndEvidenceOf(turnEndEvent(3, {}))).toEqual({
      found: true,
      evidence: { turn: 3, kind: "" },
    });
  });
});

describe("lastTurnEndOf：取日志里最新一条结束证据", () => {
  it("倒序扫过尾随的其它追加（turn/end 之后通常还有落盘的事件）", () => {
    const agent = makeAgent("s-last", {
      events: [turnEndEvent(1), turnEndEvent(5, { kind: "completed" }), unknownEvent()],
    });
    expect(lastTurnEndOf(agent)).toEqual({ found: true, evidence: { turn: 5, kind: "completed" } });
  });

  it("日志里一条 turn/end 都没有时返回「没有证据」而不是猜一个", () => {
    const agent = makeAgent("s-none", { events: [unknownEvent()] });
    expect(lastTurnEndOf(agent)).toEqual({ found: false });
  });
});

describe("isSubagentOf：子代理归属判定", () => {
  it("origin 命中即真，不必再问注册表", () => {
    const agent = makeAgent("sub-origin", { header: { origin: "subagent" } });
    expect(isSubagentOf(agent, makeAgentRegistry())).toBe(true);
  });

  it("没有 parentSession 就是主任务", () => {
    const agent = makeAgent("main-root", { header: {} });
    expect(isSubagentOf(agent, makeAgentRegistry())).toBe(false);
  });

  it("父 agent 已消亡（查不到）时判主任务：宁可多报一条 done，也不静默用户自己的任务", () => {
    const agent = makeAgent("fork-orphan", { header: { parentSession: "p-gone" } });
    expect(isSubagentOf(agent, makeAgentRegistry())).toBe(false);
  });

  it("父 agent 在册但不拥有它（用户 fork 主线）时判主任务：header 单信号分不开两种 fork", () => {
    const child = makeAgent("fork-user", { header: { parentSession: "p-live" } });
    const parent = makeAgent("p-live");
    const registry = makeAgentRegistry({ live: [parent], owned: [] });
    expect(isSubagentOf(child, registry)).toBe(false);
  });

  it("父 agent 在册且确由它创建时判子代理（运行时归属是唯一可靠的第二个信号）", () => {
    const child = makeAgent("sub-owned", { header: { parentSession: "p-owner" } });
    const parent = makeAgent("p-owner");
    const registry = makeAgentRegistry({ live: [parent], owned: [["sub-owned", "p-owner"]] });
    expect(isSubagentOf(child, registry)).toBe(true);
  });
});
