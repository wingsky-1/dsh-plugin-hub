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
 * 装配状态用判别联合而不是哨兵对象：依赖是三个域的面，抄一份哨兵等于把依赖清单维护
 * 两遍，而且它每次变动都要跟着改。
 *
 * 依赖方向：只引用本目录、`../judge/`、`../route/`、`../dispatch/`、`../../deps.ts`，
 * 不引用 `interface.ts`。
 */
import type { ChannelDelivery, HistoryEntry, PipelineDeps } from "../../deps.ts";
import { dispatchMessage } from "../dispatch/index.ts";
import { judgeRequest } from "../judge/index.ts";
import type { SuppressReason } from "../judge/type.ts";
import { routeTargets } from "../route/index.ts";
import type { RoutedTarget } from "../route/type.ts";
import type { NotifyRequest } from "./type.ts";

/** 归档结果：发出去了带逐出口明细，被压制了带原因；两者必居其一。 */
type ArchiveOutcome = { suppressed: SuppressReason } | { channels: ChannelDelivery[] };

/** 装配状态：未装配时连入参一起不存在，因此不需要哨兵去扮演一份假依赖。 */
type PipelineState = { installed: false } | { installed: true; deps: PipelineDeps };

/** 裁决管线：唯一裁决点，以及一条通知的生命周期。 */
class NotificationPipeline {
  private state: PipelineState = { installed: false };

  /** 装配。重复装配是编程错误，当场暴露。 */
  install(deps: PipelineDeps): void {
    if (this.state.installed) throw new Error("dsh-notifier: pipeline 域只能装配一次");
    this.state = { installed: true, deps };
  }

  /** 卸载：连同入参一起放开对其他域的引用。此后到达的请求一律丢弃。 */
  release(): void {
    this.state = { installed: false };
  }

  /**
   * 提交一条通知请求。
   *
   * 未装配时静默丢弃，不抛错：本方法是宿主事件链的出口，事件不会因为本插件没准备好
   * 就停下来，而在这条链上抛错的代价是打断别人的流程——症状与本插件毫无字面关联。
   */
  submit(request: NotifyRequest): void {
    const state = this.state;
    if (!state.installed) return;
    const deps = state.deps;

    const config = deps.config.readConfig();
    const verdict = judgeRequest(config, request, deps.enabled);
    if (!verdict.ok) {
      this.archive(deps, request, { suppressed: verdict.reason });
      return;
    }

    const targets = routeTargets({ frames: deps.frames }, config, request.kind);
    if (targets.length === 0) {
      this.archive(deps, request, { suppressed: "no-target" });
      return;
    }

    void this.send(deps, request, targets).catch(() => {
      // 投递层承诺逐目标 fail-soft（失败是返回值，不是异常），走到这里说明契约已被
      // 破坏。宿主事件链上不能抛：一次未捕获的拒绝会打断整条通知路径，而它是唯一路径。
    });
  }

  /**
   * 投递，然后归档。
   *
   * 装配入参走参数而不是读 `this.state`：`await` 期间可能发生卸载，回头再读字段会
   * 拿到一份已经不存在的依赖。
   */
  private async send(
    deps: PipelineDeps,
    request: NotifyRequest,
    targets: RoutedTarget[],
  ): Promise<void> {
    const channels = await dispatchMessage(
      { channels: deps.channels, stores: deps.stores },
      { title: request.title, body: request.body },
      targets,
    );
    this.archive(deps, request, { channels });
  }

  /** 归档：一次通知写一条记录，发出与压制只在载荷上分叉。 */
  private archive(deps: PipelineDeps, request: NotifyRequest, outcome: ArchiveOutcome): void {
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
    deps.stores.appendHistory(entry);
  }
}

/** 本域唯一的裁决点：类不外放，外面 `new` 不出第二份。 */
export const notificationPipeline = new NotificationPipeline();
