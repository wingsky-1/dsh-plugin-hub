/**
 * dsh-notifier events 域 —— 订阅宿主事件、转交翻译、把请求递给下游。
 * 本块只做搬运不含判断；状态机的装配与卸载也在这里成对发生。
 */
import type { EventsDeps, PipelinePort } from "../../deps.ts";
import { agentStates } from "../state/index.ts";
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

  /** 装配：装状态机，再订阅宿主事件。 */
  install(deps: EventsDeps): void {
    if (this.installed) throw new Error("dsh-notifier: events 域只能装配一次");
    this.installed = true;
    agentStates.install({ logger: deps.logger, agents: deps.agents });
    const { events: port, pipeline } = deps;
    this.releases.push(
      port.onApprovalRequest((request) => forward(pipeline, translateApproval(request))),
      port.onUserQuestion((request) => forward(pipeline, translateUserQuestion(request))),
      port.onSessionEvent((sessionId, event) =>
        forward(pipeline, translateSessionEvent(sessionId, event)),
      ),
      // agent 四个事件把官方载荷整份转给翻译：翻出哪一类通知要看会话日志、header 与
      // turn 证据，这些都在载荷里的 Agent 对象上，本块不做拆分。
      port.onAgentStatus((payload) => forward(pipeline, translateAgentStatus(payload))),
      port.onAgentDisposed((payload) => forward(pipeline, translateAgentDisposed(payload))),
      port.onAgentTurnStopping((payload) => forward(pipeline, translateTurnStopping(payload))),
      port.onAgentError((payload) => forward(pipeline, translateAgentError(payload))),
    );
  }

  /** 摘除全部订阅并卸载状态机。重复调用无害——卸载链可能走到不止一次。 */
  release(): void {
    for (const release of this.releases) release();
    this.releases.length = 0;
    agentStates.release();
    // 复位而不是只摘订阅：留着会让同进程的下一次 `install` 撞上「只能装配一次」。
    this.installed = false;
  }
}

/** 把翻译结果递给下游；不产出通知是常态，不是需要处理的情况。 */
function forward(pipeline: PipelinePort, translation: Translation): void {
  if (translation.ok) pipeline.submit(translation.request);
}

/** 本域唯一的订阅点：类不外放，外面 `new` 不出第二份订阅。 */
export const eventListener = new EventListener();
