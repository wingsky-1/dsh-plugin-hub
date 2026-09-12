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
 * | 1 | `config` | 通知配置的单一事实源 | 组合层入口层、日志 |
 * | 2 | `stores` | 历史与投递状态的持久化 | 设置域的面、日志 |
 * | 3 | `pipeline` | 一条通知的生命周期与**唯一裁决点** | config / channels / stores 三个域的面、帧出口、总开关 |
 * | 4 | `events` | 宿主事件 → 通知请求（适配层） | 宿主事件面、裁决管线 |
 * | 5 | `sdk` | 对外 ABI（`ctx["wingsky.notifier"]`） | 裁决管线、内置 kind 列表 |
 * | 6 | `api` | 浏览器出口：HTTP 路由 + SSE | 配置读写、历史、裁决管线、帧入口 |
 *
 * `upgrade` 排在最前不是因为它是上游，而是因为它动的是**磁盘**：各域装配时会读
 * 文件，迁移必须在那些读之前落定。
 *
 * `channels` 无状态，**不参与装配**：它是纯动作，谁用谁引契约。组合根不替它持有
 * 实例，也不替调用方保管它的入参。
 *
 * ## 纪律
 *
 * - 域之间不互相引用实现；跨域能力由本文件显式接上。
 * - 交接以**域的面**为单位，不是把对方的方法拆成一个个函数传进去：`config: configApi`
 *   而不是 `readConfig`。散装函数在装配点读不出「依赖哪个域」，每多用一个方法还要
 *   再改一次这里。
 * - 同理不交接**算好的值**：设置是活的，装配期算出的数字会变成静态数据，而它看起来
 *   与实时读取一模一样。
 * - 本文件是唯一允许引用全部域 `interface.ts` 的地方。
 * - 域的全部跨域依赖申报在各自的 `deps.ts`；本文件按该申报满足它。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import * as channelsApi from "./server/channels/interface.ts";
import type { NotifyFrame } from "./server/channels/interface.ts";
import * as configApi from "./server/config/interface.ts";
import type { NotifierEntryConfig } from "./server/config/interface.ts";
import * as eventsApi from "./server/events/interface.ts";
import type { HostEventPort } from "./server/events/interface.ts";
import * as pipelineApi from "./server/pipeline/interface.ts";
import type { LoggerPort } from "./server/shared/type.ts";
import * as storesApi from "./server/stores/interface.ts";
import { installUpgrade } from "./server/upgrade/interface.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 依赖的宿主服务。 */
export const inject = ["webServer"];

/**
 * 组合层入口配置（插件挂载点传入）。
 *
 * 两层合一：**设置项**作为用户层之下的默认层——组合层与启动参数给出厂默认之外的
 * 取值，用户在设置页里显式改过的键仍然压在它上面；**装配开关**只在这一层表达。
 */
export interface NotifierApplyConfig extends NotifierEntryConfig {
  /** 总开关；`false` 时一律不投递。归裁决层消费，不落盘、不进设置层。 */
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

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
  /**
   * 帧出口：通知帧经宿主事件总线交给 api 域。
   *
   * 走总线而不是直连 api 域，是因为投递域能证明的只有「帧交出去了」——浏览器通道
   * 不提供展示回执（同 FCM / APNs 只保证 accepted）。出口到总线为止，「谁在听」
   * 就不是投递域需要知道的事。
   */
  readonly emitFrame: (frame: NotifyFrame) => void;
  readonly events: HostEventPort;
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
    emitFrame: (frame) => {
      ctx.emit("notifier/frame", frame);
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
            const reason = failure instanceof Error ? failure.message : String(failure);
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
function assemble(host: HostPort, config: NotifierApplyConfig): Array<() => void> {
  const disposers: Array<() => void> = [];

  // 0. 存储形态迁移：动的是磁盘，必须早于任何读文件的域。
  installUpgrade({ logger: host.logger });

  // 1. 设置：读面在装配返回时即可用，后续各域不必等加载。
  configApi.installConfig({ entry: config, logger: host.logger });

  // 2. 存储：给它设置域的面，而不是算好的保留天数。
  storesApi.installStores({ config: configApi, logger: host.logger });

  // 3. 裁决管线：拿到的全是域的面。判据在它这里，事实在别人那里——投递域不知道有
  //    历史，设置域不知道有通知，而「该不该发」只有这一处回答。
  pipelineApi.installPipeline({
    enabled: config.enabled !== false,
    config: configApi,
    channels: channelsApi,
    stores: storesApi,
    frames: { emit: host.emitFrame },
  });
  disposers.push(pipelineApi.releasePipeline);

  // 4. 事件：宿主事件 → 通知请求。请求一律产出，去留由裁决层决定——开关会在本域
  //    看不见的地方被改，让它去问一遍等于把运行期策略摊进按事件驱动的块里。
  eventsApi.installEvents({ events: host.events, pipeline: pipelineApi });
  disposers.push(eventsApi.releaseEvents);

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
