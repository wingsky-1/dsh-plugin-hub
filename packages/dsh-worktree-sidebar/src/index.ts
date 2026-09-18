/**
 * 宿主端组合根：收窄宿主上下文、按依赖顺序装配各域、卸载逆序释放。
 *
 * `ctx` 的知识只在这里出现——两个宿主适配器各自的官方形状收窄都写在下面对应的 `bind*` 调用里，
 * 适配逻辑住 `src/server/host/`（宿主 rc 演进时只动那几个小文件）。五个域因此都拿不到 `ctx`，
 * 也都能脱离 cordis 被单测驱动。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-typert-protocol";
import { ROUTES } from "./shared/interface.ts";
import { bindAgents } from "./server/host/agents.ts";
import type { StoredSessionsFace } from "./server/host/sessions.ts";
import { bindSessions } from "./server/host/sessions.ts";
import { bindTypert } from "./server/host/typert.ts";
import * as apiApi from "./server/api/interface.ts";
import * as bindingApi from "./server/binding/interface.ts";
import * as gitApi from "./server/git/interface.ts";
import type { SessionChainPort, TypertPort } from "./server/scope/deps.ts";
import * as scopeApi from "./server/scope/interface.ts";
import type { AgentPort } from "./server/tools/deps.ts";
import * as toolsApi from "./server/tools/interface.ts";
import type { LoggerPort } from "./server/shared/interface.ts";
import { bindingsFile } from "./server/shared/interface.ts";

/** 路由清单经这里出去，构建期注入客户端（bundle-host.ts 只认入口的 `ROUTES` 导出）。 */
export { ROUTES };

/** 稳定的 cordis 插件名。 */
export const name = "worktree-sidebar";

/**
 * 依赖的宿主服务。声明成依赖之后由框架保证服务就绪才轮到装配。
 *
 * `typert` 是接管 `workspaceFileScope` 的唯一入口；`sessions` 只用来读**父链**（子 agent 继承父会话的
 * 登记要靠它）。`sandboxPolicy` 曾经也在这里，是「provider 缺失时自己复刻官方默认语义」那套兜底的输入，
 * 兜底删掉后它没有消费方了。
 */
export const inject = ["webServer", "agents", "typert", "sessions"];

/** 组合层入口配置。只有总开关（经插件配置传入）：不在盘上读用户配置文件，绑定表由插件在 DSH_HOME 下自持。 */
export interface WorktreeSidebarConfig {
  /** 总开关；`false` 时一律不接管、不注册工具、不挂路由。 */
  enabled?: boolean;
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
  readonly register: (route: WebRoute) => () => void;
  readonly agents: AgentPort;
  readonly typert: TypertPort;
  readonly sessions: SessionChainPort;
  readonly now: () => string;
}

/** 挂载 dsh-worktree-sidebar。 */
export async function apply(ctx: Context, config: WorktreeSidebarConfig = {}): Promise<void> {
  const host: HostPort = {
    logger: ctx.logger,
    register: (route) => ctx.webServer.register(route),
    agents: bindAgents({
      on: (event, handler) => ctx.on(event, handler),
      all: () => ctx.agents.list(),
    }),
    typert: bindTypert(ctx.typert.lookups),
    sessions: bindSessions(ctx.sessions, () => storedSessionsOf(ctx)),
    now: () => new Date().toISOString(),
  };
  const disposers = await assemble(host, config);
  ctx.effect(() => () => safeDisposeAll(disposers));
}

/**
 * 官方**持久**会话面（可选）。每次调用都现取：`ctx.get` 的语义是「取当刻值，未提供回 undefined」
 * （`cordis/lib/index.js:754-771`），提前取一次会让晚挂的后端永久退化成缺席，子会话继承就只在
 * 会话存活期间成立——而 UI 里能点选的恰是已结束的子会话。
 */
function storedSessionsOf(ctx: Context): StoredSessionsFace | undefined {
  return ctx.get("sessionPersistence");
}

/**
 * 装配：按依赖顺序接上各域，返回它们的释放函数。
 *
 * 各域都是**进程内单例**（`installXxx` + `releaseXxx` 成对），域内状态住在实例里而不是模块里；
 * 同进程装配两次由各域的 `installed` 守卫在第二次 `install` 时**显式抛错**——
 * 响亮失败优于静默共享状态或丢数据。
 *
 * 一律「装一个就把它的释放动作推进链里」：中途失败必须把已经装上的域放掉再抛，
 * 否则一次装配失败会留下半装的域，而它的释放函数还没进 `disposers`，卸载时没人收。
 */
async function assemble(
  host: HostPort,
  config: WorktreeSidebarConfig,
): Promise<Array<() => void | Promise<void>>> {
  const disposers: Array<() => void | Promise<void>> = [];
  if (config.enabled === false) return disposers;

  try {
    // 1. 绑定域：其余三个域都读它，故最先装。
    bindingApi.installBinding({ logger: host.logger, file: bindingsFile() });
    disposers.push(bindingApi.releaseBinding);

    // 2. git 域：tools 的增删与 scope 的归属校验都要它。递进去的 exec 面是本域自带的常量，
    //    它仍然走装配入参，因为测试要能换成假 exec（域内不起子进程）。
    gitApi.installGit({ exec: gitApi.gitExec });
    disposers.push(gitApi.releaseGit);

    // 3. scope 域：接管 workspaceFileScope。capture 必须在 configure 之前、provider 缺席时就地等待，
    //    两件事都由本域自己保证（它拿到的是查找表窄面，不是 ctx）。
    scopeApi.installScope({
      logger: host.logger,
      binding: bindingApi,
      git: gitApi,
      typert: host.typert,
      sessions: host.sessions,
    });
    disposers.push(scopeApi.releaseScope);

    // 4. tools 域：写绑定的唯一入口。它读 scope 的**绑定来源**（不是生效根）：工具面的现状读数
    //    因此与侧边栏那一路同源，fork 出来的会话不会再被回一句「本会话没有绑定」。
    toolsApi.installTools({
      logger: host.logger,
      binding: bindingApi,
      git: gitApi,
      scope: scopeApi,
      agents: host.agents,
      now: host.now,
    });
    disposers.push(toolsApi.releaseTools);

    // 5. api 域：读 scope 的**生效值**（不是绑定表原文），最后装。一个提供方一行：
    //    修订号来自 binding、生效根来自 scope，本域不认识任何一个域的实现。
    apiApi.installApi({
      register: host.register,
      logger: host.logger,
      binding: bindingApi,
      scope: scopeApi,
    });
    disposers.push(apiApi.releaseApi);
  } catch (cause) {
    await safeDisposeAll(disposers);
    throw cause;
  }

  return disposers;
}

/** 逐个释放（逆序）；单个释放失败不阻断其余（否则一个域的清理会拖垮整条卸载链）。 */
async function safeDisposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
  // 逆序：后装的先释放，否则 api 域会在别人已放开的入参上继续服务。
  // 逐个 await：binding 域的释放要等在飞的写盘落定，不等就会让下一次装配读到更旧的磁盘状态。
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常。
    }
  }
}
