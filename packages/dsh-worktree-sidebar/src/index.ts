/**
 * 宿主端组合根：收窄宿主上下文、按依赖顺序装配各域、卸载逆序释放。
 *
 * 两个适配层住在这里，因为它们是 `ctx` 知识的唯一收口处：`bindAgents`（谁算 agent、怎么把工具装进它的作用域）
 * 与 `bindTypert`（官方 typert 的类型体操）。四个域因此都拿不到 `ctx`，也都能脱离 cordis 被单测驱动。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WorkspaceFileScope } from "@deepseek-ai/dsh-api-workspace-files";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-typert-protocol";
import * as apiApi from "./server/api/interface.ts";
import * as bindingApi from "./server/binding/interface.ts";
import * as gitApi from "./server/git/interface.ts";
import type { DefaultScopePort, FileScope, TypertPort } from "./server/scope/deps.ts";
import * as scopeApi from "./server/scope/interface.ts";
import type { AgentPort } from "./server/tools/deps.ts";
import * as toolsApi from "./server/tools/interface.ts";
import type { LoggerPort } from "./server/shared/interface.ts";
import { bindingsFile } from "./server/shared/interface.ts";
import { ROUTES } from "./contract.ts";

/** 路由清单经这里出去，构建期注入客户端（bundle-host.ts 只认入口的 `ROUTES` 导出）。 */
export { ROUTES };

/** 稳定的 cordis 插件名。 */
export const name = "worktree-sidebar";

/**
 * 依赖的宿主服务。声明成依赖之后由框架保证服务就绪才轮到装配。
 * `typert` / `sessions` / `sandboxPolicy` 是文件根接管与官方默认等价实现的前提，
 * 与官方 dsh-api-workspace-files 的注入面同源（它也是这四个）。
 */
export const inject = ["webServer", "agents", "typert", "sessions", "sandboxPolicy"];

/** 组合层入口配置。只有总开关：本插件没有用户配置文件。 */
export interface WorktreeSidebarConfig {
  /** 总开关；`false` 时一律不接管、不注册工具、不挂路由。 */
  enabled?: boolean;
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
  readonly register: (route: WebRoute) => () => void;
  readonly exec: gitApi.GitExecPort;
  readonly agents: AgentPort;
  readonly typert: TypertPort;
  readonly defaults: DefaultScopePort;
  readonly now: () => string;
}

/** 挂载 dsh-worktree-sidebar。 */
export function apply(ctx: Context, config: WorktreeSidebarConfig = {}): void {
  const host: HostPort = {
    logger: ctx.logger,
    register: (route) => ctx.webServer.register(route),
    exec: gitApi.createGitExec(),
    agents: bindAgents(ctx),
    typert: bindTypert(ctx),
    defaults: bindDefaults(ctx),
    now: () => new Date().toISOString(),
  };
  const disposers = assemble(host, config);
  ctx.effect(() => () => safeDisposeAll(disposers));
}

/**
 * agent 注册面：工具域只看到「一个 agent 有 id、有 cwd、可以往里装工具」；
 * 「只给顶层 agent」与「装进去的效应随 agent 一起释放」由这里决定。
 */
function bindAgents(ctx: Context): AgentPort {
  /** 订阅回调用的是发布时的 agent 对象；到 `publish` 时只能靠 id 找回它。 */
  const live = new Map<string, Agent>();

  const faceOf = (agent: Agent) => ({ id: agent.id, cwd: agent.session.header.cwd });

  return {
    subscribe: (handler) =>
      ctx.on("agent/created", ({ agent }) => {
        // 只给顶层 agent：子代理的工具面由它的调用方决定，不该被本插件改变。
        if (!ctx.agents.roots().includes(agent)) return;
        live.set(agent.id, agent);
        handler(faceOf(agent));
      }),
    list: () =>
      ctx.agents.roots().map((agent) => {
        live.set(agent.id, agent);
        return faceOf(agent);
      }),
    publish: (face, definitions) => {
      const agent = live.get(face.id);
      if (agent === undefined) return () => undefined;
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
      // cordis 的 effect disposer 是**可等待**的（Disposable<Promise<void>>），而 tools 域的释放链是同步的
      // （它的调用点全部在同步的卸载路径上）。agent 释放在框架侧本来就会跑这个 effect，
      // 这里只是允许主动提前；因此不阻塞，也不让 rejection 变成未处理拒绝。
      return () => {
        void Promise.resolve(dispose()).catch(() => undefined);
      };
    },
  };
}

/**
 * typert 适配层：官方类型只在这里出现，scope 域只认自己的窄接口。
 *
 * 两处**刻意**的窄化，各自的依据都写在这里：
 * 1. `lookups.get()` 的返回类型是**无参数**的 `TypertLookupProvider`（`unknown/unknown`），
 *    参数只出现在 `register` / `configure` 的重载上（dsh-typert-protocol/lib/types/types.d.ts:389）。
 *    运行时它确实是该键的描述符，所以这里按键的类型断言回来。
 * 2. 我们的 `FileScope.sessionId` 是 `string`，官方 wire 是品牌化的 `SessionId`——
 *    品牌只在边界上有意义，域内带着它只会让四个域都得认识官方类型。
 */
