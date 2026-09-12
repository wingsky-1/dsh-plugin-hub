/**
 * dsh-notifier —— 宿主端组合根（唯一的装配层）。
 *
 * ## 只做三件事
 *
 * 1. **收窄宿主上下文**：把 `ctx` 变成各域要用的窄面。域不直接触达全局上下文。
 * 2. **按依赖顺序装配**：域只声明「我需要什么」，满足它是组合根的事。
 * 3. **注册生命周期**：宿主副作用经 `ctx.effect` 登记，卸载时按装配的逆序释放。
 *
 * 业务判断一律不在这里——凡是「什么时候该做什么」的问题，答案都属于某个域。
 * 组合根只把域接起来，不替它们做决定。
 *
 * ## 装配顺序（= 依赖顺序：下游先、上游后）
 *
 * | 序 | 域 | 职责 | 交给它什么 |
 * |---|---|---|---|
 * | 0 | `upgrade` | 存储形态的版本迁移 | 日志 |
 * | 1 | `config` | 通知配置的单一事实源 | 日志 |
 * | 2 | `stores` | 历史与投递状态的持久化 | 日志 |
 * | 3 | `pipeline` | 一条通知的生命周期与**唯一裁决点** | 总开关、帧出口 |
 * | 4 | `events` | 宿主事件 → 通知请求（适配层） | 宿主事件面 |
 * | 5 | `sdk` | 对外 ABI：登记通知种类、接收外部发送 | 宿主出口、裁决管线、设置面 |
 * | 6 | `api` | 浏览器出口：HTTP 路由 + SSE | 路由注册口、帧入口、日志 |
 *
 * `upgrade` 排在最前不是因为它是上游，而是因为它动的是**磁盘**：各域装配时会读
 * 文件，迁移必须在那些读之前落定。
 *
 * `api` 排在最后：它读的是各域的现值，装早了页面第一次请求就会拿到半成品。
 *
 * `channels` 无状态，**没有装配动作**：它没有状态要装，只是被裁决管线当成能力面递
 * 进去。组合根不替它持有实例，也不替调用方保管它的入参。
 *
 * ## 纪律
 *
 * - 域之间不互相引用实现；需要谁的能力、需要哪一样，在各自的 `deps.ts` 里引出来。
 * - 组合根只交付**域拿不到的东西**：宿主能力（日志、事件面、路由口、帧总线）与挂载点
 *   值（总开关）。域间依赖不经这里，所以本文件读起来就是一张「谁需要宿主什么」的表。
 * - 交付的是**能力**，不是算好的值：设置是活的，装配期取一次的快照会在用户改设置后
 *   失效，而它看起来与实时读取一模一样。
 * - 本文件是唯一允许引用全部域 `interface.ts` 的地方。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import * as apiApi from "./server/api/interface.ts";
import * as channelsApi from "./server/channels/interface.ts";
import * as configApi from "./server/config/interface.ts";
import * as eventsApi from "./server/events/interface.ts";
import type { HostEventPort } from "./server/events/interface.ts";
import * as pipelineApi from "./server/pipeline/interface.ts";
import type { OutgoingFrame } from "./server/pipeline/interface.ts";
import type { ExposePort } from "./server/sdk/deps.ts";
import * as sdkApi from "./server/sdk/interface.ts";
import type { NotifierService } from "./server/sdk/interface.ts";
import type { LoggerPort } from "./server/shared/type.ts";
import * as storesApi from "./server/stores/interface.ts";
import { installUpgrade } from "./server/upgrade/interface.ts";

/**
 * 对外服务面的类型。
 *
 * 消费方要写 `const n: NotifierService = ctx["wingsky.notifier"]` 就得能命名它，而它同时
 * 是下面那段声明合并的载荷——不导出，这个包对兄弟插件就只有运行时可用、类型上无从引用。
 */
export type { NotifierService } from "./server/sdk/interface.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 依赖的宿主服务。 */
export const inject = ["webServer"];

/**
 * 组合层入口配置（插件挂载点传入）。
 *
 * 只有总开关。设置项不在这里——设置全部住在本插件自己的配置文件里，由设置页读写；
 * 再开一层「组合层默认值」，只会让人以为某处配过什么，而它永远是空的。
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
 * 宿主事件默认按作用域过滤：只有与当前 fiber 相关的事件才会送达。
 *
 * 通知插件必须看到**所有**会话与 agent，所以每条订阅都要带它。漏掉的表现是
 * 「有些会话不通知」，而且只在多会话场景下才出现——单会话调试永远复现不了。
 */
