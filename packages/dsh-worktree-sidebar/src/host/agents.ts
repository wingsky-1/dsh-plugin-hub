/**
 * 宿主 agent 适配层：把官方 `Agent` 面收窄成 tools 域认得的注册面。
 *
 * 「只给顶层 agent」与「装进去的效应随 agent 一起释放」这两条判断住在这里。
 * 它只认下面这个窄端口，因此不需要起 cordis 就能被白盒驱动。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentFace, AgentPort } from "../server/tools/deps.ts";

/**
 * 适配器真正用到的宿主 agent 面。刻意与官方 `Agent` 解耦：公开的 `Agent` 面要求一个真的
 * `Context`，而本适配器只用「身份 / 会话 cwd / 往这个作用域装工具 / 效应随作用域释放」四件事。
 * 官方 `Agent` 结构上可赋值给它。
 */
export interface HostAgentLike {
  readonly id: string;
  readonly session: { readonly header: { readonly cwd?: string } };
  readonly ctx: {
    readonly tools: { register(definition: ToolDefinition): () => void };
    /** 返回该效应的释放器；官方实现是「可等待的」，域内只需能调用它。 */
    effect(execute: () => () => void): () => unknown;
  };
}

/** 宿主事件面与 agent 枚举面：只开本适配器要的两样。 */
export interface AgentHostPort {
  /** 订阅 agent 发布。返回退订函数。 */
  on(event: "agent/created", handler: (payload: { agent: HostAgentLike }) => void): () => void;
  /** 当前**顶层** agent 快照。 */
  roots(): readonly HostAgentLike[];
}

/** agent 注册面：工具域只看到「一个 agent 有 id、有 cwd、可以往里装工具」。 */
export function bindAgents(host: AgentHostPort): AgentPort {
  /** 订阅回调用的是发布时的 agent 对象；到 `publish` 时只能靠 id 找回它。 */
  const live = new Map<string, HostAgentLike>();

  const faceOf = (agent: HostAgentLike): AgentFace => ({
    id: agent.id,
    cwd: agent.session.header.cwd,
  });

  return {
    subscribe: (handler) =>
      host.on("agent/created", ({ agent }) => {
        // 只给顶层 agent：子代理的工具面由它的调用方决定，不该被本插件改变。
        if (!host.roots().includes(agent)) return;
        live.set(agent.id, agent);
        handler(faceOf(agent));
      }),
    list: () =>
      host.roots().map((agent) => {
        live.set(agent.id, agent);
        return faceOf(agent);
      }),
    publish: (face, definitions) => {
      const agent = live.get(face.id);
      if (agent === undefined) {
        // 「未装配的占位要抛错」而不是给空 disposer：`publish` 的调用点是自家 tools 域的同步
        // 调用，且只发生在 list/subscribe 递出同一个 face 之后，未知 id 只可能是组合根递错了
        // 一个从没注册过的 face。静默回空会让它表现成「工具装上了但其实没有」。
        // 与 notifier 的「挂在宿主事件链上、未装配时静默丢弃」相反先例无关：那是宿主回调，
        // 这里是我们自己的同步调用。
        throw new Error(`dsh-worktree-sidebar: agent ${face.id} 未注册，拒绝把工具装进未知作用域`);
      }
      // 装进 agent 自己的 effect：agent 释放时工具随之摘除，顺序交给框架，
      // 我们不需要另外订阅 agent/disposed。
      const disposers = definitions.map((definition) => agent.ctx.tools.register(definition));
      const disposeTools = (): void => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 卸载阶段不做失败上报，避免掩盖首个异常。
          }
        }
      };
      const dispose = agent.ctx.effect(() => disposeTools);
      // cordis 的 effect disposer 是**可等待的**（Disposable<Promise<void>>），而 tools 域的释放链是同步的
      // （它的调用点全部在同步的卸载路径上）。agent 释放在框架侧本来就会跑这个 effect，
      // 这里只是允许主动提前；因此不阻塞，也不让 rejection 变成未处理拒绝。
      return () => {
        void Promise.resolve(dispose()).catch(() => undefined);
      };
    },
  };
}