function bindTypert(ctx: Context): TypertPort {
  const lookups = ctx.typert.lookups;
  return {
    current: () => {
      const descriptor = lookups.get("workspaceFileScope") as
        | {
            resolve: (
              id: SessionId,
            ) => WorkspaceFileScope | undefined | Promise<WorkspaceFileScope | undefined>;
          }
        | undefined;
      if (descriptor === undefined) return undefined;
      const resolve = descriptor.resolve.bind(descriptor);
      return {
        resolve: async (sessionId: string): Promise<FileScope | undefined> => {
          const scope = await resolve(sessionId as SessionId);
          if (scope === undefined) return undefined;
          return { sessionId: scope.sessionId, workspaceRoot: scope.workspaceRoot };
        },
      };
    },
    configure: (resolver) =>
      lookups.configure("workspaceFileScope", async (sessionId) => {
        const scope = await resolver(sessionId);
        if (scope === undefined) return undefined;
        // sessionId 用官方那一个（已品牌化），而不是我们回传的字符串。
        return { sessionId, workspaceRoot: scope.workspaceRoot };
      }),
  };
}

/**
 * 官方默认解析所需的三个事实。逐条对齐 dsh-api-workspace-files/lib/index.js:378-387：
 * 活会话优先、`sessionPersistence` 用可选链（缺该服务不是错误）、`sandboxPolicy.workspaceRoot` 兜底。
 */
function bindDefaults(ctx: Context): DefaultScopePort {
  /** 这两样都由官方服务提供，但它们的 Context 声明不住在我们依赖的类型包里（官方靠 static inject 取用），
   *  所以按结构读一次：读不到就返回 undefined，让上游走它自己的 lookup-not-found，而不是抛。 */
  const sandboxPolicy = () =>
    ctx.get("sandboxPolicy" as never, false) as { workspaceRoot?: string } | undefined;
  const persistence = () =>
    ctx.get("sessionPersistence" as never, false) as
      { stat(id: SessionId): Promise<{ header: { cwd?: string } } | undefined> } | undefined;

  return {
    live: (sessionId) => {
      const session = ctx.sessions.get(sessionId as SessionId);
      return session === undefined ? undefined : { cwd: session.header.cwd };
    },
    stored: async (sessionId) => {
      const store = persistence();
      if (store === undefined) return undefined;
      const stored = await store.stat(sessionId as SessionId);
      return stored === undefined ? undefined : { cwd: stored.header.cwd };
    },
    sandboxRoot: () => sandboxPolicy()?.workspaceRoot,
  };
}

/**
 * 装配：按依赖顺序接上各域，返回它们的释放函数。
 *
 * 四个域都是**工厂**（`createXxx` 返回实例），没有模块级状态：
 * 同进程装配两次不会互相污染，也不会在第二次抛「已装配」。组合根持有实例，域只管自己的闭包。
 *
 * 中途失败必须把已经装上的域放掉再抛——否则一次装配失败会留下半装的域，
 * 而它的释放函数还没进 `disposers`，卸载时没人收。
 */
function assemble(host: HostPort, config: WorktreeSidebarConfig): Array<() => void> {
  const disposers: Array<() => void> = [];
  if (config.enabled === false) return disposers;

  try {
    // 1. 绑定域：其余三个域都读它，故最先建。它没有可释放的资源（状态随实例一起被回收）。
    const binding = bindingApi.createBinding({
      logger: host.logger,
      file: bindingsFile(),
      now: host.now,
    });

    // 2. git 域：tools 的增删与 scope 的归属校验都要它。
    const git = gitApi.createGit({ exec: host.exec });

    // 3. scope 域：接管 workspaceFileScope。capture 必须在 configure 之前，由本域自己保证。
    const scope = scopeApi.createScope({
      logger: host.logger,
      binding,
      git,
      typert: host.typert,
      defaults: host.defaults,
    });
    disposers.push(() => scope.dispose());

    // 4. tools 域：写绑定的唯一入口。
    const tools = toolsApi.createTools({
      logger: host.logger,
      binding,
      git,
      agents: host.agents,
      now: host.now,
    });
    disposers.push(() => tools.dispose());

    // 5. api 域：读 scope 的**生效值**（不是绑定表原文），最后建。
    const api = apiApi.createApi({
      register: host.register,
      logger: host.logger,
      binding: { revision: binding.revision, effectiveWorktree: scope.effectiveWorktree },
    });
    disposers.push(() => api.dispose());
  } catch (cause) {
    safeDisposeAll(disposers);
    throw cause;
  }

  return disposers;
}

/** 逐个释放；单个释放失败不阻断其余（否则一个域的清理会拖垮整条卸载链）。 */
function safeDisposeAll(disposers: Array<() => void>): void {
  // 逆序：后装的先释放，否则 api 域会在别人已放开的入参上继续服务。
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常。
    }
  }
}
