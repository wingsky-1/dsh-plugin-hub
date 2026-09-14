/** tools 域依赖声明：只声明「我需要外部什么」，声明面只有类型。 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type * as bindingApi from "../binding/interface.ts";
import type * as gitApi from "../git/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/**
 * binding 域给工具的能力面。**工具是唯一的写入口**——api 域拿不到这三个方法，
 * 所以浏览器侧不存在任何写绑定的授权路径。
 */
export type BindingPort = Pick<typeof bindingApi, "get" | "put" | "drop">;

/** git 域给工具的能力面。只列本域真正要用的方法，域内不认识 git 的其余能力。 */
type GitPort = Pick<
  typeof gitApi,
  | "commonDir"
  | "belongsTo"
  | "headBranch"
  | "checkRefFormat"
  | "addWorktree"
  | "removeWorktree"
  | "listWorktrees"
>;

/** 一条 agent 的窄面。 */
export interface AgentFace {
  readonly id: string;
  /**
   * 会话工作目录。判定「是否在 git 仓库里」与解析相对路径都用它。
   * 缺省时不注册工具——没有 cwd 就无法回答「这个会话在不在仓库里」，猜一个会给出错的工具。
   */
  readonly cwd: string | undefined;
}

/**
 * agent 注册面。三个方法各自对应一件事，域内不出现 `ctx`：
 * 谁订事件、从哪枚举、怎么把工具装进某个 agent 的作用域，都是组合根的知识。
 */
export interface AgentPort {
  /** 订阅「新 agent 发布」。返回退订函数。 */
  subscribe(handler: (agent: AgentFace) => void): () => void;
  /** 当前存活的所有 agent 快照（含子 agent；插件加载前就存在的那些都在里面）。 */
  list(): readonly AgentFace[];
  /** 把工具装进该 agent 的作用域，返回释放函数。 */
  publish(agent: AgentFace, definitions: readonly ToolDefinition[]): () => void;
}

export interface ToolsDeps {
  readonly logger: LoggerPort;
  readonly binding: BindingPort;
  readonly git: GitPort;
  readonly agents: AgentPort;
  /** 登记时间戳。由组合根注入，与 binding 域共用同一个时钟实现。 */
  readonly now: () => string;
}
