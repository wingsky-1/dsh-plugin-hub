/** 真实 Context 的 waterfall、全局订阅及子代理归属；不钉系统时钟，沿用原落盘界碑。 */
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import { pollUntil } from "../helpers.ts";
import {
  BASE_SETTINGS,
  captureWarnings,
  countKind,
  fakeAgent,
  fakeAgents,
  fakeSession,
  fakeSettings,
  fakeWebServer,
  historyLines,
  kindLine,
  mount,
  mounted,
  mountApprovalAnswerer,
  mountQuestionAnswerer,
  notifier,
  scopeRejecting,
  seed,
  seqAnchor,
  seqValue,
  settleHistory,
  turnEndEvent,
} from "./real-context-support.ts";

describe("waterfall 契约（审批 / 提问）", () => {
  it("approval/request：链头可达，且 next() 把判定原样交还给更早注册的短路 answerer", async () => {
    const root = new Context();
    const calls: string[] = [];
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    // 宿主的形态：内置 answerer 在本插件之前注册，并且**不调 next()**（GUI 应答后即短路）。
    await mountApprovalAnswerer(root, calls, "rejected");
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;
    // 反向固化：不带 prepend 的后来者排在这个短路 answerer 之后，整条链对它不可见。
    const control: string[] = [];
    root.on("approval/request", async () => {
      control.push("late");
      return "cancelled";
    });

    const request = { toolName: "bash", reason: "要写文件" } as unknown as ApprovalRequest;
    const outcome = await root.waterfall("approval/request", request, async () => "unavailable");

    // ② 链路结果没被吞：最终判定仍来自 answerer（插件自己返回 undefined 时这里会是 undefined）。
    expect(outcome).toBe("rejected");
    // ③ answerer 确实被调用：插件的 next() 真的把判定交了回来。
    expect(calls).toEqual(["answerer"]);
    // ① 插件的处理器被调用：可达性只有它自己的副作用能证明（审批通知落史）。
    await pollUntil(() => countKind("ask") === 1, "审批通知落史");
    // 反向固化：同一个事件、同一次派发里，后注册的无 prepend 监听器被短路挡在外面。
    // （`control` 空是**夹具前提**——answerer 短路后链不再往下走，不是本插件的判据。）
    expect(control).toEqual([]);
    await fiber.dispose();
    mounted.live = null;
  });

  it("user-questions/request：第二条 waterfall 与审批同构（同一个链头与交还契约）", async () => {
    const root = new Context();
    const calls: string[] = [];
    const answer: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["是"] }] };
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    await mountQuestionAnswerer(root, calls, answer);
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;

    // 只给必需的 questions：形状合法，值与文案无关（文案归 translate 域的单测）。
    const request: AskUserQuestionRequest = { questions: [{ id: "q1", question: "选哪个？" }] };
    const outcome = await root.waterfall("user-questions/request", request, async () => ({
      answers: [],
    }));

    // 交还的是 answerer 的**整份**判定，不是被本插件加工过的形状。
    expect(outcome).toEqual(answer);
    expect(calls).toEqual(["answerer"]);
    await pollUntil(() => countKind("question") === 1, "提问通知落史");
    await fiber.dispose();
    mounted.live = null;
  });

  it("guard：处理器内部抛错不向宿主抛——提问链路照旧交出判定，只留一条 warn", async () => {
    const root = new Context();
    const calls: string[] = [];
    const warns = captureWarnings(root);
    const answer: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["是"] }] };
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    await mountQuestionAnswerer(root, calls, answer);
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;

    // 上游形状漂移：一条缺 `question` 文本的提问。它在编译期本就被拦住，而守卫存在的理由正是
    // 编译期管不到的那一侧——载荷跨宿主边界不受信。
    const drifted = { questions: [{ id: "q1" }] } as unknown as AskUserQuestionRequest;

    // 宿主链不被打断：本插件只是旁观者，抛出去会让 next() 不被调用（症状是「提问框不弹了」）。
    const outcome = await root.waterfall("user-questions/request", drifted, async () => ({
      answers: [],
    }));
    expect(outcome).toEqual(answer);
    expect(calls).toEqual(["answerer"]);

    // 不静默：文案只此一处，吞掉之后「通知不工作」会变成查不出原因的现象。
    const guardWarn = warns.find((line) => line.includes("宿主事件处理失败"));
    expect(guardWarn?.startsWith("dsh-notifier: 宿主事件处理失败 —— ")).toBe(true);

    // 同一层壳的另一支：宿主抛出来的可以**不是** Error（官方那边失败类型本就是 unknown），
    // 文案得照样出得来，而不是把一次宿主异常消化成空字符串。
    const hostile = {
      get toolName(): string {
        throw "宿主抛出的字符串";
      },
    } as unknown as ApprovalRequest;
    const second = await root.waterfall("approval/request", hostile, async () => "unavailable");
    expect(second).toBe("unavailable");
    expect(warns.some((line) => line.endsWith("宿主抛出的字符串"))).toBe(true);
    await fiber.dispose();
    mounted.live = null;
  });
});

