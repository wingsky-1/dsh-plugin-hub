/**
 * dsh-notifier events 域 translate 块 —— 宿主说法 → 通知请求的翻译，以及本域唯一的文案表。
 *
 * 判据面：这是「用户最后看到什么字」的唯一来源。文案改错不会让任何编译失败，只会让通知里的
 * 任务名消失、工具名变成 `mcp__x__y`、耗时显示成「NaN 秒」。故正文按**逐字**断言，而不是
 * 断言「包含某个词」——包含式断言对多余的空行、错位的标点完全无感。
 *
 * 只有**无状态**的翻译在这里测：需要状态机的 `agent/status` 与 `agent/turn-stopping` 走
 * `listen.test.ts` 的装配面（那里才看得到「记账 → 判定」的完整时序）。`translateSessionEvent` 是例外：
 * 它唯一的副作用就是往状态机记账，故这里直接读状态机的那一次判定。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentErrorPayload, NotifyRequest } from "../../../src/server/events/deps.ts";
import { releaseEvents } from "../../../src/server/events/interface.ts";
import { agentStates } from "../../../src/server/events/impl/state/index.ts";
import {
  NOTIFY_KINDS,
  formatDuration,
  prettyToolName,
} from "../../../src/server/events/impl/translate/catalog.ts";
import {
  translateAgentDisposed,
  translateAgentError,
  translateApproval,
  translateSessionEvent,
  translateUserQuestion,
} from "../../../src/server/events/impl/translate/index.ts";
import type { Translation } from "../../../src/server/events/impl/translate/type.ts";
import { makeLogger } from "../../helpers.ts";

/**
 * `translateSessionEvent` 会往状态机里记账（这正是它存在的理由），故每个用例后清一次:
 * 记账留在同文件的下一个用例里，会让「推送证据优先」那类判定的起点随机变化。
 */
afterEach(() => {
  releaseEvents();
});

/** 会话日志条目：本块只读 `type` 与 `data`。 */
function titleEvent(title: string): SessionEvent {
  return { type: "session/title", data: { title } } as unknown as SessionEvent;
}

function turnEndEvent(turn: number): SessionEvent {
  return {
    type: "turn/end",
    data: { turn, reason: { kind: "completed" } },
  } as unknown as SessionEvent;
}

/** 假 agent：只露出被读的两处（`id` 与 `session`）。 */
function makeAgent(id: string, title?: string): Agent {
  const events = title === undefined ? [] : [titleEvent(title)];
  return {
    id,
    session: { header: {}, snapshotEvents: () => events },
  } as unknown as Agent;
}

/** 宿主载荷跨边界不受信，故用例按「宿主可能送出的最小形状」构造再收口一次。 */
function approval(
  over: { toolName?: string; reason?: string; agent?: Agent } = {},
): ApprovalRequest {
  return { toolName: "bash", ...over } as unknown as ApprovalRequest;
}

function question(over: {
  questions?: ReadonlyArray<{ id: string; question: string }>;
  agent?: Agent;
}): AskUserQuestionRequest {
  return { questions: [], ...over } as unknown as AskUserQuestionRequest;
}

function agentError(over: {
  agent: Agent;
  turn?: number;
  step?: number;
  error?: string;
}): AgentErrorPayload {
  return { turn: 1, step: 1, error: "出错了", ...over } as AgentErrorPayload;
}

/** 翻译结果非 ok 时取不到请求，用例要先证明 ok 再读——抽出来免得每处都写一遍收窄。 */
function requestOf(translation: Translation): NotifyRequest {
  if (!translation.ok) throw new Error("本用例期望翻译产出通知，实际没有");
  return translation.request;
}

describe("审批与提问：两条 waterfall 的旁路翻译", () => {
  it("审批带上任务名、工具中文名与理由（用户要先看懂「在等什么」才谈得上确认）", () => {
    const request = requestOf(
      translateApproval(
        approval({ toolName: "bash", reason: "要跑测试", agent: makeAgent("a1", "修复登录") }),
      ),
    );
    expect(request.kind).toBe("ask");
    expect(request.title).toBe("DSH：等待审批");
    expect(request.body).toBe(
      "任务「修复登录」等待审批（工具「终端命令」）\n理由：要跑测试\n请到 DSH 界面确认或拒绝",
    );
  });

  it("没有 agent 与理由时不写空占位行（「任务「undefined」」比不写任务名更糟）", () => {
    const request = requestOf(
      translateApproval(approval({ toolName: "mcp__chrome-devtools__click" })),
    );
    expect(request.body).toBe(
      '工具「MCP 服务器 "chrome-devtools" 的工具 "click"」等待审批\n请到 DSH 界面确认或拒绝',
    );
  });

  it("提问取首个问题作摘要，并带上任务名", () => {
    const request = requestOf(
      translateUserQuestion(
        question({
          questions: [
            { id: "q1", question: "要哪个格式？" },
            { id: "q2", question: "第二个问题" },
          ],
          agent: makeAgent("a2", "写文档"),
        }),
      ),
    );
    expect(request.kind).toBe("question");
    expect(request.title).toBe("DSH：向你提问");
    expect(request.body).toBe("任务「写文档」需要你回答\n问题：要哪个格式？\n请到 DSH 界面回答");
  });

  it("questions 为空时不写「问题：」行：空摘要看起来像内容丢了", () => {
    const request = requestOf(translateUserQuestion(question({ questions: [] })));
    expect(request.body).toBe("有提问需要你回答\n请到 DSH 界面回答");
  });

  // 空串与「没有 question 字段」是两回事，但对用户是同一件事：两条都会渲染出一行没有内容的
  // 「问题：」。只测 `questions: []` 的话，把判据退化成「首个问题存在就行」也全绿。
  it("首个问题的文本是空串时同样不写「问题：」行（判的是摘要非空，不是「有没有首个问题」）", () => {
    const request = requestOf(
      translateUserQuestion(question({ questions: [{ id: "q1", question: "" }] })),
    );
    expect(request.body).toBe("有提问需要你回答\n请到 DSH 界面回答");
  });
});

