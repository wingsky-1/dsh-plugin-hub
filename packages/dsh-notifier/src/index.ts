/**
 * 宿主端组合根：收窄宿主上下文、按依赖顺序装配各域（`upgrade` 最先因其动磁盘、`api` 最后因其读现值）、卸载逆序释放。
 * 交付的是能力对象而非装配期快照——设置是活的，快照看起来与实时读取一模一样。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import * as apiApi from "./server/api/interface.ts";
import * as channelsApi from "./server/channels/interface.ts";
import * as configApi from "./server/config/interface.ts";
import * as eventsApi from "./server/events/interface.ts";
import type { AgentRegistryPort, HostEventPort } from "./server/events/interface.ts";
import * as pipelineApi from "./server/pipeline/interface.ts";
import type { OutgoingFrame } from "./server/pipeline/interface.ts";
import type { LegacySettingsFace } from "./server/upgrade/deps.ts";
import type { ExposePort } from "./server/sdk/deps.ts";
import * as sdkApi from "./server/sdk/interface.ts";
import type { NotifierService } from "./server/sdk/interface.ts";
import type { LoggerPort } from "./server/shared/interface.ts";
import * as storesApi from "./server/stores/interface.ts";
import { installUpgrade, releaseUpgrade } from "./server/upgrade/interface.ts";

/**
 * 对外服务面类型：消费方要写 `const n: NotifierService = ctx["wingsky.notifier"]` 就得能命名它，
 * 它同时是下面声明合并的载荷。
 */
export type { NotifierService } from "./server/sdk/interface.ts";

/** 宿主 settings 服务的名字。它是宿主的知识，不是本插件的 ABI。 */
const SETTINGS_SERVICE = "settings";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/**
 * 依赖的宿主服务。`settings` 是**必需**依赖而不是可选探测：0.2.3 把配置存在它那里，装配期要读一次存量。
 * 声明成依赖之后，宿主保证服务就绪才装配本插件——顺序由框架保证，比「先试一次、再监听晚到的」可靠。
 */
export const inject = ["webServer", SETTINGS_SERVICE];

/**
 * 组合层入口配置（插件挂载点传入）。只有总开关：设置项全部住在本插件自己的配置文件里，
 * 这里再开一层默认值只会让人以为某处配过什么，而它永远是空的。
 */
export interface NotifierApplyConfig {
  /** 总开关；`false` 时一律不投递。不落盘、不进设置层。 */
  enabled?: boolean;
}

/** 挂载 dsh-notifier。 */
export function apply(ctx: Context, config: NotifierApplyConfig = {}): void {
  const host = bindHost(ctx);
  const disposers = assemble(host, config);
  ctx.effect(() => () => safeDisposeAll(disposers));
}

/**
 * 宿主事件默认按 fiber 作用域过滤，通知插件必须看到所有会话与 agent，故每条订阅都要带它。
 * 漏掉的表现是「有些会话不通知」，且只在多会话下出现——单会话调试永远复现不了。
 */
const GLOBAL_LISTEN = { global: true } as const;

/**
 * 对外名字的声明合并。必须写在包入口：`declare module` 是全局增强，入口声明面不可达时
 * `lib/index.d.ts` 里就没有它（`pack:check` 的「声明合并可达性」判据盯这条）；键引用 sdk 域的
 * 常量，服务名只留一个物理定义——抄一份字面量同样能编译，改名漏改时只会在运行时的另一头暴露。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 通知中心服务面：兄弟插件经它登记自己的通知种类、发送通知。 */
    [sdkApi.NOTIFIER_SERVICE]: NotifierService;
  }
}

/**
 * 帧总线：生产端只给 `emit`（裁决管线），消费端只给 `onFrame`（浏览器出口），类型就是围栏。
 * 它是组合根的本地设施而不是宿主事件总线上的事件——总线上的名字是公共面，谁都能收发。
 * 遍历前先取快照：帧是 fire-and-forget 的旁路，回调里退订不该打断本轮其余订阅者。
 */