function registerScopedEventReachability(): void {
  it("多会话派发下本插件的订阅仍可达：漏掉 {global:true} 的表现是「有些会话不通知」", async () => {
    const { root, unmount } = await mount({});
    const control: string[] = [];
    // 对照：同一个事件、同一次派发，没有 {global:true} 的订阅会被作用域过滤掉。
    // （`control` 空是**夹具前提**——cordis 的 filter 真的在拒人，不是本插件的判据。）
    root.on("agent/error", () => {
      control.push("untagged");
    });

    // 宿主按 agent 作用域派发时传的就是这样一个 thisArg（filter 决定哪些订阅可见）。
    const scoped = scopeRejecting<"agent/error">();
    root.emit(scoped, "agent/error", {
      agent: fakeAgent("itest-scope"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });

    await pollUntil(() => countKind("error") === 1, "作用域收紧下仍到达管线");
    // （`control` 空是**夹具前提**——cordis 的 filter 真的在拒人，不是本插件的判据。）
    expect(control).toEqual([]);
    await unmount();
  });

  /**
   * 余下四条全局订阅**各自**可证伪：上面 `agent/error` 那条只覆盖了一条订阅，而宿主契约 canary 里
   * 的 `assertEventReachability` 测的是 cordis 的过滤语义本身（它自己临时挂监听器），都没能证明这
   * 四条带没带 `{global:true}`——**旧版同名文件是靠扫 `src/index.ts` 源码文本断言「全部 `ctx.on`
   * 注册处带 `{global:true}`」的**（还带 `// @ts-nocheck`），重写改成纯运行时行为后这块守卫缺了一
   * 个口子，下面就是它的行为版替身。四条写在同一个用例里是为了省掉四次装配，但每一段都独立成立：
   * 删掉对应那行的 `GLOBAL_LISTEN`，只有该段会红。
   */
  it("四条全局订阅各自可证伪（旧源码文本扫描的行为版替身）：收紧派发下状态 / 会话 / turn / 消亡都仍到达", async () => {
    const { root, unmount } = await mount({});
    // agent/* 共用同一个 this 位类型，会话那条在会话那一侧，故造两个载体。
    const scopedAgent = scopeRejecting<"agent/status">();
    const scopedSession = scopeRejecting<"session/event">();
    const signal = new AbortController().signal;

    // ① agent/status：两跳判定照旧产出完成通知（证据取自日志快照，与会话推送无关）。
    const statusEvents: SessionEvent[] = [];
    const statusAgent = fakeAgent("itest-scope-status", statusEvents);
    root.emit(scopedAgent, "agent/status", { agent: statusAgent, status: "running" });
    statusEvents.push(turnEndEvent(1, "completed"));
    root.emit(scopedAgent, "agent/status", { agent: statusAgent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "① 作用域收紧下 agent/status 仍产出完成通知");

    // ② session/event：这条会话的日志快照是空的，完成判定只能靠推送来的那笔证据——收不到就没有通知。
    // 用「比前一段多一条」而不是绝对值：这一段的成立与否不该被上一段的条数绑住。
    const doneBeforePush = countKind("done");
    const pushAgent = fakeAgent("itest-scope-session");
    root.emit(scopedAgent, "agent/status", { agent: pushAgent, status: "running" });
    root.emit(
      scopedSession,
      "session/event",
      fakeSession("itest-scope-session"),
      turnEndEvent(1, "completed"),
    );
    root.emit(scopedAgent, "agent/status", { agent: pushAgent, status: "idle" });
    await pollUntil(
      () => countKind("done") === doneBeforePush + 1,
      "② 作用域收紧下 session/event 的推送证据仍被记账",
    );

    // ③ agent/turn-stopping：同一 turn 只发一次（去重状态机在收紧的派发下也要吃到这两跳）。
    // 本段只证明「到达并被记账」：本例的 notifyTurnEnd 是默认的 false，所以这条 turn-end 是以
    // suppressed 落的史——它分不出「发了」与「被压制」，投递面的判据在下面那条用例里。
    const turnAgent = fakeAgent("itest-scope-turn");
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 1, "③ 作用域收紧下 turn 边界仍到达状态机");
    expect(kindLine("turn-end")?.suppressed).toBe("kind-off");
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await settleHistory();
    expect(countKind("turn-end")).toBe(1);

    // ④ agent/disposed：清账把那笔去重记录抹掉，否则同一个 id 复用后这一 turn 永远不再通知。
    const disposed = scopeRejecting<"agent/disposed">();
    root.emit(disposed, "agent/disposed", { agent: turnAgent });
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 2, "④ 作用域收紧下消亡事件仍清账");
    await unmount();
  });
}