describe("会话内事件：只记账，不产出", () => {
  it("turn/end 不产出通知（宿主每追加一条日志就发一条通知是灾难），但把证据交给状态机接着用", () => {
    const agent = makeAgent("s1");
    expect(translateSessionEvent("s1", turnEndEvent(4)).ok).toBe(false);

    // 「记账」的唯一可观测出口：idle 判定读的就是这条推送来的证据，没记住就永远判不出完成。
    agentStates.install({
      logger: makeLogger(),
      agents: { lookup: () => ({ found: false }), isOwnedBy: () => false },
    });
    agentStates.observeStatus({ agent, status: "running" });
    expect(agentStates.observeStatus({ agent, status: "idle" })).toMatchObject({
      ok: true,
      kind: "done",
    });
  });

  it("认不出的宿主事件类型也不产出、不抛错（事件链是活的，抛错等于让插件崩在运行中）", () => {
    const unknown = { type: "assistant/message", data: {} } as unknown as SessionEvent;
    expect(translateSessionEvent("s1", unknown).ok).toBe(false);
  });

  // 占位能力是「抛错」而不是「空实现」：没人听的日志出口会静默，但装配守卫有洞时必须当场暴露，
  // 否则表现为「通知全没了、且没有任何线索指向装配」。
  it("未装配时判定路过的状态机当场抛错（占位成抛错而非按空状态判定）", () => {
    const agent = {
      id: "u-uninstalled",
      session: { header: { parentSession: "p-gone" }, snapshotEvents: () => [] },
    } as unknown as Agent;

    agentStates.observeStatus({ agent, status: "running" });
    agentStates.rememberTurnEnd(agent.id, { turn: 1, kind: "completed" });
    // 归属查询是这条判定路上唯一碰到装配入参的一步：它在未装配时应当抛「尚未装配」。
    expect(() => agentStates.observeStatus({ agent, status: "idle" })).toThrow(/尚未装配/u);
  });
});

describe("agent 生命周期与错误", () => {
  it("agent 被销毁只清账不产出（完成与否已由 idle 判过，再来一条等于重复通知）", () => {
    const translation = translateAgentDisposed({ agent: makeAgent("a3", "任务") });
    expect(translation.ok).toBe(false);
  });

  it("错误通知带任务名、轮次、步数与错误文本", () => {
    const request = requestOf(
      translateAgentError(
        agentError({ agent: makeAgent("a4", "部署"), turn: 2, step: 3, error: "连接超时" }),
      ),
    );
    expect(request.kind).toBe("error");
    expect(request.title).toBe("DSH：任务出错");
    expect(request.body).toBe("任务「部署」执行出错\n第 2 轮第 3 步：连接超时");
  });

  it("没有轮次时退化成纯错误文本，而不是写一行「第 0 轮」", () => {
    const request = requestOf(
      translateAgentError(
        agentError({ agent: makeAgent("a5"), turn: 0, step: 0, error: "连接超时" }),
      ),
    );
    expect(request.body).toBe("任务执行出错\n错误：连接超时");
  });

  it("本域不填 severity：缺省强度由裁决层按 kind 查表补，这里写一份就是同一条映射的第二处事实源", () => {
    const request = requestOf(
      translateAgentError(agentError({ agent: makeAgent("a6"), error: "炸了" })),
    );
    expect("severity" in request).toBe(false);
  });
});

describe("文案表：本域翻得出来的种类恰好六个", () => {
  it("表里没有 test（它不对应任何宿主事件，文案归 api 域的测试端点唯一产出）", () => {
    expect(Object.keys(NOTIFY_KINDS).sort()).toEqual([
      "ask",
      "done",
      "error",
      "question",
      "subagent-done",
      "turn-end",
    ]);
  });
});

describe("formatDuration：耗时的人类可读形式", () => {
  it.each<[number, string]>([
    [0, "0 秒"],
    [45_000, "45 秒"],
    [135_000, "2 分 15 秒"],
    [3_600_000, "1 小时"],
    [3_661_000, "1 小时 1 分 1 秒"],
  ])("%i 毫秒 → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("负耗时按 0 处理（时钟回拨不能渲染出「-1 秒」这种通知）", () => {
    expect(formatDuration(-1000)).toBe("0 秒");
  });
});

describe("prettyToolName：工具名的可读化", () => {
  it.each<[string | undefined, string]>([
    ["bash", "终端命令"],
    ["subagent_fork", "子代理任务"],
    [undefined, "?"],
    ["my_custom_tool", "my_custom_tool"],
    ["mcp__chrome-devtools__click", 'MCP 服务器 "chrome-devtools" 的工具 "click"'],
    ["mcp__a__b__c", 'MCP 服务器 "a" 的工具 "b__c"'],
    ["mcp__only-two", "mcp__only-two"],
  ])("%s → %s", (name, text) => {
    expect(prettyToolName(name)).toBe(text);
  });
});
