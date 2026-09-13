/**
 * dsh-notifier pipeline 域 —— 编排：一条通知从「发生」到「出去」的全程。
 * 本块只串流程，另做一件事是归档——记录这条通知走到了哪一步、为什么没走完。
 */
import type { ChannelDelivery, HistoryEntry, PipelineDeps, StorePort } from "../../deps.ts";
import { notificationDispatcher } from "../dispatch/index.ts";
import { finalizeRequest } from "../finalize/index.ts";
import { judgeRequest } from "../judge/index.ts";
import type { SuppressReason } from "../judge/type.ts";
import { routeTargets } from "../route/index.ts";
import type { RoutedTarget } from "../route/type.ts";
import type { NotifyRequest } from "./type.ts";

/** 归档结果：发出去了带逐出口明细，被压制了带原因；两者必居其一。 */
type ArchiveOutcome = { suppressed: SuppressReason } | { channels: ChannelDelivery[] };

/** 未装配的告警文案：占位能力被真的读到，说明装配守卫有洞。 */
const NOT_INSTALLED = "dsh-notifier: 裁决管线尚未装配";

/**
 * 未装配时的占位：让字段有确定的类型，不必让每个使用点先判一次空。
 * 能力占位成抛错而不是空实现——真被读到时「没装配」应当当场暴露。帧出口是例外：它是
 * 旁路，「没人听」与「没有出口」对它没有区别。
 */
const UNINSTALLED: PipelineDeps = {
  enabled: false,
  frames: { emit: () => {} },
  logger: { warn: () => {} },
  config: {
    readConfig: () => {
      throw new Error(NOT_INSTALLED);
    },
  },
  stores: {
    appendHistory: () => {
      throw new Error(NOT_INSTALLED);
    },
    recordStatus: () => {
      throw new Error(NOT_INSTALLED);
    },
  },
  channels: {
    deliver: () => Promise.reject(new Error(NOT_INSTALLED)),
  },
};

/** 裁决管线：唯一裁决点，以及一条通知的生命周期。 */
class NotificationPipeline {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参：宿主能力、挂载点值，以及本域依赖的那几个域。 */
  private deps: PipelineDeps = UNINSTALLED;

  /** 装配。重复装配是编程错误，当场暴露。 */
  install(deps: PipelineDeps): void {
    if (this.installed) throw new Error("dsh-notifier: pipeline 域只能装配一次");
    this.installed = true;
    this.deps = deps;
    notificationDispatcher.install({ channels: deps.channels, stores: deps.stores });
  }

  /** 卸载：清空投递节奏状态、放开对宿主面的引用。此后到达的请求一律丢弃。 */
  release(): void {
    this.installed = false;
    this.deps = UNINSTALLED;
    notificationDispatcher.release();
  }

  /**
   * 提交一条通知请求。
   * 未装配时静默丢弃，不抛错：本方法挂在宿主事件链上，在这里抛会打断别人的流程。
   */
  submit(request: NotifyRequest): void {
    if (!this.installed) return;
    // 能力在入口取一次并往下传：`send` 是异步的，卸载可能发生在它完成之前，而这次
    // 投递已经开始了——半路换成占位值会让一条本该正常送达的通知凭空失败。
    const { enabled, frames, logger, config, stores } = this.deps;
    // 本次通知的时刻只取一次：投递载荷与历史记录共用它，两处各取一次会对不上。
    const ts = Date.now();

    const snapshot = config.readConfig();
    const verdict = judgeRequest(snapshot, request, enabled);
    if (!verdict.ok) {
      this.archive(stores, request, ts, { suppressed: verdict.reason });
      return;
    }

    const route = routeTargets({ frames, logger }, snapshot, request);
    const noTargets = route.targets.length === 0;
    for (const id of route.stale) {
      // 归档只认 `SuppressReason` 的词表：日志按同一口径说这条路由项的去向，不另造归档里查不到的词。
      const fate = noTargets
        ? "本条通知归档 suppressed:no-target"
        : "该目标已丢弃，其余目标照常投递";
      logger.warn(`dsh-notifier: kindRoutes[${request.kind}] 指向已删除频道 ${id}，${fate}`);
    }
    if (noTargets) {
      this.archive(stores, request, ts, { suppressed: "no-target" });
      return;
    }

    void this.send(stores, request, ts, route.targets).catch((cause) => {
      // 投递块承诺逐目标 fail-soft（失败是返回值，不是异常），走到这里说明契约已被破坏。
      // 宿主事件链上不能抛，但也不能静默——「通知没发出去、且没有任何痕迹」最难查。
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn(`dsh-notifier: 投递失败 —— ${reason}`);
    });
  }

  /** 定稿，投递，归档。 */
  private async send(
    stores: StorePort,
    request: NotifyRequest,
    ts: number,
    targets: RoutedTarget[],
  ): Promise<void> {
    const message = finalizeRequest(request, ts);
    const deliveries = await notificationDispatcher.dispatch(message, targets);
    this.archive(stores, request, ts, { channels: deliveries });
  }

  /** 归档：一次通知写一条记录，发出与压制只在载荷上分叉。 */
  private archive(
    stores: StorePort,
    request: NotifyRequest,
    ts: number,
    outcome: ArchiveOutcome,
  ): void {
    const entry: HistoryEntry = {
      ts,
      kind: request.kind,
      title: request.title,
      message: request.body,
    };
    if ("suppressed" in outcome) {
      entry.suppressed = outcome.suppressed;
    } else {
      entry.channels = outcome.channels;
    }
    stores.appendHistory(entry);
  }
}

/** 本域唯一的裁决点：类不外放，外面 `new` 不出第二份。 */
export const notificationPipeline = new NotificationPipeline();
