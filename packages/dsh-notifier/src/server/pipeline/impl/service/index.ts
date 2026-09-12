/**
 * dsh-notifier pipeline 域 —— 编排：一条通知从「发生」到「出去」的全程。
 *
 * 本块只串流程、不判业务：留不留由裁决块回答，发给谁由路由块回答，送没送到由投递块
 * 回答。它自己多做的一件事是**归档**——只有站在全程的位置上，才知道这条通知走到了
 * 哪一步、为什么没走完，而「为什么」正是用户唯一会来问的东西。
 *
 * 归档只有一个时刻：**投递完成之后**。被压制的那条路没有投递，于是就地归档——两条
 * 路写的是同一条记录形状，区别只在带的是「逐出口明细」还是「压制原因」。
 *
 * 依赖方向：只引用本目录、`../judge/`、`../route/`、`../dispatch/`、`../../deps.ts`，
 * 不引用 `interface.ts`。
 */
import type { ChannelDelivery, HistoryEntry, PipelineDeps, StorePort } from "../../deps.ts";
import { dispatchMessage } from "../dispatch/index.ts";
import type { DispatchPort } from "../dispatch/type.ts";
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
 * 未装配时的占位。
 *
 * 装配是必经路径（`installed` 守卫），占位值不会被真正读到；它的作用是让字段有确定
 * 的类型，从而不必让每个使用点都先判一次空。能力占位成抛错而不是空实现：真被读到
 * 时，「没装配」应当当场暴露，而不是静默地不归档、不投递。
 *
 * 帧出口是例外，它保持静默：帧是 fire-and-forget 的旁路，「没人听」与「没有出口」
 * 对它没有区别。
 */
const UNINSTALLED: PipelineDeps = {
  enabled: false,
  frames: { emit: () => {} },
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
  }

  /** 卸载：放开对宿主面的引用。此后到达的请求一律丢弃。 */
  release(): void {
    this.installed = false;
    this.deps = UNINSTALLED;
  }

  /**
   * 提交一条通知请求。
   *
   * 未装配时静默丢弃，不抛错：本方法是宿主事件链的出口，事件不会因为本插件没准备好
   * 就停下来，而在这条链上抛错的代价是打断别人的流程——症状与本插件毫无字面关联。
   */
  submit(request: NotifyRequest): void {
    if (!this.installed) return;
    // 能力在入口取一次并往下传：`send` 是异步的，卸载可能发生在它完成之前，而这次
    // 投递已经开始了——半路换成占位值，会让一条本该正常送达的通知在归档时凭空失败。
    const { enabled, frames, config, stores, channels } = this.deps;

    const snapshot = config.readConfig();
    const verdict = judgeRequest(snapshot, request, enabled);
    if (!verdict.ok) {
      this.archive(stores, request, { suppressed: verdict.reason });
      return;
    }

    const targets = routeTargets({ frames }, snapshot, request);
    if (targets.length === 0) {
      this.archive(stores, request, { suppressed: "no-target" });
      return;
    }

    void this.send({ channels, stores }, request, targets).catch(() => {
      // 投递层承诺逐目标 fail-soft（失败是返回值，不是异常），走到这里说明契约已被
      // 破坏。宿主事件链上不能抛：一次未捕获的拒绝会打断整条通知路径，而它是唯一路径。
    });
  }

  /** 投递，然后归档。 */
  private async send(deps: DispatchPort, request: NotifyRequest, targets: RoutedTarget[]): Promise<void> {
    const deliveries = await dispatchMessage(deps, { title: request.title, body: request.body }, targets);
    this.archive(deps.stores, request, { channels: deliveries });
  }

  /** 归档：一次通知写一条记录，发出与压制只在载荷上分叉。 */
  private archive(stores: StorePort, request: NotifyRequest, outcome: ArchiveOutcome): void {
    const entry: HistoryEntry = {
      ts: Date.now(),
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
