/**
 * dsh-notifier events 域 —— 订阅宿主事件并把翻译结果送出去。
 *
 * 本块只做搬运：订阅、转交翻译、把产出的请求递给下游。判断在 `../translate/`，
 * 下游在组合根——它自己不留任何决定。
 *
 * 状态是实例字段：订阅句柄。类可以被实例化多次，但域只装配一个——「只订阅一次」
 * 靠契约层不导出实例来保证，而不是靠把状态藏进闭包让别人够不着。
 *
 * 依赖方向：只引用本目录、`../translate/` 与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { EventsDeps } from "../../deps.ts";
import {
  translateAgentDisposed,
  translateAgentError,
  translateAgentStatus,
  translateApproval,
  translateSessionEvent,
  translateTurnStopping,
  translateUserQuestion,
} from "../translate/index.ts";
import type { Translation } from "../translate/type.ts";

/** 宿主事件的订阅集合：装配时装上，卸载时全部摘除。 */
class EventListener {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 退订句柄；卸载期逐个调用。 */
  private readonly releases: Array<() => void> = [];

  /**
   * 装配：订阅宿主事件。
   *
   * 不交出释放句柄：摘订阅是本域自己的动作（`release`），由契约层在卸载期调用。
   * 把闭包递出去，等于让「谁负责摘干净」这件事散到调用方手里。
   */
  install(deps: EventsDeps): void {
    if (this.installed) throw new Error("dsh-notifier: events 域只能装配一次");
    this.installed = true;
    const port = deps.events;
    this.releases.push(
      port.onApprovalRequest((request) => submit(translateApproval(request), deps)),
      port.onUserQuestion((request) => submit(translateUserQuestion(request), deps)),
      port.onSessionEvent((sessionId, event) => submit(translateSessionEvent(sessionId, event), deps)),
      port.onAgentStatus((agentId, status) => submit(translateAgentStatus(agentId, status), deps)),
      port.onAgentDisposed((agentId) => submit(translateAgentDisposed(agentId), deps)),
      port.onAgentTurnStopping((agentId, turn) => submit(translateTurnStopping(agentId, turn), deps)),
      port.onAgentError((agentId, turn, errorText) => submit(translateAgentError(agentId, turn, errorText), deps)),
    );
  }

  /** 摘除全部订阅。重复调用无害——卸载链可能走到不止一次。 */
  release(): void {
    for (const release of this.releases) release();
    this.releases.length = 0;
  }
}

/** 把翻译结果递给下游；不产出通知是常态，不是需要处理的情况。 */
function submit(translation: Translation, deps: EventsDeps): void {
  if (translation.ok) deps.pipeline.submit(translation.request);
}

/** 本域唯一的订阅点：类不外放，外面 `new` 不出第二份订阅。 */
export const eventListener = new EventListener();