class FrameBus {
  private readonly handlers = new Set<(payload: OutgoingFrame) => void>();

  emit(payload: OutgoingFrame): void {
    for (const handler of [...this.handlers]) handler(payload);
  }

  onFrame(handler: (payload: OutgoingFrame) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
  /** 帧总线：帧经它从裁决管线走到浏览器出口。 */
  readonly frames: FrameBus;
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  readonly register: (route: WebRoute) => () => void;
  readonly events: HostEventPort;
  /** 宿主 agent 注册表：子代理归属判定要它。 */
  readonly agents: AgentRegistryPort;
  /**
   * 宿主 settings 服务：0.2.3 把配置存在那里，新架构搬走后仍需读它一次。
   * 只声明本域要用的 `describe`——窄面让「本域不认识 settings 的其余能力」成为类型事实。
   */
  readonly legacySettings: LegacySettingsFace;
  /** 宿主出口：把服务面挂上上下文。服务名是 sdk 域的 ABI，组合根不参与命名。 */
  readonly expose: ExposePort;
}

function bindHost(ctx: Context): HostPort {
  /**
   * 把本插件的处理收进一个「绝不向宿主抛错」的壳里：本插件在宿主事件链上只是旁观者，
   * 自己出问题不该影响别人的流程。审批与提问这两条是 waterfall，抛出去会让 `next()`
   * 不被调用，症状是「审批框不弹了」，与本插件毫无字面关联。
   */
  const guard = (run: () => void): void => {
    try {
      run();
    } catch (cause) {
      // 不静默：这里是唯一还知道发生了什么的地方，吞掉之后「通知不工作」会变成查不出原因的现象。
      const reason = cause instanceof Error ? cause.message : String(cause);
      ctx.logger.warn(`dsh-notifier: 宿主事件处理失败 —— ${reason}`);
    }
  };

  return {
    logger: ctx.logger,
    frames: new FrameBus(),
    // 依赖已由 `inject` 声明，服务就绪才轮到本插件装配：这里直接取用，没有探测、也没有迟到分支。
    legacySettings: ctx.settings,
    register: (route) => ctx.webServer.register(route),
    // 名字取自 sdk 域（ABI 的定义处）。显式类型参数是道保险：谁把那里退回硬编码字面量，
    // 少了它就静默失败——`ctx.provide` 的 `(name: string, value?: any)` 重载会兜住任意字符串。
    expose: {
      provide: (service) =>
        ctx.provide<typeof sdkApi.NOTIFIER_SERVICE>(sdkApi.NOTIFIER_SERVICE, service),
    },
    events: {
      // 审批事件是 waterfall：本插件只旁观，转发之后必须 next()，漏掉就等于替所有人否决了
      // 这次审批，症状是「审批不弹了」。prepend 让本监听器排在链前——前面的监听器不调
      // next() 时，这次审批会对本插件彻底不可见。
      onApprovalRequest: (handler) =>
        ctx.on(
          "approval/request",
          (request, next) => {
            guard(() => handler(request));
            return next();
          },
          { global: true, prepend: true },
        ),
      // 与审批同构的第二个 waterfall：同样只旁观、同样必须把判定交还，漏 next() 的症状是
      // 「提问不弹了」。
      onUserQuestion: (handler) =>
        ctx.on(
          "user-questions/request",
          (request, next) => {
            guard(() => handler(request));
            return next();
          },
          { global: true, prepend: true },
        ),
      onSessionEvent: (handler) =>
        ctx.on(
          "session/event",
          (session, event) => {
            guard(() => handler(session.id, event));
          },
          GLOBAL_LISTEN,
        ),
      // agent 四个事件把官方载荷**原样**转过去：拆成 id 等于替域决定「哪些字段有用」，
      // 而那个决定正是 events 域该做的判断。
      onAgentStatus: (handler) =>
        ctx.on(
          "agent/status",
          (payload) => {
            guard(() => handler(payload));
          },
          GLOBAL_LISTEN,
        ),
      onAgentDisposed: (handler) =>
        ctx.on(
          "agent/disposed",
          (payload) => {
            guard(() => handler(payload));
          },
          GLOBAL_LISTEN,
        ),
      onAgentTurnStopping: (handler) =>
        ctx.on(
          "agent/turn-stopping",
          (payload) => {
            guard(() => handler(payload));
          },
          GLOBAL_LISTEN,
        ),
      // 唯一的例外是错误原文：官方那边是宽类型，在这里做唯一一次收窄，域内不出现宽类型。
      onAgentError: (handler) =>
        ctx.on(
          "agent/error",
          (payload) => {
            const failure = payload.error;
            const reason = failure instanceof Error ? failure.message : String(failure);
            guard(() => handler({ ...payload, error: reason }));
          },
          GLOBAL_LISTEN,
        ),
    },
    // 宿主 agent 注册表：子代理归属判定的第二个信号。查不到与查得到分开报，怎么理解是域的事。
    agents: {
      lookup: (id) => {
        const agent = ctx.get("agents", false)?.get(id);
        return agent === undefined ? { found: false } : { found: true, agent };
      },
      isOwnedBy: (id, owner) => ctx.get("agents", false)?.isOwnedBy(id, owner) === true,
    },
  };
}

/**
 * 装配：按依赖顺序接上各域，返回它们的释放函数。每步入参都来自上一步的产出或 `host`，
 * 顺序错了就是运行期空值。
 */
function assemble(host: HostPort, config: NotifierApplyConfig): Array<() => void> {
  const disposers: Array<() => void> = [];

  // 0. 存储与配置形态迁移：动的是磁盘（存储三个文件 + 配置文件），必须早于任何读文件的域。
  //    存量配置由 settings 的显式依赖保证在装配期可读，所以整条链是同步的。
  installUpgrade({ logger: host.logger, legacySettings: host.legacySettings });
  disposers.push(releaseUpgrade);

  // 1. 设置：读面在装配返回时即可用，后续各域不必等加载。
  configApi.installConfig({ logger: host.logger });
  disposers.push(configApi.releaseConfig);

  // 2. 存储：保留天数由它自己按需读设置，不在这里替它取值。
  storesApi.installStores({ logger: host.logger, config: configApi });
  disposers.push(storesApi.releaseStores);

  // 3. 裁决管线：递的是提供方的命名空间对象（消费方用 Pick 收窄），将来多用一样能力不用改这行。
  pipelineApi.installPipeline({
    enabled: config.enabled !== false,
    frames: host.frames,
    logger: host.logger,
    config: configApi,
    stores: storesApi,
    channels: channelsApi,
  });
  disposers.push(pipelineApi.releasePipeline);

  // 4. 事件：请求一律产出，去留由裁决层决定——开关会在本域看不见的地方被改。
  eventsApi.installEvents({
    events: host.events,
    agents: host.agents,
    logger: host.logger,
    pipeline: pipelineApi,
  });
  disposers.push(eventsApi.releaseEvents);

  // 5. 对外 ABI：服务面自己不依赖任何后装的域，但 api 域要读它的种类清单，故排在 api 之前。
  sdkApi.installSdk({
    expose: host.expose,
    config: configApi,
    pipeline: pipelineApi,
  });
  disposers.push(sdkApi.releaseSdk);

  // 6. 浏览器出口：最后装——它读各域的现值，装早了页面第一次请求就会拿到半成品。
  apiApi.installApi({
    register: host.register,
    frames: host.frames,
    logger: host.logger,
    config: configApi,
    stores: storesApi,
    pipeline: pipelineApi,
    kinds: sdkApi,
  });
  disposers.push(apiApi.releaseApi);

  return disposers;
}

/** 逐个释放；单个释放失败不阻断其余（否则一个域的清理会拖垮整条卸载链）。 */
function safeDisposeAll(disposers: Array<() => void>): void {
  // 逆序：后装的先释放，否则 api 域会在别人已放开的入参上继续服务。
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常
    }
  }
}