function registerHostEventDelivery(): void {
  it("agent/error：真实 emit 到达管线，错误原文经组合根收窄成文本落进历史", async () => {
    const { root, unmount } = await mount({});
    root.emit("agent/error", {
      agent: fakeAgent("itest-error"),
      turn: 2,
      step: 3,
      error: new Error("磁盘满了"),
    });
    // 宽类型（unknown）在这里做唯一一次收窄：域内拿到的必须是可展示的文本。
    root.emit("agent/error", {
      agent: fakeAgent("itest-error"),
      turn: 2,
      step: 4,
      error: 42,
    });
    await pollUntil(() => countKind("error") === 2, "两条错误通知落史");
    const lines = historyLines().filter((line) => line.kind === "error");
    expect(lines).toHaveLength(2);
    // 收窄的两支：Error 取 `message`，非 Error 用 `String()`。判据必须咬住「取 message」这个动作——
    // 正文模板是 `…：${文本}`，而 `String(new Error("磁盘满了"))` 是 `"Error: 磁盘满了"`，
    // 只断包含「磁盘满了」的话两种写法都过（恒真），故断紧贴前缀冒号的那一段 + 反断整对象形态。
    const messages = lines.map((line) => line.message ?? "").join("\n");
    expect(messages).toContain("：磁盘满了");
    expect(messages).not.toContain("Error: 磁盘满了");
    expect(messages).toContain("42");
    await unmount();
  });

  it("agent/status：裸 idle 不发通知，running→idle 两跳且日志里有本轮新证据才产出 done", async () => {
    const { root, unmount } = await mount({});
    // 会话日志是一段可增长的快照，本轮结束的证据在 running 之后才追加进来。
    // 「进入 running 时日志里已有的 turn/end 是上一轮的、不许当成本轮完成」（`证据源=快照冻结`）
    // 有专门的主：`test/unit/events/listen.test.ts`，此处不重复覆盖。
    const events: SessionEvent[] = [];
    const agent = fakeAgent("itest-done", events);

    // 「只有 running 被看见过，idle 才算一轮结束」这条已由 test/unit/events/listen.test.ts 单测
    // 守死（那边还多断了一条「不留诊断」），这里只走本层独有的两跳：running → turn/end → idle。
    root.emit("agent/status", { agent, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "完成通知落史");
    await unmount();
  });

  it("session/event：推送的 turn/end 被记账，缺了它完成判定退化成不发（唯一可辨的副作用）", async () => {
    const { root, warns, unmount } = await mount({});
    // 快照里没有 turn/end：完成判定只能靠 session/event 推来的那一条证据。
    const agent = fakeAgent("itest-push");
    const session = fakeSession("itest-push");

    root.emit("agent/status", { agent, status: "running" });
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(
      () => warns.some((line) => line.includes("完成判定跳过")),
      "无证据时的跳过诊断",
    );
    expect(countKind("done")).toBe(0);

    root.emit("agent/status", { agent, status: "running" });
    root.emit("session/event", session, turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "推送证据驱动的完成通知");
    await unmount();
  });

  it("agent/turn-stopping 与 agent/disposed：同一 turn 只发一次，agent 消亡后清账", async () => {
    seed({ ...BASE_SETTINGS, notifyTurnEnd: true });
    const { root, unmount } = await mount({});
    const agent = fakeAgent("itest-turn");
    const signal = new AbortController().signal;

    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 1, "turn-end 落史");

    // 落史本身只证明「事件到了状态机并写了一行」：notifyTurnEnd 关着时同一条也会以 turn-end 落史，
    // 只是带 suppressed。投递面要有自己的判据——出站明细与浏览器帧的序号。
    const delivered = kindLine("turn-end");
    expect(delivered?.suppressed).toBeUndefined();
    expect(delivered?.channels).toEqual([{ channelId: "browser", status: "ok" }]);
    await pollUntil(() => seqValue() === seqAnchor + 1, "帧经 FrameBus 出去");

    // 同一 turn 再来一次：去重状态机在真实事件链上也要成立（否则每步都弹一条）。
    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    // 界碑划界：不然「没有第二条」是抢跑得来的。
    await settleHistory();
    expect(countKind("turn-end")).toBe(1);

    // 消亡事件清掉去重记录：否则同一 id 复用后这一 turn 永远不再通知。
    root.emit("agent/disposed", { agent });
    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 2, "清账后同一 turn 可再发");
    await unmount();
  });

  it("浏览器出口拿到帧：投递经组合根 FrameBus 走到 api 域，序号前进一格", async () => {
    const { root, unmount } = await mount({});
    root.emit("agent/error", {
      agent: fakeAgent("itest-frame"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });
    await pollUntil(() => countKind("error") === 1, "投递归档");
    // 序号只在 api 域订阅到帧之后才前进：这一格同时证明 FrameBus 的 emit 与 onFrame 两端接上了。
    await pollUntil(() => seqValue() === seqAnchor + 1, "帧经 FrameBus 出去");
    const delivered = kindLine("error")?.channels?.[0];
    expect(delivered?.channelId).toBe("browser");
    expect(delivered?.status).toBe("ok");
    await unmount();
  });
}

