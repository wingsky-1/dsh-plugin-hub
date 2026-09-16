/**
 * dsh-notifier — 通知帧展示策略的判据（#769 阶段 2）。
 *
 * 这些判定原先与 Notification 构造、DOM 横幅、音频播放交织在一个函数里，因此没有一条判据。
 * 抽成纯函数后逐条钉住——尤其那三条「看起来可以简化、实际会改行为」的语义：缺 sound 字段的
 * 旧帧、playOnly + system 的归一、playOnly 不受可见性约束。
 */
import { describe, expect, it } from "vitest";

import {
  displayChannelOf,
  fallbackChannelOf,
  frameAccepted,
  soundPolicyOf,
} from "../../src/client/notify/policy.ts";

describe("soundPolicyOf：帧级声音策略", () => {
  it("缺 sound 字段的旧帧按「跟随系统默认」处理", () => {
    expect(soundPolicyOf(undefined, false)).toEqual({
      selfPlay: false,
      silent: false,
      tone: undefined,
    });
    expect(soundPolicyOf(null, false)).toEqual({ selfPlay: false, silent: false, tone: undefined });
    expect(soundPolicyOf("selfplay", false)).toEqual({
      selfPlay: false,
      silent: false,
      tone: undefined,
    });
  });

  it("silent 只静音、不自播", () => {
    expect(soundPolicyOf({ mode: "silent" }, false)).toEqual({
      selfPlay: false,
      silent: true,
      tone: undefined,
    });
  });

  it("selfplay 必须同时静音系统弹窗（否则与页内自播叠成双响）", () => {
    expect(soundPolicyOf({ mode: "selfplay", tone: "ding" }, false)).toEqual({
      selfPlay: true,
      silent: true,
      tone: "ding",
    });
  });

  it("tone 非字符串一律当没有（未知取值不给下游猜）", () => {
    expect(soundPolicyOf({ mode: "selfplay", tone: 7 }, false).tone).toBeUndefined();
    expect(soundPolicyOf({ mode: "selfplay", tone: null }, false).tone).toBeUndefined();
  });

  it("playOnly + system 归一为自播：没有弹窗实体时 OS 不会发声，不归一就是「0 弹 0 播」", () => {
    expect(soundPolicyOf({ mode: "system", tone: "bell" }, true)).toEqual({
      selfPlay: true,
      silent: true,
      tone: "bell",
    });
  });

  it("playOnly 不改变已明确的自播/静音策略", () => {
    expect(soundPolicyOf({ mode: "selfplay", tone: "pop" }, true).selfPlay).toBe(true);
    expect(soundPolicyOf({ mode: "silent" }, true)).toEqual({
      selfPlay: false,
      silent: true,
      tone: undefined,
    });
  });
});

describe("fallbackChannelOf / displayChannelOf：落点", () => {
  it("可见用横幅、隐藏改标题（看不见的页面上横幅没有意义）", () => {
    expect(fallbackChannelOf(false, "visible")).toBe("banner");
    expect(fallbackChannelOf(false, "hidden")).toBe("title");
  });

  it("playOnly 两条降级通道都不用", () => {
    expect(fallbackChannelOf(true, "visible")).toBe("none");
    expect(fallbackChannelOf(true, "hidden")).toBe("none");
  });

  it("可用且非 playOnly 才走系统通知", () => {
    expect(
      displayChannelOf({ playOnly: false, notificationUsable: true, visibility: "visible" }),
    ).toBe("notification");
    expect(
      displayChannelOf({ playOnly: true, notificationUsable: true, visibility: "hidden" }),
    ).toBe("none");
    expect(
      displayChannelOf({ playOnly: false, notificationUsable: false, visibility: "hidden" }),
    ).toBe("title");
  });
});

describe("frameAccepted：可见性门", () => {
  const base = { whenVisible: undefined, playOnly: undefined, visibility: "visible" };

  it("测试通知无条件处理（验证链路就是它的目的）", () => {
    expect(frameAccepted({ ...base, kind: "test" })).toBe(true);
    expect(
      frameAccepted({ kind: "test", whenVisible: false, playOnly: false, visibility: "visible" }),
    ).toBe(true);
  });

  it("页面可见时默认不提醒", () => {
    expect(frameAccepted({ ...base, kind: "done" })).toBe(false);
  });

  it("页面可见但帧说「可见时也弹」→ 处理", () => {
    expect(frameAccepted({ ...base, kind: "done", whenVisible: true })).toBe(true);
  });

  it("playOnly 不受可见性约束（纯声音提醒，不打扰界面）", () => {
    expect(frameAccepted({ ...base, kind: "done", playOnly: true })).toBe(true);
  });

  it("页面隐藏时一律处理（whenVisible 不参与）", () => {
    expect(
      frameAccepted({
        kind: "done",
        whenVisible: undefined,
        playOnly: undefined,
        visibility: "hidden",
      }),
    ).toBe(true);
  });
});
