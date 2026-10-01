/**
 * dsh-notifier pipeline 域 —— 投递：把消息送到选定的出口，结果按频道归位。
 * 重试、退避、在途上限与 system 的 1 秒节流都在这里（出口只回答「可不可重试」）；
 * 节奏状态按 `channelId` 键控，跨配置变更延续。
 *
 * **卸载的边界**（`release()` 能做什么、不能做什么）：
 *  - 尚未开投的队列项一律结算成 `skipped`（理由 `reasonDispatchCanceled`）并把 promise 收口：
 *    卸载后既不该再发通知，也不该让调用方的 `Promise.all` 永远挂着。
 *  - **已经开投的在途请求召不回来**：`spawn` 出去的子进程、已经发出的 fetch 都会跑完，并如实
 *    产出归档明细。卸载只保证它们**不再重试、不再写频道状态**（`settle` 的 installed 闸）——
 *    强杀在途请求等于把「投递是否发生」这件事变成不可知的，那比晚一条归档更糟。
 *  - 取消只对 `maxInflight > 0` 的出口生效（当前只有 bark，见 `POLICIES`）：其余三类在
 *    `withGate` 里早退直投，压根没有队列，也就没有可取消的东西。
 */
import type { ProducedReason } from "../../../shared/interface.ts";
import { reason, reasonFromCause } from "../../../shared/interface.ts";
import type { ChannelDelivery, DeliveryTarget, NotifyMessage } from "../../deps.ts";
import type { RoutedTarget } from "../route/type.ts";
import type { ChannelRhythm, DeliverOutcome, DispatchPolicy, DispatchPort } from "./type.ts";

/** 目标类型 → 节奏策略；`Record<DeliveryTarget["type"], …>` 让新增出口类型成为编译错误。 */
const POLICIES: Record<DeliveryTarget["type"], DispatchPolicy> = {
  bark: { maxRetries: 2, backoffMs: 1000, maxInflight: 2, throttleMs: 0 },
  webhook: { maxRetries: 0, backoffMs: 0, maxInflight: 0, throttleMs: 0 },
  browser: { maxRetries: 0, backoffMs: 0, maxInflight: 0, throttleMs: 0 },
  system: { maxRetries: 0, backoffMs: 0, maxInflight: 0, throttleMs: 1000 },
};

/** 未装配时的占位：真被读到应当当场暴露，而不是静默丢通知。 */
const NOT_INSTALLED = "dsh-notifier: 投递块尚未装配";

const UNINSTALLED: DispatchPort = {
  channels: {
    deliver: () => Promise.reject(new Error(NOT_INSTALLED)),
  },
  stores: {
    appendHistory: () => {
      throw new Error(NOT_INSTALLED);
    },
    recordStatus: () => {
      throw new Error(NOT_INSTALLED);
    },
  },
};

/** 投递结果 → 归档明细：失败与空动作各自的理由只落在它们那一支上。 */
function deliveryOf(channelId: string, result: DeliverOutcome): ChannelDelivery {
  if (result.status === "failed") return { channelId, status: "failed", reason: result.reason };
  if (result.status === "skipped") return { channelId, status: "skipped", reason: result.reason };
  return { channelId, status: "ok" };
}

/** 出口违约的失败理由：宿主原文进 `detail`，文案归客户端字典。 */
function reasonOf(cause: unknown): ProducedReason {
  return reasonFromCause("reasonChannelThrew", cause);
}

/**
 * 节流命中：本次**没有投递**。归档如实说这一条，而不是把上一次的结论挂到这一次头上——
 * 上一次的结论已经在它自己那一行里了，透传只会让两行都变成无可追溯的。
 */
function throttled(channelId: string): ChannelDelivery {
  return { channelId, status: "skipped", reason: reason("reasonThrottled") };
}

/**
 * 卸载取消：本次**没有投递**，且原因与节流必须能分辨——节流是「这一条自己太密」，取消是
 * 「插件已经卸了、队里那条不必再开投」。归档里混成一个理由，用户就只能靠猜判断通知为什么没到。
 */
function canceled(): { status: "skipped"; reason: ProducedReason } {
  return { status: "skipped", reason: reason("reasonDispatchCanceled") };
}

/** 线性退避等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 投递器：节奏策略表 + 每频道节奏状态。单例，装配与卸载必须成对。 */
class Dispatcher {
  /** 单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参：投递出口与频道状态写面。 */
  private port: DispatchPort = UNINSTALLED;
  /** 逐频道的门与节流状态；`release` 时整表清空。 */
  private rhythms = new Map<string, ChannelRhythm>();