describe("宿主事件可达性", () => {
  registerScopedEventReachability();
  registerHostEventDelivery();
});

describe("宿主 agent 注册表（子代理归属）", () => {
  it("注册表缺位：带 parentSession 的会话按主任务处理（宁可多报一条 done，不静默用户自己的任务）", async () => {
    const { root, unmount } = await mount({});
    // header 有 parentSession，但宿主没装 agents 服务：`ctx.get("agents", false)` 必须缺位安全，
    // 而不是抛错或把「查不到」当成「是子代理」——后者会让子代理的完成通知永远发不出去。
    const events: SessionEvent[] = [];
    const child = fakeAgent("itest-orphan", events, { parentSession: "itest-gone" });

    root.emit("agent/status", { agent: child, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: child, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "查不到父 agent 时按主任务报完成");
    expect(countKind("subagent-done")).toBe(0);
    await unmount();
  });

  it("注册表有据：确由父 agent 创建的会话落 subagent-done，而不是当成主任务再报一次", async () => {
    const parent = fakeAgent("itest-parent");
    const events: SessionEvent[] = [];
    const child = fakeAgent("itest-child", events, { parentSession: "itest-parent" });
    const { root, unmount } = await mount({ services: { agents: fakeAgents(parent, child) } });

    root.emit("agent/status", { agent: child, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: child, status: "idle" });
    // 两跳判定的产物只有 kind 能区分：`done` 会让每个子代理都伪装成用户的主任务。
    await pollUntil(() => countKind("subagent-done") === 1, "子代理完成通知落史");
    expect(countKind("done")).toBe(0);
    await unmount();
  });
});
