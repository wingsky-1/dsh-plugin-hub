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
 * - 组合根只交付两样东西：域**拿不到**的宿主能力（日志、事件面、路由口、帧总线、服务
 *   出口）与挂载点值（总开关），以及**域之间的能力**——后者按提供方分组、递的是命名空间
 *   对象，消费方用 `Pick` 收窄要哪几样。本文件因此读起来就是一张「谁需要谁」的表。
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
import type { AgentRegistryPort, HostEventPort } from "./server/events/interface.ts";
import * as pipelineApi from "./server/pipeline/interface.ts";
import type { OutgoingFrame } from "./server/pipeline/interface.ts";
import type { LegacySettingsPort } from "./server/upgrade/deps.ts";
import type { ExposePort } from "./server/sdk/deps.ts";
import * as sdkApi from "./server/sdk/interface.ts";
import type { NotifierService } from "./server/sdk/interface.ts";
import type { LoggerPort } from "./server/shared/type.ts";
import * as storesApi from "./server/stores/interface.ts";
import { installUpgrade, releaseUpgrade } from "./server/upgrade/interface.ts";

/**
 * 对外服务面的类型。
 *
 * 消费方要写 `const n: NotifierService = ctx["wingsky.notifier"]` 就得能命名它，而它同时
 * 是下面那段声明合并的载荷——不导出，这个包对兄弟插件就只有运行时可用、类型上无从引用。
 */
export type { NotifierService } from "./server/sdk/interface.ts";

/** 宿主 settings 服务的名字。它是宿主的知识，不是本插件的 ABI。 */
const SETTINGS_SERVICE = "settings";

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
 * 对外名字的声明合并。
 *
 * 声明在包入口而不是它所属的域文件里：`declare module` 是全局增强，tsc 只在入口可达的
 * 声明闭包里保留它——写在域里、而入口的对外声明面又不引用那个域时，产物
 * `lib/index.d.ts` 里根本看不到它，消费方按包名导入时 `ctx["wingsky.notifier"]` 就没有
 * 类型。`pack:check` 的「声明合并可达性」判据盯的正是这条。
 *
 * 键引用常量而不是写字面量：接口的计算属性名接受**字面量类型**，而 `NOTIFIER_SERVICE`
 * 在 `as const` 下正是字面量类型。于是服务名只有一个物理定义（在 sdk 域——那是它所属
 * ABI 的定义处），这里不再抄一份：抄一份同样能编译，代价是改名时漏改一处，而它只在
 * 运行时的另一头才暴露——消费方 `ctx.get` 拿到空。
 *
 * 本包**只声明这一个**对外名。通知帧走组合根本地接线（见 `FrameBus`），投递终态走
 * 历史与频道状态两个查询面：对外的两个需求（「我要发通知」「发出去没有」）都是点对点
 * 的，广播事件只会让公共面多一份要养、又没人认领的协议。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 通知中心服务面：兄弟插件经它登记自己的通知种类、发送通知。 */
    [sdkApi.NOTIFIER_SERVICE]: NotifierService;
  }
}

