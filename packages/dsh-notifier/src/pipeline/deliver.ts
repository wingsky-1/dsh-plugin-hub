/**
 * dsh-notifier — 推送管线域：投递（PR1 机械提炼自 sdk/service 旧 createNotifierService）。
 *
 * 本文件承载「单频道投递」的现状语义（受理同步返回 + 终态经 status/sent 异步
 * 可见，铁律 1）：截断按码点、错误出口统一 sanitizeErrorText（评审 P0-4：error/
 * status/事件三路都过）。重试/并发门/门表生命周期等框架能力随 PR2 行为重构
 * （B-3）在本域上移——PR1 仅搬家，函数体与调用时序与提炼前完全一致。
 */
import { sanitizeErrorText } from "../text/interface.ts";
import type { NotifyChannel, NotifySeverity, NotifyResult, NotifierServiceDeps } from "../sdk/interface.ts";

/** 统一码点截断（中文场景按码点，不按 UTF-16 code unit）。 */
export function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/**
 * 单频道投递：受理同步返回（铁律 1）；投递终态经 status 落盘 + sent 事件
 * 异步可见（channel.send 的 promise 决议；browser 同步完成即终态）。错误出口
 * 统一 sanitizeErrorText。
 * @param args.recordStatus / args.emitSent 投递终态出口（装配层经 deps 注入）。
 */
export function deliverToChannel(args: {
  kind: string;
  title: string;
  message: string;
  ts: number;
  severity: NotifySeverity | undefined;
  target: { id: string; channel: NotifyChannel };
  recordStatus: NotifierServiceDeps["recordStatus"];
  emitSent: NotifierServiceDeps["emitSent"];
}): NotifyResult {
  const { kind, title, message, ts, severity, target, recordStatus, emitSent } = args;
  const { id, channel } = target;
  const finalizeError = (err: unknown): string => sanitizeErrorText(err instanceof Error ? err.message : String(err), 300);
  try {
    const safeTitle = truncateCodePoints(String(title), channel.capabilities.titleMaxLen > 0 ? channel.capabilities.titleMaxLen : channel.capabilities.maxBodyLen);
    const safeBody = truncateCodePoints(String(message), channel.capabilities.maxBodyLen);
    const outcome = channel.send({ title: safeTitle, body: safeBody, kind, ts, severity });
    const emitOk = () => {
      try {
        recordStatus(id, "ok");
        emitSent({ kind, title: safeTitle, message: safeBody, channelId: id, status: "ok", ts });
      } catch {
        // 终态上报失败不影响受理语义
      }
    };
    const emitFail = (err: unknown) => {
      const e = finalizeError(err);
      try {
        recordStatus(id, "failed", e);
        emitSent({ kind, title: safeTitle, message: safeBody, channelId: id, status: "failed", error: e, ts });
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
      emitSent({ kind, title, message, channelId: id, status: "failed", error: e, ts });
    } catch {
      // 同上
    }
    return { channelId: id, status: "failed", error: e };
  }
}