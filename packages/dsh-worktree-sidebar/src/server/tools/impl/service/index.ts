/**
 * tools 域装配：把三个工具装进「位于 git 仓库里的」所有 agent 的作用域（含子 agent）。
 *
 * 两条入口缺一不可：`agent/created` 覆盖之后发布的 agent，`list()` 覆盖**本装配之前就已经在跑**的那些。
 * 后者不是理论情形——dev HMR、动态装插件、以及任何在会话已经打开时才挂上的插件都会撞上它，
 * 而漏掉它的表现是「老会话看不到工具」，且只在重启后才复现。
 *
 * 已注册的 agent 映射与订阅住在实例里；域是**进程内单例**，第二次 `install` 由 `installed` 守卫
 * **显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentFace, ToolsDeps } from "../../deps.ts";
import { buildCreateTool } from "../create/index.ts";
import { buildRemoveTool } from "../remove/index.ts";
import { buildRegisterTool } from "../register/index.ts";
import { repoOf } from "../bind/index.ts";

/** 三个工具的注册者：唯一实例。 */
class ToolsService {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  private deps: ToolsDeps | undefined;
  /** 每个 agent 的工具摘除器。释放时逐个调用并清空，下一次装配才装得进同一个 agent。 */
  private readonly perAgent = new Map<string, () => void>();
  private unsubscribe: (() => void) | undefined;
  // 判定要走一次 git，是异步的；不串行化的话两个同时发布的 agent 会各自看到「尚未注册」，
  // 于是同一个 agent 被装两遍。
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * 装配代数。在飞的异步判定跨过一次 release 就作废——否则它会把上一代的 deps 装进新一代，
   * 而那种串味的症状是「工具装了但绑的是上一个装配体的表」。
   */
  private generation = 0;

  /** 装配工具域。重复装配是编程错误，当场暴露。 */
  install(deps: ToolsDeps): void {
    if (this.installed) throw new Error("dsh-worktree-sidebar: tools 域只能装配一次");
    this.installed = true;
    this.deps = deps;
    const generation = this.generation;
    const consider = (agent: AgentFace): void => this.consider(generation, agent);
    this.unsubscribe = deps.agents.subscribe(consider);
    for (const agent of deps.agents.list()) consider(agent);
  }

  /**
   * 卸载：退订、逐个摘掉每个 agent 的工具、丢掉映射与在飞的异步链，复位装配标记。重复调用无害。
   * 映射必须清空——留着它下一次装配会把同一个 agent 当成「已装过」直接跳过，工具永远装不上。
   */
  release(): void {
    this.installed = false;
    this.generation += 1;
    this.deps = undefined;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch {
        // 卸载阶段不做失败上报，避免掩盖首个异常。
      }
    }
    for (const dispose of [...this.perAgent.values()].reverse()) {
      try {
        dispose();
      } catch {
        // 同上。
      }
    }
    this.perAgent.clear();
    this.chain = Promise.resolve();
  }

  /** 判定一个 agent 是否该装工具，该装就装。同一个 agent 只处理一次。 */
  private consider(generation: number, agent: AgentFace): void {
    this.chain = this.chain
      .then(async () => {
        const deps = this.deps;
        if (deps === undefined) return;
        if (generation !== this.generation || this.perAgent.has(agent.id)) return;
        if ((await repoOf(deps, agent)) === undefined) return;
        // 解析期间可能已被释放、已被换了一代装配，或该 agent 已被处理过：都要重新确认。
        if (generation !== this.generation || this.perAgent.has(agent.id)) return;
        const definitions: readonly ToolDefinition[] = [
          buildRegisterTool(deps),
          buildCreateTool(deps),
          buildRemoveTool(deps),
        ];
        this.perAgent.set(agent.id, deps.agents.publish(agent, definitions));
      })
      .catch((cause: unknown) => {
        const deps = this.deps;
        // 失败要归因到活着的那一代：落后一代的失败连「谁的 logger」都无从谈起。
        if (deps === undefined || generation !== this.generation) return;
        const reason = cause instanceof Error ? cause.message : String(cause);
        deps.logger.warn("dsh-worktree-sidebar: 工具注册失败 — " + reason);
      });
  }
}

/** 本域唯一实例：类不外放，外面 `new` 不出第二份注册表。 */
export const toolsService = new ToolsService();