/**
 * 帧总线：组合根接上的两头。
 *
 * 生产端给裁决管线（只有 `emit`），消费端给浏览器出口（只有 `onFrame`）——两个域各自
 * 只拿到自己该有的那一半（类型就是围栏），谁也伪造不了通知、谁也发不出帧。
 *
 * 两端都在本包内，所以它是**组合根的本地设施**而不是宿主事件总线上的一个事件：总线
 * 上的名字是公共面，任何插件都能 emit 与 on，而这里的两头都只该由本包的两个域持有。
 *
 * 状态收在实例字段里：帧是 fire-and-forget 的旁路，逐个投给订阅者，一个订阅者出问题
 * 不该让其余收不到帧——所以遍历前先取快照，回调里退订也不会打断本轮。
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
   * 宿主 settings 服务：0.2.3 把配置存在那里，新架构搬走之后仍需读它一次。
   *
   * 它是**可选**的：服务可能晚于本插件就绪，宿主也可以根本不装它。
   */
  readonly legacySettings: LegacySettingsPort;
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
    frames: new FrameBus(),
    // 存量配置的读取面：先试一次（服务可能已经在），再监听晚到的。只监听事件会漏掉
    // 「注册之前就已经 provide」的那种顺序，而只试一次会漏掉晚到的——两个都要。
    legacySettings: {
      whenReady: (handler) => {
        const existing = ctx.get("settings", false);
        if (existing) handler(existing);
        return ctx.on(
          "internal/service",
          (name, value) => {
            if (name === SETTINGS_SERVICE) handler(value);
          },
          GLOBAL_LISTEN,
        );
      },
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
        ctx.provide<typeof sdkApi.NOTIFIER_SERVICE>(sdkApi.NOTIFIER_SERVICE, service),
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
      // agent 四个事件把官方载荷**原样**转过去，不在这里拆字段：任务名、子代理归属、
      // turn 证据都要从 Agent 对象上读，拆成 id 就等于替域决定「哪些字段有用」，而那个
      // 决定正是本域该做的判断（见 `events/deps.ts`）。
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
      // 唯一的例外是错误原文：失败可能是任何东西抛出的（官方那边是宽类型），在这里做
      // 唯一一次收窄，域拿到的就是一条文本——域内不出现宽类型。
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
    // 宿主 agent 注册表：子代理归属判定的第二个信号。查不到与查得到分开报（见
    // `AgentLookup`），组合根不做判断——「父 agent 不在册」该怎么理解是域的事。
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
 * 装配：按依赖顺序接上各域，返回它们的释放函数（逆序执行）。
 *
 * 每一步的入参都来自上一步的产出或 `host`——装配顺序即依赖顺序，顺序错了就是
 * 运行期空值。
 */
function assemble(host: HostPort, config: NotifierApplyConfig): Array<() => void> {
  const disposers: Array<() => void> = [];

  // 0. 存储形态迁移：动的是磁盘，必须早于任何读文件的域。
  //    它的存量配置那一路要等宿主 settings 服务就绪（0.2.3 把配置存在那里），所以装的是
  //    一个回调而不是一次同步动作——回调里经 config 域的写面落地。
  installUpgrade({ logger: host.logger, legacySettings: host.legacySettings, config: configApi });
  disposers.push(releaseUpgrade);

  // 1. 设置：读面在装配返回时即可用，后续各域不必等加载。
  configApi.installConfig({ logger: host.logger });
  disposers.push(configApi.releaseConfig);

  // 2. 存储：保留天数由它自己按需读设置，不在这里替它取值。
  storesApi.installStores({ logger: host.logger, config: configApi });
  disposers.push(storesApi.releaseStores);

  // 3. 裁决管线：交付的是**能力对象**而不是算好的值——设置是活的，装配期取一次快照
  //    会在用户改设置后失效，而它看起来与实时读取一模一样。
  //    每个 Port 递的是提供方的命名空间对象（消费方用 Pick 收窄），于是本域将来多用
  //    一样能力时，这一行不用改。
  pipelineApi.installPipeline({
    enabled: config.enabled !== false,
    frames: host.frames,
    logger: host.logger,
    config: configApi,
    stores: storesApi,
    channels: channelsApi,
  });
  disposers.push(pipelineApi.releasePipeline);

  // 4. 事件：宿主事件 → 通知请求。请求一律产出，去留由裁决层决定——开关会在本域
  //    看不见的地方被改，让它去问一遍等于把运行期策略摊进按事件驱动的块里。
  eventsApi.installEvents({ events: host.events, agents: host.agents, pipeline: pipelineApi });
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
  // 逆序：后装的先释放。api 域读的是各域的现值，它必须最先关掉；正序释放会让它在
  // 别人已经放开的入参上继续服务。
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常
    }
  }
}
