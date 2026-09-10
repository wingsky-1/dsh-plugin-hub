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
import type { NotifyResult } from "../sdk/interface.ts";
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

  function deliverOne(target: ResolvedTarget, notice: AdjudicatedNotice): NotifyResult {
    const { id, channel, dispatch } = target;
    const finalizeError = (err: unknown): string => sanitizeErrorText(err instanceof Error ? err.message : String(err), 300);
    try {
      const safeTitle = truncateCodePoints(String(notice.title), channel.capabilities.titleMaxLen > 0 ? channel.capabilities.titleMaxLen : channel.capabilities.maxBodyLen);
      const safeBody = truncateCodePoints(String(notice.body), channel.capabilities.maxBodyLen);
      const payload: DeliverPayload = { title: safeTitle, body: safeBody, kind: notice.kind, ts: notice.ts, severity: notice.severity };
      const outcome = dispatch !== undefined ? play(target, payload) : channel.send(payload);
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