const GLOBAL_LISTEN = { global: true } as const;

/**
 * 两个对外名字的声明合并。
 *
 * 声明在包入口而不是它们各自的域文件里：`declare module` 是全局增强，tsc 只在入口
 * 可达的声明闭包里保留它——写在域里、而入口的对外声明面又不引用那个域时，产物
 * `lib/index.d.ts` 里根本看不到它，消费方按包名导入时 `ctx.on(…, …)` 与
 * `ctx["wingsky.notifier"]` 就都没有类型。`pack:check` 的「声明合并可达性」判据盯的
 * 正是这条。
 *
 * 两个键都引用常量而不是写字面量：接口的计算属性名接受**字面量类型**，而两个常量在
 * `as const` 下正是字面量类型。于是名字各只有一个物理定义（服务名在 sdk 域、帧事件名
 * 在 pipeline 域，都是它们所属 ABI 的定义处），这里不再各抄一份——抄一份同样能编译，
 * 代价是改名时漏改一处，而两个名字都只在运行时的另一头才暴露：服务名漏改是消费方
 * `ctx.get` 拿到空，帧事件名漏改是「帧发出去没人收到」。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    /**
     * 通知中心服务面：兄弟插件经它登记自己的通知种类、发送通知。
     *
     * 声明在这里与 `Events` 同因（见上）。
     */
    [sdkApi.NOTIFIER_SERVICE]: NotifierService;
  }
  interface Events {
    /** 待展示的通知帧（生产端是裁决管线的帧出口，消费端是 api 域的流枢纽）。 */
    [pipelineApi.NOTIFIER_FRAME](payload: OutgoingFrame): void;
  }
}

/**
 * 帧总线：组合根接上的两头。
 *
 * 生产端给裁决管线（只有 `emit`），消费端给浏览器出口（只有 `onFrame`）——两个域各自
 * 只拿到自己该有的那一半，谁也伪造不了通知、谁也发不出帧。合起来才是总线。
 */
interface FrameBus {
  emit(payload: OutgoingFrame): void;
  onFrame(handler: (payload: OutgoingFrame) => void): () => void;
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
  /** 帧总线：帧经它从裁决管线走到浏览器出口。 */
  readonly frames: FrameBus;
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  readonly register: (route: WebRoute) => () => void;
  readonly events: HostEventPort;
  /** 宿主出口：把服务面挂上上下文。服务名是 sdk 域的 ABI，组合根不参与命名。 */
  readonly expose: ExposePort;
}

