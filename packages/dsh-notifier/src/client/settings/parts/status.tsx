/**
 * 频道状态呈现原子：时间戳格式化、状态摘要/状态点、per-channel 测试按钮、失败徽标。
 *
 * statusMap / sendTest / t 由调用方显式传入：原子层不读卡片状态，否则「搬走的函数捕获的仍是
 * 旧 state」这类闭包语义变化不会有任何编译期信号。
 */
import * as React from "react";
import { reasonText } from "../../reason-text.ts";
import type { Translate } from "../../locale.ts";
import type { HistoryRecordView } from "../types.ts";

/** 频道状态表（键 = 频道 id；/status 载荷逐项透传，读侧只取自己认识的字段）。 */
interface ChannelStatus {
  lastTs?: number;
  lastStatus?: string;
  lastError?: unknown;
}
export type ChannelStatusMap = Record<string, ChannelStatus | undefined>;

export function padTime(ts: number) {
  const d = new Date(ts);
  const pad = function (n: number) {
    return n < 10 ? "0" + n : String(n);
  };
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

/**
 * 该频道在历史中的最新 skipped 明细（#912 症状2“历史直达”的读面）。
 * history 是倒序（最近在前，见 index.tsx fetchHistory），从头找第一条命中即最新。
 * 只认 status 全等于 "skipped" 且 channelId 全等的明细——skipped 不进 statusMap
 * （值域 ok/failed 锁死，见 status-poll.ts 模块头的决策），这里是它在状态行唯一的可见出口。
 */
function latestSkippedDelivery(
  channelKey: string,
  history: HistoryRecordView[] | null | undefined,
): { reason?: unknown } | undefined {
  if (!Array.isArray(history)) return undefined;
  for (const record of history) {
    const channels = (record as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) continue;
    for (const item of channels) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const delivery = item as { channelId?: unknown; status?: unknown; reason?: unknown };
      if (delivery.channelId === channelKey && delivery.status === "skipped") return delivery;
    }
  }
  return undefined;
}

/** 频道状态摘要（上提卡头 statusDot + statusTxt；完整错误经 title 提示）。 */
export function statusText(
  channelKey: string,
  statusMap: ChannelStatusMap,
  t: Translate,
  history?: HistoryRecordView[] | null,
): string {
  const st = statusMap[channelKey];
  if (!st || !st.lastTs) {
    // 无终态条目：ok/failed 值域里没有 skipped 的位置（#912 选历史直达，不改值域）——
    // 历史中有该频道的 skipped 明细时，把原因摆出来并指向通知记录，否则仍是“尚未投递”。
    const skipped = latestSkippedDelivery(channelKey, history);
    if (skipped === undefined) return t("chNeverSent");
    const skippedWhy = reasonText(skipped.reason, t);
    return t("chNeverSent") + (skippedWhy ? " · " + skippedWhy : "") + t("chSkippedSeeHistory");
  }
  if (st.lastStatus === "ok") return t("chLastOk") + " · " + padTime(st.lastTs);
  const why = reasonText(st.lastError, t);
  return t("chLastFail") + " · " + padTime(st.lastTs) + (why ? "：" + why : "");
}

export function statusDotClass(channelKey: string, statusMap: ChannelStatusMap): string {
  const st = statusMap[channelKey];
  if (!st || !st.lastTs) return "";
  return st.lastStatus === "ok" ? "ok" : "fail";
}

export function testBtn(
  channelId: string | undefined,
  sendTest: (id?: string) => void,
  t: Translate,
) {
  return (
    <button
      type="button"
      className="dn-set-btn dn-set-btnSmall"
      onClick={function () {
        sendTest(channelId);
      }}
    >
      {t("chTest")}
    </button>
  );
}

/** 投递失败徽标：最近投递失败时上提至卡头 summary 行，收起态仍可见。 */
export function failBadge(channelKey: string, statusMap: ChannelStatusMap, t: Translate) {
  const st = statusMap[channelKey];
  if (!st || !st.lastTs || st.lastStatus !== "failed") return null;
  return <span className="dn-ch-failBadge">{t("chLastFail") + " · " + padTime(st.lastTs)}</span>;
}