  /** 装配。 */
  install(port: DispatchPort): void {
    if (this.installed) throw new Error("dsh-notifier: 投递块只能装配一次");
    this.installed = true;
    this.port = port;
  }

  /** 卸载：放开能力面、清空全部节奏状态（门与节流都不跨装配期存活），
   *  并把**还在队列里**的投递逐条结算掉。顺序不能反：`clear()` 一执行就再也取不到那些队列项。 */
  release(): void {
    this.installed = false;
    this.port = UNINSTALLED;
    // 先 installed 后 cancel：结算走的是 `settle`，它要读到「已卸载」才不写频道状态。
    for (const rhythm of this.rhythms.values()) {
      for (const queued of rhythm.queue.splice(0)) queued.cancel();
    }
    this.rhythms.clear();
  }

  /** 投递：逐目标 fail-soft（出口承诺失败是返回值），结果与 `targets` 同序同长。 */
  async dispatch(message: NotifyMessage, targets: RoutedTarget[]): Promise<ChannelDelivery[]> {
    // 能力在入口取一次：卸载可能发生在本次投递完成之前。
    const port = this.port;
    return Promise.all(targets.map((routed) => this.dispatchSafely(port, message, routed)));
  }

  /**
   * 单目标的违约收口：一个目标违约只产出它自己的失败明细。
   * 违约若冒给 `dispatch` 里的 `Promise.all`，整批一起拒绝，调用方连健康频道的明细都拿不到，
   * 只能记一条「投递失败」——一次出口打洞就抹掉整批故障现场。
   */
  private async dispatchSafely(
    port: DispatchPort,
    message: NotifyMessage,
    routed: RoutedTarget,
  ): Promise<ChannelDelivery> {
    try {
      return await this.dispatchOne(port, message, routed);
    } catch (cause) {
      const failure = reasonOf(cause);
      this.recordFailure(port, routed.channelId, failure);
      return deliveryOf(routed.channelId, {
        status: "failed",
        // 违约的出口没给出任何证据，与通道层收违约时的口径一致。
        stage: "accepted",
        reason: failure,
        // 出口承诺把失败做成返回值，抛出来说明它有洞；再投一次只是把同一个洞踩第二遍。
        retryable: false,
      });
    }
  }

  /**
   * 违约频道的状态写面：状态只是观测面，它自己违约也不能再升级为抛出——明细已经成立。
   *
   * **卸载后不写**（与 `settle` 同一条闸）：这是本块**第二条**会写频道状态的路，出口在卸载之后
   * 才违约（网络层抛错常发生在这类时刻）就会走它。漏掉这一条，模块头承诺的「不再写频道状态」
   * 就是空话——而写面会真的落到磁盘上。
   */
  private recordFailure(port: DispatchPort, channelId: string, failure: ProducedReason): void {
    if (!this.installed) return;
    try {
      port.stores.recordStatus(channelId, "failed", failure);
    } catch {
      // 状态写不进去不该改变这次投递的结论
    }
  }

  /** 单目标：节流 → 在途门 → 重试，然后写频道状态并返回归档明细。 */
  private async dispatchOne(
    port: DispatchPort,
    message: NotifyMessage,
    routed: RoutedTarget,
  ): Promise<ChannelDelivery> {
    const policy = POLICIES[routed.target.type];
    const rhythm = this.rhythmOf(routed.channelId);
    if (policy.throttleMs > 0) {
      // 时间戳在投递开始前写入：并发的第二条在本次完成前就该被拦下（旧实现同序）。
      const now = Date.now();
      if (now - rhythm.lastAt < policy.throttleMs) return throttled(routed.channelId);
      rhythm.lastAt = now;
    }
    const result = await this.withGate(
      rhythm,
      policy.maxInflight,
      () => this.deliverWithRetry(port, message, routed.target, policy),
      () => canceled(),
    );
    return this.settle(port, routed.channelId, result);
  }

  /** 取（必要时创建）频道的节奏状态。 */
  private rhythmOf(channelId: string): ChannelRhythm {
    const existing = this.rhythms.get(channelId);
    if (existing !== undefined) return existing;
    const fresh: ChannelRhythm = { lastAt: 0, inflight: 0, queue: [] };
    this.rhythms.set(channelId, fresh);
    return fresh;
  }

