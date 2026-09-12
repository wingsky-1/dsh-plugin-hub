/**
 * dsh-notifier pipeline 域 —— 编排：一条通知从「发生」到「出去」的全程。
 *
 * 本块只串流程、不判业务：留不留由裁决块回答，发给谁由路由块回答，送没送到由投递块
 * 回答。它自己多做的一件事是**落史**——只有站在全程的位置上，才知道这条通知走到了
 * 哪一步、为什么没走完，而「为什么」正是用户唯一会来问的东西。
 *
 * 状态只有装配入参一项。类可以被实例化多次，但域只装配一个——「唯一裁决点」靠契约
 * 层不导出实例来保证，而不是靠把状态藏进闭包让别人够不着。
 *
 * 依赖方向：只引用本目录、`../judge/`、`../route/`、`../dispatch/`、`../../deps.ts`，
 * 不引用 `interface.ts`。
 */
import type { NotifyRequest } from "../../deps.ts";
import { dispatchMessage } from "../dispatch/index.ts";
import { judgeRequest } from "../judge/index.ts";
import type { SuppressReason } from "../judge/type.ts";
import { routeTargets } from "../route/index.ts";
import type { RoutedTarget } from "../route/type.ts";
import type { PipelineDeps } from "./type.ts";

/** 未装配哨兵里的函数：被调到就说明守卫漏了，当场抛错好过继续往下走。 */
function uninstalled(): never {
  throw new Error("dsh-notifier: pipeline 域尚未装配");
}

/**
 * 未装配哨兵。
 *
 * 它的唯一作用是让字段有确定的类型，从而不必让每个使用点都先判一次空。装配是必经
 * 路径，这些函数不会被真正调到。
 */
const UNINSTALLED: PipelineDeps = {
  enabled: false,
  readConfig: uninstalled,
  deliver: uninstalled,
  recordStatus: uninstalled,
  appendHistory: uninstalled,
  emitFrame: uninstalled,
};

/** 裁决管线：唯一裁决点，以及一条通知的生命周期。 */
class NotificationPipeline {
  /**
   * 装配入参；未装配或已卸载时是哨兵。
   *
   * 用它同时充当「装没装」的判据，而不是另设一个布尔字段：两个字段会出现「布尔说
   * 装了、入参还是哨兵」这种自相矛盾的状态，而那种状态只能靠纪律维持一致。
   */
  private deps: PipelineDeps = UNINSTALLED;

  /** 装配。重复装配是编程错误，当场暴露。 */
  install(deps: PipelineDeps): void {
    if (this.deps !== UNINSTALLED) throw new Error("dsh-notifier: pipeline 域只能装配一次");
    this.deps = deps;
  }

  /** 卸载：放开对其他域的引用。此后到达的请求一律丢弃。 */
  release(): void {
    this.deps = UNINSTALLED;
  }

  /**
   * 提交一条通知请求。
   *
   * 未装配时静默丢弃，不抛错：本方法是宿主事件链的出口，事件不会因为本插件没准备好
   * 就停下来，而在这条链上抛错的代价是打断别人的流程——症状与本插件毫无字面关联。
   */
  submit(request: NotifyRequest): void {
    const deps = this.deps;
    if (deps === UNINSTALLED) return;

    const config = deps.readConfig();
    const verdict = judgeRequest(config, request, deps.enabled);
    if (!verdict.ok) {
      appendSuppressed(deps, request, verdict.reason);
      return;
    }

    const targets = routeTargets({ emitFrame: deps.emitFrame }, config, request.kind);
    if (targets.length === 0) {
      appendSuppressed(deps, request, "no-target");
      return;
    }

    void this.send(deps, request, targets).catch(() => {
      // 投递层承诺逐目标 fail-soft（失败是返回值，不是异常），走到这里说明契约已被
      // 破坏。宿主事件链上不能抛：一次未捕获的拒绝会打断整条通知路径，而它是唯一路径。
    });
  }

  /**
   * 投递并落史。
   *
   * 装配入参走参数而不是读 `this.deps`：`await` 期间可能发生卸载，读字段会在投递
   * 返回后拿着哨兵去落史。
   */
  private async send(
    deps: PipelineDeps,
    request: NotifyRequest,
    targets: RoutedTarget[],
  ): Promise<void> {
    await dispatchMessage(
      { deliver: deps.deliver, recordStatus: deps.recordStatus },
      { title: request.title, body: request.body },
      targets,
    );
    deps.appendHistory({
      ts: Date.now(),
      kind: request.kind,
      title: request.title,
      message: request.body,
    });
  }
}

/** 记一条「本该发出、但被拦下」的历史：只记「没发」等于让用户对着空收件箱猜。 */
function appendSuppressed(deps: PipelineDeps, request: NotifyRequest, reason: SuppressReason): void {
  deps.appendHistory({
    ts: Date.now(),
    kind: request.kind,
    title: request.title,
    message: request.body,
    suppressed: reason,
  });
}

/** 本域唯一的裁决点：类不外放，外面 `new` 不出第二份。 */
export const notificationPipeline = new NotificationPipeline();
