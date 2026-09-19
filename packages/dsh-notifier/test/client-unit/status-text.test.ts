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
    const text = statusText("system", {}, translateWithZh, history);
    expect(text).toContain(zh.reasonThrottled);
    // 最新者唯一：旧原因不得残留（否则“取最新”判据恒真）
    expect(text).not.toContain(zh.reasonSkipConfig);
  });

  it("skipped 明细缺 reason 时给原因未知不断尾（reasonText 未知回退）", () => {
    const history = [historyRecord([{ channelId: "system", status: "skipped" }])];
    const text = statusText("system", {}, translateWithZh, history);
    expect(text).toBe(zh.chNeverSent + " · " + zh.reasonUnknown + zh.chSkippedSeeHistory);
  });

  it("skipped 明细 reason 为未知 code 时同样回退原因未知", () => {
    const history = [
      historyRecord([{ channelId: "system", status: "skipped", reason: { code: "reasonNoSuch" } }]),
    ];
    const text = statusText("system", {}, translateWithZh, history);
    expect(text).toBe(zh.chNeverSent + " · " + zh.reasonUnknown + zh.chSkippedSeeHistory);
  });

  it("skipped 明细 reason 为空串时不挂空分隔符（falsy 分支锁死）", () => {
    const history = [historyRecord([{ channelId: "system", status: "skipped", reason: "" }])];
    expect(statusText("system", {}, translateWithZh, history)).toBe(
      zh.chNeverSent + zh.chSkippedSeeHistory,
    );
  });

  it("脏 history 形态一律无视（缺 channels/非数组/脏明细不算解释）", () => {
    // record 缺 channels 键
    expect(
      statusText("system", {}, translateWithZh, [historyRecord(undefined as unknown as never, {})]),
    ).toBe(zh.chNeverSent);
    // channels 非数组
    const nonArray = historyRecord("nope" as unknown as never);
    expect(statusText("system", {}, translateWithZh, [nonArray])).toBe(zh.chNeverSent);
    // 明细脏形态：null / 字符串 / 数组一律跳过
    const dirty = historyRecord([null, "x", ["system"]]);
    expect(statusText("system", {}, translateWithZh, [dirty])).toBe(zh.chNeverSent);
    // history 本体非数组（undefined 已在旧用例覆盖，这里钉字符串形态）
    expect(statusText("system", {}, translateWithZh, "nope" as unknown as never)).toBe(
      zh.chNeverSent,
    );
  });

  it("lastTs 为 0 视为无终态（falsy 语义）：有 skipped 走直达、无则仍尚未投递", () => {
    const empty: ChannelStatusMap = { system: { lastTs: 0, lastStatus: "ok" } };
    expect(statusText("system", empty, translateWithZh)).toBe(zh.chNeverSent);
    const history = [
      historyRecord([
        { channelId: "system", status: "skipped", reason: { code: "reasonSkipConfig" } },
      ]),
    ];
    expect(statusText("system", empty, translateWithZh, history)).toContain(zh.reasonSkipConfig);
  });

  it("有 lastTs 但无 lastStatus 时按失败分支渲染（非 ok 一律失败）", () => {
    const map = { system: { lastTs: 100 } } as unknown as ChannelStatusMap;
    expect(statusText("system", map, translateWithZh)).toContain(zh.chLastFail);
  });

  it("数组序即最新序：ts 早晚不参与判定（实现只看数组位置）", () => {
    const history = [
      historyRecord(
        [{ channelId: "system", status: "skipped", reason: { code: "reasonSkipConfig" } }],
        { ts: 1 },
      ),
      historyRecord(
        [{ channelId: "system", status: "skipped", reason: { code: "reasonThrottled" } }],
        { ts: 99 },
      ),
    ];
    // 首个数组元素 ts 更老但仍胜出：实现不读 ts，只取首个命中
    const text = statusText("system", {}, translateWithZh, history);
    expect(text).toContain(zh.reasonSkipConfig);
    expect(text).not.toContain(zh.reasonThrottled);
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