function bindHost(ctx: Context): HostPort {
  /**
   * 把本插件的处理收进一个「绝不向宿主抛错」的壳里。
   *
   * 本插件在宿主事件链上只是旁观者，它自己出问题不该影响别人的流程。审批与提问这
   * 两条尤其致命——它们是 waterfall，抛出去会让 `next()` 不被调用，症状是「审批框
   * 不弹了」，与本插件毫无字面关联。所以这一层不是锦上添花的防御，是通道的组成部分：
   * 只要订阅宿主事件，就必须保证自己不往外抛。
   */
  const guard = (run: () => void): void => {
    try {
      run();
    } catch (cause) {
      // 不静默：吞掉之后「通知不工作」会变成一个查不出原因的现象，而这里是唯一
      // 还知道发生了什么的地方。
      const reason = cause instanceof Error ? cause.message : String(cause);
      ctx.logger.warn(`dsh-notifier: 宿主事件处理失败 —— ${reason}`);
    }
  };

  return {
    logger: ctx.logger,
    frames: {
      // 事件名取自 pipeline 域（帧出口的定义处），组合根不自己写一遍字面量。`emit` 与
      // `on` 都没有 `(name: string)` 那样的逃生重载，所以名字与声明合并不一致时是编译
      // 错误，不需要额外的保险写法。
      emit: (payload) => {
        ctx.emit(pipelineApi.NOTIFIER_FRAME, payload);
      },
      // 转发而不是把 ctx 递出去：域要的是「订阅帧」，不是「订阅任意事件」。
      onFrame: (handler) =>
        ctx.on(pipelineApi.NOTIFIER_FRAME, (payload) => {
          guard(() => handler(payload));
        }),
    },
    register: (route) => ctx.webServer.register(route),
    // 名字取自 sdk 域（ABI 的定义处），组合根不自己写一遍字面量。
    //
    // 显式给类型参数：上面声明合并的键引用同一个常量，两者结构上不可能不一致，所以这行
    // 现在是一道保险——谁把那里退回硬编码字面量，少了它就变成静默失败：`ctx.provide` 的
    // 第二个重载 `(name: string, value?: any)` 会兜住任意字符串，编译通过、服务却挂在
    // 没人认识的名字上。
    expose: {
      provide: (service) =>
        ctx.provide<typeof sdkApi.NOTIFIER_SERVICE>(
          sdkApi.NOTIFIER_SERVICE,
          service,
        ),
    },
    events: {
      // 宿主的审批事件是 waterfall：监听者要么自己裁决、要么调 next() 把判定交还。
      // 本插件只旁观，所以转发之后必须 next()——漏掉这一步就等于替所有人否决了
      // 这次审批，而症状是「审批不弹了」，与通知毫无字面关联。
      // prepend 让本监听器排在链的前面：排在别人后面时，任何一个不调 next() 的
      // 前序监听器都会让这次审批对本插件彻底不可见。
      onApprovalRequest: (handler) =>
        ctx.on(
          "approval/request",
          (request, next) => {
            guard(() => handler(request));
            return next();
          },
          { global: true, prepend: true },
        ),
      // 与审批同构的第二个 waterfall：提问同样只旁观，同样必须把判定交还。
      // 漏掉 next() 的症状是「提问不弹了」——比吞掉审批更隐蔽，因为提问本来就少见。
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
      onAgentStatus: (handler) =>
        ctx.on(
          "agent/status",
          (payload) => {
            guard(() => handler(payload.agent.id, payload.status));
          },
          GLOBAL_LISTEN,
        ),
      onAgentDisposed: (handler) =>
        ctx.on(
          "agent/disposed",
          (payload) => {
            guard(() => handler(payload.agent.id));
          },
          GLOBAL_LISTEN,
        ),
      onAgentTurnStopping: (handler) =>
        ctx.on(
          "agent/turn-stopping",
          (payload) => {
            guard(() => handler(payload.agent.id, payload.turn));
          },
          GLOBAL_LISTEN,
        ),
      // 失败可能是任何东西抛出的：在这里做唯一一次收窄，域拿到的就是一条文本。
      onAgentError: (handler) =>
        ctx.on(
          "agent/error",
          (payload) => {
            const failure = payload.error;
            const reason =
              failure instanceof Error ? failure.message : String(failure);
            guard(() => handler(payload.agent.id, payload.turn, reason));
          },
          GLOBAL_LISTEN,
        ),
    },
  };
}

/**
 * 装配：按依赖顺序接上各域，返回它们的释放函数（逆序执行）。
 *
 * 每一步的入参都来自上一步的产出或 `host`——装配顺序即依赖顺序，顺序错了就是
 * 运行期空值。
 */
function assemble(
  host: HostPort,
  config: NotifierApplyConfig,
): Array<() => void> {
  const disposers: Array<() => void> = [];

  // 0. 存储形态迁移：动的是磁盘，必须早于任何读文件的域。
  installUpgrade({ logger: host.logger });

  // 1. 设置：读面在装配返回时即可用，后续各域不必等加载。
  configApi.installConfig({ logger: host.logger });

  // 2. 存储：保留天数由它自己按需读设置，不在这里替它取值。
  storesApi.installStores({ logger: host.logger, config: configApi });

  // 3. 裁决管线：交付的是**能力对象**而不是算好的值——设置是活的，装配期取一次快照
  //    会在用户改设置后失效，而它看起来与实时读取一模一样。
  //    每个 Port 递的是提供方的命名空间对象（消费方用 Pick 收窄），于是本域将来多用
  //    一样能力时，这一行不用改。
  pipelineApi.installPipeline({
    enabled: config.enabled !== false,
    frames: host.frames,
    config: configApi,
    stores: storesApi,
    channels: channelsApi,
  });
  disposers.push(pipelineApi.releasePipeline);

  // 4. 事件：宿主事件 → 通知请求。请求一律产出，去留由裁决层决定——开关会在本域
  //    看不见的地方被改，让它去问一遍等于把运行期策略摊进按事件驱动的块里。
  eventsApi.installEvents({ events: host.events, pipeline: pipelineApi });
  disposers.push(eventsApi.releaseEvents);

  // 5. 对外 ABI：把服务面挂上上下文。排在 api 之前——设置端点要读它的种类清单，而 api
  //    域是最后装的；服务面自己不依赖任何后装的域。
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
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常
    }
  }
}
