/**
 * tools 域装配：把三个工具装进「位于 git 仓库里的」顶层 agent 的作用域。
 *
 * 两条入口缺一不可：`agent/created` 覆盖之后发布的 agent，`list()` 覆盖**本插件加载前就已经在跑**的那些。
 * 后者不是理论情形——dev HMR、动态装插件、以及任何在会话已经打开时才挂上的插件都会撞上它，
 * 而漏掉它的表现是「老会话看不到工具」，且只在重启后才复现。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AgentFace, ToolsDeps } from "../../deps.ts";
import { buildCreateTool } from "../create/index.ts";
import { buildRemoveTool } from "../remove/index.ts";
import { buildRegisterTool } from "../register/index.ts";
import { repoOf } from "../bind/index.ts";

interface Installed {
  readonly deps: ToolsDeps;
  readonly perAgent: Map<string, () => void>;
  unsubscribe: () => void;
}

let installed: Installed | null = null;

/** 装配工具域。 */
export function install(deps: ToolsDeps): void {
  if (installed !== null) throw new Error("dsh-worktree-sidebar: tools 域已装配");
  const state: Installed = { deps, perAgent: new Map(), unsubscribe: () => undefined };
  installed = state;

  // 判定要走一次 git，是异步的；不串行化的话两个同时发布的 agent 会各自看到「尚未注册」，
  // 于是同一个 agent 被装两遍。
  let chain: Promise<unknown> = Promise.resolve();
  const consider = (agent: AgentFace): void => {
    chain = chain
      .then(async () => {
        if (installed !== state || state.perAgent.has(agent.id)) return;
        if ((await repoOf(deps, agent)) === undefined) return;
        // git 调用期间可能已被释放，或该 agent 已被处理过：两个都要重新确认。
        if (installed !== state || state.perAgent.has(agent.id)) return;
        const definitions: readonly ToolDefinition[] = [
          buildRegisterTool(deps),
          buildCreateTool(deps),
          buildRemoveTool(deps),
        ];
        state.perAgent.set(agent.id, deps.agents.publish(agent, definitions));
      })
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        deps.logger.warn("dsh-worktree-sidebar: 工具注册失败 — " + reason);
      });
  };

  const unsubscribe = deps.agents.subscribe(consider);
  if (installed !== state) {
    // subscribe 期间被释放：退订，不再枚举。
    unsubscribe();
    return;
  }
  state.unsubscribe = unsubscribe;

  for (const agent of deps.agents.list()) consider(agent);
}

/** 卸载工具域：退订 + 摘掉每个 agent 的工具。幂等。 */
export function release(): void {
  const current = installed;
  installed = null;
  if (current === null) return;
  try {
    current.unsubscribe();
  } catch {
    // 卸载阶段不做失败上报，避免掩盖首个异常。
  }
  for (const dispose of [...current.perAgent.values()].reverse()) {
    try {
      dispose();
    } catch {
      // 同上。
    }
  }
  current.perAgent.clear();
}