  /**
   * 在途门：槽位满时排队等待，队列无上限。
   *
   * `onCanceled` 只对**队列项**有意义（`maxInflight > 0` 才有队列，当前只有 bark）：卸载时它把
   * 这一条结算成 skipped，开投永不发生。必须是 **resolve 而不是 reject**——reject 会冒给
   * `dispatchSafely` 的 catch，产出一条 failed 明细并再写一次频道状态，与「卸载后不写状态」
   * 直接矛盾；也会让调用方看到一次根本不存在的失败。形参不叫 `canceled`：模块里已有一个同名的
   * 结算函数，遮蔽它会让「这个 canceled 到底是谁」要靠读上下文才答得上来。
   */
  private withGate<T>(
    rhythm: ChannelRhythm,
    maxInflight: number,
    run: () => Promise<T>,
    onCanceled: () => T,
  ): Promise<T> {
    if (maxInflight <= 0) return run();
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        rhythm.inflight += 1;
        run().then(
          (value) => {
            this.releaseSlot(rhythm);
            resolve(value);
          },
          (cause) => {
            this.releaseSlot(rhythm);
            reject(cause);
          },
        );
      };
      if (rhythm.inflight < maxInflight) {
        start();
        return;
      }
      // 队列项成对登记：开投走 `start`，卸载走 `cancel`（不碰 inflight——它没占过槽位）。
      rhythm.queue.push({ start, cancel: () => resolve(onCanceled()) });
    });
  }

  /** 让出一个在途槽位并唤醒队首（队首是成对登记项，走它那一半）。 */
  private releaseSlot(rhythm: ChannelRhythm): void {
    rhythm.inflight -= 1;
    const next = rhythm.queue.shift();
    if (next !== undefined) next.start();
  }

  /**
   * 单目标投递 + 重试：只对出口标注 `retryable` 的失败重试，线性退避。
   *
   * `this.installed` 是退避闸而不只是首轮闸：卸载后仍在退避循环里，就是插件已经卸了还在按
   * 节奏对外打请求（实测 attempts 1 → 3）。它在**两个时间窗**上都要判：循环条件挡住「本次投递
   * 在途期间被卸载」，循环体内的复查挡住「退避等待期间被卸载」——只加循环条件的话，退避醒来
   * 之后那次 `deliverOnce` 照样会发出去。已经在途的那一次跑完、如实归档，不再有下一次。
   */
  private async deliverWithRetry(
    port: DispatchPort,
    message: NotifyMessage,
    target: DeliveryTarget,
    policy: DispatchPolicy,
  ): Promise<DeliverOutcome> {
    let attempt = 0;
    let result = await this.deliverOnce(port, message, target);
    while (
      result.status === "failed" &&
      result.retryable &&
      attempt < policy.maxRetries &&
      this.installed
    ) {
      attempt += 1;
      await sleep(policy.backoffMs * attempt);
      // 退避期间卸载：这一次不再发出去，如实返回上一次的失败结果（归档照旧，状态不写）。
      if (!this.installed) break;
      result = await this.deliverOnce(port, message, target);
    }
    return result;
  }

  /** 单次投递：一次只投一个目标，结果与目标唯一对应。 */
  private async deliverOnce(
    port: DispatchPort,
    message: NotifyMessage,
    target: DeliveryTarget,
  ): Promise<DeliverOutcome> {
    const results = await port.channels.deliver(message, [target]);
    return results[0];
  }

  /**
   * 写频道状态并返回归档明细。**卸载后一律不写**：频道状态是给还在用的界面看的观测面，
   *  插件卸载了就没有读者，而写面会真的落到磁盘上（stores 域的 `record()` 不看 installed）。
   * 归档明细照常产出——「卸载后不再写状态」不等于「把这次投递改成没发生过」。
   */
  private settle(port: DispatchPort, channelId: string, result: DeliverOutcome): ChannelDelivery {
    if (!this.installed) return deliveryOf(channelId, result);
    if (result.status === "failed") port.stores.recordStatus(channelId, "failed", result.reason);
    // `skipped` 不写状态：出口这次什么都没做，没有「最后一次投递结论」可言——写 ok 等于替它宣称成功。
    else if (result.status === "ok") port.stores.recordStatus(channelId, "ok");
    return deliveryOf(channelId, result);
  }
}

/** 本域唯一的投递器：类不外放，外面造不出第二份节奏状态。 */
export const notificationDispatcher = new Dispatcher();
