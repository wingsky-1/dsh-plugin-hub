/**
 * dsh-notifier — 保存串行 guard 的判据（#769 阶段 1）。
 *
 * guard 的每条语义都对应一个用户可见后果：占位必须只在成功时发生、被拒的入口必须能原样补发、
 * 释放必须能覆盖任何路径（否则按钮永久「保存中」）。这些原先都没有判据。
 */
import { describe, expect, it } from "vitest";

import { createSaveGuard } from "../../src/client/settings/save-guard.ts";

describe("保存串行 guard：一次只在途一个，被拒入口原样补发", () => {
  it("空闲时占用成功，在途时被拒且不改变占用态", () => {
    const guard = createSaveGuard();
    expect(guard.isBusy()).toBe(false);
    expect(guard.tryBegin("all")).toBe(true);
    expect(guard.isBusy()).toBe(true);
    expect(guard.tryBegin("channels")).toBe(false);
    expect(guard.isBusy()).toBe(true);
  });

  it("end 返回「在途期间最后一次被拒的入口」并释放占用", () => {
    const guard = createSaveGuard();
    guard.tryBegin("all");
    guard.tryBegin("channels");
    guard.tryBegin("channels");
    expect(guard.end()).toBe("channels");
    expect(guard.isBusy()).toBe(false);
  });

  it("同一在途期多次点击不同入口时记最后一次意图（只补发一次，天然不风暴）", () => {
    const guard = createSaveGuard();
    guard.tryBegin("all");
    guard.tryBegin("channels");
    guard.tryBegin("all");
    expect(guard.end()).toBe("all");
  });

  it("无被拒入口时 end 返回 null（不产生补发）", () => {
    const guard = createSaveGuard();
    guard.tryBegin("all");
    expect(guard.end()).toBeNull();
  });

  it("end 清空 pending：下一次 end 不再重复补发", () => {
    const guard = createSaveGuard();
    guard.tryBegin("all");
    guard.tryBegin("channels");
    expect(guard.end()).toBe("channels");
    expect(guard.end()).toBeNull();
  });

  it("释放后可再次占用（异常路径也走 end，防按钮永久卡死）", () => {
    const guard = createSaveGuard();
    guard.tryBegin("all");
    guard.end();
    expect(guard.tryBegin("channels")).toBe(true);
    expect(guard.end()).toBeNull();
  });

  it("补发入口不能被升级成全量：被拒的是 channels 就补发 channels", () => {
    // 若补发时改成 "all"，事件 tab 的半成品草稿会被一起提交（语义反转）
    const guard = createSaveGuard();
    guard.tryBegin("all");
    guard.tryBegin("channels");
    const replayed = guard.end();
    expect(replayed).toBe("channels");
    expect(replayed).not.toBe("all");
  });
});
