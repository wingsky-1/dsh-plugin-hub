/**
 * dsh-notifier — 推送管线域：投递编排（PR2 工厂化，T2-1）。
 *
 * createDeliverer 封装码点截断 + 单频道 fail-soft 投递 + 终态上报 + 通知级落史：
 * 受理同步返回（铁律 1），终态经 recordStatus/sent 异步可见；错误出口统一
 * sanitizeErrorText。带 dispatch 的目标（内置频道）经 deps.play(target, payload)
 * 值传递播放——spec 在裁决时快照解析、随 target 携带，本域不持快照引用（D23）；
 * 其余目标走 channel.send。重试/并发门等框架能力随 T2-2 在本域上移（B-3）。
 */
import { sanitizeErrorText } from "../text/interface.ts";
import type { NotifyChannel, NotifyResult, RetryableError } from "../sdk/interface.ts";
import type { AdjudicatedNotice, DeliverDeps, DeliverPayload, Deliverer, ResolvedTarget } from "./interface.ts";

/** 统一码点截断（中文场景按码点，不按 UTF-16 code unit）。 */
export function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/**
 * 创建投递编排器：notice → stale skipped 先、逐目标 fail-soft 投递、通知级落史。
 * 终态上报失败不影响受理语义（铁律 1）；频道 send 同步抛错 → 该频道受理 failed
 * 且不牵连其他目标。
 */
export function createDeliverer(deps: DeliverDeps): Deliverer {
  const { recordStatus, emitSent, appendHistory, play } = deps;

  // B-3：门表生命周期 = 本工厂实例闭包，按 channelId（type:id）键控、跨配置
  // 变更延续（对等现状 outbound.ts:13-22 的 barkGates Map 语义）。
  const gates = new Map<string, { inflight: number; queue: Array<() => void> }>();

  function gateFor(channelId: string) {
    let gate = gates.get(channelId);
    if (!gate) {
      gate = { inflight: 0, queue: [] };
      gates.set(channelId, gate);
    }
    return gate;
  }

  /** 经并发门的投递（在途 ≥ maxInflight 排队，无上限队列；缺省 = 无门）。 */
  function withGate(channelId: string, maxInflight: number | undefined, run: () => Promise<void>): Promise<void> {
    if (maxInflight === undefined) return run();
    const gate = gateFor(channelId);
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        gate.inflight += 1;
        run().then(
          (value) => {
            gate.inflight -= 1;
            const next = gate.queue.shift();
            if (next) next();
            resolve(value);
          },
          (error) => {
            gate.inflight -= 1;
            const next = gate.queue.shift();
            if (next) next();
            reject(error);
          },
        );
      };
      if (gate.inflight >= maxInflight) gate.queue.push(start);
      else start();
    });
  }

  /**
   * 框架重试（B-3）：按 channel.capabilities.retry 声明 + RetryableError 协议
   * 决策——retryable:false 确定失败立即终态；网络/5xx（true）或未标注按
   * backoffMs × attempt 线性退避（缺省 backoffMs=1000）。
   */
  async function sendWithRetry(channel: NotifyChannel, payload: DeliverPayload): Promise<void> {
    const retry = channel.capabilities.retry;
    const maxRetries = retry?.maxRetries ?? 0;
    const backoffMs = retry?.backoffMs ?? 1000;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const outcome = channel.send(payload);
        if (outcome && typeof (outcome as Promise<void>).then === "function") await (outcome as Promise<void>);
        return;
      } catch (error) {
        lastError = error;
        if ((error as RetryableError).retryable === false) throw error;
        if (attempt < maxRetries) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  /** 单目标投递入口：dispatch 目标经 play；channel.send 目标在声明了
   *  retry/maxInflight 时经框架重试+并发门（B-3），否则直通 channel.send
   *  （零重试无门，保留 send 返回 undefined 的同步终态语义）。 */
  function deliverOutcome(target: ResolvedTarget, payload: DeliverPayload): void | Promise<void> {
    if (target.dispatch !== undefined) return play(target, payload);
    const caps = target.channel.capabilities;
    if (caps.retry === undefined && caps.maxInflight === undefined) return target.channel.send(payload);
    return withGate(target.id, caps.maxInflight, () => sendWithRetry(target.channel, payload));
  }

  function deliverOne(target: ResolvedTarget, notice: AdjudicatedNotice): NotifyResult {
    const { id, channel, dispatch } = target;
    const finalizeError = (err: unknown): string => sanitizeErrorText(err instanceof Error ? err.message : String(err), 300);
    try {
      const rawTitle = String(notice.title);
      const rawBody = String(notice.body);
      // mergeTitleIntoBody（L8-1）：标题拼入正文、title 位传空串，拼入后长度
      // 权威 = maxBodyLen（不再按 titleMaxLen 单独截断）；空 title 不产生多余
      // 换行。titleMaxLen<=0 且未声明 mergeTitleIntoBody：保留 T2-1/T2-2 现状
      // 宽限截断行为不变（隐式并入已废弃，显式字段接管——见 sdk/interface.ts）。
      let safeTitle: string;
      let safeBody: string;
      if (channel.capabilities.mergeTitleIntoBody === true) {
        safeTitle = "";
        safeBody = truncateCodePoints(rawTitle ? `${rawTitle}\n${rawBody}` : rawBody, channel.capabilities.maxBodyLen);
      } else {
        safeTitle = truncateCodePoints(rawTitle, channel.capabilities.titleMaxLen > 0 ? channel.capabilities.titleMaxLen : channel.capabilities.maxBodyLen);
        safeBody = truncateCodePoints(rawBody, channel.capabilities.maxBodyLen);
      }
      const payload: DeliverPayload = { title: safeTitle, body: safeBody, kind: notice.kind, ts: notice.ts, severity: notice.severity };
      // dispatch 目标（内置频道）经 play 值传递——不经门不经重试（实时推送不
      // 被慢出站拖住，现状语义）；channel.send 目标经框架重试 + 并发门（B-3）。
      const outcome = deliverOutcome(target, payload);
      const emitOk = () => {
        try {
          recordStatus(id, "ok");
          emitSent({ kind: notice.kind, title: safeTitle, message: safeBody, channelId: id, status: "ok", ts: notice.ts });
        } catch {
          // 终态上报失败不影响受理语义
        }
      };
      const emitFail = (err: unknown) => {
        const e = finalizeError(err);
        try {
          recordStatus(id, "failed", e);
          emitSent({ kind: notice.kind, title: safeTitle, message: safeBody, channelId: id, status: "failed", error: e, ts: notice.ts });
        } catch {
          // 同上
        }
      };
      if (outcome && typeof (outcome as Promise<void>).then === "function") {
        (outcome as Promise<void>).then(emitOk, emitFail);
      } else {
        emitOk();
      }
      return { channelId: id, status: "ok" };
    } catch (error) {
      const e = finalizeError(error);
      try {
        recordStatus(id, "failed", e);
        emitSent({ kind: notice.kind, title: notice.title, message: notice.body, channelId: id, status: "failed", error: e, ts: notice.ts });
      } catch {
        // 同上
      }
      return { channelId: id, status: "failed", error: e };
    }
  }

  return function deliver(notice: AdjudicatedNotice): NotifyResult[] {
    const results: NotifyResult[] = [];
    for (const id of notice.stale) {
      results.push({ channelId: id, status: "skipped", error: "stale-route" });
    }
    for (const target of notice.targets) {
      results.push(deliverOne(target, notice));
    }
    appendHistory({ ts: notice.ts, kind: notice.kind, title: notice.title, message: notice.body });
    return results;
  };
}