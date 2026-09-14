/**
 * 宿主 agent 适配器（src/host/agents.ts）—— 白盒用例：递手写窄端口直接驱动 `bindAgents`。
 *
 * 为什么必须白盒：适配器的输入是宿主 `ctx`，而 `publish` 的未知 id 分支在真机上不可达
 * （tools 域只会拿 list/subscribe 刚递出去的 face 回来）。把它拆成窄端口之后，这条分支
 * 才第一次有了判据——「未装配的占位要抛错」，而不是静默回一个空释放器。
 *
 * 假件只记原始事实（装了什么、拆了什么、回调了几次），不替适配器做任何判断。
 */
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { bindAgents } from "../../src/host/agents.ts";
import type { AgentHostPort, HostAgentLike } from "../../src/host/agents.ts";
import type { AgentFace } from "../../src/server/tools/deps.ts";

/** 一个 agent 作用域的最小假件：适配器只读 id 与 session.header.cwd。 */
function makeAgent(id: string, cwd: string | undefined) {
  const registered: ToolDefinition[] = [];
  const disposed: ToolDefinition[] = [];
  const agent: HostAgentLike = {
    id,
    session: { header: { cwd } },
    ctx: {
      tools: {
        register: (definition) => {
          registered.push(definition);
          return () => {
            disposed.push(definition);
          };
        },
      },
      // 官方 effect 的语义：效应体立即执行并交出它的 disposer，effect 的释放器触发那个 disposer。
      effect: (execute) => {
        const disposeEffect = execute();
        return () => {
          disposeEffect();
        };
      },
    },
  };
  return { agent, registered, disposed };
}

/** 宿主面假件：roots 由用例给定，事件经 `emit` 手工派发。 */
function fakeHost(roots: readonly HostAgentLike[]) {
  const events: string[] = [];
  const handlers: Array<(payload: { agent: HostAgentLike }) => void> = [];
  const port: AgentHostPort = {
    on: (event, handler) => {
      events.push(event);
      handlers.push(handler);
      return () => undefined;
    },
    roots: () => roots,
  };
  return {
    port,
    events,
    emit: (agent: HostAgentLike) => {
      for (const handler of handlers) handler({ agent });
    },
  };
}

/** 两个占位工具定义：适配器只把它们转手给 `ctx.tools.register`，不读任何字段。 */
const DEFINITIONS = [
  { name: "ws_worktree_register" },
  { name: "ws_worktree_remove" },
] as unknown as readonly ToolDefinition[];

describe("agent 注册面", () => {
  it("list() 枚举过的 agent 能 publish，返回的释放器摘掉它装进去的工具", () => {
    const a1 = makeAgent("a1", "/repo");
    const { port } = fakeHost([a1.agent]);
    const agents = bindAgents(port);

    const faces = agents.list();
    expect(faces).toEqual([{ id: "a1", cwd: "/repo" }]);
    const dispose = agents.publish(faces[0], DEFINITIONS);
    expect(a1.registered).toEqual([...DEFINITIONS]);

    dispose();
    expect(a1.disposed).toEqual([...DEFINITIONS]);
  });

  it("subscribe 收到顶层 agent 后同样能 publish", () => {
    // 事件到达时这个 agent 已经在 roots 里——真机上 agent/created 就是它入册的那一刻。
    const a2 = makeAgent("a2", "/repo");
    const host = fakeHost([a2.agent]);
    const agents = bindAgents(host.port);
    const seen: AgentFace[] = [];
    agents.subscribe((face) => {
      seen.push(face);
    });

    host.emit(a2.agent);
    expect(host.events).toEqual(["agent/created"]);
    expect(seen).toEqual([{ id: "a2", cwd: "/repo" }]);

    agents.publish(seen[0], DEFINITIONS);
    expect(a2.registered).toEqual([...DEFINITIONS]);
  });

  it("publish 一个从没注册过的 id 当场抛错，不静默回空释放器", () => {
    const { port } = fakeHost([]);
    const agents = bindAgents(port);

    expect(() => agents.publish({ id: "ghost", cwd: "/repo" }, DEFINITIONS)).toThrow(
      "dsh-worktree-sidebar: agent ghost 未注册，拒绝把工具装进未知作用域",
    );
  });

  it("子代理（不在 roots 里）不进 live：只有顶层 agent 被回调并拿到工具", () => {
    const parent = makeAgent("p1", "/repo");
    const child = makeAgent("c1", "/repo");
    const host = fakeHost([parent.agent]);
    const agents = bindAgents(host.port);
    const seen: AgentFace[] = [];
    agents.subscribe((face) => {
      seen.push(face);
    });

    host.emit(child.agent);
    host.emit(parent.agent);
    expect(seen).toEqual([{ id: "p1", cwd: "/repo" }]);

    agents.publish(seen[0], DEFINITIONS);
    expect(parent.registered).toEqual([...DEFINITIONS]);
    expect(child.registered).toEqual([]);
  });
});
