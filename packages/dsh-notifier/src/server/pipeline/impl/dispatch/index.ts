/**
 * dsh-notifier pipeline 域 —— 投递：把消息送到选定的出口，结果按频道归位。
 * 重试、退避、在途上限与 system 的 1 秒节流都在这里（出口只回答「可不可重试」）；
 * 节奏状态按 `channelId` 键控，跨配置变更延续。
 */
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

/**
 * 首投递还没有上一次结论时透传的值：视为成功。
 * 只有「首次投递尚未完成时又来了第二条」会读到它；旧实现同口径——没有失败证据就不报
 * 失败，免得连点测试按钮时报出一条不存在的故障。
 */
const ASSUMED_OK: DeliverOutcome = { status: "ok", stage: "delivered" };

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

  /** 卸载：放开能力面并清空全部节奏状态（门与节流都不跨装配期存活）。 */
  release(): void {
    this.installed = false;
    this.port = UNINSTALLED;
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
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.recordFailure(port, routed.channelId, reason);
      return deliveryOf(routed.channelId, {
        status: "failed",
        // 违约的出口没给出任何证据，与通道层收违约时的口径一致。
        stage: "accepted",
        reason,
        // 出口承诺把失败做成返回值，抛出来说明它有洞；再投一次只是把同一个洞踩第二遍。
        retryable: false,
      });
    }
  }

  /** 违约频道的状态写面：状态只是观测面，它自己违约也不能再升级为抛出——明细已经成立。 */
  private recordFailure(port: DispatchPort, channelId: string, reason: string): void {
    try {
      port.stores.recordStatus(channelId, "failed", reason);
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
      if (now - rhythm.lastAt < policy.throttleMs) return deliveryOf(routed.channelId, rhythm.last);
      rhythm.lastAt = now;
    }
    const result = await this.withGate(rhythm, policy.maxInflight, () =>
      this.deliverWithRetry(port, message, routed.target, policy),
    );
    rhythm.last = result;
    return this.settle(port, routed.channelId, result);
  }

  /** 取（必要时创建）频道的节奏状态。 */
  private rhythmOf(channelId: string): ChannelRhythm {
    const existing = this.rhythms.get(channelId);
    if (existing !== undefined) return existing;
    const fresh: ChannelRhythm = { lastAt: 0, last: ASSUMED_OK, inflight: 0, queue: [] };
    this.rhythms.set(channelId, fresh);
    return fresh;
  }

  /** 在途门：槽位满时排队等待，队列无上限。 */
  private withGate<T>(
    rhythm: ChannelRhythm,
    maxInflight: number,
    run: () => Promise<T>,
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
      if (rhythm.inflight >= maxInflight) rhythm.queue.push(start);
      else start();
    });
  }

  /** 让出一个在途槽位并唤醒队首。 */
  private releaseSlot(rhythm: ChannelRhythm): void {
    rhythm.inflight -= 1;
    const next = rhythm.queue.shift();
    if (next !== undefined) next();
  }

  /** 单目标投递 + 重试：只对出口标注 `retryable` 的失败重试，线性退避。 */
  private async deliverWithRetry(
    port: DispatchPort,
    message: NotifyMessage,
    target: DeliveryTarget,
    policy: DispatchPolicy,
  ): Promise<DeliverOutcome> {
    let attempt = 0;
    let result = await this.deliverOnce(port, message, target);
    while (result.status === "failed" && result.retryable && attempt < policy.maxRetries) {
      attempt += 1;
      await sleep(policy.backoffMs * attempt);
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

  /** 写频道状态并返回归档明细。 */
  private settle(port: DispatchPort, channelId: string, result: DeliverOutcome): ChannelDelivery {
    if (result.status === "failed") port.stores.recordStatus(channelId, "failed", result.reason);
    // `skipped` 不写状态：出口这次什么都没做，没有「最后一次投递结论」可言——写 ok 等于替它宣称成功。
    else if (result.status === "ok") port.stores.recordStatus(channelId, "ok");
    return deliveryOf(channelId, result);
  }
}

/** 本域唯一的投递器：类不外放，外面造不出第二份节奏状态。 */
export const notificationDispatcher = new Dispatcher();
