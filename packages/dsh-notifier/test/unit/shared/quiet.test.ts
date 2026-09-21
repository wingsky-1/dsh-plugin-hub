/**
 * dsh-notifier src/shared/quiet —— 免打扰共享面的单源判据。
 *
 * 收口起因：上限（服务端 5 / 客户端 5）与区间口径（judge parseClock+inWindow、
 * input CLOCK_PATTERN+asQuietWindow、客户端 clockToMinutesLocal+windowHitLocal）
 * 各写一份，口径一致全靠人工同步。收口后三端消费同一个绑定，「同值同口径」由构造保证；
 * 本文件再把值、口径与「各端不再有第二份字面量/第二份实现」钉成可判红的判据。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUIET_WINDOWS_LIMIT,
  inWindowMinutes,
  isClockText,
} from "../../../src/shared/interface.ts";
import { QUIET_WINDOWS_LIMIT as MODEL_LIMIT } from "../../../src/server/config/impl/model/type.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { normalizeConfig, validateSettings } from "../../../src/server/config/impl/input/index.ts";
import { inWindow, judgeRequest } from "../../../src/server/pipeline/impl/judge/index.ts";

const pkgDir = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

describe("上限单源：两端读同一个数", () => {
  it("共享值钉住 5，模型侧只是转出（改一边即红）", () => {
    expect(QUIET_WINDOWS_LIMIT).toBe(5);
    expect(MODEL_LIMIT).toBe(QUIET_WINDOWS_LIMIT);
  });

  it("客户端不再抄一份 VIEW 常量", () => {
    const src = readFileSync(join(pkgDir, "src/client/settings/panes/events.tsx"), "utf8");
    expect(src).not.toMatch(/QUIET_WINDOWS_LIMIT_VIEW/u);
    expect(src).toContain("QUIET_WINDOWS_LIMIT");
    expect(src).toContain('from "../../../shared/interface.ts"');
  });
});

describe("命中口径三端同表：共享 / 裁决同行", () => {
  it.each<[number, string, string, boolean]>([
    [23 * 60, "22:00", "08:00", true],
    [8 * 60, "22:00", "08:00", false],
    [22 * 60, "22:00", "08:00", true],
    [13 * 60 + 30, "13:00", "14:00", true],
    [14 * 60, "13:00", "14:00", false],
    [12 * 60, "12:00", "12:00", false],
    [12 * 60, "25:00", "08:00", false],
    [12 * 60, "22:00", "nope", false],
  ])("inWindowMinutes(%i, %s, %s) = %s，且裁决侧同行", (minutes, start, end, hit) => {
    expect(inWindowMinutes(minutes, start, end)).toBe(hit);
    expect(inWindow(minutes, start, end)).toBe(hit);
  });

  it("时钟形状两端同源：合法放行、非法拒绝", () => {
    for (const clock of ["00:00", "22:00", "23:59"]) expect(isClockText(clock)).toBe(true);
    for (const clock of ["24:00", "22:60", "9:30", "abc", "", "22:00:00"]) {
      expect(isClockText(clock)).toBe(false);
    }
  });

  it("写面与读面同口径：合法窗口放行，非法/零长拒绝或丢项", () => {
    expect(
      validateSettings({
        quietHours: { enabled: true, windows: [{ start: "22:00", end: "08:00" }] },
      }),
    ).toEqual({ ok: true });
    for (const windows of [
      [{ start: "25:00", end: "08:00" }],
      [{ start: "22:00", end: "22:00" }],
    ]) {
      const verdict = validateSettings({ quietHours: { enabled: true, windows } });
      if (verdict.ok) throw new Error("期望判非法，实际放行：" + JSON.stringify(windows));
      expect(verdict.error.key).toBe("quietHours");
    }
    // 读面：非法单项只废该项，合法窗口保留；显式 [] 保持 []（空数组 = 未命中）。
    const kept = normalizeConfig({
      quietHours: {
        enabled: true,
        windows: [
          { start: "nope", end: "08:00" },
          { start: "22:00", end: "08:00" },
        ],
      },
    });
    expect(kept.quietHours.windows).toEqual([{ start: "22:00", end: "08:00" }]);
    expect(
      normalizeConfig({ quietHours: { enabled: true, windows: [] } }).quietHours.windows,
    ).toEqual([]);
  });

  it("裁决脏项不抛：非对象单项按未命中跳过（活链上不抛，见 judge 文件头）", () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));
    const dirty = {
      ...DEFAULT_CONFIG,
      quietHours: {
        enabled: true,
        windows: ["x", null, 42, { start: "22:00", end: "08:00" }] as unknown as {
          start: string;
          end: string;
        }[],
      },
    };
    expect(() => judgeRequest(dirty, { kind: "done", title: "t", body: "b" }, true)).not.toThrow();
    expect(judgeRequest(dirty, { kind: "done", title: "t", body: "b" }, true)).toEqual({
      ok: false,
      reason: "quiet",
    });
    const allDirty = {
      ...DEFAULT_CONFIG,
      quietHours: {
        enabled: true,
        windows: ["x", null] as unknown as { start: string; end: string }[],
      },
    };
    expect(judgeRequest(allDirty, { kind: "done", title: "t", body: "b" }, true)).toEqual({
      ok: true,
    });
  });

  it("客户端回显走共享命中，不再自备区间实现", () => {
    const src = readFileSync(join(pkgDir, "src/client/settings/panes/events.tsx"), "utf8");
    expect(src).not.toMatch(/function windowHitLocal/u);
    expect(src).not.toMatch(/function clockToMinutesLocal/u);
    expect(src).toContain("inWindowMinutes");
  });
});
