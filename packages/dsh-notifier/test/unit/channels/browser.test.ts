/**
 * dsh-notifier channels 域 browser 出口 —— 跨端通知帧的构造。
 *
 * 帧是本域唯一的线协议产物（宿主 → 客户端），判据只有两条：
 *  - 铃声决议：页面在「只响不弹」时没有能发系统提示音的实体，只能自播；决议错了表现为
 *    用户开了声音却一声不响，或不该响的时候响；
 *  - 上限与可选键：正文进帧前必须按页面侧的上限截断，而 `severity` 缺席要**不写键**而不是写
 *    `undefined`——线协议两侧对「这个键在不在」的解释不同。
 * 帧出口用假实现收帧，本块不需要真推送设施。
 */
import { describe, expect, it } from "vitest";

import { sendBrowser } from "../../../src/server/channels/impl/browser/index.ts";
import type { BrowserTarget, NotifyFrame } from "../../../src/server/channels/impl/browser/type.ts";
import type { NotifyMessage } from "../../../src/server/channels/impl/deliver/type.ts";

function messageOf(over: Partial<NotifyMessage> = {}): NotifyMessage {
  return { title: "标题", body: "正文", kind: "done", ts: 1_700_000_000_000, ...over };
}

/** 收帧的假出口：帧是这条出口的唯一产物，收到即投递完成。 */
function collector(): {
  frames: NotifyFrame[];
  targetOf: (over?: Partial<BrowserTarget>) => BrowserTarget;
} {
  const frames: NotifyFrame[] = [];
  return {
    frames,
    targetOf: (over = {}) => ({
      type: "browser",
      popup: true,
      sound: true,
      whenVisible: false,
      emitFrame: (frame) => {
        frames.push(frame);
      },
      ...over,
    }),
  };
}

describe("sendBrowser", () => {
  // 只响不弹时页面里没有能发系统提示音的实体，判错就是「开了声音却一声不响」。
  it("铃声决议：false 静音，跟随系统按弹不弹分叉，显式音色走自播", () => {
    const { frames, targetOf } = collector();
    const first = sendBrowser(targetOf({ sound: false }), messageOf());
    sendBrowser(targetOf({ sound: true, popup: true }), messageOf());
    sendBrowser(targetOf({ sound: true, popup: false }), messageOf());
    sendBrowser(targetOf({ sound: "ding", popup: true }), messageOf());

    expect(frames.map((frame) => frame.sound)).toEqual([
      { mode: "silent" },
      { mode: "system" },
      { mode: "selfplay" },
      { mode: "selfplay", tone: "ding" },
    ]);
    expect(frames.map((frame) => frame.pop)).toEqual([true, true, false, true]);
    // 交给帧出口即完成：页面弹没弹不是宿主能证明的事，证据上限只能是 accepted。
    expect(first).toEqual({ status: "ok", stage: "accepted" });
  });

  // 写成 undefined 的 severity 键会被客户端读成「显式声明了空强度」；正文超限则显示被截断或整条丢弃。
  it("按页面侧上限截断标题与正文，severity 缺席就不写这个键，可见性随帧下发", () => {
    const { frames, targetOf } = collector();
    sendBrowser(targetOf(), messageOf({ title: "题".repeat(100), body: "文".repeat(3000) }));
    sendBrowser(targetOf({ whenVisible: true }), messageOf({ severity: "warning" }));

    expect(Array.from(frames[0]!.title)).toHaveLength(64);
    expect(Array.from(frames[0]!.body)).toHaveLength(2048);
    expect("severity" in frames[0]!).toBe(false);
    expect(frames[1]!.severity).toBe("warning");
    // 可见性只有页面知道，故随帧下发：渲染端回查配置会读到可能已经变过的那一份。
    expect(frames.map((frame) => frame.whenVisible)).toEqual([false, true]);
  });

  // 什么都不发也是一次投递，只是没有动作：发空帧会推进序号、进重放缓冲、并让页面认领主标签租约，
  // 而记成 ok 会让历史里多出一条没发生过的成功。判据必须把「出口自己的回答」钉死在结果上。
  it("弹窗与声音都关：不发帧，收成 skipped 而不是伪造一次投递成功", () => {
    const { frames, targetOf } = collector();
    const result = sendBrowser(targetOf({ popup: false, sound: false }), messageOf());

    expect(result).toEqual({ status: "skipped", reason: "浏览器频道：弹窗与声音都已关闭" });
    expect(frames).toEqual([]);
  });
});
