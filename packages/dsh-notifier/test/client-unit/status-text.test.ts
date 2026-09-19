/**
 * dsh-notifier — 状态行 skipped 历史直达的首个单测（#912 症状2主因）。
 *
 * statusText 本体住在 settings/parts/status.tsx（tsx，node 可直测——只 import react 类型面）；
 * 无终态条目时历史中有该频道的 skipped 明细，就把原因与“详情见通知记录”摆出来，否则仍是
 * “尚未投递”。skipped 值域不动（ok/failed 锁死），本文件同时钉住“有条目时 history 被忽略”。
 */
import { describe, expect, it } from "vitest";

import { zh } from "../../src/client/locales.ts";
import { statusText, type ChannelStatusMap } from "../../src/client/settings/parts/status.tsx";
import type { HistoryRecordView } from "../../src/client/settings/types.ts";
import { translateWithZh } from "../client-helpers.ts";

/** 历史行假件（channels 明细直写，形状与服务端 HistoryEntry 同源）。 */
function historyRecord(
  channels: unknown,
  over: Partial<HistoryRecordView> = {},
): HistoryRecordView {
  return { ts: 1, kind: "test", title: "标题", message: "正文", channels, ...over };
}

describe("statusText 无终态条目时的 skipped 历史直达", () => {
  it("无条目、无历史时仍是“尚未投递”", () => {
    expect(statusText("system", {}, translateWithZh)).toBe(zh.chNeverSent);
    expect(statusText("system", {}, translateWithZh, null)).toBe(zh.chNeverSent);
    expect(statusText("system", {}, translateWithZh, [])).toBe(zh.chNeverSent);
  });

  it("无条目但历史有该频道的 skipped：原因 + 指向通知记录（可达解释）", () => {
    const history = [
      historyRecord([
        { channelId: "system", status: "skipped", reason: { code: "reasonSkipConfig" } },
      ]),
    ];
    const text = statusText("system", {}, translateWithZh, history);
    expect(text).toBe(zh.chNeverSent + " · " + zh.reasonSkipConfig + zh.chSkippedSeeHistory);
  });

  it("只看该频道的 skipped（别频道的跳过不算数）", () => {
    const history = [
      historyRecord([
        { channelId: "browser", status: "skipped", reason: { code: "reasonSkipConfig" } },
      ]),
    ];
    expect(statusText("system", {}, translateWithZh, history)).toBe(zh.chNeverSent);
  });

  it("该频道的 ok/failed 明细不触发直达（只认 skipped）", () => {
    const history = [
      historyRecord([{ channelId: "system", status: "ok" }]),
      historyRecord([
        { channelId: "system", status: "failed", reason: { code: "reasonChannelThrew" } },
      ]),
    ];
    expect(statusText("system", {}, translateWithZh, history)).toBe(zh.chNeverSent);
  });

  it("多条时取最新（历史倒序，最近在前）", () => {
    const history = [
      historyRecord(
        [{ channelId: "system", status: "skipped", reason: { code: "reasonThrottled" } }],
        {
          ts: 2,
        },
      ),
      historyRecord(
        [{ channelId: "system", status: "skipped", reason: { code: "reasonSkipConfig" } }],
        {
          ts: 1,
        },
      ),
    ];
    expect(statusText("system", {}, translateWithZh, history)).toContain(zh.reasonThrottled);
  });

  it("有终态条目时 history 被忽略（ok 与 failed 原语义不动）", () => {
    const map: ChannelStatusMap = { system: { lastTs: 100, lastStatus: "ok" } };
    const history = [
      historyRecord([
        { channelId: "system", status: "skipped", reason: { code: "reasonSkipConfig" } },
      ]),
    ];
    expect(statusText("system", map, translateWithZh, history)).toContain(zh.chLastOk);
    const failed: ChannelStatusMap = {
      system: { lastTs: 100, lastStatus: "failed", lastError: { code: "reasonChannelThrew" } },
    };
    expect(statusText("system", failed, translateWithZh, history)).toContain(zh.chLastFail);
  });
});
